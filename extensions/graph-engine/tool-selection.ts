import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Graph nodes address Pi tools by the same names the session registers them
 * under, so the only shape constraint is what a tool name can look like.
 */
export const TOOL_NAME_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";
export const MAX_SUBAGENT_TOOLS = 32;

/**
 * The coding tools the graph engine can construct on its own, without a live
 * session. Every other tool is resolved from the session that is running the
 * graph.
 */
export const BUILTIN_GRAPH_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Built-in tools that change the workspace. Custom tools are treated as
 * read-only unless their node declares `mutates: true`: the engine cannot
 * inspect what a registered tool does, and defaulting the other way would lock
 * every read-only graph out of query-style tools.
 */
export const MUTATING_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

export function isBuiltinGraphTool(name: string): boolean {
	return (BUILTIN_GRAPH_TOOLS as readonly string[]).includes(name);
}

export function isMutatingTool(name: string): boolean {
	return MUTATING_BUILTIN_TOOLS.has(name);
}

type ToolLister = Pick<ExtensionAPI, "getAllTools">;

/**
 * Tool names the current Pi session exposes. Falls back to the built-in coding
 * tools when no session is reachable, which is the case for offline graph
 * compilation and for the test suite.
 */
export function listAvailableToolNames(api?: ToolLister): string[] {
	if (!api || typeof api.getAllTools !== "function") return [...BUILTIN_GRAPH_TOOLS];
	try {
		const names = api.getAllTools().map((tool) => tool.name).filter((name) => typeof name === "string" && name.length > 0);
		return names.length > 0 ? [...new Set(names)].sort() : [...BUILTIN_GRAPH_TOOLS];
	} catch {
		return [...BUILTIN_GRAPH_TOOLS];
	}
}

/**
 * Mirrors resolveAssignedSkills: a graph may only name tools that actually
 * exist right now, and the error names what is available so the caller can
 * correct itself.
 */
export function resolveAssignedTools(available: string[], names: string[]): string[] {
	if (names.length === 0) return [];
	const known = new Set(available);
	const missing = names.filter((name) => !known.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Assigned tools are not available in the current Pi session: ${missing.join(", ")}. Available: ${[...known].sort().join(", ") || "none"}.`,
		);
	}
	return [...names];
}
