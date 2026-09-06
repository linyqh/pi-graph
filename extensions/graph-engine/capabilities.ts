import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveGraphTool } from "./host-bridge.ts";
import { parseAvailableSkills, resolveAssignedSkills, type AssignedSkill } from "./skill-selection.ts";
import { listAvailableToolNames, resolveAssignedTools, TOOL_NAME_PATTERN } from "./tool-selection.ts";

type ToolLister = Pick<ExtensionAPI, "getAllTools">;
const BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export function listGraphToolCapabilities(api?: ToolLister, ctx?: ExtensionContext) {
	const metadata = new Map(api?.getAllTools?.().map((tool) => [tool.name, tool]) ?? []);
	return listAvailableToolNames(api).map((name) => {
		const tool = metadata.get(name);
		const source = tool?.sourceInfo?.path;
		const builtin = tool?.sourceInfo ? tool.sourceInfo.source === "builtin" : BUILTINS.has(name);
		const extensionPath = !builtin && source && isAbsolute(source) && existsSync(source) ? source : undefined;
		return {
			name,
			description: (tool?.description ?? "").slice(0, 240),
			subagent: builtin || extensionPath ? "available" : source ? "unavailable" : "unverified",
			toolNode: BUILTINS.has(name) || !!resolveGraphTool(name, ctx),
			...(extensionPath ? { extensionPath } : {}),
			...(!builtin && !extensionPath ? { reason: "No reloadable extension file; SDK/inline tools need a file-backed child extension." } : {}),
		};
	});
}

/** Reload only the extensions that own assigned tools, including inactive tools. */
export function resolveSubagentExtensions(api: ToolLister | undefined, names: string[]): string[] {
	const catalog = listGraphToolCapabilities(api);
	resolveAssignedTools(catalog.map((tool) => tool.name), names);
	const selected = catalog.filter((tool) => names.includes(tool.name));
	const unavailable = selected.filter((tool) => tool.subagent === "unavailable");
	if (unavailable.length) throw new Error(`Assigned tools cannot load in a child Pi process: ${unavailable.map((tool) => tool.name).join(", ")}. Use graph_capabilities to choose child-loadable tools.`);
	return [...new Set(selected.flatMap((tool) => tool.extensionPath ? [tool.extensionPath] : []))];
}

/** Optional graph-specific dependency declaration; skills never grant tools. */
export function requiredSkillTools(skill: AssignedSkill): string[] {
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(skill.path, "utf8"));
	const declared = frontmatter["graph-required-tools"];
	if (declared === undefined) return ["read"];
	if (!Array.isArray(declared) || !declared.every((name) => typeof name === "string" && new RegExp(TOOL_NAME_PATTERN).test(name))) {
		throw new Error(`Skill ${skill.name} graph-required-tools must be an array of exact tool names.`);
	}
	return [...new Set(["read", ...declared as string[]])];
}

export function validateSkillTools(skills: AssignedSkill[], tools: string[]): void {
	for (const skill of skills) {
		const missing = requiredSkillTools(skill).filter((name) => !tools.includes(name));
		if (missing.length) throw new Error(`Skill ${skill.name} requires assigned tools: ${missing.join(", ")}. Add them explicitly to this subagent's tools; skills do not enable tools.`);
	}
}

export function listGraphSkillCapabilities(systemPrompt: string, registered: Iterable<AssignedSkill>) {
	const entries = [...registered];
	const names = [...new Set([...parseAvailableSkills(systemPrompt), ...entries].map((skill) => skill.name))].sort();
	return resolveAssignedSkills(systemPrompt, names, entries).map((skill) => {
		try {
			return { ...skill, requiredTools: requiredSkillTools(skill) };
		} catch (error) {
			return { ...skill, error: error instanceof Error ? error.message : String(error) };
		}
	});
}
