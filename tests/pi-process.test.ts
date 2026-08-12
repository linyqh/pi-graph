import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildSubagentSystemPrompt, buildToolSelectionArgs, parseJsonFromText, runPiSubagent } from "../extensions/graph-engine/pi-process.ts";
import { truncateText } from "../extensions/graph-engine/services.ts";

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

test("truncateText enforces the 50KB and 2000-line limits", () => {
	const byLines = truncateText(new Array(2100).fill("line").join("\n"));
	assert.equal(byLines.truncated, true);
	assert.match(byLines.text, /truncated output/);
	assert.ok(byLines.text.split("\n").length <= 2001);

	const byBytes = truncateText("x".repeat(60 * 1024));
	assert.equal(byBytes.truncated, true);
	assert.ok(Buffer.byteLength(byBytes.text, "utf8") <= 50 * 1024);
});
