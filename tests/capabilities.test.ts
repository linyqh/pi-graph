import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listGraphToolCapabilities, resolveSubagentExtensions, validateSkillTools } from "../extensions/graph-engine/capabilities.ts";
import { registerGraphHostEnvironment } from "../extensions/graph-engine/host-bridge.ts";
import { resolveInstalledPiCli, runPiPrompt } from "../extensions/graph-engine/pi-process.ts";

test("inactive file-backed tools load in children; parent inline tools fail before launch", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "graph-capabilities-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const extension = join(cwd, "plugin.ts");
	await writeFile(extension, "export default function () {}\n");
	const api = { getAllTools: () => [
		{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
		{ name: "hidden_query", sourceInfo: { path: extension, source: "local" } },
		{ name: "tool_search", sourceInfo: { path: "<inline:search>", source: "sdk" } },
	] } as unknown as Pick<ExtensionAPI, "getAllTools">;
	const catalog = listGraphToolCapabilities(api);
	assert.equal(catalog.find((tool) => tool.name === "hidden_query")?.subagent, "available");
	assert.equal(catalog.find((tool) => tool.name === "hidden_query")?.toolNode, false);
	assert.deepEqual(resolveSubagentExtensions(api, ["read", "hidden_query"]), [extension]);
	assert.throws(() => resolveSubagentExtensions(api, ["tool_search"]), /cannot load.*tool_search/);
	assert.throws(() => resolveSubagentExtensions(api, ["missing"]), /not available.*missing/);
});

test("skill dependencies are explicit and missing assignments or files fail", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "graph-skill-deps-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const skill = { name: "transcribe", path: join(cwd, "SKILL.md") };
	await writeFile(skill.path, "---\nname: transcribe\ngraph-required-tools: [speech_transcribe]\n---\n");
	assert.throws(() => validateSkillTools([skill], ["read"]), /requires assigned tools: speech_transcribe/);
	assert.doesNotThrow(() => validateSkillTools([skill], ["read", "speech_transcribe"]));
	await writeFile(skill.path, "---\ngraph-required-tools: invalid\n---\n");
	assert.throws(() => validateSkillTools([skill], ["read"]), /array of exact/);
	await rm(skill.path);
	assert.throws(() => validateSkillTools([skill], ["read"]), /ENOENT/);
});

test("real Pi child loads assigned extension, excludes sibling tools and stops missing-tool requests", { timeout: 60_000 }, async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "graph-child-smoke-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	t.after(() => registerGraphHostEnvironment(undefined));
	const extension = join(cwd, "plugin.mjs");
	const calls = join(cwd, "requests.jsonl");
	await writeFile(extension, `
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
export default function(pi) {
  for (const name of ["fixture_query", "fixture_extra"]) pi.registerTool({ name, label:name, description:name, parameters:Type.Object({}), async execute() { return {content:[{type:"text",text:"tool executed"}],details:{}}; } });
  pi.registerProvider("graph-smoke", {
    baseUrl:"http://127.0.0.1:1", apiKey:"fixture", api:"openai-completions",
    models:[{id:"mock",name:"mock",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000}],
    streamSimple(model, context) {
      const names = (context.tools ?? []).map(tool => tool.name).sort();
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify(names)+"\\n");
      const result = context.messages.find(message => message.role === "toolResult");
      const useTool = names.includes("fixture_query") && !result;
      const content = useTool ? [{type:"toolCall",id:"fixture-call",name:"fixture_query",arguments:{}}] : [{type:"text",text:JSON.stringify({names,executed:!!result})}];
      const message = {role:"assistant",content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:useTool?"tool_use":"stop",timestamp:Date.now()};
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {stream.push({type:"done",reason:message.stopReason,message});stream.end(message);});
      return stream;
    }
  });
}
`);
	registerGraphHostEnvironment({
		agentDir: join(cwd, "agent"),
		preparePiProcess: (args, env) => ({ command: process.execPath, args: [resolveInstalledPiCli()!, "--no-extensions", "--no-session", ...args], env }),
	});
	const options = { cwd, prompt: "Run assigned query", provider: "graph-smoke", model: "mock", skills: [], extensionPaths: [extension] };
	const result = await runPiPrompt({ ...options, tools: ["read", "fixture_query"] });
	assert.equal(result.exitCode, 0, result.stderr || result.errorMessage);
	assert.deepEqual(JSON.parse(result.finalText), { names: ["fixture_query", "read"], executed: true });
	const { readFile } = await import("node:fs/promises");
	const before = await readFile(calls, "utf8");
	const missing = await runPiPrompt({ ...options, tools: ["fixture_missing"] });
	assert.equal(missing.exitCode, 1, missing.stderr);
	assert.match(missing.errorMessage ?? "", /did not load assigned tools: fixture_missing/);
	assert.equal(await readFile(calls, "utf8"), before, "missing tool must prevent any model request");
	const empty = await runPiPrompt({ ...options, tools: [] });
	assert.equal(empty.exitCode, 0, empty.stderr || empty.errorMessage);
	assert.deepEqual(JSON.parse(empty.finalText), { names: [], executed: false });
});
