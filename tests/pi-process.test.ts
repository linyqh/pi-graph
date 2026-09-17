import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildPiPromptArgs, buildSubagentSystemPrompt, buildToolSelectionArgs, parseJsonFromText, resolveInstalledPiCli, runPiSubagent } from "../extensions/graph-engine/pi-process.ts";
import { truncateText } from "../extensions/graph-engine/services.ts";

test("subagent tool selection passes any session tool name through to the child", () => {
	assert.deepEqual(buildToolSelectionArgs(["read", "fpa_query", "fpa_calc"]), ["--tools", "read,fpa_query,fpa_calc"]);
});

test("locating the installed Pi CLI never throws and only reports a real file", () => {
	// Absent from this package's own devDependencies, so the assertion has to
	// hold both ways: hosts that embed Pi resolve it, this checkout does not.
	const cli = resolveInstalledPiCli();
	if (cli === undefined) return;
	assert.equal(path.basename(cli), "cli.js");
	assert.ok(fs.existsSync(cli));
});

test("parseJsonFromText accepts direct, fenced, and embedded objects", () => {
	assert.deepEqual(parseJsonFromText('{"status":"pass"}'), { status: "pass" });
	assert.deepEqual(parseJsonFromText('```json\n{"status":"pass"}\n```'), { status: "pass" });
	assert.deepEqual(parseJsonFromText('Result: {"status":"pass"} done'), { status: "pass" });
});

test("parseJsonFromText rejects empty and malformed output", () => {
	assert.throws(() => parseJsonFromText(""), /No text to parse/);
	assert.throws(() => parseJsonFromText("not json"), /not valid JSON/);
});

test("subagent tool selection never falls back to pi defaults", () => {
	assert.deepEqual(buildToolSelectionArgs([]), ["--no-tools"]);
	assert.deepEqual(buildToolSelectionArgs(["read", "grep"]), ["--tools", "read,grep"]);
});

test("subagent session persistence uses the host session directory", () => {
	const args = buildPiPromptArgs({
		agentName: "reviewer",
		prompt: "Review",
		cwd: "/srv/fpa/tenants/acme/workspace/default",
		sessionDir: "/srv/fpa/tenants/acme/sessions/default",
		sessionId: "child-session",
		tools: [],
		skills: [],
	});
	assert.deepEqual(args.slice(0, 7), [
		"--mode", "json", "-p",
		"--session-id", "child-session",
		"--session-dir", "/srv/fpa/tenants/acme/sessions/default",
	]);
});

test("subagent prompt requires every assigned Skill to be loaded before acting", () => {
	const prompt = buildSubagentSystemPrompt("reviewer", [
		{ name: "code-review", path: "/tmp/code-review/SKILL.md" },
	], "Return concise findings.");
	assert.match(prompt, /Assigned skills: code-review/);
	assert.match(prompt, /use the read tool to load every assigned SKILL\.md/);
	assert.match(prompt, /Return concise findings/);
	assert.match(buildSubagentSystemPrompt("plain", []), /No skills are assigned/);
});

test("subagent execution does not mistake an embedding host script for the Pi CLI", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graph-host-test-"));
	const hostScript = path.join(dir, "web-host.js");
	const fakePi = path.join(dir, process.platform === "win32" ? "pi.cmd" : "pi");
	const originalArgv1 = process.argv[1];
	const originalPath = process.env.PATH;

	try {
		fs.writeFileSync(hostScript, "process.exit(0);\n", "utf8");
		fs.writeFileSync(
			fakePi,
			process.platform === "win32"
				? `@echo off\r\necho {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"stopReason":"stop"}}\r\n`
				: `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } }));\n`,
			"utf8",
		);
		if (process.platform !== "win32") fs.chmodSync(fakePi, 0o755);

		process.argv[1] = hostScript;
		process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
		const result = await runPiSubagent({
			agentName: "probe",
			prompt: "Return OK.",
			cwd: dir,
			tools: [],
			skills: [],
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalText, "OK");
		assert.equal(result.stopReason, "stop");
	} finally {
		process.argv[1] = originalArgv1;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("subagent execution launches the installed Pi CLI through Electron's Node mode", {
	skip: process.platform === "win32",
}, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graph-electron-host-test-"));
	const fakeElectron = path.join(dir, "Electron");
	const argsFile = path.join(dir, "args.txt");
	const envFile = path.join(dir, "env.txt");
	const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
	assert.ok(execPathDescriptor);
	const originalPath = process.env.PATH;
	const originalArgsFile = process.env.PI_GRAPH_TEST_ARGS_FILE;
	const originalEnvFile = process.env.PI_GRAPH_TEST_ENV_FILE;
	const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
	const installedCli = resolveInstalledPiCli();
	assert.ok(installedCli, "the integration fixture requires the installed Pi CLI peer");

	try {
		fs.writeFileSync(
			fakeElectron,
			`#!/bin/sh\nprintf '%s\\n' "$@" > "$PI_GRAPH_TEST_ARGS_FILE"\nprintf '%s' "$ELECTRON_RUN_AS_NODE" > "$PI_GRAPH_TEST_ENV_FILE"\nprintf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"stopReason":"stop"}}'\n`,
			"utf8",
		);
		fs.chmodSync(fakeElectron, 0o755);

		Object.defineProperty(process, "execPath", { value: fakeElectron, configurable: true });
		Object.defineProperty(process.versions, "electron", { value: "43.4.0", configurable: true });
		process.env.PATH = dir;
		process.env.PI_GRAPH_TEST_ARGS_FILE = argsFile;
		process.env.PI_GRAPH_TEST_ENV_FILE = envFile;

		const result = await runPiSubagent({
			agentName: "probe",
			prompt: "Return OK.",
			cwd: dir,
			tools: [],
			skills: [],
		});

		const args = fs.readFileSync(argsFile, "utf8").trim().split("\n");
		assert.equal(result.finalText, "OK");
		assert.equal(args[0], installedCli);
		assert.deepEqual(args.slice(1, 4), ["--mode", "json", "-p"]);
		assert.equal(fs.readFileSync(envFile, "utf8"), "1");
	} finally {
		Object.defineProperty(process, "execPath", execPathDescriptor);
		if (electronDescriptor) Object.defineProperty(process.versions, "electron", electronDescriptor);
		else delete (process.versions as Record<string, string | undefined>).electron;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalArgsFile === undefined) delete process.env.PI_GRAPH_TEST_ARGS_FILE;
		else process.env.PI_GRAPH_TEST_ARGS_FILE = originalArgsFile;
		if (originalEnvFile === undefined) delete process.env.PI_GRAPH_TEST_ENV_FILE;
		else process.env.PI_GRAPH_TEST_ENV_FILE = originalEnvFile;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("truncateText enforces the 50KB and 2000-line limits", () => {
	const byLines = truncateText(new Array(2100).fill("line").join("\n"));
	assert.equal(byLines.truncated, true);
	assert.match(byLines.text, /truncated output/);
	assert.ok(byLines.text.split("\n").length <= 2001);

	const byBytes = truncateText("x".repeat(60 * 1024));
	assert.equal(byBytes.truncated, true);
	assert.ok(Buffer.byteLength(byBytes.text, "utf8") <= 50 * 1024);
});

test("subagent usage budget cancels the process and waits for its exit", { skip: process.platform === "win32" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graph-budget-process-"));
	const fakePi = path.join(dir, "pi");
	const originalPath = process.env.PATH;
	const pidFile = path.join(dir, "pid");
	const budgetError = new Error("budget exhausted");
	let requests = 0;
	try {
		fs.writeFileSync(fakePi, `#!${process.execPath}\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nconsole.log(JSON.stringify({type: "message_start", message: {role: "assistant"}}));\nsetInterval(() => {}, 1000);\n`);
		fs.chmodSync(fakePi, 0o755);
		process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ""}`;
		await assert.rejects(runPiSubagent({ agentName: "probe", prompt: "x", cwd: dir, tools: [], skills: [],
			reportUsage(delta) { requests += delta.requests ?? 0; throw budgetError; },
		}), (error) => error === budgetError);
		assert.equal(requests, 1);
		const pid = Number(fs.readFileSync(pidFile, "utf8"));
		assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
	} finally {
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
