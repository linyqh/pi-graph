import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import graphExtension from "../extensions/graph-engine/index.ts";

test("real Pi agent loop marks validation errors and stops after the second identical failure", { timeout: 20_000 }, async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "graph-edit-loop-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	settings.setProjectTrusted(true);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true,
		extensionFactories: [{ name: "graph", factory: graphExtension }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	let calls = 0;
	const broken = { schemaVersion: 1, name: "broken-loop", description: "Test", mutationPolicy: "read-only", start: "first", maxSteps: 3,
		nodes: [{ id: "first", type: "prompt", prompt: "First" }, { id: "last", type: "prompt", prompt: "Last" }],
	};
	modelRuntime.registerProvider("edit-test", {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture",
		models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }],
		streamSimple(model, context) {
			calls++;
			if (calls > 2) throw new Error("Repeated failures did not stop the agent loop");
			if (calls === 2) {
				const result = context.messages.find((message) => message.role === "toolResult");
				assert.ok(result?.role === "toolResult" && result.isError);
			}
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [{ type: "toolCall", id: `edit-${calls}`, name: "graph_create", arguments: { spec: broken } }, ...(calls === 2 ? [{ type: "toolCall" as const, id: "extra-read", name: "read", arguments: { path: "not-executed" } }] : [])],
				stopReason: "toolUse", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "done", reason: "toolUse", message }); stream.end(message); });
			return stream;
		},
	});
	const { session } = await createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, modelRuntime,
		model: modelRuntime.getModel("edit-test", "mock"), sessionManager: SessionManager.inMemory(cwd), tools: ["graph_create", "read"],
	});
	t.after(() => session.dispose());
	await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
	await session.prompt("Create a graph");
	assert.equal(calls, 2);
	const results = session.agent.state.messages.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 3);
	assert.match(JSON.stringify(results.find((result) => result.toolName === "read")?.content), /turn stopped/);
	assert.ok(results.every((result) => result.isError));
	assert.match(JSON.stringify(results.filter((result) => result.toolName === "graph_create").at(-1)?.content), /Stopped this agent turn/);
	assert.ok(!(await readdir(cwd)).includes(".agent-graph"));
});
