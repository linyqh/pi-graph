import assert from "node:assert/strict";
import test from "node:test";
import {
	GraphExecutionError,
	compileDeclarativeGraphSpec,
	resumeEmbeddedGraph,
	runEmbeddedGraph,
	type GraphExecutionServices,
	type GraphRunStore,
	type GraphState,
} from "../extensions/graph-engine/embed.ts";

// 宿主视角：没有 Pi 会话、没有 ExtensionContext，只有自己的服务与检查点存储。
function spec() {
	return {
		schemaVersion: 2, name: "embedded", version: "1.0.0", description: "embed fixture", mutationPolicy: "read-only", start: "seal", maxSteps: 8,
		nodes: [
			{ id: "seal", type: "tool", tool: "host_seal", args: { names: "{{data.names}}" }, outputKey: "sealed", next: "fan" },
			{ id: "fan", type: "map", itemsPath: "data.sealed.tasks", maxItems: 4, concurrency: 2, next: "wrap", templates: [{
				id: "work", type: "prompt", prompt: "{{data.mapTask.input.name}}",
				validation: { schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } }, validator: "host.answer.v1", maxCorrections: 2 },
				failure: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
			}] },
			{ id: "wrap", type: "prompt", prompt: "{{data.fan}}", outputKey: "summary" },
		],
	};
}

interface Harness { services: GraphExecutionServices; calls: string[]; store: GraphRunStore; saved: GraphState[] }

function harness(model: (name: string, attempt: number) => unknown): Harness {
	const calls: string[] = [];
	const attempts = new Map<string, number>();
	const saved: GraphState[] = [];
	const services: GraphExecutionServices = {
		async completePrompt(request) {
			calls.push(request.prompt);
			const attempt = (attempts.get(request.prompt) ?? 0) + 1;
			attempts.set(request.prompt, attempt);
			const output = model(request.prompt, attempt);
			return { output, text: JSON.stringify(output), meta: {} };
		},
		async runSubagent() { throw new Error("embedded hosts have no child Pi processes"); },
		async invokeTool(request) {
			const names = request.args.names as string[];
			const output = { tasks: names.map((name) => ({ taskId: name, template: "work", required: false, input: { name } })) };
			return { output, text: "", meta: {} };
		},
		async validateOutput(_validator, output) {
			return (output as { answer?: string }).answer === "bad" ? { valid: false, feedback: "answer must not be bad" } : { valid: true };
		},
		truncate: (value) => value,
	};
	const store: GraphRunStore = {
		persist: (state) => { saved.push(structuredClone(state)); },
		readCheckpoint: (runId) => [...saved].reverse().find((state) => state.runId === runId),
	};
	return { services, calls, store, saved };
}

test("an embedded host runs a durable v2 graph with its own services and checkpoint store", async () => {
	const host = harness((name) => name === "wrap-prompt" ? "done" : { answer: `ok-${name}` });
	const result = await runEmbeddedGraph(compileDeclarativeGraphSpec(spec()), {
		goal: "g", cwd: "host://embed-run", input: { names: ["a", "b"] }, services: host.services, runStore: host.store,
	});
	assert.equal(result.status, "completed", result.state.error);
	assert.equal(host.saved.at(-1)?.status, "completed");
	assert.ok(host.saved.length > 4, "every transition is checkpointed through the host store");
	assert.deepEqual((result.state.data.fan as { taskId: string; status: string }[]).map((item) => [item.taskId, item.status]), [["a", "completed"], ["b", "completed"]]);
});

test("transient failures retry, invalid output is corrected, and an optional task that keeps failing stays visible", async () => {
	const host = harness((name, attempt) => {
		if (name === "slow") throw new GraphExecutionError("provider timed out", "transient");
		if (name === "flaky" && attempt === 1) throw new GraphExecutionError("provider timed out", "transient");
		if (name === "sloppy" && attempt === 1) return { answer: "bad" };
		return { answer: `ok-${name}` };
	});
	const result = await runEmbeddedGraph(compileDeclarativeGraphSpec(spec()), {
		goal: "g", cwd: "host://embed-failures", input: { names: ["slow", "flaky", "sloppy", "fine"] }, services: host.services, runStore: host.store,
	});
	assert.equal(result.status, "completed", result.state.error);
	const byTask = Object.fromEntries((result.state.data.fan as { taskId: string; status: string }[]).map((item) => [item.taskId, item.status]));
	assert.deepEqual(byTask, { slow: "failed", flaky: "completed", sloppy: "completed", fine: "completed" });
	assert.equal(host.calls.filter((call) => call === "slow").length, 3, "retries stop at the declared attempt cap");
	assert.equal(result.state.tasks!["fan:slow"].errorKind, "transient");
	assert.equal(result.state.tasks!["fan:sloppy"].corrections, 1);
});

test("an embedded host resumes a failed snapshot and reuses the tasks that already finished", async () => {
	let broken = true;
	const host = harness((name) => {
		if (name === "b" && broken) throw new Error("provider rejected the request");
		return { answer: `ok-${name}` };
	});
	// 必需任务失败会让整次运行失败；已完成的 a、c 的结果已随同一个原子快照落盘。
	const required = spec();
	const graph = compileDeclarativeGraphSpec(required);
	const failed = await runEmbeddedGraph(graph, {
		goal: "g", cwd: "host://embed-resume", input: { names: ["a", "b", "c"] }, services: host.services, runStore: host.store,
	});
	assert.equal(failed.status, "completed", "optional tasks never fail the run");
	assert.equal((failed.state.data.fan as { status: string }[]).filter((item) => item.status === "failed").length, 1);

	// 必需任务：同样的输入，失败应当使整次运行 failed，修复后从检查点恢复。
	const strict = harness((name) => {
		if (name === "b" && broken) throw new Error("provider rejected the request");
		return { answer: `ok-${name}` };
	});
	strict.services.invokeTool = async (request) => {
		const names = request.args.names as string[];
		return { output: { tasks: names.map((name) => ({ taskId: name, template: "work", required: true, input: { name } })) }, text: "", meta: {} };
	};
	const first = await runEmbeddedGraph(graph, {
		goal: "g", cwd: "host://embed-resume-strict", input: { names: ["a", "b", "c"] }, services: strict.services, runStore: strict.store,
	});
	assert.equal(first.status, "failed");
	assert.notEqual(first.state.tasks!["fan:a"].result, undefined, "a sibling that finished before the failure is saved");
	assert.equal(first.state.tasks!["fan:c"], undefined, "no new task is dispatched after the first terminal failure");

	broken = false;
	const before = strict.calls.length;
	const checkpoint = strict.store.readCheckpoint!(first.state.runId)!;
	const resumed = await resumeEmbeddedGraph(graph, checkpoint, { cwd: "host://embed-resume-strict", services: strict.services, runStore: strict.store });
	assert.equal(resumed.status, "completed", resumed.state.error);
	assert.equal(resumed.state.resumeCount, 1);
	assert.deepEqual(strict.calls.slice(before).filter((call) => ["a", "b", "c"].includes(call)).sort(), ["b", "c"], "the finished task is reused; failed and never-started tasks run");
});
