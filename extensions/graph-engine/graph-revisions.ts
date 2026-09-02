import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RegisteredGraphDefinition } from "./registry.ts";
import type { DeclarativeGraphSpec, LoadedProjectGraph, ProjectGraphCompiler } from "./project-graphs.ts";
import { loadProjectGraphs, PROJECT_GRAPH_MAX_BYTES } from "./project-graphs.ts";
import { legacyProjectGraphSourcePath, projectGraphSourcePath, resolveAgentGraphProjectPaths } from "./storage.ts";

const GRAPH_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DEFINITION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_SCHEMA_VERSION = 1;

export type GraphRevisionAction = "create" | "update" | "rollback" | "observed";

export interface GraphRevisionSummary {
	version: string;
	definitionHash: string;
	createdAt: number;
	activationCount: number;
	active: boolean;
}

export interface GraphActivationRecord {
	id: string;
	action: GraphRevisionAction;
	fromDefinitionHash?: string;
	toDefinitionHash: string;
	timestamp: number;
}

export interface ProjectGraphHistory {
	schemaVersion: number;
	graph: string;
	headDefinitionHash: string;
	revisions: GraphRevisionSummary[];
	activations: GraphActivationRecord[];
}

interface StoredGraphHistory {
	schemaVersion: number;
	graph: string;
	headDefinitionHash: string;
	revisions: Array<{
		version: string;
		definitionHash: string;
		createdAt: number;
	}>;
	activations: GraphActivationRecord[];
}

interface GraphRevisionTransaction {
	schemaVersion: number;
	id: string;
	graph: string;
	action: "update" | "rollback";
	fromDefinitionHash: string;
	toDefinitionHash: string;
	timestamp: number;
}

export interface GraphSpecChange {
	path: string;
	kind: "add" | "remove" | "replace";
	before?: unknown;
	after?: unknown;
}

export interface GraphRevisionInspection {
	history: ProjectGraphHistory;
	selected?: {
		spec: DeclarativeGraphSpec;
		diffFromActive: GraphSpecChange[];
	};
}

export interface PreparedGraphRevisionChange {
	current: LoadedProjectGraph;
	candidate: LoadedProjectGraph;
	diff: GraphSpecChange[];
	noChange: boolean;
}

export class ProjectGraphRevisionConflictError extends Error {
	readonly actualDefinitionHash?: string;

	constructor(message: string, actualDefinitionHash?: string) {
		super(message);
		this.name = "ProjectGraphRevisionConflictError";
		this.actualDefinitionHash = actualDefinitionHash;
	}
}

interface RevisionPaths {
	root: string;
	graph: string;
	revisions: string;
	history: string;
	transaction: string;
}

function revisionPaths(cwd: string, name: string): RevisionPaths {
	if (!GRAPH_NAME_PATTERN.test(name)) throw new Error(`Invalid project graph name: ${name}`);
	const catalog = resolveAgentGraphProjectPaths(cwd).catalog;
	const root = join(catalog, "graph-revisions");
	const graph = join(root, name);
	return {
		root,
		graph,
		revisions: join(graph, "revisions"),
		history: join(graph, "history.json"),
		transaction: join(graph, "transaction.json"),
	};
}

function pathIsInside(parent: string, child: string): boolean {
	const value = relative(parent, child);
	return value === "" || (!!value && !value.startsWith("..") && !isAbsolute(value));
}

async function existingRealPath(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertRegularFile(path: string): Promise<void> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Graph revision path must be a regular file: ${path}`);
	if (await realpath(path) !== join(await realpath(dirname(path)), basename(path))) {
		throw new Error(`Graph revision path must not traverse symlinks: ${path}`);
	}
}

async function ensureRevisionDirectories(cwd: string, paths: RevisionPaths): Promise<void> {
	const cwdReal = await realpath(cwd);
	const projectPaths = resolveAgentGraphProjectPaths(cwd);
	for (const path of [projectPaths.root, projectPaths.catalog, paths.root, paths.graph, paths.revisions]) {
		const expected = resolve(cwdReal, relative(cwd, path));
		const existing = await existingRealPath(path);
		if (existing && existing !== expected) {
			throw new Error("Graph revision directory must remain inside cwd and must not contain symlinks.");
		}
		if (!existing) await mkdir(path);
		const pathReal = await realpath(path);
		if (!pathIsInside(cwdReal, pathReal) || pathReal !== expected) {
			throw new Error("Graph revision directory must remain inside cwd and must not contain symlinks.");
		}
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Graph revision path must be a real directory: ${path}`);
	}
	await access(paths.revisions, constants.W_OK);
}

async function writeExclusive(path: string, content: string): Promise<void> {
	let created = false;
	try {
		const handle = await open(path, "wx");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
			created = true;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		await assertRegularFile(path);
		if (await readFile(path, "utf8") !== content) throw new Error(`Immutable graph revision conflict: ${path}`);
	}
	if (created) await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function writeAtomic(path: string, content: string): Promise<void> {
	try {
		await assertRegularFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = join(resolve(path, ".."), `.${basename(path)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx");
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
		await syncDirectory(dirname(path));
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function serializedSpec(spec: DeclarativeGraphSpec, compiler: ProjectGraphCompiler): string {
	const serialized = compiler.serialize ? compiler.serialize(spec) : `${JSON.stringify(spec, null, "\t")}\n`;
	if (Buffer.byteLength(serialized, "utf8") > PROJECT_GRAPH_MAX_BYTES) throw new Error(`Project graph exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`);
	return serialized;
}

function definitionHash(definition: RegisteredGraphDefinition): string {
	if (!definition.definitionHash || !DEFINITION_HASH_PATTERN.test(definition.definitionHash)) {
		throw new Error("Project graph revision storage requires a SHA-256 definitionHash.");
	}
	return definition.definitionHash;
}

function compileRevision(
	spec: DeclarativeGraphSpec,
	cwd: string,
	name: string,
	compiler: ProjectGraphCompiler,
	sourcePath = projectGraphSourcePath(name),
): LoadedProjectGraph {
	const path = join(resolveAgentGraphProjectPaths(cwd).graphs, `${name}.json`);
	const definition = compiler.compile(spec, { cwd, path, sourcePath });
	if (definition.name !== name) throw new Error(`Compiled graph name must match spec.name (${name}).`);
	definitionHash(definition);
	return { definition, spec, path };
}

async function readStoredHistory(paths: RevisionPaths): Promise<StoredGraphHistory | undefined> {
	try {
		await assertRegularFile(paths.history);
		const value = JSON.parse(await readFile(paths.history, "utf8")) as StoredGraphHistory;
		if (value.schemaVersion !== REVISION_SCHEMA_VERSION || value.graph !== basename(paths.graph) || !Array.isArray(value.revisions) || !Array.isArray(value.activations)) {
			throw new Error(`Invalid graph revision history: ${paths.history}`);
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function storeHistory(paths: RevisionPaths, history: StoredGraphHistory): Promise<void> {
	await writeAtomic(paths.history, `${JSON.stringify(history, null, "\t")}\n`);
}

function addRevision(
	history: StoredGraphHistory,
	version: string,
	hash: string,
	timestamp: number,
): void {
	if (!history.revisions.some((item) => item.definitionHash === hash)) {
		history.revisions.push({ version, definitionHash: hash, createdAt: timestamp });
	}
}

function addActivation(history: StoredGraphHistory, activation: GraphActivationRecord): void {
	if (!history.activations.some((item) => item.id === activation.id)) history.activations.push(activation);
	history.headDefinitionHash = activation.toDefinitionHash;
}

async function archiveRevision(
	paths: RevisionPaths,
	graph: LoadedProjectGraph,
	compiler: ProjectGraphCompiler,
): Promise<void> {
	const hash = definitionHash(graph.definition);
	await writeExclusive(join(paths.revisions, `${hash}.json`), serializedSpec(graph.spec, compiler));
}

async function activeProjectGraph(
	cwd: string,
	trusted: boolean,
	name: string,
	compiler: ProjectGraphCompiler,
): Promise<LoadedProjectGraph> {
	if (!trusted) throw new Error("Project graph revision access requires an explicitly trusted cwd.");
	const loaded = await loadProjectGraphs({ cwd, trusted, compiler });
	const graph = loaded.graphs.find((item) => item.definition.name === name);
	if (!graph) throw new Error(`Project graph not found: ${name}`);
	const expectedPath = join(resolveAgentGraphProjectPaths(cwd).graphs, `${name}.json`);
	if (graph.path !== expectedPath) throw new Error(`Project graph must be migrated to canonical storage before it can be revised: ${name}`);
	definitionHash(graph.definition);
	return graph;
}

async function readTransaction(paths: RevisionPaths): Promise<GraphRevisionTransaction | undefined> {
	try {
		await assertRegularFile(paths.transaction);
		const value = JSON.parse(await readFile(paths.transaction, "utf8")) as GraphRevisionTransaction;
		if (value.schemaVersion !== REVISION_SCHEMA_VERSION || value.graph !== basename(paths.graph)) {
			throw new Error(`Invalid graph revision transaction: ${paths.transaction}`);
		}
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function recoverTransaction(
	cwd: string,
	trusted: boolean,
	name: string,
	compiler: ProjectGraphCompiler,
	paths: RevisionPaths,
): Promise<void> {
	const transaction = await readTransaction(paths);
	if (!transaction) return;
	const active = await activeProjectGraph(cwd, trusted, name, compiler);
	const activeHash = definitionHash(active.definition);
	if (activeHash === transaction.fromDefinitionHash) {
		await unlink(paths.transaction);
		await syncDirectory(paths.graph);
		return;
	}
	if (activeHash !== transaction.toDefinitionHash) {
		throw new ProjectGraphRevisionConflictError(
			`Graph revision transaction conflicts with active definition ${activeHash}.`,
			activeHash,
		);
	}
	const history = await readStoredHistory(paths) ?? {
		schemaVersion: REVISION_SCHEMA_VERSION,
		graph: name,
		headDefinitionHash: transaction.fromDefinitionHash,
		revisions: [],
		activations: [],
	};
	addRevision(history, active.definition.version, activeHash, transaction.timestamp);
	addActivation(history, {
		id: transaction.id,
		action: transaction.action,
		fromDefinitionHash: transaction.fromDefinitionHash,
		toDefinitionHash: transaction.toDefinitionHash,
		timestamp: transaction.timestamp,
	});
	await storeHistory(paths, history);
	await unlink(paths.transaction);
	await syncDirectory(paths.graph);
}

async function ensureArchived(
	cwd: string,
	trusted: boolean,
	name: string,
	compiler: ProjectGraphCompiler,
	action: "create" | "observed" = "observed",
): Promise<{ graph: LoadedProjectGraph; history: StoredGraphHistory }> {
	const paths = revisionPaths(cwd, name);
	await ensureRevisionDirectories(cwd, paths);
	await recoverTransaction(cwd, trusted, name, compiler, paths);
	const graph = await activeProjectGraph(cwd, trusted, name, compiler);
	const hash = definitionHash(graph.definition);
	await archiveRevision(paths, graph, compiler);
	const timestamp = Date.now();
	const history = await readStoredHistory(paths) ?? {
		schemaVersion: REVISION_SCHEMA_VERSION,
		graph: name,
		headDefinitionHash: hash,
		revisions: [],
		activations: [],
	};
	addRevision(history, graph.definition.version, hash, timestamp);
	if (history.activations.length === 0 || history.headDefinitionHash !== hash) {
		addActivation(history, {
			id: randomUUID(),
			action: history.activations.length === 0 ? action : "observed",
			...(history.activations.length > 0 ? { fromDefinitionHash: history.headDefinitionHash } : {}),
			toDefinitionHash: hash,
			timestamp,
		});
	}
	await storeHistory(paths, history);
	return { graph, history };
}

function asComparable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(asComparable);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(Object.keys(record).sort().map((key) => [key, asComparable(record[key])]));
}

function nodeMap(value: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries = value.map((item) => {
		if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") return undefined;
		return [(item as { id: string }).id, item] as const;
	});
	if (entries.some((item) => !item)) return undefined;
	return Object.fromEntries(entries as Array<readonly [string, unknown]>);
}

function diffValues(before: unknown, after: unknown, path: string, output: GraphSpecChange[]): void {
	if (JSON.stringify(asComparable(before)) === JSON.stringify(asComparable(after))) return;
	if (before === undefined) {
		output.push({ path, kind: "add", after });
		return;
	}
	if (after === undefined) {
		output.push({ path, kind: "remove", before });
		return;
	}
	const beforeNodes = path === "nodes" || path.endsWith(".children") ? nodeMap(before) : undefined;
	const afterNodes = path === "nodes" || path.endsWith(".children") ? nodeMap(after) : undefined;
	if (beforeNodes && afterNodes) {
		for (const key of [...new Set([...Object.keys(beforeNodes), ...Object.keys(afterNodes)])].sort()) {
			diffValues(beforeNodes[key], afterNodes[key], `${path}.${key}`, output);
		}
		return;
	}
	if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
		const left = before as Record<string, unknown>;
		const right = after as Record<string, unknown>;
		for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
			diffValues(left[key], right[key], path ? `${path}.${key}` : key, output);
		}
		return;
	}
	output.push({ path, kind: "replace", before, after });
}

export function diffGraphSpecs(before: DeclarativeGraphSpec, after: DeclarativeGraphSpec): GraphSpecChange[] {
	const changes: GraphSpecChange[] = [];
	diffValues(before, after, "", changes);
	return changes;
}

function publicHistory(history: StoredGraphHistory): ProjectGraphHistory {
	const counts = new Map<string, number>();
	for (const activation of history.activations) counts.set(activation.toDefinitionHash, (counts.get(activation.toDefinitionHash) ?? 0) + 1);
	return {
		schemaVersion: history.schemaVersion,
		graph: history.graph,
		headDefinitionHash: history.headDefinitionHash,
		revisions: history.revisions.map((revision) => ({
			...revision,
			activationCount: counts.get(revision.definitionHash) ?? 0,
			active: revision.definitionHash === history.headDefinitionHash,
		})),
		activations: [...history.activations],
	};
}

export async function ensureProjectGraphRevision(options: {
	cwd: string;
	trusted: boolean;
	name: string;
	compiler: ProjectGraphCompiler;
	action?: "create" | "observed";
}): Promise<{ graph: LoadedProjectGraph; history: ProjectGraphHistory }> {
	const ensured = await ensureArchived(options.cwd, options.trusted, options.name, options.compiler, options.action);
	return { graph: ensured.graph, history: publicHistory(ensured.history) };
}

export async function prepareProjectGraphUpdate(options: {
	cwd: string;
	trusted: boolean;
	compiler: ProjectGraphCompiler;
	spec: DeclarativeGraphSpec;
	expectedDefinitionHash: string;
}): Promise<PreparedGraphRevisionChange> {
	const current = await activeProjectGraph(options.cwd, options.trusted, options.spec.name, options.compiler);
	const actualHash = definitionHash(current.definition);
	if (actualHash !== options.expectedDefinitionHash) {
		throw new ProjectGraphRevisionConflictError(
			`Project graph changed since it was inspected (${options.expectedDefinitionHash} !== ${actualHash}).`,
			actualHash,
		);
	}
	const candidate = compileRevision(options.spec, options.cwd, options.spec.name, options.compiler);
	const candidateHash = definitionHash(candidate.definition);
	const noChange = candidateHash === actualHash;
	if (!noChange && candidate.definition.version === current.definition.version) {
		throw new Error(`Project graph version must change when its definition changes (${current.definition.version}).`);
	}
	return { current, candidate, diff: diffGraphSpecs(current.spec, candidate.spec), noChange };
}

async function activate(options: {
	cwd: string;
	trusted: boolean;
	compiler: ProjectGraphCompiler;
	prepared: PreparedGraphRevisionChange;
	action: "update" | "rollback";
}): Promise<{ graph: LoadedProjectGraph; history: ProjectGraphHistory; diff: GraphSpecChange[] }> {
	const name = options.prepared.current.definition.name;
	const paths = revisionPaths(options.cwd, name);
	const ensured = await ensureArchived(options.cwd, options.trusted, name, options.compiler);
	const currentHash = definitionHash(ensured.graph.definition);
	const expectedHash = definitionHash(options.prepared.current.definition);
	if (currentHash !== expectedHash) throw new ProjectGraphRevisionConflictError("Project graph changed before activation.", currentHash);
	if (options.prepared.noChange) return { graph: ensured.graph, history: publicHistory(ensured.history), diff: [] };

	await archiveRevision(paths, options.prepared.candidate, options.compiler);
	const targetHash = definitionHash(options.prepared.candidate.definition);
	const timestamp = Date.now();
	const transaction: GraphRevisionTransaction = {
		schemaVersion: REVISION_SCHEMA_VERSION,
		id: randomUUID(),
		graph: name,
		action: options.action,
		fromDefinitionHash: currentHash,
		toDefinitionHash: targetHash,
		timestamp,
	};
	await writeExclusive(paths.transaction, `${JSON.stringify(transaction, null, "\t")}\n`);

	const activePath = options.prepared.current.path;
	await assertRegularFile(activePath);
	const latestSource = await readFile(activePath, "utf8");
	const parsed = options.compiler.parse ? options.compiler.parse(latestSource, activePath) : JSON.parse(latestSource);
	if (!parsed || typeof parsed !== "object") throw new Error("Project graph active definition is invalid.");
	const latest = compileRevision(parsed as DeclarativeGraphSpec, options.cwd, name, options.compiler);
	const latestHash = definitionHash(latest.definition);
	if (latestHash !== currentHash) {
		await unlink(paths.transaction);
		await syncDirectory(paths.graph);
		throw new ProjectGraphRevisionConflictError("Project graph changed immediately before activation.", latestHash);
	}
	await writeAtomic(activePath, serializedSpec(options.prepared.candidate.spec, options.compiler));

	const history = ensured.history;
	addRevision(history, options.prepared.candidate.definition.version, targetHash, timestamp);
	addActivation(history, {
		id: transaction.id,
		action: options.action,
		fromDefinitionHash: currentHash,
		toDefinitionHash: targetHash,
		timestamp,
	});
	await storeHistory(paths, history);
	await unlink(paths.transaction);
	await syncDirectory(paths.graph);
	return { graph: options.prepared.candidate, history: publicHistory(history), diff: options.prepared.diff };
}

export async function updateProjectGraphRevision(options: {
	cwd: string;
	trusted: boolean;
	compiler: ProjectGraphCompiler;
	spec: DeclarativeGraphSpec;
	expectedDefinitionHash: string;
}): Promise<{ graph: LoadedProjectGraph; history: ProjectGraphHistory; diff: GraphSpecChange[]; noChange: boolean }> {
	const prepared = await prepareProjectGraphUpdate(options);
	if (prepared.noChange) {
		const ensured = await ensureProjectGraphRevision({ ...options, name: options.spec.name });
		return { graph: prepared.current, history: ensured.history, diff: [], noChange: true };
	}
	const result = await activate({ ...options, prepared, action: "update" });
	return { ...result, noChange: false };
}

async function loadRevision(options: {
	cwd: string;
	trusted: boolean;
	name: string;
	definitionHash: string;
	compiler: ProjectGraphCompiler;
	sourcePath?: string;
}): Promise<LoadedProjectGraph> {
	if (!options.trusted) throw new Error("Project graph revision access requires an explicitly trusted cwd.");
	if (!DEFINITION_HASH_PATTERN.test(options.definitionHash)) throw new Error("Graph revision requires a valid SHA-256 definitionHash.");
	const paths = revisionPaths(options.cwd, options.name);
	const path = join(paths.revisions, `${options.definitionHash}.json`);
	await assertRegularFile(path);
	const source = await readFile(path, "utf8");
	if (Buffer.byteLength(source, "utf8") > PROJECT_GRAPH_MAX_BYTES) throw new Error(`Project graph exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`);
	const parsed = options.compiler.parse ? options.compiler.parse(source, path) : JSON.parse(source);
	if (!parsed || typeof parsed !== "object" || (parsed as { name?: unknown }).name !== options.name) {
		throw new Error(`Graph revision does not belong to ${options.name}.`);
	}
	const graph = compileRevision(parsed as DeclarativeGraphSpec, options.cwd, options.name, options.compiler, options.sourcePath);
	if (definitionHash(graph.definition) !== options.definitionHash) throw new Error(`Graph revision hash does not match ${options.definitionHash}.`);
	return graph;
}

export async function getProjectGraphRevisionHistory(options: {
	cwd: string;
	trusted: boolean;
	name: string;
	definitionHash?: string;
	compiler: ProjectGraphCompiler;
}): Promise<GraphRevisionInspection> {
	const ensured = await ensureArchived(options.cwd, options.trusted, options.name, options.compiler);
	const history = publicHistory(ensured.history);
	if (!options.definitionHash) return { history };
	const selected = await loadRevision({ ...options, definitionHash: options.definitionHash });
	return {
		history,
		selected: {
			spec: selected.spec,
			diffFromActive: diffGraphSpecs(ensured.graph.spec, selected.spec),
		},
	};
}

export async function rollbackProjectGraphRevision(options: {
	cwd: string;
	trusted: boolean;
	name: string;
	targetDefinitionHash: string;
	expectedDefinitionHash: string;
	compiler: ProjectGraphCompiler;
}): Promise<{ graph: LoadedProjectGraph; history: ProjectGraphHistory; diff: GraphSpecChange[]; noChange: boolean }> {
	const current = await activeProjectGraph(options.cwd, options.trusted, options.name, options.compiler);
	const actualHash = definitionHash(current.definition);
	if (actualHash !== options.expectedDefinitionHash) {
		throw new ProjectGraphRevisionConflictError("Project graph changed since rollback was requested.", actualHash);
	}
	const candidate = await loadRevision({ ...options, definitionHash: options.targetDefinitionHash });
	const prepared: PreparedGraphRevisionChange = {
		current,
		candidate,
		diff: diffGraphSpecs(current.spec, candidate.spec),
		noChange: actualHash === options.targetDefinitionHash,
	};
	if (prepared.noChange) {
		const ensured = await ensureProjectGraphRevision({ ...options, action: "observed" });
		return { graph: current, history: ensured.history, diff: [], noChange: true };
	}
	const result = await activate({ ...options, prepared, action: "rollback" });
	return { ...result, noChange: false };
}

export async function resolveProjectGraphRevision(options: {
	cwd: string;
	trusted: boolean;
	name: string;
	version: string | undefined;
	definitionHash: string | undefined;
	sourcePath: string | undefined;
	compiler: ProjectGraphCompiler;
}): Promise<RegisteredGraphDefinition> {
	if (!options.definitionHash) throw new Error(`Graph checkpoint for ${options.name} has no definition hash.`);
	if (options.sourcePath !== projectGraphSourcePath(options.name) && options.sourcePath !== legacyProjectGraphSourcePath(options.name)) {
		throw new Error(`Graph checkpoint for ${options.name} has an unsupported source path.`);
	}
	const active = await activeProjectGraph(options.cwd, options.trusted, options.name, options.compiler).catch(() => undefined);
	if (active && definitionHash(active.definition) === options.definitionHash) {
		if (active.definition.sourcePath === options.sourcePath) return active.definition;
		return compileRevision(active.spec, options.cwd, options.name, options.compiler, options.sourcePath).definition;
	}
	const revision = await loadRevision({ ...options, definitionHash: options.definitionHash, sourcePath: options.sourcePath });
	if (revision.definition.version !== options.version) {
		throw new Error(`Graph revision version ${revision.definition.version} does not match checkpoint version ${options.version ?? "none"}.`);
	}
	return revision.definition;
}

async function revisionHistoryDeletionTarget(cwd: string, name: string): Promise<{
	paths: RevisionPaths;
	entries: string[];
} | undefined> {
	const paths = revisionPaths(cwd, name);
	const graphReal = await existingRealPath(paths.graph);
	if (!graphReal) return undefined;
	const cwdReal = await realpath(cwd);
	if (!pathIsInside(cwdReal, graphReal) || graphReal !== resolve(cwdReal, relative(cwd, paths.graph))) {
		throw new Error("Graph revision directory must remain inside cwd and must not contain symlinks.");
	}
	const revisionsStat = await lstat(paths.revisions);
	const revisionsReal = await realpath(paths.revisions);
	if (!revisionsStat.isDirectory() || revisionsStat.isSymbolicLink() || revisionsReal !== join(graphReal, "revisions")) {
		throw new Error("Graph revisions path must be a real directory and must not traverse symlinks.");
	}
	const entries: string[] = [];
	for (const entry of await readdir(paths.revisions, { withFileTypes: true })) {
		if (!entry.isFile() || entry.isSymbolicLink() || !DEFINITION_HASH_PATTERN.test(basename(entry.name, ".json"))) {
			throw new Error(`Unexpected graph revision entry prevents deletion: ${entry.name}`);
		}
		const revisionPath = join(paths.revisions, entry.name);
		await assertRegularFile(revisionPath);
		if (await realpath(revisionPath) !== join(revisionsReal, entry.name)) {
			throw new Error(`Graph revision entry must remain inside its revision directory: ${entry.name}`);
		}
		entries.push(entry.name);
	}
	for (const path of [paths.history, paths.transaction]) {
		try {
			await assertRegularFile(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return { paths, entries };
}

export async function assertProjectGraphRevisionHistoryDeletable(cwd: string, name: string): Promise<void> {
	await revisionHistoryDeletionTarget(cwd, name);
}

export async function deleteProjectGraphRevisionHistory(cwd: string, name: string): Promise<void> {
	const target = await revisionHistoryDeletionTarget(cwd, name);
	if (!target) return;
	const { paths, entries } = target;
	for (const entry of entries) await unlink(join(paths.revisions, entry));
	await syncDirectory(paths.revisions);
	for (const path of [paths.history, paths.transaction]) {
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await rmdir(paths.revisions);
	await rmdir(paths.graph);
	await syncDirectory(paths.root);
}
