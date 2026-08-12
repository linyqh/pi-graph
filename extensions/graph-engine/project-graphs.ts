import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, open, readFile, realpath, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { compileDeclarativeGraphSpec, parseDeclarativeGraphSpec, serializeDeclarativeGraphSpec } from "./declarative.ts";
import type { RegisteredGraphDefinition } from "./registry.ts";
import {
	AGENT_GRAPH_DIR_NAME,
	LEGACY_PI_DIR_NAME,
	PROJECT_GRAPHS_DIR_NAME,
	projectGraphSourcePath,
	resolveAgentGraphProjectPaths,
} from "./storage.ts";
import type { JsonObject } from "./types.ts";
import { validateGraph } from "./validation.ts";

export { AGENT_GRAPH_DIR_NAME, LEGACY_PI_DIR_NAME, PROJECT_GRAPHS_DIR_NAME, projectGraphSourcePath };
export const PROJECT_GRAPH_MAX_BYTES = 256 * 1024;
const GRAPH_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export type ProjectGraphDiagnosticCode =
	| "untrusted"
	| "missing-directory"
	| "unsafe-directory"
	| "unsafe-file"
	| "file-too-large"
	| "invalid-json"
	| "invalid-spec"
	| "filename-mismatch"
	| "compile-error"
	| "invalid-graph"
	| "duplicate-graph"
	| "write-conflict";

export interface ProjectGraphDiagnostic {
	code: ProjectGraphDiagnosticCode;
	message: string;
	path?: string;
	graphName?: string;
}

export interface DeclarativeGraphSpec extends JsonObject {
	name: string;
}

export interface ProjectGraphCompiler {
	parse?(source: string, path: string): unknown;
	compile(spec: DeclarativeGraphSpec, options: { cwd: string; path: string }): RegisteredGraphDefinition;
	serialize?(spec: DeclarativeGraphSpec): string;
}

export interface LoadProjectGraphsOptions {
	cwd: string;
	trusted: boolean;
	compiler: ProjectGraphCompiler;
}

export interface LoadedProjectGraph {
	definition: RegisteredGraphDefinition;
	spec: DeclarativeGraphSpec;
	path: string;
}

export interface LoadProjectGraphsResult {
	graphs: LoadedProjectGraph[];
	diagnostics: ProjectGraphDiagnostic[];
	directory: string;
}

export interface SaveProjectGraphOptions extends LoadProjectGraphsOptions {
	spec: DeclarativeGraphSpec;
}

export interface SaveProjectGraphResult {
	graph: LoadedProjectGraph;
	path: string;
	diagnostics: ProjectGraphDiagnostic[];
}

export interface DeleteProjectGraphOptions extends LoadProjectGraphsOptions {
	name: string;
}

export interface DeleteProjectGraphResult {
	name: string;
	path: string;
	diagnostics: ProjectGraphDiagnostic[];
}

export interface MigrateLegacyProjectGraphsOptions {
	cwd: string;
	trusted: boolean;
}

export interface MigrateLegacyProjectGraphsResult {
	migrated: Array<{ from: string; to: string }>;
	diagnostics: ProjectGraphDiagnostic[];
	directory: string;
	legacyDirectory: string;
}

export const declarativeProjectGraphCompiler: ProjectGraphCompiler = {
	parse(source) {
		return parseDeclarativeGraphSpec(JSON.parse(source));
	},
	compile(spec) {
		return compileDeclarativeGraphSpec(spec, { sourcePath: projectGraphSourcePath(spec.name) });
	},
	serialize(spec) {
		return `${serializeDeclarativeGraphSpec(spec).json}\n`;
	},
};

function isRecord(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDeclarativeGraphSpec(value: unknown): value is DeclarativeGraphSpec {
	return isRecord(value) && typeof value.name === "string" && GRAPH_NAME_PATTERN.test(value.name);
}

function pathIsInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function existingRealPath(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function assertTrusted(trusted: boolean): Promise<ProjectGraphDiagnostic | undefined> {
	if (trusted) return undefined;
	return {
		code: "untrusted",
		message: "Project graph access requires an explicitly trusted cwd.",
	};
}

function parseSpec(source: string, path: string, compiler: ProjectGraphCompiler): DeclarativeGraphSpec {
	const parsed = compiler.parse ? compiler.parse(source, path) : JSON.parse(source);
	if (!isDeclarativeGraphSpec(parsed)) throw new Error("Project graph spec must be an object with a non-empty name.");
	return parsed;
}

function compileSpec(spec: DeclarativeGraphSpec, options: { cwd: string; path: string }, compiler: ProjectGraphCompiler): RegisteredGraphDefinition {
	const graph = compiler.compile(spec, options);
	const result = validateGraph(graph);
	if (!result.ok) {
		throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
	}
	return graph;
}

function diagnostic(code: ProjectGraphDiagnosticCode, message: string, path?: string, graphName?: string): ProjectGraphDiagnostic {
	return { code, message, path, graphName };
}

export function resolveProjectGraphsDirectory(cwd: string): string {
	return resolveAgentGraphProjectPaths(cwd).graphs;
}

async function loadGraphDirectory(options: LoadProjectGraphsOptions & {
	directory: string;
	expectedRealDirectory: string;
	cwdReal: string;
	graphs: LoadedProjectGraph[];
	diagnostics: ProjectGraphDiagnostic[];
	seen: Set<string>;
}): Promise<void> {
	const directoryReal = await existingRealPath(options.directory);
	if (!directoryReal) return;
	if (!pathIsInside(options.cwdReal, directoryReal)) {
		options.diagnostics.push(diagnostic("unsafe-directory", "Project graph directory must resolve inside cwd.", options.directory));
		return;
	}
	if (directoryReal !== options.expectedRealDirectory) {
		options.diagnostics.push(diagnostic("unsafe-directory", "Project graph directory must not contain symlinked path components.", options.directory));
		return;
	}

	const dirStat = await lstat(options.directory);
	if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
		options.diagnostics.push(diagnostic("unsafe-directory", "Project graph path must be a real directory.", options.directory));
		return;
	}

	const entries = (await readdir(options.directory, { withFileTypes: true }))
		.filter((entry) => extname(entry.name) === ".json")
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));

	for (const entry of entries) {
		const path = join(options.directory, entry);
		const stem = basename(entry, ".json");
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink()) {
				options.diagnostics.push(diagnostic("unsafe-file", "Project graph must be a regular JSON file.", path));
				continue;
			}
			if (stat.size > PROJECT_GRAPH_MAX_BYTES) {
				options.diagnostics.push(diagnostic("file-too-large", `Project graph exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`, path));
				continue;
			}
			const source = await readFile(path, "utf8");
			const spec = parseSpec(source, path, options.compiler);
			if (spec.name !== stem) {
				options.diagnostics.push(diagnostic("filename-mismatch", `Project graph filename must match spec.name (${spec.name}).`, path, spec.name));
				continue;
			}
			if (options.seen.has(spec.name)) {
				options.diagnostics.push(diagnostic("duplicate-graph", `Duplicate project graph name: ${spec.name}`, path, spec.name));
				continue;
			}
			const definition = compileSpec(spec, { cwd: options.cwd, path }, options.compiler);
			if (definition.name !== spec.name) {
				options.diagnostics.push(diagnostic("invalid-graph", `Compiled graph name must match spec.name (${spec.name}).`, path, spec.name));
				continue;
			}
			options.graphs.push({ definition, spec, path });
			options.seen.add(spec.name);
		} catch (error) {
			const message = error instanceof SyntaxError
				? "Project graph contains invalid JSON."
				: error instanceof Error ? error.message : String(error);
			const code: ProjectGraphDiagnosticCode = error instanceof SyntaxError ? "invalid-json" : "compile-error";
			options.diagnostics.push(diagnostic(code, message, path));
		}
	}
}

export async function loadProjectGraphs(options: LoadProjectGraphsOptions): Promise<LoadProjectGraphsResult> {
	const paths = resolveAgentGraphProjectPaths(options.cwd);
	const directory = paths.graphs;
	const trustDiagnostic = await assertTrusted(options.trusted);
	if (trustDiagnostic) return { graphs: [], diagnostics: [trustDiagnostic], directory };

	const diagnostics: ProjectGraphDiagnostic[] = [];
	const cwdReal = await existingRealPath(options.cwd);
	if (!cwdReal) {
		return {
			graphs: [],
			diagnostics: [diagnostic("unsafe-directory", `Project cwd does not exist: ${options.cwd}`, options.cwd)],
			directory,
		};
	}

	const graphs: LoadedProjectGraph[] = [];
	const seen = new Set<string>();
	for (const location of [
		{ directory: paths.graphs, expectedRealDirectory: resolve(cwdReal, AGENT_GRAPH_DIR_NAME, PROJECT_GRAPHS_DIR_NAME) },
		{ directory: paths.legacyGraphs, expectedRealDirectory: resolve(cwdReal, LEGACY_PI_DIR_NAME, PROJECT_GRAPHS_DIR_NAME) },
	]) {
		await loadGraphDirectory({ ...options, ...location, cwdReal, graphs, diagnostics, seen });
	}

	return { graphs, diagnostics, directory };
}

async function assertGraphDirectoryWritable(cwd: string, directory: string): Promise<void> {
	const cwdReal = await realpath(cwd);
	const storagePath = resolve(cwd, AGENT_GRAPH_DIR_NAME);
	const storageReal = await existingRealPath(storagePath);
	if (storageReal && !pathIsInside(cwdReal, storageReal)) {
		throw new Error("Agent graph storage directory must resolve inside cwd.");
	}
	if (storageReal && storageReal !== resolve(cwdReal, AGENT_GRAPH_DIR_NAME)) {
		throw new Error("Agent graph storage directory must not be a symlink.");
	}
	await mkdir(directory, { recursive: true });
	const directoryReal = await realpath(directory);
	if (!pathIsInside(cwdReal, directoryReal)) {
		throw new Error("Project graph directory must resolve inside cwd.");
	}
	if (directoryReal !== resolve(cwdReal, AGENT_GRAPH_DIR_NAME, PROJECT_GRAPHS_DIR_NAME)) {
		throw new Error("Project graph directory must not contain symlinked path components.");
	}
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("Project graph path must be a real directory.");
	}
	await access(directory, constants.W_OK);
}

export async function migrateLegacyProjectGraphs(options: MigrateLegacyProjectGraphsOptions): Promise<MigrateLegacyProjectGraphsResult> {
	const paths = resolveAgentGraphProjectPaths(options.cwd);
	const result: MigrateLegacyProjectGraphsResult = {
		migrated: [],
		diagnostics: [],
		directory: paths.graphs,
		legacyDirectory: paths.legacyGraphs,
	};
	const trustDiagnostic = await assertTrusted(options.trusted);
	if (trustDiagnostic) {
		result.diagnostics.push(trustDiagnostic);
		return result;
	}

	const cwdReal = await existingRealPath(options.cwd);
	if (!cwdReal) {
		result.diagnostics.push(diagnostic("unsafe-directory", `Project cwd does not exist: ${options.cwd}`, options.cwd));
		return result;
	}
	const legacyReal = await existingRealPath(paths.legacyGraphs);
	if (!legacyReal) return result;
	if (legacyReal !== resolve(cwdReal, LEGACY_PI_DIR_NAME, PROJECT_GRAPHS_DIR_NAME)) {
		result.diagnostics.push(diagnostic("unsafe-directory", "Legacy project graph directory must not contain symlinked path components.", paths.legacyGraphs));
		return result;
	}
	const legacyStat = await lstat(paths.legacyGraphs);
	if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) {
		result.diagnostics.push(diagnostic("unsafe-directory", "Legacy project graph path must be a real directory.", paths.legacyGraphs));
		return result;
	}

	const entries = (await readdir(paths.legacyGraphs, { withFileTypes: true }))
		.filter((entry) => extname(entry.name) === ".json")
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
	if (entries.length === 0) return result;
	await assertGraphDirectoryWritable(options.cwd, paths.graphs);

	for (const entry of entries) {
		const from = join(paths.legacyGraphs, entry);
		const to = join(paths.graphs, entry);
		const graphName = basename(entry, ".json");
		const stat = await lstat(from);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			result.diagnostics.push(diagnostic("unsafe-file", "Legacy project graph must be a regular JSON file.", from, graphName));
			continue;
		}
		try {
			await copyFile(from, to, constants.COPYFILE_EXCL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				result.diagnostics.push(diagnostic("write-conflict", `Canonical project graph already exists: ${graphName}`, from, graphName));
				continue;
			}
			throw error;
		}
		try {
			await unlink(from);
			result.migrated.push({ from, to });
		} catch (error) {
			result.diagnostics.push(diagnostic(
				"write-conflict",
				`Copied legacy project graph but could not remove its old file: ${error instanceof Error ? error.message : String(error)}`,
				from,
				graphName,
			));
		}
	}

	try {
		await rmdir(paths.legacyGraphs);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
	}
	return result;
}

export async function saveProjectGraph(options: SaveProjectGraphOptions): Promise<SaveProjectGraphResult> {
	const trustDiagnostic = await assertTrusted(options.trusted);
	if (trustDiagnostic) throw new Error(trustDiagnostic.message);
	if (!isDeclarativeGraphSpec(options.spec)) throw new Error("Project graph spec must include a non-empty name.");

	const paths = resolveAgentGraphProjectPaths(options.cwd);
	const directory = paths.graphs;
	const filename = `${options.spec.name}.json`;
	const path = join(directory, filename);
	const definition = compileSpec(options.spec, { cwd: options.cwd, path }, options.compiler);
	if (definition.name !== options.spec.name) {
		throw new Error(`Compiled graph name must match spec.name (${options.spec.name}).`);
	}

	const serialized = options.compiler.serialize
		? options.compiler.serialize(options.spec)
		: `${JSON.stringify(options.spec, null, "\t")}\n`;
	if (Buffer.byteLength(serialized, "utf8") > PROJECT_GRAPH_MAX_BYTES) {
		throw new Error(`Project graph exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`);
	}
	try {
		await lstat(join(paths.legacyGraphs, filename));
		throw new Error(`Legacy project graph already exists: ${join(paths.legacyGraphs, filename)}. Migrate it before creating a replacement.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	await assertGraphDirectoryWritable(options.cwd, directory);
	const directoryReal = await realpath(directory);
	const resolvedTarget = resolve(directoryReal, filename);
	if (!pathIsInside(directoryReal, resolvedTarget)) {
		throw new Error("Project graph target path must remain inside the graph directory.");
	}

	try {
		const stat = await lstat(resolvedTarget);
		if (stat.isSymbolicLink()) throw new Error("Project graph target must not be a symlink.");
		throw new Error(`Project graph already exists: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (await realpath(directory) !== directoryReal) {
		throw new Error("Project graph directory changed before the exclusive write.");
	}

	const handle = await open(resolvedTarget, "wx");
	try {
		await handle.writeFile(serialized, "utf8");
	} finally {
		await handle.close();
	}

	return {
		graph: {
			definition,
			spec: options.spec,
			path,
		},
		path,
		diagnostics: [],
	};
}

export async function deleteProjectGraph(options: DeleteProjectGraphOptions): Promise<DeleteProjectGraphResult> {
	const trustDiagnostic = await assertTrusted(options.trusted);
	if (trustDiagnostic) throw new Error(trustDiagnostic.message);
	if (!GRAPH_NAME_PATTERN.test(options.name)) throw new Error("Project graph deletion requires a valid graph name.");

	const loaded = await loadProjectGraphs(options);
	const graph = loaded.graphs.find((item) => item.definition.name === options.name);
	if (!graph) throw new Error(`Project graph not found: ${options.name}`);

	const paths = resolveAgentGraphProjectPaths(options.cwd);
	const allowedDirectories = [paths.graphs, paths.legacyGraphs];
	const sourceDirectory = allowedDirectories.find((directory) => graph.path === join(directory, `${options.name}.json`));
	if (!sourceDirectory) throw new Error("Project graph target is outside supported storage directories.");
	const directoryReal = await realpath(sourceDirectory);
	const resolvedTarget = resolve(directoryReal, `${options.name}.json`);
	if (!pathIsInside(directoryReal, resolvedTarget)) {
		throw new Error("Project graph target path must remain inside the graph directory.");
	}
	if (await realpath(sourceDirectory) !== directoryReal) {
		throw new Error("Project graph directory changed before deletion.");
	}

	const stat = await lstat(resolvedTarget);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Project graph target must be a regular file and not a symlink.");
	}
	const targetReal = await realpath(resolvedTarget);
	if (targetReal !== resolvedTarget) {
		throw new Error("Project graph target must not traverse symlinks.");
	}
	await access(sourceDirectory, constants.W_OK);
	await unlink(resolvedTarget);

	return {
		name: options.name,
		path: graph.path,
		diagnostics: loaded.diagnostics,
	};
}
