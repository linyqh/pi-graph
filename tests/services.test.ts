import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGraphExecutionServices } from "../extensions/graph-engine/services.ts";

function modelContext(complete: (context: unknown) => Promise<unknown>): ExtensionContext {
	const model = { provider: "test-provider", id: "test-model" };
	return {
		model,
		modelRegistry: {
			find(provider: string, id: string) {
				return provider === model.provider && id === model.id ? model : undefined;
			},
			complete: async (_model: unknown, context: unknown) => complete(context),
		},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function assistant(text: string) {
	return {
		content: [{ type: "text", text }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
	};
}

test("completePrompt performs one tool-free model call and normalizes output errors", async () => {
	let requestContext: unknown;
	const executionServices = createGraphExecutionServices(modelContext(async (context) => {
		requestContext = context;
		return assistant('```json\n{"status":"pass"}\n```');
	}));
	const result = await executionServices.completePrompt({
		prompt: "Review",
		systemPrompt: "Return JSON",
		parseJson: true,
		cwd: "/workspace",
	});
	assert.deepEqual(result.output, { status: "pass" });
	assert.equal((requestContext as { tools?: unknown }).tools, undefined);
	assert.equal((requestContext as { messages: unknown[] }).messages.length, 1);

	const empty = createGraphExecutionServices(modelContext(async () => assistant("")));
	await assert.rejects(empty.completePrompt({ prompt: "x", cwd: "/workspace" }), /empty output/);
	const failed = createGraphExecutionServices(modelContext(async () => {
		throw new Error("provider unavailable");
	}));
	await assert.rejects(failed.completePrompt({ prompt: "x", cwd: "/workspace" }), /provider unavailable/);
	const stopped = createGraphExecutionServices(modelContext(async () => ({
		...assistant("partial"),
		stopReason: "error",
		errorMessage: "model rejected request",
	})));
	await assert.rejects(stopped.completePrompt({ prompt: "x", cwd: "/workspace" }), /model rejected request/);
	const aborted = createGraphExecutionServices(modelContext(async () => ({
		...assistant("partial"),
		stopReason: "aborted",
		errorMessage: "model request cancelled",
	})));
	await assert.rejects(
		aborted.completePrompt({ prompt: "x", cwd: "/workspace" }),
		(error: Error) => error.name === "AbortError" && /model request cancelled/.test(error.message),
	);
});

test("invokeBuiltinTool validates and executes all seven supported pi tools", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-tools-"));
	const bin = join(cwd, "bin");
	const originalPath = process.env.PATH;
	await mkdir(bin);
	await writeFile(join(bin, "fd"), "#!/bin/sh\nprintf 'sample.txt\\n'\n", "utf8");
	await chmod(join(bin, "fd"), 0o700);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	const services = createGraphExecutionServices();
	try {
		await services.invokeBuiltinTool({ tool: "write", args: { path: "sample.txt", content: "alpha\nbeta\n" }, cwd });
		await services.invokeBuiltinTool({ tool: "edit", args: { path: "sample.txt", oldText: "beta", newText: "gamma" }, cwd });
		const read = await services.invokeBuiltinTool({ tool: "read", args: { path: "sample.txt" }, cwd });
		const grep = await services.invokeBuiltinTool({ tool: "grep", args: { pattern: "gamma", path: "." }, cwd });
		const find = await services.invokeBuiltinTool({ tool: "find", args: { pattern: "*.txt", path: "." }, cwd });
		const list = await services.invokeBuiltinTool({ tool: "ls", args: { path: "." }, cwd });
		const bash = await services.invokeBuiltinTool({ tool: "bash", args: { command: "pwd" }, cwd });

		assert.match(read.text, /gamma/);
		assert.match(grep.text, /gamma/);
		assert.match(find.text, /sample\.txt/);
		assert.match(list.text, /sample\.txt/);
		assert.match(bash.text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(await readFile(join(cwd, "sample.txt"), "utf8"), "alpha\ngamma\n");
	} finally {
		process.env.PATH = originalPath;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("invokeBuiltinTool rejects invalid arguments and tool failures", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-tool-errors-"));
	const services = createGraphExecutionServices();
	try {
		await assert.rejects(
			services.invokeBuiltinTool({ tool: "read", args: {}, cwd }),
			/arguments failed schema validation/,
		);
		await assert.rejects(
			services.invokeBuiltinTool({ tool: "bash", args: { command: "exit 7" }, cwd }),
			/failed/i,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runSubagent rejects an assigned Skill that is unavailable before spawning Pi", async () => {
	const executionServices = createGraphExecutionServices(modelContext(async () => assistant("unused")));
	await assert.rejects(executionServices.runSubagent({
		agentName: "reviewer",
		prompt: "Review",
		tools: ["read"],
		skills: ["code-review"],
		cwd: "/workspace",
	}), /Assigned skills are not available.*code-review/);
});
