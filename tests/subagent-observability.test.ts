import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subagentNode } from "../extensions/graph-engine/nodes/index.ts";
import { buildPiPromptArgs, buildSubagentSystemPrompt } from "../extensions/graph-engine/pi-process.ts";
import { runGraph } from "../extensions/graph-engine/runtime.ts";
import type { GraphDefinition, GraphExecutionServices, GraphSubagentRequest } from "../extensions/graph-engine/types.ts";

function pi(): ExtensionAPI {
	return { appendEntry() {} } as unknown as ExtensionAPI;
}

test("subagent Pi invocation persists a named, addressable session", () => {
	const args = buildPiPromptArgs({
		prompt: "Inspect the project.",
		cwd: "/workspace",
		provider: "laien",
		model: "gpt-5.5",
		tools: ["read", "grep"],
		skills: [],
		sessionId: "019ff01a-dc79-7069-baa9-eca1fecfe7fd",
		sessionName: "Subagent · reviewer",
	});

	assert.deepEqual(args.slice(0, 7), [
		"--mode", "json", "-p",
		"--session-id", "019ff01a-dc79-7069-baa9-eca1fecfe7fd",
		"--name", "Subagent · reviewer",
	]);
	assert.ok(args.includes("--tools"));
	assert.ok(args.includes("read,grep"));
	assert.ok(args.includes("--no-skills"));
	assert.ok(!args.includes("--no-session"));
	assert.match(buildSubagentSystemPrompt("reviewer", []), /isolated persistent pi .* child session/);
});

test("graph projection exposes subagent initialization and retains it after completion", async () => {
	let request: GraphSubagentRequest | undefined;
	const services: GraphExecutionServices = {
		async completePrompt() {
			throw new Error("unexpected prompt");
		},
		async runSubagent(next) {
			request = next;
			return { output: "done", text: "done", meta: { kind: "subagent" } };
		},
		async invokeBuiltinTool() {
			throw new Error("unexpected tool");
		},
		truncate(value) {
			return value;
		},
	};
	const lane = subagentNode({
		id: "review",
		label: "Review Evidence",
		agentName: "reviewer",
		provider: "laien",
		model: "gpt-5.5",
		tools: ["read", "grep"],
		skills: ["research"],
		systemPrompt: "Stay read-only.",
		prompt: "Inspect the project and cite files.",
	});
	const graph: GraphDefinition = {
		name: "observable",
		version: "1.0.0",
		description: "Observe a child agent.",
		start: lane.id,
		mutationPolicy: "read-only",
		nodes: { [lane.id]: lane },
	};

	const result = await runGraph(pi(), graph, { goal: "review", cwd: "/workspace", services });
	const projected = result.projection.nodes[0]?.subagent;

	assert.equal(result.status, "completed");
	assert.match(request?.sessionId ?? "", /^[0-9a-f-]{36}$/);
	assert.equal(projected?.sessionId, request?.sessionId);
	assert.equal(projected?.title, "Review Evidence");
	assert.equal(projected?.model, "laien/gpt-5.5");
	assert.equal(projected?.thinkingLevel, "auto");
	assert.deepEqual(projected?.tools, ["read", "grep"]);
	assert.deepEqual(projected?.skills, ["research"]);
	assert.equal(projected?.prompt, "Inspect the project and cite files.");
	assert.equal(projected?.systemPrompt, "Stay read-only.");
});
