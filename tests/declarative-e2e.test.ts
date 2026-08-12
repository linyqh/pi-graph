import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compileDeclarativeGraphSpec } from "../extensions/graph-engine/declarative.ts";
import { runGraph } from "../extensions/graph-engine/runtime.ts";
import type { GraphExecutionOutput, GraphExecutionServices } from "../extensions/graph-engine/types.ts";

function pi(): ExtensionAPI {
	return { appendEntry() {} } as unknown as ExtensionAPI;
}

function output(value: unknown, kind: string): GraphExecutionOutput {
	return {
		output: value,
		text: typeof value === "string" ? value : JSON.stringify(value),
		meta: { kind },
	};
}

function context(approved: boolean): ExtensionContext {
	return {
		hasUI: true,
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => approved,
			setStatus() {},
		},
	} as unknown as ExtensionContext;
}

test("a generated read-only graph runs router and parallel branches end to end", async () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "generated-quality-check",
		version: "1.0.0",
		description: "Route into two independent quality checks and summarize them.",
		mutationPolicy: "read-only",
		start: "classify",
		maxSteps: 6,
		nodes: [
			{
				id: "classify",
				type: "prompt",
				prompt: "Classify {{goal}}.",
				parseJson: true,
				outputKey: "decision",
				next: "route_check",
			},
			{
				id: "route_check",
				type: "router",
				path: "data.decision.route",
				cases: [
					{ equals: "inspect", to: "parallel_checks" },
					{ equals: "skip", done: true },
				],
				default: { done: true },
			},
			{
				id: "parallel_checks",
				type: "parallel",
				concurrency: 2,
				next: "summarize",
				children: [
					{ id: "tests_lane", type: "prompt", prompt: "Review tests for {{goal}}." },
					{ id: "code_lane", type: "prompt", prompt: "Review code for {{goal}}." },
				],
			},
			{
				id: "summarize",
				type: "prompt",
				prompt: "Summarize {{data.parallel_checks}}.",
				outputKey: "finalSummary",
			},
		],
	}, { sourcePath: ".pi/graphs/generated-quality-check.json" });

	const services: GraphExecutionServices = {
		async completePrompt(request) {
			if (request.parseJson) return output({ route: "inspect" }, "prompt");
			if (request.prompt.startsWith("Review tests")) return output("tests are covered", "prompt");
			if (request.prompt.startsWith("Review code")) return output("code is clear", "prompt");
			return output("quality summary", "prompt");
		},
		async runSubagent() {
			throw new Error("unexpected subagent");
		},
		async invokeBuiltinTool() {
			throw new Error("unexpected tool");
		},
		truncate(value) {
			return value;
		},
	};

	const result = await runGraph(pi(), graph, {
		goal: "check release quality",
		cwd: "/workspace/generated-read-only",
		services,
	});

	assert.equal(result.status, "completed");
	assert.equal(result.state.data.finalSummary, "quality summary");
	assert.deepEqual(Object.keys(result.state.data.parallel_checks as object), ["tests_lane", "code_lane"]);
	assert.equal(graph.definitionHash?.length, 64);
	assert.equal(Object.values(graph.nodes).some((node) => node.capabilities?.mutatesWorkspace), false);
});

test("a generated graph can route an exhausted failure into a repair prompt", async () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "generated-failure-repair",
		version: "1.0.0",
		description: "Retry invalid output, then explain the failure through an explicit error edge.",
		mutationPolicy: "read-only",
		start: "fragile",
		maxSteps: 3,
		nodes: [
			{
				id: "fragile",
				type: "prompt",
				prompt: "Return structured output for {{goal}}.",
				failure: { maxAttempts: 2, onError: "repair" },
			},
			{
				id: "repair",
				type: "prompt",
				prompt: "Explain this failure: {{data.__graphError.message}}",
				outputKey: "finalSummary",
			},
		],
	});

	const prompts: string[] = [];
	const services: GraphExecutionServices = {
		async completePrompt(request) {
			prompts.push(request.prompt);
			if (request.prompt.startsWith("Return structured")) throw new Error("provider returned invalid JSON");
			return output("repaired explanation", "prompt");
		},
		async runSubagent() {
			throw new Error("unexpected subagent");
		},
		async invokeBuiltinTool() {
			throw new Error("unexpected tool");
		},
		truncate(value) {
			return value;
		},
	};

	const result = await runGraph(pi(), graph, {
		goal: "repair invalid output",
		cwd: "/workspace/generated-failure-repair",
		services,
	});

	assert.equal(result.status, "completed");
	assert.equal(result.output, "repaired explanation");
	assert.equal(prompts.filter((prompt) => prompt.startsWith("Return structured")).length, 2);
	assert.equal(prompts.at(-1), "Explain this failure: provider returned invalid JSON");
	assert.equal(result.state.lastFailure?.handled, true);
	assert.equal(result.projection.edges.find((edge) => edge.label === "error")?.traversedCount, 1);
});

test("a generated mutating graph executes in a trusted project without approval", async () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "generated-direct-write",
		version: "1.0.0",
		description: "Write directly in a trusted project.",
		mutationPolicy: "mutating",
		start: "write_file",
		maxSteps: 1,
		nodes: [{
			id: "write_file",
			type: "tool",
			tool: "write",
			args: { path: "RESULT.md", content: "{{goal}}" },
			outputKey: "finalSummary",
		}],
	});

	let writes = 0;
	const services: GraphExecutionServices = {
		async completePrompt() {
			throw new Error("unexpected prompt");
		},
		async runSubagent() {
			throw new Error("unexpected subagent");
		},
		async invokeBuiltinTool(request) {
			writes += 1;
			assert.deepEqual(request.args, { path: "RESULT.md", content: "ship direct change" });
			return output("written", "tool");
		},
		truncate(value) {
			return value;
		},
	};

	const result = await runGraph(pi(), graph, {
		goal: "ship direct change",
		cwd: "/workspace/generated-direct",
		extensionContext: context(true),
		services,
	});

	assert.equal(result.status, "completed");
	assert.equal(writes, 1);
	assert.deepEqual(result.state.approvals, []);
});

test("a generated mutating graph executes only after its approval node succeeds", async () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "generated-approved-write",
		version: "1.0.0",
		description: "Request approval before writing a requested file.",
		mutationPolicy: "approval-required",
		start: "approve_write",
		maxSteps: 3,
		nodes: [
			{
				id: "approve_write",
				type: "approval",
				title: "Approve write?",
				message: "Write the approved goal: {{goal}}",
				yes: "write_file",
			},
			{
				id: "write_file",
				type: "tool",
				tool: "write",
				args: { path: "RESULT.md", content: "{{goal}}" },
				approvalNodeId: "approve_write",
				outputKey: "finalSummary",
			},
		],
	});

	let writes = 0;
	const services: GraphExecutionServices = {
		async completePrompt() {
			throw new Error("unexpected prompt");
		},
		async runSubagent() {
			throw new Error("unexpected subagent");
		},
		async invokeBuiltinTool(request) {
			writes += 1;
			assert.deepEqual(request.args, { path: "RESULT.md", content: "ship approved change" });
			return output("written", "tool");
		},
		truncate(value) {
			return value;
		},
	};

	const rejected = await runGraph(pi(), graph, {
		goal: "ship approved change",
		cwd: "/workspace/generated-rejected",
		extensionContext: context(false),
		services,
	});
	assert.equal(rejected.status, "completed");
	assert.equal(writes, 0);
	assert.equal(rejected.state.approvals.at(-1)?.approved, false);

	const approved = await runGraph(pi(), graph, {
		goal: "ship approved change",
		cwd: "/workspace/generated-approved",
		extensionContext: context(true),
		services,
	});
	assert.equal(approved.status, "completed");
	assert.equal(writes, 1);
	assert.equal(approved.state.approvals.at(-1)?.approved, true);
});
