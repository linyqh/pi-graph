import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { compileDeclarativeGraphSpec } from "../extensions/graph-engine/declarative.ts";
import { resumeGraph, runGraph } from "../extensions/graph-engine/runtime.ts";
import type { GraphExecutionServices, GraphState } from "../extensions/graph-engine/types.ts";
import { createGraphExecutionServices } from "../extensions/graph-engine/services.ts";
import { GraphExecutionError } from "../extensions/graph-engine/execution-policy.ts";

const pi = { appendEntry() {} } as unknown as ExtensionAPI;
function specification(schemaVersion = 2) {
	return { schemaVersion, name: "durable-test", version: "1.0.0", description: "Recovery fixture",
		mutationPolicy: "read-only", start: "scenarios", maxSteps: 8,
		nodes: [{ id: "scenarios", type: "parallel", concurrency: 3, children:
			["efficiency", "growth", "risk"].map((id) => ({ id, type: "prompt", prompt: id })) }] };
}
function services(call: (prompt: string) => Promise<unknown>): GraphExecutionServices {
	return {
		async completePrompt(request) { const output = await call(request.prompt); return { output, text: JSON.stringify(output), meta: {} }; },
		async runSubagent() { throw new Error("Unexpected subagent"); },
		async invokeTool() { throw new Error("Unexpected tool"); },
		truncate: (value) => value,
	};
}

test("v2 persists successful siblings and resumes only the failed task", async () => {
	const graph = compileDeclarativeGraphSpec(specification());
	const calls: Record<string, number> = {};
	let overloaded = true;
	const execution = services(async (name) => {
		calls[name] = (calls[name] ?? 0) + 1;
		if (name === "efficiency" && overloaded) throw new Error("Our servers are currently overloaded. Please try again later.");
		return { scenario: name };
	});
	const checkpoints: GraphState[] = [];
	const failed = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-recovery", services: execution,
		runtimeServices: { persistCheckpoint: (state) => checkpoints.push(structuredClone(state)) } });
	assert.equal(failed.status, "failed");
	assert.equal(failed.state.schemaVersion, 2);
	assert.equal(failed.state.nodes.growth.status, "completed");
	overloaded = false;
	// Resume the serialized checkpoint, not any in-memory promise or child session.
	const checkpoint = JSON.parse(JSON.stringify(checkpoints.at(-1))) as GraphState;
	const resumed = await resumeGraph(pi, graph, checkpoint, { cwd: "/durable-recovery", services: execution });
	assert.equal(resumed.status, "completed");
	assert.deepEqual(calls, { efficiency: 2, growth: 1, risk: 1 });
	assert.deepEqual((resumed.state.data.scenarios as any).growth.result.growth, { scenario: "growth" });
});

test("v2 retries a transient parallel failure without rerunning successful siblings", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].failure = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 5 };
	const graph = compileDeclarativeGraphSpec(spec);
	const calls: Record<string, number> = {};
	const result = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-retry", services: services(async (name) => {
		calls[name] = (calls[name] ?? 0) + 1;
		if (name === "efficiency" && calls[name] < 3) throw new GraphExecutionError("Our servers are currently overloaded. Please try again later.", "transient");
		return name;
	}) });
	assert.equal(result.status, "completed", result.state.error);
	assert.deepEqual(calls, { efficiency: 3, growth: 1, risk: 1 });
	assert.equal(result.state.history.filter((entry) => entry.nodeId === "efficiency" && entry.type === "retry").length, 2);
});

test("v2 output validation repairs only the invalid result and records feedback", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].validation = { schema: { type: "object", required: ["budget"], properties: { budget: { type: "number" } }, additionalProperties: false }, maxCorrections: 2 };
	const prompts: string[] = [];
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-output", services: services(async (prompt) => {
		prompts.push(prompt);
		if (prompt === "efficiency") return { budget: "wrong" };
		if (prompt.startsWith("efficiency")) return { budget: 100 };
		return prompt;
	}) });
	assert.equal(result.status, "completed", result.state.error);
	assert.equal(prompts.filter((prompt) => prompt === "growth").length, 1);
	assert.equal(prompts.filter((prompt) => prompt.startsWith("efficiency")).length, 2);
	assert.match(prompts.at(-1)!, /budget/);
});

test("v2 cumulative invocation budget survives resume", async () => {
	const spec: any = specification();
	spec.budget = { maxInvocations: 3 };
	let calls = 0;
	const execution = services(async () => { calls++; throw new Error("failure"); });
	const graph = compileDeclarativeGraphSpec(spec);
	const first = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-budget", services: execution });
	assert.equal(calls, 3);
	const resumed = await resumeGraph(pi, graph, first.state, { cwd: "/durable-budget", services: execution });
	assert.equal(resumed.status, "failed");
	assert.match(resumed.state.error!, /budget/i);
	assert.equal(calls, 3);
});

test("v2 cannot enable output repair on mutating nodes or v1 graphs", () => {
	const spec: any = specification(1);
	spec.nodes[0].children[0].validation = { schema: { type: "number" } };
	assert.throws(() => compileDeclarativeGraphSpec(spec), /schemaVersion 2|v2/);
	spec.schemaVersion = 2;
	spec.mutationPolicy = "mutating";
	spec.start = "write";
	spec.nodes = [{ id: "write", type: "subagent", agentName: "writer", tools: ["write"], prompt: "write", validation: { schema: { type: "number" } } }];
	assert.throws(() => compileDeclarativeGraphSpec(spec), /read-only/);
});

test("v2 rejects corrupt saved results and incompatible execution versions", async () => {
	const graph = compileDeclarativeGraphSpec(specification());
	const execution = services(async (name) => { if (name === "efficiency") throw new Error("failure"); return name; });
	const failed = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-integrity", services: execution });
	const corrupt = structuredClone(failed.state);
	corrupt.tasks!.growth.result!.output = "tampered";
	const resumed = await resumeGraph(pi, graph, corrupt, { cwd: "/durable-integrity", services: execution });
	assert.equal(resumed.status, "failed");
	assert.match(resumed.state.error!, /Corrupt saved result/);
	await assert.rejects(resumeGraph(pi, compileDeclarativeGraphSpec(specification(1)), failed.state, { cwd: "/durable-integrity", services: execution }), /semantics/);
});

test("v2 changed inputs invalidate saved siblings", async () => {
	const graph = compileDeclarativeGraphSpec(specification());
	let fail = true;
	const calls: string[] = [];
	const execution = services(async (name) => { calls.push(name); if (name === "efficiency" && fail) throw new Error("failure"); return name; });
	const first = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-input", services: execution });
	first.state.data.newEvidence = "revision2";
	fail = false;
	const resumed = await resumeGraph(pi, graph, first.state, { cwd: "/durable-input", services: execution });
	assert.equal(resumed.status, "completed");
	assert.equal(calls.filter((name) => name === "growth").length, 2);
});

test("v2 business re-entry starts a new batch instead of reusing the previous round", async () => {
	const spec: any = specification();
	spec.nodes[0].next = "judge";
	spec.nodes.push({ id: "judge", type: "prompt", prompt: "judge", next: "route", outputKey: "verdict" });
	spec.nodes.push({ id: "route", type: "router", path: "data.verdict", cases: [{ equals: "again", to: "scenarios" }], default: { done: true } });
	let rounds = 0;
	let growth = 0;
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-round", services: services(async (name) => {
		if (name === "judge") return ++rounds === 1 ? "again" : "done";
		if (name === "growth") growth++;
		return name;
	}) });
	assert.equal(result.status, "completed", result.state.error);
	assert.equal(growth, 2);
});

test("v2 never commits success if the result checkpoint cannot be persisted", async () => {
	const graph = compileDeclarativeGraphSpec(specification());
	let rejected = false;
	const result = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-disk", services: services(async (name) => name),
		runtimeServices: { persistCheckpoint(state) {
			if (!rejected && state.nodes.growth.status === "completed") { rejected = true; throw new Error("disk full"); }
		} } });
	assert.equal(result.status, "failed");
	assert.equal(result.state.nodes.growth.status, "failed");
	assert.equal(result.state.tasks!.growth.result, undefined);
});

test("v2 unknown and business errors are not retried", async () => {
	for (const error of [new Error("permission denied"), new GraphExecutionError("Source receipt expired; rate limit exceeded in unrelated diagnostic", "business")]) {
		const spec: any = specification();
		spec.nodes[0].children[0].failure = { maxAttempts: 3, initialDelayMs: 1 };
		let calls = 0;
		const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-fatal", services: services(async (name) => {
			if (name === "efficiency") { calls++; throw error; } return name;
		}) });
		assert.equal(result.status, "failed");
		assert.equal(calls, 1);
	}
});

test("v2 repeated invalid output stops without resetting correction count on resume", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].validation = { schema: { type: "number" }, maxCorrections: 2 };
	let calls = 0;
	const execution = services(async (name) => { if (name.startsWith("efficiency")) calls++; return "invalid"; });
	const graph = compileDeclarativeGraphSpec(spec);
	const first = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-stalled", services: execution });
	assert.equal(first.status, "failed");
	assert.equal(calls, 2);
	assert.equal(first.state.tasks!.efficiency.corrections, 2);
	const resumed = await resumeGraph(pi, graph, first.state, { cwd: "/durable-stalled", services: execution });
	assert.equal(resumed.status, "failed");
	assert.equal(calls, 3);
});

test("v2 top-level output validation uses the same policy as parallel tasks", async () => {
	const spec: any = specification();
	spec.start = "answer";
	spec.nodes = [{ id: "answer", type: "prompt", prompt: "answer", validation: { schema: { type: "number" } } }];
	let calls = 0;
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-top", services: services(async () => ++calls === 1 ? "bad" : 42) });
	assert.equal(result.status, "completed", result.state.error);
	assert.equal(result.output, 42);
});

test("v2 deadline cancels an in-flight model and waits for it to settle", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].budget = { timeoutMs: 10 };
	let settled = false;
	const execution = services(async (name) => name);
	execution.completePrompt = async (request) => {
		if (request.prompt === "efficiency") await new Promise<void>((_resolve, reject) => {
			request.signal!.addEventListener("abort", () => { settled = true; reject(request.signal!.reason); }, { once: true });
		});
		return { output: request.prompt, text: request.prompt, meta: {} };
	};
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-timeout", services: execution });
	assert.equal(result.status, "failed");
	assert.match(result.state.error!, /time budget/);
	assert.equal(settled, true);
});

test("v2 registered business validator can block without output correction", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].validation = { schema: { type: "string" }, validator: "finance-v1" };
	let calls = 0;
	const execution = services(async (name) => { if (name.startsWith("efficiency")) calls++; return name; });
	execution.validateOutput = async () => ({ valid: false, blocked: true, feedback: "preflight expired" });
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-business", services: execution });
	assert.equal(result.status, "failed");
	assert.match(result.state.error!, /preflight expired/);
	assert.equal(calls, 1);
});

test("v2 deadline also cancels registered output validation", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].budget = { timeoutMs: 20 };
	spec.nodes[0].children[0].validation = { schema: { type: "string" }, validator: "slow" };
	const execution = services(async (name) => name);
	let settled = false;
	execution.validateOutput = async (_name, _output, signal) => new Promise((_resolve, reject) => {
		signal!.addEventListener("abort", () => { settled = true; reject(signal!.reason); }, { once: true });
	});
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-validator-timeout", services: execution });
	assert.equal(result.status, "failed");
	assert.match(result.state.error!, /time budget/);
	assert.equal(settled, true);
});

test("v2 cancellation interrupts retry backoff before another model invocation", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].failure = { maxAttempts: 3, initialDelayMs: 50000 };
	const controller = new AbortController();
	let calls = 0;
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), {
		goal: "plan", cwd: "/durable-cancel-retry", signal: controller.signal,
		services: services(async (name) => { if (name === "efficiency") { calls++; throw new GraphExecutionError("overload", "transient"); } return name; }),
		onUpdate(update) { if (update.details.state.history.some((event) => event.type === "retry")) controller.abort(); },
	});
	assert.equal(result.status, "interrupted");
	assert.equal(calls, 1);
});

test("v2 reports observed model usage cumulatively across failed attempts", async () => {
	const spec: any = specification();
	spec.budget = { maxRequests: 2, maxTokens: 100 };
	spec.nodes[0].concurrency = 1;
	const execution = services(async (name) => name);
	let calls = 0;
	execution.completePrompt = async (request) => {
		calls++;
		request.reportUsage!({ requests: 1 });
		request.reportUsage!({ tokens: 5, cost: 0.01 });
		return { output: request.prompt, text: request.prompt, meta: {} };
	};
	const graph = compileDeclarativeGraphSpec(spec);
	const first = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-usage", services: execution });
	assert.equal(first.status, "failed");
	assert.equal(calls, 2);
	assert.deepEqual(first.state.usage, { invocations: 2, requests: 2, tokens: 10, cost: 0.02 });
	await resumeGraph(pi, graph, first.state, { cwd: "/durable-usage", services: execution });
	assert.equal(calls, 2);
});

test("v2 shared run budget aborts every in-flight sibling", async () => {
	const spec: any = specification();
	spec.budget = { maxTokens: 10 };
	const execution = services(async (name) => name);
	const cancelled: string[] = [];
	execution.completePrompt = async (request) => {
		if (request.prompt === "efficiency") {
			await new Promise((resolve) => setImmediate(resolve));
			request.reportUsage!({ tokens: 11 });
		} else await new Promise<void>((_resolve, reject) => {
			request.signal!.addEventListener("abort", () => { cancelled.push(request.prompt); reject(request.signal!.reason); }, { once: true });
		});
		return { output: request.prompt, text: request.prompt, meta: {} };
	};
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-shared-cancel", services: execution });
	assert.equal(result.status, "failed");
	assert.match(result.state.error!, /tokens budget/);
	assert.deepEqual(cancelled.sort(), ["growth", "risk"]);
});

test("v2 rejects negative validator verdicts even with empty feedback", async () => {
	const spec: any = specification();
	spec.nodes[0].children[0].validation = { schema: { type: "string" }, validator: "empty", maxCorrections: 0 };
	const execution = services(async (name) => name);
	execution.validateOutput = async () => ({ valid: false, feedback: "" });
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-empty-feedback", services: execution });
	assert.equal(result.status, "failed");
	assert.match(result.state.error!, /validator rejected/);
});

test("v2 expired graph cannot complete through a synchronous router", async () => {
	const spec: any = specification();
	spec.start = "route";
	spec.nodes = [{ id: "route", type: "router", path: "data.mode", cases: [{ equals: "done", done: true }], default: { done: true } }];
	const graph = compileDeclarativeGraphSpec(spec);
	const first = await runGraph(pi, graph, { goal: "plan", cwd: "/durable-expired-router", services: services(async (name) => name) });
	first.state.status = "failed";
	first.state.currentNode = "route";
	first.state.deadlineAt = 1;
	const resumed = await resumeGraph(pi, graph, first.state, { cwd: "/durable-expired-router", services: services(async (name) => name) });
	assert.equal(resumed.status, "failed");
	assert.match(resumed.state.error!, /time budget/);
});

test("v2 graph deadline dismisses approval without recording a decision", async () => {
	const spec: any = specification();
	spec.budget = { timeoutMs: 20 };
	spec.start = "approve";
	spec.nodes = [{ id: "approve", type: "approval", title: "Approve?", message: "x", yes: "done" }, { id: "done", type: "prompt", prompt: "done" }];
	let dismissed = false;
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-approval-timeout", services: services(async (name) => name),
		ui: { confirm: async (_title: string, _message: string, options: { signal: AbortSignal }) => new Promise<boolean>((resolve) => {
			options.signal.addEventListener("abort", () => { dismissed = true; resolve(false); }, { once: true });
		}) } as any,
	});
	assert.equal(result.status, "failed");
	assert.equal(dismissed, true);
	assert.equal(result.state.approvals.length, 0);
	assert.equal(result.state.nodes.done.status, "pending");
});

test("v2 configuration errors containing provider keywords are never retried", async () => {
	const spec: any = specification();
	spec.nodes[0].children = [{ id: "bad", type: "tool", tool: "ECONNRESET", args: {}, failure: { maxAttempts: 3, initialDelayMs: 1 } }];
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec), { goal: "plan", cwd: "/durable-tool-config", services: { ...createGraphExecutionServices(), requiresProcessOwnership: false } });
	assert.equal(result.status, "failed");
	assert.match(result.state.error!, /Unsupported graph tool/);
	assert.equal(result.state.tasks!.bad.attempts, 1);
	assert.equal(result.state.history.filter((event) => event.type === "retry").length, 0);
});

test("v2 default services require ownership even when explicitly injected", async () => {
	await assert.rejects(runGraph(pi, compileDeclarativeGraphSpec(specification()), { cwd: "/durable-no-store", goal: "plan", services: createGraphExecutionServices() }), /process ownership/);
});

test("v2 resume confirmation obeys the original deadline", async () => {
	const spec: any = specification();
	spec.mutationPolicy = "mutating";
	spec.start = "write";
	spec.nodes = [{ id: "write", type: "tool", tool: "write", args: { path: "x", content: "x" } }];
	const graph = compileDeclarativeGraphSpec(spec);
	const execution = services(async (name) => name);
	execution.invokeTool = async () => { throw new Error("fixture failure"); };
	const context = { isProjectTrusted: () => true } as any;
	const first = await runGraph(pi, graph, { cwd: "/durable-resume-confirm", goal: "plan", services: execution, extensionContext: context });
	let called = false;
	first.state.deadlineAt = Date.now() - 1;
	await assert.rejects(resumeGraph(pi, graph, first.state, { cwd: first.state.cwd, services: execution, runtimeServices: { confirmResume: async () => { called = true; return true; } } }), /time budget/);
	assert.equal(called, false);
	first.state.deadlineAt = Date.now() + 20;
	await assert.rejects(resumeGraph(pi, graph, first.state, { cwd: first.state.cwd, services: execution, ui: {
		confirm: async (_title: string, _message: string, options: { signal: AbortSignal }) => new Promise<boolean>((resolve) => {
			called = true;
			options.signal.addEventListener("abort", () => resolve(false), { once: true });
		}),
	} as any }), /time budget/);
	assert.equal(called, true);
});

test("v2 recovery uses owned project results and rejects stale resume snapshots", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createProjectGraphRunStore } = await import("../extensions/graph-engine/run-store.ts");
	const { interruptOrphanedGraphRuns } = await import("../extensions/graph-engine/runtime.ts");
	const { default: extension } = await import("../extensions/graph-engine/index.ts");
	const dir = mkdtempSync(join(tmpdir(), "graph-owned-recovery-"));
	try {
		const store = createProjectGraphRunStore(dir);
		const graph = compileDeclarativeGraphSpec(specification());
		const execution = services(async (name) => { if (name === "efficiency") throw new Error("failure"); return name; });
		const first = await runGraph(pi, graph, { cwd: dir, goal: "plan", services: execution, runStore: store });
		const newer = structuredClone(first.state);
		newer.resumeCount++;
		store.persist(newer);
		await assert.rejects(resumeGraph(pi, graph, first.state, { cwd: dir, services: execution, runStore: store }), /stale/);
		newer.status = "running";
		store.persist(newer);
		const stale = structuredClone(newer);
		delete stale.tasks!.growth;
		const entries = [{ type: "custom", customType: "graph-run", data: { state: stale } }];
		const handlers: Array<(...args: any[]) => unknown> = [];
		extension({ appendEntry() {}, registerEntryRenderer() {}, registerCommand() {}, registerTool() {}, events: { on() {}, emit() {} },
			on(name: string, handler: (...args: any[]) => unknown) { if (name === "session_start") handlers.push(handler); },
		} as any);
		const lease = store.acquireExecutionLease();
		try {
			await assert.rejects(async () => { for (const handler of handlers) await handler({}, { cwd: dir, isProjectTrusted: () => true, sessionManager: { getBranch: () => entries }, hasUI: false, ui: { notify() {} } }); }, /still alive/);
			assert.ok(store.readCheckpoint(newer.runId)!.tasks!.growth.result);
		} finally { lease.release(); }
		const [recovered] = interruptOrphanedGraphRuns(pi, entries, { cwd: dir, runStore: store });
		assert.equal(recovered.status, "interrupted");
		assert.ok(recovered.tasks!.growth.result);
		assert.equal(recovered.resumeCount, newer.resumeCount);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
