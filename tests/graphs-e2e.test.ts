import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGraph } from "../extensions/graph-engine/runtime.ts";
import type { GraphExecutionOutput, GraphExecutionServices } from "../extensions/graph-engine/types.ts";
import { researchGraph } from "../graphs/research.ts";

function pi(): ExtensionAPI {
	return { appendEntry() {} } as unknown as ExtensionAPI;
}

function output(value: unknown, kind: string): GraphExecutionOutput {
	return { output: value, text: typeof value === "string" ? value : JSON.stringify(value), meta: { kind } };
}

test("research graph exercises tool, prompt, parallel subagents, router, and synthesis read-only", async () => {
	let promptCalls = 0;
	let active = 0;
	let maxActive = 0;
	const toolNames: string[] = [];
	const services: GraphExecutionServices = {
		async completePrompt() {
			promptCalls += 1;
			return promptCalls === 1
				? output({ laneA: "inspect runtime", laneB: "inspect tests", successCriteria: ["files"] }, "prompt")
				: output("final research synthesis", "prompt");
		},
		async runSubagent(request) {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			assert.deepEqual(request.tools, ["read", "grep", "find", "ls"]);
			assert.deepEqual(request.skills, []);
			return output(`${request.agentName} findings`, "subagent");
		},
		async invokeBuiltinTool(request) {
			toolNames.push(request.tool);
			return output(["extensions", "graphs"], "tool");
		},
		truncate(value) {
			return value;
		},
	};
	const result = await runGraph(pi(), researchGraph, {
		goal: "understand the repository",
		cwd: "/workspace/research",
		services,
	});
	assert.equal(result.status, "completed");
	assert.equal(result.state.data.finalSummary, "final research synthesis");
	assert.deepEqual(toolNames, ["ls"]);
	assert.equal(promptCalls, 2);
	assert.equal(maxActive, 2);
	assert.equal(Object.values(researchGraph.nodes).some((node) => node.capabilities?.mutatesWorkspace), false);
	assert.equal(researchGraph.nodes.parallel_research.children?.some((node) => node.capabilities?.mutatesWorkspace), false);
});
