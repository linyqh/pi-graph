import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	approvalNode,
	parallelNode,
	promptNode,
	routerNode,
	subagentNode,
	toolNode,
} from "../extensions/graph-engine/nodes/index.ts";
import type {
	GraphDefinition,
	GraphExecutionServices,
	GraphNode,
	GraphNodeContext,
	GraphNodeResult,
	GraphState,
} from "../extensions/graph-engine/types.ts";

function state(): GraphState {
	return {
		schemaVersion: 1,
		runId: "run-1",
		graphName: "nodes",
		graphVersion: "1.0.0",
		goal: "goal",
		cwd: "/workspace",
		status: "running",
		currentNode: "node",
		data: { goal: "goal" },
		history: [],
		nodes: {},
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 1,
	};
}

function services(overrides: Partial<GraphExecutionServices> = {}): GraphExecutionServices {
	return {
		async completePrompt() {
			return { output: "prompt", text: "prompt", meta: { kind: "prompt" } };
		},
		async runSubagent() {
			return { output: "subagent", text: "subagent", meta: { kind: "subagent" } };
		},
		async invokeBuiltinTool(request) {
			return { output: request.args, text: "tool", meta: { kind: "tool" } };
		},
		truncate(value) {
			return value;
		},
		...overrides,
	};
}

function context(executionServices: GraphExecutionServices, patch: Partial<GraphNodeContext> = {}): GraphNodeContext {
	const graph: GraphDefinition = {
		name: "nodes",
		version: "1.0.0",
		mutationPolicy: "read-only",
		start: "node",
		nodes: {},
	};
	const ctx: GraphNodeContext = {
		pi: {} as ExtensionAPI,
		graph,
		state: state(),
		cwd: "/workspace",
		services: executionServices,
		emit() {},
		async runChildNode(node, childState) {
			return node.run({ ...ctx, state: childState ?? ctx.state });
		},
		...patch,
	};
	return ctx;
}

test("promptNode and subagentNode use distinct execution services", async () => {
	const calls: string[] = [];
	let subagentRequest: unknown;
	const executionServices = services({
		async completePrompt() {
			calls.push("prompt");
			return { output: "from prompt", text: "from prompt", meta: {} };
		},
		async runSubagent(request) {
			calls.push("subagent");
			subagentRequest = request;
			return { output: "from child", text: "from child", meta: {} };
		},
	});
	const extensionContext = {
		model: { provider: "provider", id: "model" },
	} as unknown as ExtensionContext;
	const ctx = context(executionServices, { extensionContext });

	const prompt = promptNode({ id: "prompt", prompt: "hello", failure: { maxAttempts: 2, onError: "recover_prompt" } });
	const subagent = subagentNode({
		id: "child",
		agentName: "researcher",
		prompt: "inspect",
		tools: ["read"],
		skills: ["code-review"],
		failure: { maxAttempts: 3, onError: "recover_child" },
	});
	assert.deepEqual((await prompt.run(ctx)).data?.prompt, "from prompt");
	assert.deepEqual((await subagent.run(ctx)).data?.child, "from child");
	assert.deepEqual(calls, ["prompt", "subagent"]);
	assert.deepEqual(subagentRequest as Record<string, unknown>, {
		agentName: "researcher",
		prompt: "inspect",
		systemPrompt: undefined,
		provider: "provider",
		model: "model",
		tools: ["read"],
		skills: ["code-review"],
		cwd: "/workspace",
		signal: undefined,
		parseJson: undefined,
	});
	assert.deepEqual(prompt.capabilities?.mutatesWorkspace, false);
	assert.deepEqual(subagent.capabilities?.mutatesWorkspace, false);
	assert.deepEqual(subagent.metadata?.skills, ["code-review"]);
	assert.deepEqual(prompt.failure, { maxAttempts: 2, onError: "recover_prompt" });
	assert.deepEqual(subagent.failure, { maxAttempts: 3, onError: "recover_child" });
});

test("toolNode calls the builtin-tool service and derives mutation metadata", async () => {
	let request: unknown;
	const executionServices = services({
		async invokeBuiltinTool(value) {
			request = value;
			return { output: "ok", text: "ok", meta: {} };
		},
	});
	const read = toolNode({
		id: "read",
		tool: "read",
		args: { path: "README.md" },
		failure: { maxAttempts: 2, onError: "recover_read" },
	});
	const write = toolNode({ id: "write", tool: "write", args: { path: "a", content: "b" }, approvalNodeId: "approve" });
	await read.run(context(executionServices));
	assert.deepEqual(request as Record<string, unknown>, {
		tool: "read",
		args: { path: "README.md" },
		cwd: "/workspace",
		signal: undefined,
	});
	assert.equal(read.capabilities?.mutatesWorkspace, false);
	assert.equal(write.capabilities?.mutatesWorkspace, true);
	assert.equal(write.approvalNodeId, "approve");
	assert.deepEqual(read.failure, { maxAttempts: 2, onError: "recover_read" });
});

test("approvalNode pauses without UI and never records a decline", async () => {
	const approval = approvalNode({ id: "approve", title: "Approve?", message: "Plan", yes: "next" });
	const result = await approval.run(context(services()));
	assert.deepEqual(result.pause, { reason: "approval_ui_unavailable" });
	assert.deepEqual(result.data?.approve, {
		pending: true,
		paused: true,
		reason: "approval_ui_unavailable",
	});
	assert.equal(result.next, undefined);
});

test("router and dynamic next reject undeclared targets", async () => {
	assert.throws(
		() => promptNode({ id: "dynamic", prompt: "x", next: () => "next" }),
		/must declare targets/,
	);
	const router = routerNode({ id: "route", targets: ["allowed"], route: () => "other" });
	await assert.rejects(router.run(context(services())), /undeclared target/);
});

test("node factories reserve __graphError for runtime failures", () => {
	assert.throws(() => promptNode({ id: "prompt", prompt: "x", outputKey: "__graphError" }), /reserved outputKey/);
	assert.throws(() => subagentNode({
		id: "subagent",
		agentName: "subagent",
		tools: ["read"],
		prompt: "x",
		outputKey: "__graphError",
	}), /reserved outputKey/);
	assert.throws(() => toolNode({ id: "tool", tool: "read", args: {}, outputKey: "__graphError" }), /reserved outputKey/);
});

test("parallelNode keeps input order, limits configuration, and propagates abort", async () => {
	const child = (id: string, delay: number): GraphNode => ({
		id,
		type: "test",
		capabilities: { readOnly: true, mutatesWorkspace: false },
		async run() {
			await new Promise((resolve) => setTimeout(resolve, delay));
			return { data: { id } };
		},
	});
	const parallel = parallelNode({
		id: "parallel",
		children: [child("slow", 15), child("fast", 1)],
		concurrency: 2,
	});
	const result = await parallel.run(context(services()));
	assert.deepEqual(Object.keys(result.data?.parallel as object), ["slow", "fast"]);
	assert.equal((result.data?.parallel as { slow: { index: number } }).slow.index, 0);
	assert.throws(() => parallelNode({ id: "too_many", children: new Array(9).fill(child("x", 0)) }), /at most 8/);
	assert.throws(() => parallelNode({ id: "too_wide", children: [child("x", 0)], concurrency: 5 }), /at most 4/);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(parallel.run(context(services(), { signal: controller.signal })), /aborted/);
});

test("parallelNode drains active children before rejecting and does not start queued children", async () => {
	let releaseSibling: (() => void) | undefined;
	const siblingGate = new Promise<void>((resolve) => {
		releaseSibling = resolve;
	});
	const activity: string[] = [];
	const child = (id: string, run: () => Promise<GraphNodeResult>): GraphNode => ({
		id,
		type: "test",
		capabilities: { readOnly: true, mutatesWorkspace: false },
		run,
	});
	const parallel = parallelNode({
		id: "parallel_failure",
		children: [
			child("failure", async () => {
				activity.push("failure:start");
				throw new Error("first child failed");
			}),
			child("active_sibling", async () => {
				activity.push("active_sibling:start");
				await siblingGate;
				activity.push("active_sibling:settled");
				return {};
			}),
			child("queued", async () => {
				activity.push("queued:start");
				return {};
			}),
		],
		concurrency: 2,
	});

	let settled = false;
	const runPromise = parallel.run(context(services()));
	const settlementObserver = runPromise.then(
		() => { settled = true; },
		() => { settled = true; },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.deepEqual(activity, ["failure:start", "active_sibling:start"]);
	assert.equal(settled, false);

	releaseSibling?.();
	await assert.rejects(runPromise, /first child failed/);
	await settlementObserver;
	assert.deepEqual(activity, ["failure:start", "active_sibling:start", "active_sibling:settled"]);

	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(activity, ["failure:start", "active_sibling:start", "active_sibling:settled"]);

	let releaseAbort!: () => void;
	const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
	const abortWins = parallelNode({
		id: "parallel_abort_priority",
		children: [
			child("ordinary_failure", async () => {
				throw new Error("ordinary child failed first");
			}),
			child("aborted_sibling", async () => {
				await abortGate;
				throw new DOMException("cancelled", "AbortError");
			}),
		],
		concurrency: 2,
	});
	const abortRun = abortWins.run(context(services()));
	await new Promise<void>((resolve) => setImmediate(resolve));
	releaseAbort();
	await assert.rejects(abortRun, (error: Error) => error.name === "AbortError");
});
