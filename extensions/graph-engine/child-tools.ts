import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Loaded last by runPiPrompt. Pi ignores unknown --tools names, so verify them. */
export default function graphChildTools(pi: ExtensionAPI): void {
	const selection = JSON.parse(process.env.PI_GRAPH_CHILD_SELECTION ?? "null") as { tools: string[]; skills: { name: string; path: string }[] } | null;
	if (!selection) throw new Error("Graph child selection is missing.");
	pi.on("input", () => {
		try {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const missing = selection.tools.filter((name) => !available.has(name));
			if (missing.length) throw new Error(`Child Pi did not load assigned tools: ${missing.join(", ")}.`);
			const missingSkills = selection.skills.filter((skill) => !existsSync(skill.path));
			if (missingSkills.length) throw new Error(`Child Pi cannot read assigned skills: ${missingSkills.map((skill) => skill.name).join(", ")}.`);
			pi.setActiveTools(selection.tools);
			return { action: "continue" as const };
		} catch (error) {
			process.stderr.write(`${JSON.stringify({ type: "graph_child_error", message: error instanceof Error ? error.message : String(error) })}\n`);
			return { action: "handled" as const };
		}
	});
	pi.on("before_agent_start", () => { pi.setActiveTools(selection.tools); });
	pi.on("tool_call", (event) => selection.tools.includes(event.toolName)
		? undefined : { block: true, reason: `Tool ${event.toolName} is not assigned to this graph subagent.` });
}
