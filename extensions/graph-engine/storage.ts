import { resolve } from "node:path";

export const AGENT_GRAPH_DIR_NAME = ".agent-graph";
export const PROJECT_GRAPHS_DIR_NAME = "graphs";
export const PROJECT_RUNS_DIR_NAME = "runs";
export const PROJECT_CATALOG_DIR_NAME = "catalog";
export const LEGACY_PI_DIR_NAME = ".pi";

export interface AgentGraphProjectPaths {
	root: string;
	graphs: string;
	runs: string;
	catalog: string;
	legacyGraphs: string;
}

export function resolveAgentGraphProjectPaths(cwd: string): AgentGraphProjectPaths {
	const root = resolve(cwd, AGENT_GRAPH_DIR_NAME);
	return {
		root,
		graphs: resolve(root, PROJECT_GRAPHS_DIR_NAME),
		runs: resolve(root, PROJECT_RUNS_DIR_NAME),
		catalog: resolve(root, PROJECT_CATALOG_DIR_NAME),
		legacyGraphs: resolve(cwd, LEGACY_PI_DIR_NAME, PROJECT_GRAPHS_DIR_NAME),
	};
}

export function projectGraphSourcePath(name: string): string {
	return `${AGENT_GRAPH_DIR_NAME}/${PROJECT_GRAPHS_DIR_NAME}/${name}.json`;
}

export function legacyProjectGraphSourcePath(name: string): string {
	return `${LEGACY_PI_DIR_NAME}/${PROJECT_GRAPHS_DIR_NAME}/${name}.json`;
}

export function projectGraphSourcePathsEquivalent(left: string | undefined, right: string | undefined): boolean {
	if (left === right) return true;
	if (!left || !right) return false;
	const canonicalPrefix = `${AGENT_GRAPH_DIR_NAME}/${PROJECT_GRAPHS_DIR_NAME}/`;
	const legacyPrefix = `${LEGACY_PI_DIR_NAME}/${PROJECT_GRAPHS_DIR_NAME}/`;
	const canonicalName = left.startsWith(canonicalPrefix) ? left.slice(canonicalPrefix.length) : undefined;
	const legacyName = right.startsWith(legacyPrefix) ? right.slice(legacyPrefix.length) : undefined;
	if (canonicalName && canonicalName === legacyName) return true;
	const reverseCanonicalName = right.startsWith(canonicalPrefix) ? right.slice(canonicalPrefix.length) : undefined;
	const reverseLegacyName = left.startsWith(legacyPrefix) ? left.slice(legacyPrefix.length) : undefined;
	return !!reverseCanonicalName && reverseCanonicalName === reverseLegacyName;
}
