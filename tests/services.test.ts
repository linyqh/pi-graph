import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Type from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGraphExecutionServices } from "../extensions/graph-engine/services.ts";
import { registerGraphToolResolver } from "../extensions/graph-engine/host-bridge.ts";

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
	const truncated = createGraphExecutionServices(modelContext(async () => ({
		...assistant('{"status":"par'),
		stopReason: "length",
	})));
	await assert.rejects(
		truncated.completePrompt({ prompt: "x", cwd: "/workspace" }),
		/output limit and stopped mid-generation/,
	);
});

test("invokeTool validates and executes all seven supported pi tools", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-tools-"));
	const bin = join(cwd, "bin");
	const originalPath = process.env.PATH;
	await mkdir(bin);
	await writeFile(join(bin, "fd"), "#!/bin/sh\nprintf 'sample.txt\\n'\n", "utf8");
	await chmod(join(bin, "fd"), 0o700);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	const services = createGraphExecutionServices();
	try {
		await services.invokeTool({ tool: "write", args: { path: "sample.txt", content: "alpha\nbeta\n" }, cwd });
		await services.invokeTool({ tool: "edit", args: { path: "sample.txt", oldText: "beta", newText: "gamma" }, cwd });
		const read = await services.invokeTool({ tool: "read", args: { path: "sample.txt" }, cwd });
		const grep = await services.invokeTool({ tool: "grep", args: { pattern: "gamma", path: "." }, cwd });
		const find = await services.invokeTool({ tool: "find", args: { pattern: "*.txt", path: "." }, cwd });
		const list = await services.invokeTool({ tool: "ls", args: { path: "." }, cwd });
		const bash = await services.invokeTool({ tool: "bash", args: { command: "pwd" }, cwd });

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

test("invokeTool rejects invalid arguments and tool failures", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-tool-errors-"));
	const services = createGraphExecutionServices();
	try {
		await assert.rejects(
			services.invokeTool({ tool: "read", args: {}, cwd }),
			/arguments failed schema validation/,
		);
		await assert.rejects(
			services.invokeTool({ tool: "bash", args: { command: "exit 7" }, cwd }),
			/failed/i,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("invokeTool executes a session tool through the host resolver", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-custom-tool-"));
	const calls: unknown[] = [];
	registerGraphToolResolver((name) => name !== "fpa_query" ? undefined : ({
		name: "fpa_query",
		parameters: Type.Object({ sql: Type.String() }, { additionalProperties: false }),
		async execute(_id: string, params: unknown) {
			calls.push(params);
			return { content: [{ type: "text", text: "42" }], details: { rows: 1 } };
		},
	} as unknown as ToolDefinition));

	const services = createGraphExecutionServices();
	try {
		const result = await services.invokeTool({ tool: "fpa_query", args: { sql: "select 42" }, cwd });
		assert.equal(result.text, "42");
		assert.deepEqual(calls, [{ sql: "select 42" }]);

		await assert.rejects(
			services.invokeTool({ tool: "fpa_query", args: { sql: 7 }, cwd }),
			/arguments failed schema validation/,
		);
	} finally {
		registerGraphToolResolver(undefined);
		await rm(cwd, { recursive: true, force: true });
	}
});

test("invokeTool explains why an unresolvable tool cannot run", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-unresolvable-tool-"));
	const api = { getAllTools: () => [{ name: "read" }, { name: "fpa_query" }] } as unknown as Pick<ExtensionAPI, "getAllTools">;
	const services = createGraphExecutionServices(undefined, api);
	try {
		// Registered in the session, but no resolver is installed to execute it.
		await assert.rejects(
			services.invokeTool({ tool: "fpa_query", args: {}, cwd }),
			/no executor is reachable.*subagent node/s,
		);
		await assert.rejects(
			services.invokeTool({ tool: "fpa_nope", args: {}, cwd }),
			/Unsupported graph tool: fpa_nope\. Available: fpa_query, read\./,
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

test("runSubagent loads an explicitly registered hidden Skill", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-hidden-skill-"));
	const bin = join(cwd, "bin");
	const fakePi = join(bin, "pi");
	const argsFile = join(cwd, "args.json");
	const hiddenPath = join(cwd, "skills", "execution-guard", "SKILL.md");
	const originalPath = process.env.PATH;
	const originalArgsFile = process.env.PI_GRAPH_TEST_ARGS_FILE;
	await mkdir(bin);
	await mkdir(join(cwd, "skills", "execution-guard"), { recursive: true });
	await writeFile(hiddenPath, "---\nname: execution-guard\ndisable-model-invocation: true\n---\n", "utf8");
	await writeFile(
		fakePi,
		`#!/usr/bin/env node\n`
			+ `require("node:fs").writeFileSync(process.env.PI_GRAPH_TEST_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`
			+ `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } }));\n`,
		"utf8",
	);
	await chmod(fakePi, 0o700);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	process.env.PI_GRAPH_TEST_ARGS_FILE = argsFile;

	try {
		const context = modelContext(async () => assistant("unused"));
		(context as unknown as { sessionManager: { getSessionDir(): string } }).sessionManager = {
			getSessionDir: () => join(cwd, "sessions"),
		};
		const services = createGraphExecutionServices(
			context,
			undefined,
			() => [{ name: "execution-guard", path: hiddenPath }],
		);
		await services.runSubagent({
			agentName: "executor",
			prompt: "Execute safely",
			tools: ["read"],
			skills: ["execution-guard"],
			cwd,
		});
		const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
		const skillIndex = args.indexOf("--skill");
		assert.notEqual(skillIndex, -1);
		assert.equal(args[skillIndex + 1], hiddenPath);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalArgsFile === undefined) delete process.env.PI_GRAPH_TEST_ARGS_FILE;
		else process.env.PI_GRAPH_TEST_ARGS_FILE = originalArgsFile;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runSubagent forwards the host SessionManager directory to the child Pi process", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-session-dir-"));
	const bin = join(cwd, "bin");
	const fakePi = join(bin, "pi");
	const argsFile = join(cwd, "args.json");
	const sessionDir = join(cwd, "tenant-sessions");
	const originalPath = process.env.PATH;
	const originalArgsFile = process.env.PI_GRAPH_TEST_ARGS_FILE;
	await mkdir(bin);
	await writeFile(
		fakePi,
		`#!/usr/bin/env node\n`
			+ `require("node:fs").writeFileSync(process.env.PI_GRAPH_TEST_ARGS_FILE, JSON.stringify(process.argv.slice(2)));\n`
			+ `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } }));\n`,
		"utf8",
	);
	await chmod(fakePi, 0o700);

	const context = modelContext(async () => assistant("unused"));
	(context as unknown as { sessionManager: { getSessionDir(): string } }).sessionManager = {
		getSessionDir: () => sessionDir,
	};
	process.env.PATH = `${bin}:${originalPath ?? ""}`;
	process.env.PI_GRAPH_TEST_ARGS_FILE = argsFile;

	try {
		const services = createGraphExecutionServices(context);
		const result = await services.runSubagent({
			agentName: "reviewer",
			prompt: "Return OK",
			tools: [],
			skills: [],
			cwd,
		});
		assert.equal(result.text, "OK");
		const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
		const sessionDirIndex = args.indexOf("--session-dir");
		assert.notEqual(sessionDirIndex, -1);
		assert.equal(args[sessionDirIndex + 1], sessionDir);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalArgsFile === undefined) delete process.env.PI_GRAPH_TEST_ARGS_FILE;
		else process.env.PI_GRAPH_TEST_ARGS_FILE = originalArgsFile;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runSubagent fails a child that stopped at the output limit", {
	skip: process.platform === "win32",
}, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-truncated-"));
	const bin = join(cwd, "bin");
	const fakePi = join(bin, "pi");
	const originalPath = process.env.PATH;
	await mkdir(bin);
	// Exits 0 with non-empty text, exactly like the run that silently reported a
	// frozen artifact it never committed. Only stopReason tells them apart.
	await writeFile(
		fakePi,
		`#!/usr/bin/env node\n`
			+ `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Let me read the upstream artifacts first." }], stopReason: "length" } }));\n`,
		"utf8",
	);
	await chmod(fakePi, 0o700);
	process.env.PATH = `${bin}:${originalPath ?? ""}`;

	try {
		const services = createGraphExecutionServices();
		await assert.rejects(
			services.runSubagent({ agentName: "forecast", prompt: "Freeze it", tools: [], skills: [], cwd }),
			/output limit and stopped mid-generation/,
		);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("durable model results stay exact while display text remains bounded", async () => {
	const output = { evidence: "x".repeat(60000) };
	const services = createGraphExecutionServices(modelContext(async () => assistant(JSON.stringify(output))));
	const usage: unknown[] = [];
	const result = await services.completePrompt({ prompt: "x", cwd: "/workspace", parseJson: true, preserveOutput: true, reportUsage: (delta) => usage.push(delta) });
	assert.deepEqual(result.output, output);
	assert.match(result.text, /truncated output/);
	assert.deepEqual(usage, [{ requests: 1 }, { tokens: 2, cost: 0 }]);
	const oversized = createGraphExecutionServices(modelContext(async () => assistant("x".repeat(4 * 1024 * 1024))));
	await assert.rejects(oversized.completePrompt({ prompt: "x", cwd: "/workspace", preserveOutput: true }), /exceeds 4 MiB/);
});

test("only provider failures are adapted as transient infrastructure errors", async () => {
	const services = createGraphExecutionServices(modelContext(async () => {
		throw new Error("Our servers are currently overloaded. Please try again later.");
	}));
	await assert.rejects(services.completePrompt({ prompt: "x", cwd: "/workspace" }), (error: any) => error.kind === "transient");
});
