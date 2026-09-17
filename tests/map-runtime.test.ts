import assert from "node:assert/strict";
import test from "node:test";
import { compileDeclarativeGraphSpec } from "../extensions/graph-engine/declarative.ts";
import { runGraph, resumeGraph } from "../extensions/graph-engine/runtime.ts";
const pi = { appendEntry() {} } as any;
const spec = () => ({ schemaVersion: 2, name: "mapped", version: "1", description: "map fixture", mutationPolicy: "read-only", start: "analyze", maxSteps: 8,
	nodes: [{ id: "analyze", type: "map", itemsPath: "data.tasks", maxItems: 4, concurrency: 2, templates: [{ id: "worker", type: "prompt", prompt: "{{data.mapTask.input.name}}" }] }] });
const service = (call: (name: string) => Promise<unknown>) => ({ async completePrompt(request: any) { const output = await call(request.prompt); return { output, text: String(output), meta: {} }; }, truncate: (value: unknown) => value }) as any;
const task = (taskId: string, required = true) => ({ taskId, template: "worker", input: { name: taskId }, required });

test("map freezes task list and resumes only failed tasks in stable order", async () => {
	const graph = compileDeclarativeGraphSpec(spec());
	let fail = true;
	const calls: string[] = [];
	const services = service(async (name) => { calls.push(name); if (name === "a" && fail) throw new Error("failure"); return name; });
	const first = await runGraph(pi, graph, { cwd: "/map-recovery", goal: "x", input: { tasks: [task("a"), task("b")] }, services });
	assert.equal(first.status, "failed");
	assert.equal(first.state.nodes["analyze:b"].status, "completed");
	// Changing source data after the batch was sealed must not re-plan its membership.
	first.state.data.tasks = [task("c")];
	fail = false;
	const resumed = await resumeGraph(pi, graph, first.state, { cwd: "/map-recovery", services });
	assert.equal(resumed.status, "completed", resumed.state.error);
	assert.deepEqual(calls, ["a", "b", "a"]);
	assert.deepEqual((resumed.output as any[]).map((item) => item.taskId), ["a", "b"]);
	assert.ok(resumed.projection.nodes.some((node) => node.id === "analyze:b"));
});

test("map handles empty, singleton, duplicate, oversized and unauthorized tasks explicitly", async () => {
	for (const [items, status] of [[[], "completed"], [[task("a")], "completed"], [[task("a"), task("a")], "failed"], [Array.from({length: 5}, (_, i) => task(`a${i}`)), "failed"], [[{...task("a"), template: "write"}], "failed"], [[{...task("a"), tools: ["write"]}], "failed"]] as const) {
		const result = await runGraph(pi, compileDeclarativeGraphSpec(spec()), { cwd: "/map-input", goal: "x", input: { tasks: items }, services: service(async (name) => name) });
		assert.equal(result.status, status, result.state.error);
	}
});

test("optional task failure remains visible without blocking required results", async () => {
	const result = await runGraph(pi, compileDeclarativeGraphSpec(spec()), { cwd: "/map-optional", goal: "x", input: { tasks: [task("a", false), task("b")] }, services: service(async (name) => { if (name === "a") throw new Error("missing evidence"); return name; }) });
	assert.equal(result.status, "completed", result.state.error);
	assert.equal((result.output as any[])[0].status, "failed");
	assert.match((result.output as any[])[0].error, /missing evidence/);
	assert.equal((result.output as any[])[1].status, "completed");
});

test("map rejects mutable templates and legacy execution semantics", () => {
	const value: any = spec();
	value.schemaVersion = 1;
	assert.throws(() => compileDeclarativeGraphSpec(value), /v2|schemaVersion 2/);
	value.schemaVersion = 2;
	value.mutationPolicy = "mutating";
	value.nodes[0].templates = [{ id: "writer", type: "tool", tool: "write", args: { path: "x", content: "x" } }];
	assert.throws(() => compileDeclarativeGraphSpec(value), /read-only|mutate/);
});

test("run guard is mandatory and checks immutable context again before resume", async () => {
	const graph = compileDeclarativeGraphSpec({ ...spec(), guard: "business.v1" });
	const calls: string[] = [];
	const services = service(async () => { calls.push("model"); throw new Error("temporary failure"); });
	await assert.rejects(runGraph(pi, graph, { cwd: "/map-guard", goal: "x", services }), /guard is not registered/);
	let valid = true;
	services.validateRun = async (_guard: string, run: any) => {
		calls.push(run.phase);
		assert.deepEqual(run.context, { preflight_id: "sealed" });
		if (!valid) throw new Error("preflight expired");
	};
	const first = await runGraph(pi, graph, { cwd: "/map-guard", goal: "x", context: { preflight_id: "sealed" }, input: { tasks: [task("a")] }, services });
	valid = false;
	await assert.rejects(resumeGraph(pi, graph, first.state, { cwd: "/map-guard", services }), /preflight expired/);
	assert.deepEqual(calls, ["start", "model", "resume"]);
});

test("corrupt persisted batches fail closed before any child is reused or executed", async () => {
	const graph = compileDeclarativeGraphSpec(spec());
	let calls = 0;
	const services = service(async () => { calls++; throw new Error("failed"); });
	const first = await runGraph(pi, graph, { cwd: "/map-corrupt", goal: "x", input: { tasks: [task("a")] }, services });
	first.state.batches!.analyze.tasks[0].input.name = "changed";
	const resumed = await resumeGraph(pi, graph, first.state, { cwd: "/map-corrupt", services });
	assert.equal(resumed.status, "failed");
	assert.match(resumed.state.error!, /integrity/);
	assert.equal(calls, 1);
});

test("first-run guard is bounded even if its implementation ignores cancellation", async () => {
	const graph = compileDeclarativeGraphSpec({ ...spec(), guard: "business.v1", budget: { timeoutMs: 15 } });
	const services = service(async () => { throw new Error("must not run"); });
	services.validateRun = () => new Promise(() => {});
	await assert.rejects(runGraph(pi, graph, { cwd: "/guard-deadline", goal: "x", services }), /budget exhausted/);
	services.validateRun = async () => {};
	const result = await runGraph(pi, graph, { cwd: "/guard-deadline", goal: "x", input: { tasks: [] }, services });
	assert.equal(result.status, "completed");
});
