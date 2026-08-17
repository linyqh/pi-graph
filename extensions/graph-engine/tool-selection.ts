import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Graph nodes address Pi tools by the same names the session registers them
 * under, so the only shape constraint is what a tool name can look like.
 */
export const TOOL_NAME_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";
export const MAX_SUBAGENT_TOOLS = 32;

/**
 * Pi's default active tool set — the same four `AgentSession` starts with when
 * no `--tools` selection is given.
 *
 * This is what the engine assumes when it cannot reach a session (offline graph
 * compilation, the test suite). Pi's own default mode is the honest floor:
 * anything beyond it, including `grep`/`find`/`ls`, is something a session opts
 * into, so a sessionless fallback must not claim it.
 */
export const DEFAULT_GRAPH_TOOLS = ["read", "bash", "edit", "write"] as const;

/**
 * Built-in tools that change the workspace. Custom tools are treated as
 * read-only unless their node declares `mutates: true`: the engine cannot
 * inspect what a registered tool does, and defaulting the other way would lock
 * every read-only graph out of query-style tools.
 */
export const MUTATING_BUILTIN_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

export function isMutatingTool(name: string): boolean {
	return MUTATING_BUILTIN_TOOLS.has(name);
}

type ToolLister = Pick<ExtensionAPI, "getAllTools">;

/**
 * Tool names the current Pi session exposes, falling back to Pi's default tool
 * set when no session is reachable.
 */
export function listAvailableToolNames(api?: ToolLister): string[] {
	if (!api || typeof api.getAllTools !== "function") return [...DEFAULT_GRAPH_TOOLS];
	try {
		const names = api.getAllTools().map((tool) => tool.name).filter((name) => typeof name === "string" && name.length > 0);
		return names.length > 0 ? [...new Set(names)].sort() : [...DEFAULT_GRAPH_TOOLS];
	} catch {
		return [...DEFAULT_GRAPH_TOOLS];
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
