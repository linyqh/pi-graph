import { acquireExecutionLease } from "./execution-lease.ts";
import {
	closeSync,
	constants,
	fsyncSync,
	fstatSync,
	readFileSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { AGENT_GRAPH_DIR_NAME, PROJECT_RUNS_DIR_NAME, resolveAgentGraphProjectPaths } from "./storage.ts";
import type { GraphRunProjection, GraphRunStore, GraphState } from "./types.ts";

export const AGENT_GRAPH_RUN_KIND = "agent-graph.run";
export const AGENT_GRAPH_RUN_SCHEMA_VERSION = 1;
export const AGENT_GRAPH_RUN_MAX_BYTES = 16 * 1024 * 1024;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface StoredGraphRun {
	kind: typeof AGENT_GRAPH_RUN_KIND;
	schemaVersion: typeof AGENT_GRAPH_RUN_SCHEMA_VERSION;
	runId: string;
	graphName: string;
	status: GraphState["status"];
	currentNode?: string;
	state: GraphState;
	projection?: GraphRunProjection;
}

export interface GraphRunStoreDiagnostic {
	message: string;
	path?: string;
}

export interface LoadGraphRunsResult {
	runs: StoredGraphRun[];
	diagnostics: GraphRunStoreDiagnostic[];
	directory: string;
}

function pathIsInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function existingRealPathSync(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function assertRunId(runId: string): void {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Graph run ID is not safe for project storage: ${runId}`);
}

function ensureRunsDirectoryWritable(cwd: string): string {
	const paths = resolveAgentGraphProjectPaths(cwd);
	const cwdReal = realpathSync(cwd);
	const rootReal = existingRealPathSync(paths.root);
	if (rootReal && (!pathIsInside(cwdReal, rootReal) || rootReal !== resolve(cwdReal, AGENT_GRAPH_DIR_NAME))) {
		throw new Error("Agent graph storage directory must be a real directory inside cwd.");
	}
	mkdirSync(paths.runs, { recursive: true });
	const runsReal = realpathSync(paths.runs);
	if (runsReal !== resolve(cwdReal, AGENT_GRAPH_DIR_NAME, PROJECT_RUNS_DIR_NAME)) {
		throw new Error("Agent graph runs directory must not contain symlinked path components.");
	}
	const stat = lstatSync(paths.runs);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Agent graph runs path must be a real directory.");
	return runsReal;
}

function storedRun(state: GraphState, projection?: GraphRunProjection): StoredGraphRun {
	return {
		kind: AGENT_GRAPH_RUN_KIND,
		schemaVersion: AGENT_GRAPH_RUN_SCHEMA_VERSION,
		runId: state.runId,
		graphName: state.graphName,
		status: state.status,
		currentNode: state.currentNode,
		state,
		...(projection ? { projection } : {}),
	};
}

function parseStoredRun(value: unknown, path: string): StoredGraphRun {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored graph run must be an object.");
	const run = value as Partial<StoredGraphRun>;
	if (run.kind !== AGENT_GRAPH_RUN_KIND || run.schemaVersion !== AGENT_GRAPH_RUN_SCHEMA_VERSION) {
		throw new Error("Stored graph run schema is unsupported.");
	}
	if (!run.state || typeof run.state !== "object" || typeof run.runId !== "string" || run.state.runId !== run.runId) {
		throw new Error("Stored graph run identity is invalid.");
	}
	assertRunId(run.runId);
	if (basename(path, ".json") !== run.runId) throw new Error("Stored graph run filename does not match runId.");
	return run as StoredGraphRun;
}

export class ProjectGraphRunStore implements GraphRunStore {
	readonly cwd: string;
	readonly directory: string;

	constructor(cwd: string) {
		this.cwd = resolve(cwd);
		this.directory = resolveAgentGraphProjectPaths(this.cwd).runs;
	}

	persist(state: GraphState, projection?: GraphRunProjection): void {
		assertRunId(state.runId);
		const directory = ensureRunsDirectoryWritable(this.cwd);
		const target = join(directory, `${state.runId}.json`);
		try {
			const targetStat = lstatSync(target);
			if (!targetStat.isFile() || targetStat.isSymbolicLink() || realpathSync(target) !== target) {
				throw new Error("Stored graph run target must be a regular file and not a symlink.");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const serialized = `${JSON.stringify(storedRun(state, projection), null, "\t")}\n`;
		if (Buffer.byteLength(serialized, "utf8") > AGENT_GRAPH_RUN_MAX_BYTES) {
			throw new Error(`Stored graph run exceeds ${AGENT_GRAPH_RUN_MAX_BYTES} bytes.`);
		}
		const temporary = join(directory, `.${state.runId}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
		const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			try {
				writeFileSync(descriptor, serialized, "utf8");
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			renameSync(temporary, target);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {
				// Preserve the original atomic replacement failure.
			}
			throw error;
		}
	}

	readCheckpoint(runId: string): GraphState | undefined {
		assertRunId(runId);
		const file = join(ensureRunsDirectoryWritable(this.cwd), `${runId}.json`);
		let fd: number;
		try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > AGENT_GRAPH_RUN_MAX_BYTES) throw new Error("Invalid stored graph checkpoint.");
			return parseStoredRun(JSON.parse(readFileSync(fd, "utf8")), file).state;
		} finally { closeSync(fd); }
	}

	acquireExecutionLease() {
		return acquireExecutionLease(ensureRunsDirectoryWritable(this.cwd));
	}

	async load(): Promise<LoadGraphRunsResult> {
		const diagnostics: GraphRunStoreDiagnostic[] = [];
		const directoryReal = await realpath(this.directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!directoryReal) return { runs: [], diagnostics, directory: this.directory };
		const cwdReal = await realpath(this.cwd);
		if (directoryReal !== resolve(cwdReal, AGENT_GRAPH_DIR_NAME, PROJECT_RUNS_DIR_NAME)) {
			return {
				runs: [],
				diagnostics: [{ message: "Agent graph runs directory must not contain symlinked path components.", path: this.directory }],
				directory: this.directory,
			};
		}

		const runs: StoredGraphRun[] = [];
		const entries = (await readdir(this.directory, { withFileTypes: true }))
			.filter((entry) => entry.name.endsWith(".json"))
			.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = join(this.directory, entry.name);
			try {
				const stat = await lstat(path);
				if (!entry.isFile() || !stat.isFile() || stat.isSymbolicLink()) throw new Error("Stored graph run must be a regular JSON file.");
				if (stat.size > AGENT_GRAPH_RUN_MAX_BYTES) throw new Error(`Stored graph run exceeds ${AGENT_GRAPH_RUN_MAX_BYTES} bytes.`);
				runs.push(parseStoredRun(JSON.parse(await readFile(path, "utf8")), path));
			} catch (error) {
				diagnostics.push({ message: error instanceof Error ? error.message : String(error), path });
			}
		}
		runs.sort((left, right) => right.state.updatedAt - left.state.updatedAt);
		return { runs, diagnostics, directory: this.directory };
	}
}

export function createProjectGraphRunStore(cwd: string): ProjectGraphRunStore {
	return new ProjectGraphRunStore(cwd);
}
