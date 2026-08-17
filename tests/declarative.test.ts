import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DeclarativeGraphError,
	compileDeclarativeGraphSpec,
	parseDeclarativeGraphSpec,
	renderDeclarativeGraphSummary,
	serializeDeclarativeGraphSpec,
} from "../extensions/graph-engine/declarative.ts";
import type { RegisteredGraphDefinition } from "../extensions/graph-engine/registry.ts";
import type { GraphExecutionServices, GraphNodeContext, GraphState } from "../extensions/graph-engine/types.ts";

function validSpec() {
	return {
		schemaVersion: 1,
		name: "demo-flow",
		version: "1.0.0",
		description: "covers every declarative node type",
		mutationPolicy: "approval-required",
		start: "plan_step",
		maxSteps: 16,
		nodes: [
			{
				id: "plan_step",
				type: "prompt",
				prompt: "Goal: {{ goal }} in {{ cwd }}",
				outputKey: "plan",
				next: "scout_step",
			},
			{
				id: "scout_step",
				type: "subagent",
				agentName: "scout",
				tools: ["read", "grep", "find", "ls"],
				skills: ["code-review"],
				prompt: "Plan: {{ data.plan }}",
				outputKey: "findings",
				next: "read_file",
			},
			{
				id: "read_file",
				type: "tool",
				tool: "read",
				args: { path: "{{ data.file.path }}", nested: { exact: "{{ data.file }}" } },
				outputKey: "readResult",
				next: "parallel_tasks",
			},
			{
				id: "parallel_tasks",
				type: "parallel",
				concurrency: 2,
				next: "route_mode",
				children: [
					{
						id: "lane_prompt",
						type: "prompt",
						prompt: "Summarize {{ data.readResult.path }}",
					},
					{
						id: "lane_subagent",
						type: "subagent",
						agentName: "reader",
						tools: [],
						skills: [],
						prompt: "Inspect {{ data.file.path }}",
					},
					{
						id: "lane_tool",
						type: "tool",
						tool: "ls",
						args: { path: "." },
					},
				],
			},
			{
				id: "route_mode",
				type: "router",
				path: "data.mode",
				cases: [
					{ equals: "skip", done: true },
					{ equals: "write", to: "approve_write" },
				],
				default: { to: "finish_step" },
			},
			{
				id: "approve_write",
				type: "approval",
				title: "Approve write?",
				message: "Plan: {{ data.plan }}",
				yes: "write_file",
				no: "finish_step",
			},
			{
				id: "write_file",
				type: "tool",
				tool: "edit",
				args: { path: "README.md", content: "{{ goal }}" },
				outputKey: "writeResult",
				next: "fix_file",
				approvalNodeId: "approve_write",
			},
			{
				id: "fix_file",
				type: "subagent",
				agentName: "fixer",
				tools: ["edit"],
				skills: [],
				prompt: "Fix after {{ data.writeResult.path }}",
				outputKey: "fixResult",
				next: "finish_step",
				approvalNodeId: "approve_write",
			},
			{
				id: "finish_step",
				type: "prompt",
				prompt: "Done: {{ data.findings }}",
				outputKey: "finalSummary",
			},
		],
	};
}

function state(patch: Partial<GraphState> = {}): GraphState {
	return {
		schemaVersion: 1,
		runId: "run-1",
		graphName: "demo-flow",
		graphVersion: "1.0.0",
		goal: "ship feature",
		cwd: "/workspace",
		status: "running",
		currentNode: "node",
		data: {
			file: { path: "README.md", lines: 10 },
			mode: "write",
			...patch.data,
		},
		history: [],
		nodes: {},
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 1,
		...patch,
	};
}

function services(overrides: Partial<GraphExecutionServices> = {}): GraphExecutionServices {
	return {
		async completePrompt(request) {
			return { output: request.prompt, text: request.prompt, meta: { kind: "prompt" } };
		},
		async runSubagent(request) {
			return { output: { agent: request.agentName, prompt: request.prompt, tools: request.tools }, text: request.prompt, meta: { kind: "subagent" } };
		},
		async invokeTool(request) {
			return { output: request.args, text: "tool", meta: { kind: "tool", tool: request.tool } };
		},
		truncate(value) {
			return value;
		},
		...overrides,
	};
}

function context(graph: RegisteredGraphDefinition, executionServices: GraphExecutionServices, currentState = state()): GraphNodeContext {
	const ctx: GraphNodeContext = {
		pi: {} as ExtensionAPI,
		graph,
		state: currentState,
		cwd: "/workspace",
		services: executionServices,
		emit() {},
		async runChildNode(node, childState) {
			return node.run({ ...ctx, state: childState ?? ctx.state });
		},
	};
	return ctx;
}

test("compileDeclarativeGraphSpec covers six node kinds and derives registry metadata", () => {
	const graph = compileDeclarativeGraphSpec(validSpec());

	assert.equal(graph.name, "demo-flow");
	assert.equal(graph.mutationPolicy, "approval-required");
	assert.deepEqual(Object.keys(graph.nodes), [
		"plan_step",
		"scout_step",
		"read_file",
		"parallel_tasks",
		"route_mode",
		"approve_write",
		"write_file",
		"fix_file",
		"finish_step",
	]);
	assert.equal(graph.nodes.plan_step.type, "prompt");
	assert.equal(graph.nodes.scout_step.type, "subagent");
	assert.equal(graph.nodes.read_file.type, "tool");
	assert.equal(graph.nodes.parallel_tasks.type, "parallel");
	assert.equal(graph.nodes.route_mode.type, "router");
	assert.equal(graph.nodes.approve_write.type, "approval");
	assert.equal(graph.nodes.write_file.approvalNodeId, "approve_write");
	assert.equal(graph.nodes.fix_file.approvalNodeId, "approve_write");
	assert.deepEqual(graph.approvalBindings, [
		{
			node: "approve_write",
			capability: "write_file",
			description: "Approval required before write_file mutates the workspace.",
		},
		{
			node: "approve_write",
			capability: "fix_file",
			description: "Approval required before fix_file mutates the workspace.",
		},
	]);
	assert.deepEqual(graph.nodes.route_mode.routerCandidates, ["approve_write", "finish_step"]);
	assert.equal(graph.capabilities.find((capability) => capability.id === "parallel_tasks")?.mutates, false);
});

test("compileDeclarativeGraphSpec preserves top-level failure policies and error transitions", () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "failure-flow",
		version: "1.0.0",
		description: "Recover failed read-only work.",
		mutationPolicy: "read-only",
		start: "draft",
		maxSteps: 8,
		nodes: [
			{
				id: "draft",
				type: "prompt",
				prompt: "Draft {{ goal }}.",
				next: "inspect",
				failure: { maxAttempts: 2, onError: "recover" },
			},
			{
				id: "inspect",
				type: "subagent",
				agentName: "reader",
				tools: ["read"],
				prompt: "Inspect the draft.",
				next: "read_file",
				failure: { maxAttempts: 3 },
			},
			{
				id: "read_file",
				type: "tool",
				tool: "read",
				args: { path: "README.md" },
				failure: { onError: "recover" },
			},
			{ id: "recover", type: "prompt", prompt: "Recover." },
		],
	});

	assert.deepEqual(graph.nodes.draft.failure, { maxAttempts: 2, onError: "recover" });
	assert.deepEqual(graph.nodes.inspect.failure, { maxAttempts: 3 });
	assert.deepEqual(graph.nodes.read_file.failure, { onError: "recover" });
	assert.deepEqual(
		graph.transitions?.filter((transition) => transition.when === "error"),
		[
			{ from: "draft", to: "recover", when: "error" },
			{ from: "read_file", to: "recover", when: "error" },
		],
	);
});

test("compileDeclarativeGraphSpec projects localized transition labels without changing machine ids", () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "localized-flow",
		version: "1.0.0",
		description: "使用中文展示节点和连线。",
		mutationPolicy: "read-only",
		transitionLabels: {
			next: "继续",
			approved: "已批准",
			declined: "已拒绝",
			default: "其他情况",
			error: "失败",
		},
		start: "start_step",
		maxSteps: 8,
		nodes: [
			{
				id: "start_step",
				type: "prompt",
				label: "准备计划",
				prompt: "准备 {{goal}}。",
				next: "approve_plan",
				failure: { onError: "repair_step" },
			},
			{
				id: "approve_plan",
				type: "approval",
				label: "批准计划",
				title: "是否批准？",
				message: "请确认计划。",
				yes: "route_result",
				no: "done_step",
			},
			{
				id: "route_result",
				type: "router",
				label: "判断结果",
				path: "data.status",
				cases: [{ equals: "needs_fix", to: "repair_step", label: "需要修复" }],
				default: { to: "done_step", label: "无需修复" },
			},
			{
				id: "repair_step",
				type: "prompt",
				label: "修复问题",
				prompt: "修复问题。",
				next: "done_step",
			},
			{ id: "done_step", type: "prompt", label: "完成", prompt: "用中文总结。" },
		],
	});

	assert.deepEqual(graph.transitions, [
		{ from: "start_step", to: "approve_plan", when: "next", label: "继续" },
		{ from: "start_step", to: "repair_step", when: "error", label: "失败" },
		{ from: "approve_plan", to: "route_result", when: "approved", label: "已批准" },
		{ from: "approve_plan", to: "done_step", when: "declined", label: "已拒绝" },
		{ from: "route_result", to: "repair_step", when: "data.status equals \"needs_fix\"", label: "需要修复" },
		{ from: "route_result", to: "done_step", when: "default", label: "无需修复" },
		{ from: "repair_step", to: "done_step", when: "next", label: "继续" },
	]);
	assert.deepEqual(Object.keys(graph.nodes), ["start_step", "approve_plan", "route_result", "repair_step", "done_step"]);
	assert.match(renderDeclarativeGraphSummary({
		schemaVersion: 1,
		name: "summary-localized-flow",
		description: "中文摘要。",
		mutationPolicy: "read-only",
		transitionLabels: { next: "继续", approved: "已批准", declined: "已拒绝", default: "其他情况", error: "失败" },
		start: "done_step",
		maxSteps: 1,
		nodes: [{ id: "done_step", type: "prompt", label: "完成", prompt: "完成。" }],
	}), /transitionLabels=.*继续.*已批准.*已拒绝.*其他情况.*失败/);
});

test("compiled templates render safely and preserve exact tool arg placeholder types", async () => {
	const graph = compileDeclarativeGraphSpec(validSpec());
	const executionServices = services();
	const ctx = context(graph, executionServices);

	const prompt = await graph.nodes.plan_step.run(ctx);
	assert.equal(prompt.data?.plan, "Goal: ship feature in /workspace");

	const tool = await graph.nodes.read_file.run({ ...ctx, state: state({ data: { file: { path: "README.md", lines: 10 } } }) });
	assert.deepEqual(tool.data?.readResult, {
		path: "README.md",
		nested: { exact: { path: "README.md", lines: 10 } },
	});

	await assert.rejects(
		graph.nodes.read_file.run({ ...ctx, state: state({ data: {} }) }),
		DeclarativeGraphError,
	);
});

test("router cases are ordered and parallel children summarize by child id", async () => {
	const graph = compileDeclarativeGraphSpec(validSpec());
	const ctx = context(graph, services(), state({ data: { file: { path: "README.md" }, readResult: { path: "README.md" } } }));

	const writeRoute = await graph.nodes.route_mode.run({ ...ctx, state: state({ data: { mode: "write" } }) });
	assert.equal(writeRoute.next, "approve_write");

	const defaultRoute = await graph.nodes.route_mode.run({ ...ctx, state: state({ data: { mode: "read" } }) });
	assert.equal(defaultRoute.next, "finish_step");

	const doneRoute = await graph.nodes.route_mode.run({ ...ctx, state: state({ data: { mode: "skip" } }) });
	assert.equal(doneRoute.done, true);

	const parallel = await graph.nodes.parallel_tasks.run(ctx);
	assert.deepEqual(Object.keys(parallel.data?.parallel_tasks as object), ["lane_prompt", "lane_subagent", "lane_tool"]);
	assert.equal((parallel.data?.parallel_tasks as { lane_prompt: { index: number } }).lane_prompt.index, 0);
	assert.deepEqual(parallel.data?.parallel_tasksMeta, { concurrency: 2, childCount: 3 });
});

test("router may explicitly terminate from every case and default", async () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "terminal-router",
		version: "1.0.0",
		description: "End after inspecting a scalar value.",
		mutationPolicy: "read-only",
		start: "route_done",
		maxSteps: 1,
		nodes: [{
			id: "route_done",
			type: "router",
			path: "data.finished",
			cases: [{ equals: true, done: true }],
			default: { done: true },
		}],
	});
	assert.deepEqual(graph.nodes.route_done.routerCandidates, []);
	const result = await graph.nodes.route_done.run(context(graph, services(), state({ data: { finished: true } })));
	assert.equal(result.done, true);
});

test("parseDeclarativeGraphSpec rejects schema and semantic errors", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_skill", type: "subagent", agentName: "x", tools: ["read"], skills: ["Bad Skill"], prompt: "x" }],
		}),
		/pattern|must match/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "skill_without_read", type: "subagent", agentName: "x", tools: ["bash"], skills: ["code-review"], prompt: "x" }],
		}),
		/assigned skills must include the read tool/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({ ...validSpec(), name: "BadName" }),
		/kebab|pattern|must match/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({ ...validSpec(), extra: true }),
		/must not have additional properties/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({ ...validSpec(), maxSteps: 257 }),
		/<= 256|maximum|less than or equal/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "child_one", type: "subagent", agentName: "x", prompt: "x" }],
		}),
		/tools/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_prompt", type: "prompt", provider: "openai", prompt: "x" }],
		}),
		/provider and model/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_template", type: "prompt", prompt: "{{ data.__proto__.x }}" }],
		}),
		/unsafe path segment/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_template", type: "prompt", prompt: "{{data}}" }],
		}),
		/must be goal, cwd, or data dot path/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_output", type: "prompt", prompt: "x", outputKey: "constructor" }],
		}),
		/prototype-chain output keys/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_output", type: "prompt", prompt: "x", outputKey: "__graphError" }],
		}),
		/reserved for graph failures/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "bad_template", type: "prompt", prompt: "{{ data.missing" }],
		}),
		/malformed placeholder/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [
				{ id: "approve_other", type: "approval", title: "Approve?", message: "x", yes: "finish_step" },
				{ id: "write_file", type: "tool", tool: "write", args: { path: "x", content: "y" } },
				{ id: "finish_step", type: "prompt", prompt: "done" },
			],
		}),
		/explicitly declare approvalNodeId/,
	);
});

test("parseDeclarativeGraphSpec validates failure policy values and targets", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "fragile",
			nodes: [{ id: "fragile", type: "prompt", prompt: "x", failure: {} }],
		}),
		/at least maxAttempts or onError/,
	);
	for (const maxAttempts of [0, 1.5, 4]) {
		assert.throws(
			() => parseDeclarativeGraphSpec({
				...validSpec(),
				start: "fragile",
				nodes: [{ id: "fragile", type: "prompt", prompt: "x", failure: { maxAttempts } }],
			}),
			/integer|minimum|maximum|>= 1|<= 3/,
		);
	}
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "fragile",
			nodes: [{ id: "fragile", type: "tool", tool: "read", args: {}, failure: { onError: "missing" } }],
		}),
		/unknown onError target/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			mutationPolicy: "mutating",
			start: "write_file",
			nodes: [{ id: "write_file", type: "tool", tool: "write", args: {}, failure: { maxAttempts: 2 } }],
		}),
		/automatic retries require a read-only node/,
	);
});

test("parseDeclarativeGraphSpec rejects ambiguous and mutating cyclic failure routes", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "fragile",
			nodes: [
				{ id: "fragile", type: "prompt", prompt: "x", next: "repair", failure: { onError: "repair" } },
				{ id: "repair", type: "prompt", prompt: "repair" },
			],
		}),
		(error: unknown) => error instanceof DeclarativeGraphError && /duplicate the normal next target/.test(error.message),
	);

	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			mutationPolicy: "mutating",
			start: "mutate",
			nodes: [
				{ id: "mutate", type: "tool", tool: "write", args: { path: "x", content: "x" }, failure: { onError: "repair" } },
				{ id: "repair", type: "prompt", prompt: "repair", next: "mutate" },
			],
		}),
		(error: unknown) => error instanceof DeclarativeGraphError && /must not lead back to the mutating node/.test(error.message),
	);
});

test("declarative failure policies are rejected outside top-level executable nodes", () => {
	const invalidNodes = [
		{ id: "approve", type: "approval", title: "Approve?", message: "x", yes: "finish", failure: { maxAttempts: 1 } },
		{ id: "route", type: "router", path: "data.mode", cases: [{ equals: "x", done: true }], default: { done: true }, failure: { maxAttempts: 1 } },
		{ id: "lanes", type: "parallel", children: [{ id: "child", type: "prompt", prompt: "x" }], failure: { maxAttempts: 1 } },
	] as const;
	for (const invalidNode of invalidNodes) {
		assert.throws(
			() => parseDeclarativeGraphSpec({
				...validSpec(),
				start: invalidNode.id,
				nodes: [invalidNode, { id: "finish", type: "prompt", prompt: "done" }],
			}),
			/additional properties/,
		);
	}
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "lanes",
			nodes: [{
				id: "lanes",
				type: "parallel",
				children: [{ id: "child", type: "prompt", prompt: "x", failure: { maxAttempts: 2 } }],
			}],
		}),
		/additional properties/,
	);
});

test("parseDeclarativeGraphSpec applies version defaults and validates graph edges", () => {
	const { version: _version, ...withoutVersion } = validSpec();
	assert.equal(parseDeclarativeGraphSpec(withoutVersion).version, "1.0.0");

	assert.throws(
		() => parseDeclarativeGraphSpec({ ...validSpec(), start: "missing_node" }),
		/unknown start node/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "start_node", type: "prompt", prompt: "x", next: "missing_node" }],
			start: "start_node",
		}),
		/unknown next node/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "route_node",
			nodes: [{
				id: "route_node",
				type: "router",
				path: "data.constructor.value",
				cases: [{ equals: true, done: true }],
				default: { done: true },
			}],
		}),
		/unsafe path segment/,
	);
});

test("parseDeclarativeGraphSpec enforces UTF-8 template bytes and the global node limit", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "large_prompt",
			nodes: [{ id: "large_prompt", type: "prompt", prompt: "界".repeat(11_000) }],
		}),
		/at most 32768 bytes/,
	);

	const children = new Array(8).fill(undefined).map((_, index) => ({
		id: `lane_${index}`,
		type: "prompt",
		prompt: "x",
	}));
	const extraNodes = new Array(56).fill(undefined).map((_, index) => ({
		id: `step_${index}`,
		type: "prompt",
		prompt: "x",
	}));
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "parallel_start",
			nodes: [{ id: "parallel_start", type: "parallel", children }, ...extraNodes],
		}),
		/at most 64 nodes/,
	);
});

test("parseDeclarativeGraphSpec enforces mutation policy and approvalNodeId contract", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			mutationPolicy: "read-only",
		}),
		/read-only mutationPolicy/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [
				{ id: "read_file", type: "tool", tool: "read", args: { path: "README.md" }, approvalNodeId: "approve_write" },
				{ id: "approve_write", type: "approval", title: "Approve?", message: "x", yes: "finish_step" },
				{ id: "finish_step", type: "prompt", prompt: "done" },
			],
		}),
		/read-only nodes must not declare approvalNodeId/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [
				{ id: "approve_write", type: "approval", title: "Approve?", message: "x", yes: "write_file" },
				{ id: "write_file", type: "tool", tool: "write", args: { path: "x", content: "y" }, approvalNodeId: "missing_approval" },
			],
		}),
		/unknown approval node/,
	);
});

test("mutating policy allows trusted mutation without an approval binding", () => {
	const graph = compileDeclarativeGraphSpec({
		schemaVersion: 1,
		name: "direct-write",
		version: "1.0.0",
		description: "Write directly in a trusted project.",
		mutationPolicy: "mutating",
		start: "write_file",
		maxSteps: 1,
		nodes: [{ id: "write_file", type: "tool", tool: "write", args: { path: "RESULT.md", content: "done" } }],
	});

	assert.equal(graph.nodes.write_file.approvalNodeId, undefined);
	assert.equal(graph.nodes.write_file.capabilities?.requiresApproval, false);
	assert.deepEqual(graph.approvalBindings, []);
});

test("declarative summary exposes each subagent tool allowlist", () => {
	const summary = renderDeclarativeGraphSummary({
		schemaVersion: 1,
		name: "implementation-flow",
		version: "1.0.0",
		description: "Implement with Pi's default coding tools.",
		mutationPolicy: "mutating",
		start: "implement",
		maxSteps: 1,
		nodes: [{
			id: "implement",
			type: "subagent",
			agentName: "implementer",
			tools: ["read", "bash", "edit", "write", "grep"],
			skills: ["code-review"],
			prompt: "Implement {{goal}}.",
			failure: { maxAttempts: 1 },
		}],
	});

	assert.match(summary, /subagentTools=implement:\[read,bash,edit,write,grep\]/);
	assert.match(summary, /subagentSkills=implement:\[code-review\]/);
	assert.match(summary, /failurePolicies=implement:\[maxAttempts=1,onError=none\]/);
});

test("custom session tools are accepted and stay read-only until a node declares otherwise", () => {
	const spec = {
		...validSpec(),
		mutationPolicy: "read-only",
		start: "pull",
		nodes: [
			{
				id: "pull",
				type: "tool",
				tool: "fpa_query",
				args: { sql: "select 1" },
				next: "analyse",
			},
			{
				id: "analyse",
				type: "subagent",
				agentName: "analyst",
				tools: ["read", "fpa_query", "fpa_calc"],
				skills: [],
				prompt: "Analyse {{data.pull}}.",
			},
		],
	};

	const graph = compileDeclarativeGraphSpec(spec);
	assert.equal(graph.nodes.pull.capabilities?.mutatesWorkspace, false);
	assert.equal(graph.nodes.analyse.capabilities?.mutatesWorkspace, false);
	assert.deepEqual(graph.capabilities?.find((capability) => capability.id === "analyse")?.tools, ["fpa_calc", "fpa_query", "read"]);
});

test("a node may declare that a custom tool mutates, and then obeys the mutating rules", () => {
	const mutatingNode = {
		id: "publish",
		type: "tool",
		tool: "fpa_write_back",
		args: { table: "forecast" },
		mutates: true,
	};

	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			mutationPolicy: "read-only",
			start: "publish",
			nodes: [mutatingNode],
		}),
		/read-only mutationPolicy cannot contain mutating tool or subagent nodes/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{ id: "fan_out", type: "parallel", children: [{ ...mutatingNode }] }],
		}),
		/read-only/,
	);

	const graph = compileDeclarativeGraphSpec({
		...validSpec(),
		mutationPolicy: "mutating",
		start: "publish",
		nodes: [mutatingNode],
	});
	assert.equal(graph.nodes.publish.capabilities?.mutatesWorkspace, true);
	assert.equal(graph.nodes.publish.capabilities?.usesShell, false);
});

test("declarative tool names must still look like tool names", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			start: "bad_tool",
			nodes: [{ id: "bad_tool", type: "tool", tool: "not a tool name", args: {} }],
		}),
		/pattern|must match/,
	);
});

test("parallel validation rejects mutating children and excessive fan-out", () => {
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{
				id: "bad_parallel",
				type: "parallel",
				children: [{ id: "mutating_child", type: "tool", tool: "write", args: { path: "x", content: "y" } }],
			}],
		}),
		/read-only/,
	);
	assert.throws(
		() => parseDeclarativeGraphSpec({
			...validSpec(),
			nodes: [{
				id: "bad_parallel",
				type: "parallel",
				concurrency: 5,
				children: new Array(9).fill(undefined).map((_, index) => ({
					id: `child_${index}`,
					type: "prompt",
					prompt: "x",
				})),
			}],
		}),
		/required properties|additional properties|maximum|maxItems|at most/,
	);
});

test("serializeDeclarativeGraphSpec canonicalizes input and emits stable SHA-256", () => {
	const left = serializeDeclarativeGraphSpec(validSpec());
	const reordered = {
		nodes: validSpec().nodes,
		maxSteps: 16,
		start: "plan_step",
		mutationPolicy: "approval-required",
		description: "covers every declarative node type",
		version: "1.0.0",
		name: "demo-flow",
		schemaVersion: 1,
	};
	const right = serializeDeclarativeGraphSpec(reordered);

	assert.equal(left.json, right.json);
	assert.equal(left.sha256, right.sha256);
	assert.match(left.sha256, /^[a-f0-9]{64}$/);
	assert.match(renderDeclarativeGraphSummary(validSpec()), new RegExp(`sha256=${left.sha256}`));
});

test("compileDeclarativeGraphSpec writes source identity only when sourcePath is provided", () => {
	const serialized = serializeDeclarativeGraphSpec(validSpec());
	const unsourced = compileDeclarativeGraphSpec(validSpec());
	const sourced = compileDeclarativeGraphSpec(validSpec(), { sourcePath: ".pi/graphs/demo-flow.json" });

	assert.equal(unsourced.definitionHash, undefined);
	assert.equal(unsourced.sourcePath, undefined);
	assert.equal(sourced.definitionHash, serialized.sha256);
	assert.equal(sourced.sourcePath, ".pi/graphs/demo-flow.json");
});
