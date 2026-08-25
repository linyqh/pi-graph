import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parallelNode, promptNode } from "../extensions/graph-engine/nodes/index.ts";
import {
	findLatestGraphRuns,
	interruptOrphanedGraphRuns,
	isLegacyGraphState,
	resumeGraph,
	runGraph,
} from "../extensions/graph-engine/runtime.ts";
import { GRAPH_STATE_SCHEMA_VERSION } from "../extensions/graph-engine/types.ts";
import type {
	GraphCheckpointEntry,
	GraphDefinition,
	GraphNode,
	GraphState,
} from "../extensions/graph-engine/types.ts";

function fakePi(entries: GraphCheckpointEntry[] = []): ExtensionAPI {
	return {
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;
}

function readOnlyNode(id: string, run: GraphNode["run"], transitions: string[] = []): GraphNode {
	return {
		id,
		type: "test",
		transitions: transitions.map((to) => ({ to })),
		capabilities: { readOnly: true, mutatesWorkspace: false },
		run,
	};
}

function graphWith(nodes: Record<string, GraphNode>, start = Object.keys(nodes)[0], maxSteps = 8): GraphDefinition {
	return {
		name: "test",
		version: "1.0.0",
		mutationPolicy: "read-only",
		start,
		maxSteps,
		nodes,
	};
}

function trustedContext(trusted = true): ExtensionContext {
	return {
		hasUI: false,
		isProjectTrusted: () => trusted,
	} as unknown as ExtensionContext;
}

function resumableState(graph: GraphDefinition, currentNode: string, status: GraphState["status"] = "failed"): GraphState {
	return {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: "test-run-1",
		graphName: graph.name,
		graphVersion: graph.version,
		graphDefinitionHash: graph.definitionHash,
		graphSourcePath: graph.sourcePath,
		goal: "goal",
		cwd: "/workspace",
		status,
		currentNode,
		data: { goal: "goal", retained: true },
		history: [],
		nodes: Object.fromEntries(Object.keys(graph.nodes).map((id) => [id, { status: "pending" as const }])),
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 2,
	};
}

test("runGraph completes, captures failures, and enforces maxSteps", async () => {
	const success = graphWith({
		start: readOnlyNode("start", async () => ({ data: { finalSummary: "done" }, done: true })),
	});
	const successResult = await runGraph(fakePi(), success, { goal: "goal", cwd: "/success" });
	assert.equal(successResult.status, "completed");
	assert.equal(successResult.summary, "done");
	assert.equal(successResult.state.schemaVersion, GRAPH_STATE_SCHEMA_VERSION);

	const failure = graphWith({
		start: readOnlyNode("start", async () => {
			throw new Error("node failed");
		}),
	});
	const failureResult = await runGraph(fakePi(), failure, { goal: "goal", cwd: "/failure" });
	assert.equal(failureResult.status, "failed");
	assert.match(failureResult.state.error ?? "", /node failed/);

	const loop = graphWith({
		loop: readOnlyNode("loop", async () => ({ next: "loop" }), ["loop"]),
	}, "loop", 2);
	const loopResult = await runGraph(fakePi(), loop, { goal: "goal", cwd: "/loop" });
	assert.equal(loopResult.status, "failed");
	assert.match(loopResult.state.error ?? "", /maxSteps \(2\)/);
});

test("runGraph retries declared read-only node failures within maxSteps", async () => {
	let attempts = 0;
	const start = readOnlyNode("start", async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("temporary model failure");
		return { output: "recovered", done: true };
	});
	start.type = "prompt";
	start.failure = { maxAttempts: 2 };

	const result = await runGraph(fakePi(), graphWith({ start }, "start", 2), {
		goal: "goal",
		cwd: "/retry-success",
	});

	assert.equal(result.status, "completed");
	assert.equal(result.output, "recovered");
	assert.equal(attempts, 2);
	assert.equal(result.state.nodes.start.attempts, 2);
	assert.equal(result.state.nodes.start.maxAttempts, 2);
	assert.equal(result.state.history.filter((event) => event.nodeId === "start" && event.type === "start").length, 2);
	assert.equal(result.state.history.filter((event) => event.nodeId === "start" && event.type === "retry").length, 1);
	assert.equal(result.state.lastFailure, undefined);
});

test("runGraph routes exhausted failures to an explicit repair node", async () => {
	let attempts = 0;
	let repairError: unknown;
	const fragile = readOnlyNode("fragile", async () => {
		attempts += 1;
		throw new Error("invalid response payload");
	});
	fragile.type = "prompt";
	fragile.failure = { maxAttempts: 2, onError: "repair" };
	const repair = readOnlyNode("repair", async (ctx) => {
		repairError = ctx.state.data.__graphError;
		return { output: "repair complete", done: true };
	});

	const result = await runGraph(fakePi(), graphWith({ fragile, repair }, "fragile", 3), {
		goal: "goal",
		cwd: "/error-route",
	});

	assert.equal(result.status, "completed");
	assert.equal(result.output, "repair complete");
	assert.equal(attempts, 2);
	assert.deepEqual(repairError, {
		kind: "node",
		nodeId: "fragile",
		message: "invalid response payload",
		attempt: 2,
		maxAttempts: 2,
		handled: true,
		onError: "repair",
		resumable: false,
		occurredAt: result.state.lastFailure?.occurredAt,
	});
	assert.equal(result.state.lastFailure?.handled, true);
	assert.equal(result.state.nodes.fragile.status, "failed");
	assert.equal(result.state.nodes.repair.status, "completed");
});

test("runGraph does not attribute a failed route checkpoint to an unstarted repair node", async () => {
	let repairCalls = 0;
	let persistCalls = 0;
	const checkpoints: GraphState[] = [];
	const fragile = readOnlyNode("fragile", async () => {
		throw new Error("source failed");
	});
	fragile.type = "prompt";
	fragile.failure = { onError: "repair" };
	const repair = readOnlyNode("repair", async () => {
		repairCalls += 1;
		return { done: true };
	});
	const result = await runGraph(fakePi(), graphWith({ fragile, repair }, "fragile", 2), {
		goal: "goal",
		cwd: "/route-checkpoint-failure",
		runtimeServices: {
			persistCheckpoint(state) {
				persistCalls += 1;
				if (persistCalls === 3) throw new Error("route checkpoint unavailable once");
				checkpoints.push(structuredClone(state));
			},
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.state.lastFailure?.kind, "runtime");
	assert.equal(result.state.lastFailure?.nodeId, "fragile");
	assert.equal(result.state.nodes.repair.status, "pending");
	assert.equal(repairCalls, 0);
	assert.equal(result.state.history.some((event) => event.nodeId === "repair"), false);
	assert.equal(checkpoints.at(-1)?.nodes.repair.status, "pending");
});

test("runGraph exposes structured unhandled node and runtime failures", async () => {
	const fragile = readOnlyNode("fragile", async () => {
		throw new Error("permanent failure");
	});
	fragile.type = "tool";
	const failed = await runGraph(fakePi(), graphWith({ fragile }), {
		goal: "goal",
		cwd: "/structured-failure",
	});

	assert.equal(failed.status, "failed");
	assert.deepEqual(failed.state.lastFailure, {
		kind: "node",
		nodeId: "fragile",
		message: "permanent failure",
		attempt: 1,
		maxAttempts: 1,
		handled: false,
		resumable: true,
		occurredAt: failed.state.lastFailure?.occurredAt,
	});

	let attempts = 0;
	const loopingFailure = readOnlyNode("looping_failure", async () => {
		attempts += 1;
		throw new Error("still failing");
	});
	loopingFailure.type = "prompt";
	loopingFailure.failure = { maxAttempts: 3 };
	const exhausted = await runGraph(fakePi(), graphWith({ looping_failure: loopingFailure }, "looping_failure", 2), {
		goal: "goal",
		cwd: "/retry-max-steps",
	});

	assert.equal(exhausted.status, "failed");
	assert.equal(attempts, 2);
	assert.equal(exhausted.state.lastFailure?.kind, "runtime");
	assert.match(exhausted.state.lastFailure?.message ?? "", /maxSteps \(2\)/);
});

test("runGraph does not confuse ordinary aborted wording with cancellation", async () => {
	let attempts = 0;
	const start = readOnlyNode("start", async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("transaction aborted by deadlock");
		return { output: "retried", done: true };
	});
	start.type = "tool";
	start.failure = { maxAttempts: 2 };

	const result = await runGraph(fakePi(), graphWith({ start }), {
		goal: "goal",
		cwd: "/ordinary-aborted-wording",
	});
	assert.equal(result.status, "completed");
	assert.equal(result.output, "retried");
	assert.equal(attempts, 2);
});

test("runGraph treats an adapter stopReason aborted as cancellation without retry or repair", async () => {
	let promptCalls = 0;
	let repairCalls = 0;
	const start = promptNode({
		id: "start",
		prompt: "cancel",
		failure: { maxAttempts: 2, onError: "repair" },
	});
	const repair = readOnlyNode("repair", async () => {
		repairCalls += 1;
		return { done: true };
	});
	const model = { provider: "test-provider", id: "test-model" };
	const extensionContext = {
		model,
		modelRegistry: {
			find: () => model,
			async complete() {
				promptCalls += 1;
				return {
					content: [{ type: "text", text: "partial" }],
					usage: {},
					stopReason: "aborted",
					errorMessage: "provider cancelled request",
				};
			},
		},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	const result = await runGraph(fakePi(), graphWith({ start, repair }, "start", 3), {
		goal: "goal",
		cwd: "/adapter-aborted",
		extensionContext,
	});

	assert.equal(result.status, "interrupted");
	assert.equal(result.state.lastFailure, undefined);
	assert.equal(result.state.nodes.repair.status, "pending");
	assert.equal(promptCalls, 1);
	assert.equal(repairCalls, 0);
});

test("runGraph never retries or error-routes aborts and mutation authorization errors", async () => {
	let abortAttempts = 0;
	const controller = new AbortController();
	const aborting = readOnlyNode("aborting", async () => {
		abortAttempts += 1;
		controller.abort();
		throw new DOMException("aborted", "AbortError");
	});
	aborting.type = "prompt";
	aborting.failure = { maxAttempts: 3, onError: "repair" };
	const repair = readOnlyNode("repair", async () => ({ done: true }));
	const aborted = await runGraph(fakePi(), graphWith({ aborting, repair }, "aborting", 4), {
		goal: "goal",
		cwd: "/failure-abort",
		signal: controller.signal,
	});
	assert.equal(aborted.status, "interrupted");
	assert.equal(abortAttempts, 1);
	assert.equal(aborted.state.nodes.repair.status, "pending");

	let mutations = 0;
	const mutate: GraphNode = {
		id: "mutate",
		type: "tool",
		failure: { onError: "repair" },
		capabilities: { readOnly: false, mutatesWorkspace: true },
		async run() {
			mutations += 1;
			return { done: true };
		},
	};
	const graph: GraphDefinition = {
		name: "authorization-failure",
		version: "1.0.0",
		mutationPolicy: "mutating",
		start: "mutate",
		maxSteps: 2,
		nodes: { mutate, repair },
	};
	const unauthorized = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/failure-authorization",
		extensionContext: trustedContext(false),
	});
	assert.equal(unauthorized.status, "failed");
	assert.equal(unauthorized.state.lastFailure?.kind, "runtime");
	assert.equal(unauthorized.state.lastFailure?.resumable, false);
	assert.equal(unauthorized.state.nodes.repair.status, "pending");
	assert.equal(mutations, 0);
});

test("runGraph treats undeclared dynamic targets as runtime control failures", async () => {
	let promptCalls = 0;
	const start = promptNode({
		id: "start",
		prompt: "route",
		next: () => "undeclared",
		targets: ["allowed"],
		failure: { maxAttempts: 2, onError: "repair" },
	});
	const allowed = readOnlyNode("allowed", async () => ({ done: true }));
	const repair = readOnlyNode("repair", async () => ({ done: true }));
	const result = await runGraph(fakePi(), graphWith({ start, allowed, repair }, "start", 4), {
		goal: "goal",
		cwd: "/undeclared-dynamic-target",
		services: {
			async completePrompt() {
				promptCalls += 1;
				return { output: "route", text: "route", meta: {} };
			},
			async runSubagent() {
				throw new Error("unexpected subagent");
			},
			async invokeTool() {
				throw new Error("unexpected tool");
			},
			truncate(value) {
				return value;
			},
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.state.lastFailure?.kind, "runtime");
	assert.equal(result.state.lastFailure?.resumable, false);
	assert.equal(result.state.nodes.repair.status, "pending");
	assert.equal(promptCalls, 1);

	let callbackPromptCalls = 0;
	const callbackFailure = promptNode({
		id: "callback_failure",
		prompt: "route",
		next: () => {
			throw new Error("routing callback crashed");
		},
		targets: ["allowed"],
		failure: { maxAttempts: 2, onError: "repair" },
	});
	const callbackResult = await runGraph(fakePi(), graphWith({ callback_failure: callbackFailure, allowed, repair }, "callback_failure", 4), {
		goal: "goal",
		cwd: "/dynamic-target-callback-failure",
		services: {
			async completePrompt() {
				callbackPromptCalls += 1;
				return { output: "route", text: "route", meta: {} };
			},
			async runSubagent() {
				throw new Error("unexpected subagent");
			},
			async invokeTool() {
				throw new Error("unexpected tool");
			},
			truncate(value) {
				return value;
			},
		},
	});

	assert.equal(callbackResult.status, "failed");
	assert.equal(callbackResult.state.lastFailure?.kind, "runtime");
	assert.equal(callbackResult.state.lastFailure?.resumable, false);
	assert.equal(callbackResult.state.nodes.repair.status, "pending");
	assert.equal(callbackPromptCalls, 1);
});

test("runGraph keeps runtime instrumentation failures observational", async () => {
	let promptCalls = 0;
	let repairCalls = 0;
	const start = promptNode({
		id: "start",
		prompt: "start",
		failure: { maxAttempts: 2, onError: "repair" },
	});
	const repair = readOnlyNode("repair", async () => {
		repairCalls += 1;
		return { done: true };
	});
	const result = await runGraph(fakePi(), graphWith({ start, repair }, "start", 3), {
		goal: "goal",
		cwd: "/instrumentation-failure",
		services: {
			async completePrompt() {
				promptCalls += 1;
				return { output: "done", text: "done", meta: {} };
			},
			async runSubagent() {
				throw new Error("unexpected subagent");
			},
			async invokeTool() {
				throw new Error("unexpected tool");
			},
			truncate(value) {
				return value;
			},
		},
		runtimeServices: {
			emitUpdate(_state, message) {
				if (message === "Prompt node start started.") throw new Error("renderer exploded");
			},
		},
	});

	assert.equal(result.status, "completed");
	assert.equal(result.state.lastFailure, undefined);
	assert.equal(promptCalls, 1);
	assert.equal(repairCalls, 0);
});

test("runGraph rejects invalid graphs before writing the first checkpoint", async () => {
	const entries: GraphCheckpointEntry[] = [];
	const invalid = graphWith({ start: readOnlyNode("start", async () => ({ done: true })) });
	invalid.start = "missing";
	await assert.rejects(runGraph(fakePi(entries), invalid, { goal: "goal", cwd: "/invalid" }), /Invalid graph definition/);
	assert.deepEqual(entries, []);
});

test("runGraph converts a transient startup checkpoint failure into a runtime failure", async () => {
	let nodeCalls = 0;
	let persistCalls = 0;
	const persisted: GraphState[] = [];
	const graph = graphWith({
		start: readOnlyNode("start", async () => {
			nodeCalls += 1;
			return { done: true };
		}),
	});
	const result = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/startup-checkpoint-failure",
		runtimeServices: {
			persistCheckpoint(state) {
				persistCalls += 1;
				if (persistCalls === 1) throw new Error("checkpoint unavailable once");
				persisted.push(structuredClone(state));
			},
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.state.lastFailure?.kind, "runtime");
	assert.equal(result.state.lastFailure?.resumable, false);
	assert.match(result.state.error ?? "", /checkpoint unavailable once/);
	assert.equal(nodeCalls, 0);
	assert.equal(persisted.at(-1)?.status, "failed");
});

test("runGraph does not attribute a failed transition checkpoint to an unstarted target", async () => {
	let targetCalls = 0;
	let persistCalls = 0;
	const start = readOnlyNode("start", async () => ({ next: "target" }), ["target"]);
	const target = readOnlyNode("target", async () => {
		targetCalls += 1;
		return { done: true };
	});
	const result = await runGraph(fakePi(), graphWith({ start, target }, "start", 2), {
		goal: "goal",
		cwd: "/transition-checkpoint-failure",
		runtimeServices: {
			persistCheckpoint() {
				persistCalls += 1;
				if (persistCalls === 3) throw new Error("transition checkpoint unavailable once");
			},
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(result.state.lastFailure?.kind, "runtime");
	assert.equal(result.state.lastFailure?.nodeId, "start");
	assert.equal(result.state.nodes.target.status, "pending");
	assert.equal(targetCalls, 0);
	assert.equal(result.state.history.some((event) => event.nodeId === "target"), false);
});

test("runGraph exposes an explicit terminal node output", async () => {
	const graph = graphWith({
		start: readOnlyNode("start", async () => ({
			data: { recommendation: "hold" },
			output: "hold",
			done: true,
		})),
	});
	const result = await runGraph(fakePi(), graph, { goal: "goal", cwd: "/terminal-output" });

	assert.equal(result.status, "completed");
	assert.equal(result.summary, "hold");
	assert.equal(result.output, "hold");
	assert.equal(result.state.finalOutput, "hold");
});

test("runGraph pauses explicitly and aborts as interrupted", async () => {
	const paused = graphWith({
		start: readOnlyNode("start", async () => ({ pause: { reason: "waiting_for_ui" } })),
	});
	const pausedResult = await runGraph(fakePi(), paused, { goal: "goal", cwd: "/paused" });
	assert.equal(pausedResult.status, "paused");
	assert.equal(pausedResult.state.currentNode, "start");
	assert.equal(pausedResult.state.nodes.start.status, "paused");

	const controller = new AbortController();
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => {
		started = resolve;
	});
	const interrupted = graphWith({
		start: readOnlyNode("start", async (ctx) => {
			started();
			await new Promise<void>((_resolve, reject) => {
				ctx.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
			return { done: true };
		}),
	});
	const running = runGraph(fakePi(), interrupted, { goal: "goal", cwd: "/interrupted", signal: controller.signal });
	await startedPromise;
	controller.abort();
	const interruptedResult = await running;
	assert.equal(interruptedResult.status, "interrupted");
	assert.equal(interruptedResult.state.nodes.start.status, "interrupted");
});

test("runGraph projects and persists parallel child lifecycle", async () => {
	let entered = 0;
	let bothEntered!: () => void;
	let release!: () => void;
	const enteredPromise = new Promise<void>((resolve) => { bothEntered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const child = (id: string) => readOnlyNode(id, async () => {
		entered += 1;
		if (entered === 2) bothEntered();
		await gate;
		return { output: id };
	});
	const graph = graphWith({
		parallel: parallelNode({ id: "parallel", children: [child("lane_a"), child("lane_b")], concurrency: 2 }),
	});
	const entries: GraphCheckpointEntry[] = [];
	const updates: Array<Record<string, string>> = [];
	const running = runGraph(fakePi(entries), graph, {
		goal: "goal",
		cwd: "/parallel",
		onUpdate(update) {
			updates.push(Object.fromEntries(update.details.projection.nodes.map((node) => [node.id, node.status])));
		},
	});
	await enteredPromise;
	assert.deepEqual(updates.at(-1), { parallel: "running", lane_a: "running", lane_b: "running" });
	release();
	const result = await running;
	assert.deepEqual(
		Object.fromEntries(result.projection.nodes.map((node) => [node.id, node.status])),
		{ parallel: "completed", lane_a: "completed", lane_b: "completed" },
	);
	const last = entries.at(-1)?.data as { projection?: { progress: { completed: number; total: number } } } | undefined;
	assert.deepEqual(last?.projection?.progress, { completed: 3, total: 3 });
});

test("runGraph publishes a parallel failure only after active children settle", async () => {
	let markSiblingStarted!: () => void;
	let releaseSibling!: () => void;
	const siblingStarted = new Promise<void>((resolve) => { markSiblingStarted = resolve; });
	const siblingGate = new Promise<void>((resolve) => { releaseSibling = resolve; });
	let queuedCalls = 0;
	const failure = readOnlyNode("failure", async () => {
		await siblingStarted;
		throw new Error("parallel lane failed");
	});
	const sibling = readOnlyNode("sibling", async () => {
		markSiblingStarted();
		await siblingGate;
		return { output: "settled" };
	});
	const queued = readOnlyNode("queued", async () => {
		queuedCalls += 1;
		return { output: "must not run" };
	});
	const graph = graphWith({
		parallel: parallelNode({ id: "parallel", children: [failure, sibling, queued], concurrency: 2 }),
	});
	const entries: GraphCheckpointEntry[] = [];
	let updates = 0;
	let settled = false;
	const running = runGraph(fakePi(entries), graph, {
		goal: "goal",
		cwd: "/parallel-failure-drain",
		onUpdate() {
			updates += 1;
		},
	});
	running.then(
		() => { settled = true; },
		() => { settled = true; },
	);
	await siblingStarted;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(settled, false);

	releaseSibling();
	const result = await running;
	assert.equal(result.status, "failed");
	assert.equal(result.state.nodes.failure.status, "failed");
	assert.equal(result.state.nodes.sibling.status, "completed");
	assert.equal(result.state.nodes.queued.status, "pending");
	assert.equal(queuedCalls, 0);

	const entryCount = entries.length;
	const updateCount = updates;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(entries.length, entryCount);
	assert.equal(updates, updateCount);
	assert.deepEqual((entries.at(-1)?.data as { state?: GraphState }).state, result.state);
});

test("runGraph does not publish an unstarted parallel child as running", async () => {
	let childCalls = 0;
	let persistCalls = 0;
	const checkpoints: GraphState[] = [];
	const child = readOnlyNode("child", async () => {
		childCalls += 1;
		return { output: "child" };
	});
	const graph = graphWith({
		parallel: parallelNode({ id: "parallel", children: [child], concurrency: 1 }),
	});
	const result = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/parallel-child-start-checkpoint-failure",
		runtimeServices: {
			persistCheckpoint(state) {
				persistCalls += 1;
				if (persistCalls === 3) throw new Error("child checkpoint unavailable once");
				checkpoints.push(structuredClone(state));
			},
		},
	});

	assert.equal(result.status, "failed");
	assert.equal(childCalls, 0);
	assert.equal(result.state.nodes.child.status, "pending");
	assert.equal(result.state.history.some((event) => event.nodeId === "child" && event.type === "start"), false);
	assert.equal(Object.values(result.state.nodes).some((node) => node.status === "running"), false);
	assert.deepEqual(checkpoints.at(-1), result.state);
});

test("resumeGraph resets and reruns every child after a parallel failure", async () => {
	let siblingCalls = 0;
	let fragileCalls = 0;
	let queuedCalls = 0;
	let failing = true;
	const sibling = readOnlyNode("sibling", async () => {
		siblingCalls += 1;
		return { output: "sibling" };
	});
	const fragile = readOnlyNode("fragile", async () => {
		fragileCalls += 1;
		if (failing) throw new Error("parallel child failed");
		return { output: "fragile" };
	});
	const queued = readOnlyNode("queued", async () => {
		queuedCalls += 1;
		return { output: "queued" };
	});
	const graph = graphWith({
		parallel: parallelNode({ id: "parallel", children: [sibling, fragile, queued], concurrency: 1 }),
	});

	const failed = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/parallel-failure-resume",
	});
	assert.equal(failed.status, "failed");
	assert.equal(failed.state.nodes.sibling.status, "completed");
	assert.equal(failed.state.nodes.fragile.status, "failed");
	assert.equal(failed.state.nodes.queued.status, "pending");

	failing = false;
	const resumed = await resumeGraph(fakePi(), graph, failed.state, {
		cwd: "/parallel-failure-resume",
	});
	assert.equal(resumed.status, "completed");
	assert.equal(resumed.state.resumeCount, 1);
	assert.equal(siblingCalls, 2);
	assert.equal(fragileCalls, 2);
	assert.equal(queuedCalls, 1);
	for (const nodeId of ["parallel", "sibling", "fragile", "queued"]) {
		assert.equal(resumed.state.nodes[nodeId].status, "completed");
		assert.equal(resumed.state.nodes[nodeId].error, undefined);
	}
});

test("resumeGraph preserves state and rejects incompatible checkpoints", async () => {
	let attempts = 0;
	const graph = graphWith({
		start: readOnlyNode("start", async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("retry me");
			return { data: { finalSummary: "resumed" }, done: true };
		}),
	});
	const first = await runGraph(fakePi(), graph, { goal: "goal", input: { retained: true }, cwd: "/workspace" });
	const resumed = await resumeGraph(fakePi(), graph, first.state, { cwd: "/workspace" });
	assert.equal(resumed.status, "completed");
	assert.equal(resumed.state.runId, first.state.runId);
	assert.equal(resumed.state.data.retained, true);
	assert.equal(resumed.state.resumeCount, 1);
	assert.ok(resumed.state.history.length > first.state.history.length);

	await assert.rejects(resumeGraph(fakePi(), graph, { ...first.state, schemaVersion: 0 }, { cwd: "/workspace" }), /legacy/);
	await assert.rejects(resumeGraph(fakePi(), graph, { ...first.state, graphVersion: "0.9.0" }, { cwd: "/workspace" }), /version/);
	const customGraph = { ...graph, definitionHash: "a".repeat(64), sourcePath: ".pi/graphs/test.json" };
	const customState = resumableState(customGraph, "start");
	const migratedSource = await resumeGraph(
		fakePi(),
		{ ...customGraph, sourcePath: ".agent-graph/graphs/test.json" },
		customState,
		{ cwd: "/workspace" },
	);
	assert.equal(migratedSource.status, "completed");
	await assert.rejects(
		resumeGraph(fakePi(), { ...customGraph, definitionHash: "b".repeat(64) }, customState, { cwd: "/workspace" }),
		/definition hash/,
	);
	await assert.rejects(
		resumeGraph(fakePi(), { ...customGraph, sourcePath: ".pi/graphs/other.json" }, customState, { cwd: "/workspace" }),
		/source path/,
	);
	await assert.rejects(resumeGraph(fakePi(), graph, first.state, { cwd: "/other" }), /cwd mismatch/);
	await assert.rejects(resumeGraph(fakePi(), graph, resumed.state, { cwd: "/workspace" }), /completed/);
	await assert.rejects(
		resumeGraph(fakePi(), { ...graph, nodes: {} }, first.state, { cwd: "/workspace" }),
		/Invalid graph definition|no longer exists/,
	);
});

test("resumeGraph starts a fresh failure-policy attempt cycle", async () => {
	let failing = true;
	let calls = 0;
	const start = readOnlyNode("start", async () => {
		calls += 1;
		if (failing) throw new Error("retry cycle failed");
		return { output: "resumed after repair", done: true };
	});
	start.type = "prompt";
	start.failure = { maxAttempts: 2 };
	const graph = graphWith({ start }, "start", 2);

	const failed = await runGraph(fakePi(), graph, { goal: "goal", cwd: "/resume-policy-cycle" });
	assert.equal(failed.status, "failed");
	assert.equal(failed.state.lastFailure?.attempt, 2);
	assert.equal(calls, 2);

	failing = false;
	const resumed = await resumeGraph(fakePi(), graph, failed.state, { cwd: "/resume-policy-cycle" });
	assert.equal(resumed.status, "completed");
	assert.equal(resumed.output, "resumed after repair");
	assert.equal(resumed.state.nodes.start.attempts, 1);
	assert.equal(resumed.state.resumeCount, 1);
	assert.equal(calls, 3);
	assert.equal(
		resumed.state.history.filter((event) => event.nodeId === "start" && event.type === "start").at(-1)?.attempt,
		1,
	);
});

test("mutating nodes require approval, project trust, and resume confirmation", async () => {
	let mutations = 0;
	const approval = readOnlyNode("approve", async () => ({ done: true }));
	approval.type = "approval";
	const mutate: GraphNode = {
		id: "mutate",
		type: "tool",
		transitions: [],
		capabilities: { readOnly: false, mutatesWorkspace: true, requiresApproval: true },
		approvalNodeId: "approve",
		async run() {
			mutations += 1;
			return { done: true };
		},
	};
	const graph: GraphDefinition = {
		name: "mutating",
		version: "1.0.0",
		mutationPolicy: "approval-required",
		start: "approve",
		maxSteps: 4,
		nodes: {
			approve: {
				...approval,
				transitions: [{ to: "mutate" }],
				async run() {
					return { data: { approval: { approved: true } }, next: "mutate" };
				},
			},
			mutate,
		},
	};

	const untrusted = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/untrusted",
		extensionContext: trustedContext(false),
	});
	assert.equal(untrusted.status, "failed");
	assert.equal(mutations, 0);
	assert.match(untrusted.state.error ?? "", /trusted project/);

	const checkpoint = resumableState(graph, "mutate");
	checkpoint.approvals.push({ nodeId: "approve", approved: true, requestedAt: 1, resolvedAt: 1, resumeCount: 0 });
	const noUi = await resumeGraph(fakePi(), graph, checkpoint, {
		cwd: "/workspace",
		extensionContext: trustedContext(true),
		runtimeServices: {
			clearStatus() {
				throw new Error("renderer cleanup failed");
			},
		},
	});
	assert.equal(noUi.status, "paused");
	assert.equal(noUi.state.resumeCount, 0);
	assert.equal(mutations, 0);

	const confirmed = await resumeGraph(fakePi(), graph, checkpoint, {
		cwd: "/workspace",
		extensionContext: trustedContext(true),
		runtimeServices: { confirmResume: async () => true },
	});
	assert.equal(confirmed.status, "completed");
	assert.equal(confirmed.state.runId, checkpoint.runId);
	assert.equal(confirmed.state.resumeCount, 1);
	assert.equal(mutations, 1);
});

test("mutating policy runs unbound nodes directly in trusted projects", async () => {
	let mutations = 0;
	const mutate: GraphNode = {
		id: "mutate",
		type: "tool",
		capabilities: { readOnly: false, mutatesWorkspace: true, requiresApproval: false },
		async run() {
			mutations += 1;
			return { done: true };
		},
	};
	const graph: GraphDefinition = {
		name: "direct-mutation",
		version: "1.0.0",
		mutationPolicy: "mutating",
		start: "mutate",
		maxSteps: 1,
		nodes: { mutate },
	};

	const untrusted = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/untrusted-direct",
		extensionContext: trustedContext(false),
	});
	assert.equal(untrusted.status, "failed");
	assert.equal(mutations, 0);
	assert.match(untrusted.state.error ?? "", /trusted project/);

	const trusted = await runGraph(fakePi(), graph, {
		goal: "goal",
		cwd: "/trusted-direct",
		extensionContext: trustedContext(true),
	});
	assert.equal(trusted.status, "completed");
	assert.equal(mutations, 1);
	assert.deepEqual(trusted.state.approvals, []);
});

test("runGraph rejects concurrent active runs for the same cwd", async () => {
	let release!: () => void;
	let entered!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const graph = graphWith({
		start: readOnlyNode("start", async () => {
			entered();
			await gate;
			return { done: true };
		}),
	});
	const first = runGraph(fakePi(), graph, { goal: "one", cwd: "/same" });
	await enteredPromise;
	await assert.rejects(runGraph(fakePi(), graph, { goal: "two", cwd: "/same" }), /already active/);
	release();
	assert.equal((await first).status, "completed");
});

test("runGraph atomically claims cwd for simultaneous new runs and resumes", async () => {
	let releaseNew!: () => void;
	let enterNew!: () => void;
	const newEntered = new Promise<void>((resolve) => { enterNew = resolve; });
	const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
	const graph = graphWith({
		start: readOnlyNode("start", async () => {
			enterNew();
			await newGate;
			return { done: true };
		}),
	});
	const first = runGraph(fakePi(), graph, { goal: "one", cwd: "/atomic-new" });
	const second = runGraph(fakePi(), graph, { goal: "two", cwd: "/atomic-new" });
	await assert.rejects(second, /already active/);
	await newEntered;
	releaseNew();
	assert.equal((await first).status, "completed");

	let resumeCalls = 0;
	let releaseResume!: () => void;
	let resumeEntered!: () => void;
	const resumeStarted = new Promise<void>((resolve) => { resumeEntered = resolve; });
	const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
	const resumeNode = readOnlyNode("start", async () => {
		resumeCalls += 1;
		resumeEntered();
		await resumeGate;
		return { done: true };
	});
	const resumeDefinition = graphWith({ start: resumeNode });
	const checkpoint = resumableState(resumeDefinition, "start");
	const resumeOne = resumeGraph(fakePi(), resumeDefinition, checkpoint, { cwd: "/workspace" });
	const resumeTwo = resumeGraph(fakePi(), resumeDefinition, checkpoint, { cwd: "/workspace" });
	await assert.rejects(resumeTwo, /already active/);
	await resumeStarted;
	releaseResume();
	assert.equal((await resumeOne).status, "completed");
	assert.equal(resumeCalls, 1);
});

test("checkpoint queries aggregate the newest snapshot per runId", () => {
	const graph = graphWith({ start: readOnlyNode("start", async () => ({ done: true })) });
	const first = resumableState(graph, "start", "failed");
	const completed = { ...first, status: "completed" as const, currentNode: undefined, updatedAt: 5 };
	const second = { ...first, runId: "test-run-2", updatedAt: 4 };
	const entries: GraphCheckpointEntry[] = [
		{ type: "custom", customType: "graph-run", data: { state: first } },
		{ type: "custom", customType: "graph-run", data: { state: second } },
		{ type: "custom", customType: "graph-run", data: { state: completed } },
	];
	const states = findLatestGraphRuns(entries);
	assert.equal(states.length, 2);
	assert.equal(states[0].runId, first.runId);
	assert.equal(states[0].status, "completed");
	assert.equal(isLegacyGraphState(first), false);
	assert.equal(isLegacyGraphState({ ...first, schemaVersion: undefined }), true);

	const clockRollback = { ...completed, status: "failed" as const, currentNode: "start", updatedAt: 1 };
	const rollbackStates = findLatestGraphRuns([
		{ type: "custom", customType: "graph-run", data: { state: completed } },
		{ type: "custom", customType: "graph-run", data: { state: clockRollback } },
	]);
	assert.equal(rollbackStates[0]?.status, "failed");
	assert.equal(rollbackStates[0]?.updatedAt, 1);
});

test("session-start recovery marks orphaned running snapshots interrupted", () => {
	const graph = graphWith({ start: readOnlyNode("start", async () => ({ done: true })) });
	const running = resumableState(graph, "start", "running");
	running.nodes.start = { status: "running", startedAt: 1 };
	const source: GraphCheckpointEntry[] = [{ type: "custom", customType: "graph-run", data: { state: running } }];
	const persisted: GraphCheckpointEntry[] = [];
	const interrupted = interruptOrphanedGraphRuns(fakePi(persisted), source, { cwd: "/workspace" });
	assert.equal(interrupted.length, 1);
	assert.equal(interrupted[0].status, "interrupted");
	assert.equal(interrupted[0].nodes.start.status, "interrupted");
	assert.equal((persisted[0].data as { state: GraphState }).state.status, "interrupted");
});

test("a completed node carries the stop reason and output size its meta reported", async () => {
	const graph = graphWith({
		start: readOnlyNode("start", async () => ({
			data: { startMeta: { stopReason: "stop", usage: { output: 17237 } } },
			done: true,
		})),
	});
	const result = await runGraph(fakePi(), graph, { goal: "goal", cwd: "/workspace" });

	assert.equal(result.state.nodes.start.stopReason, "stop");
	assert.equal(result.state.nodes.start.outputTokens, 17237);
	assert.equal(result.projection.nodes[0].outputTokens, 17237);
});

test("node telemetry is absent rather than invented when a node reports none", async () => {
	const graph = graphWith({
		start: readOnlyNode("start", async () => ({ data: { startMeta: { kind: "tool" } }, done: true })),
	});
	const result = await runGraph(fakePi(), graph, { goal: "goal", cwd: "/workspace" });

	assert.equal(result.state.nodes.start.stopReason, undefined);
	assert.equal(result.state.nodes.start.outputTokens, undefined);
});
