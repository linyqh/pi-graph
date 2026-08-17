import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseDeclarativeGraphSpec } from "../extensions/graph-engine/declarative.ts";

const root = process.cwd();

test("package manifest exposes graph extension, create-graph skill, and graph-create prompt", async () => {
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		files?: string[];
		pi?: { extensions?: string[]; skills?: string[]; prompts?: string[] };
	};

	assert.deepEqual(manifest.files, ["README.md", "extensions", "graphs", "prompts", "skills"]);
	assert.deepEqual(manifest.pi?.extensions, ["./extensions/graph-engine/index.ts"]);
	assert.ok(manifest.pi?.skills?.includes("./skills"));
	assert.ok(manifest.pi?.prompts?.includes("./prompts"));
});

test("create-graph skill frontmatter declares name and graph_create routing", async () => {
	const skill = await readFile(join(root, "skills", "create-graph", "SKILL.md"), "utf8");
	const match = skill.match(/^---\n(?<frontmatter>[\s\S]*?)\n---/);

	assert.ok(match?.groups?.frontmatter);
	assert.match(match.groups.frontmatter, /^name: create-graph$/m);
	assert.match(match.groups.frontmatter, /graph_create/);
	assert.match(skill, /four default coding tools: `read`, `bash`, `edit`, and `write`/);
	assert.match(skill, /read-only graph or parallel child/);
	assert.match(skill, /Any tool the current Pi session exposes may be named/);
	assert.match(skill, /Never invent a tool name/);
	assert.match(skill, /Custom tools count as read-only by default/);
	assert.match(skill, /Make every subagent `skills` allowlist explicit/);
	assert.match(skill, /Never invent a Skill name/);
	assert.match(skill, /Infer the graph's presentation language/);
	assert.match(skill, /Require a `label` for every created node/);
	assert.match(skill, /Set all five `transitionLabels` fields/);
	assert.match(skill, /Keep machine-facing fields in their required portable form/);
});

test("graph-create prompt exposes an optional workflow goal and loads the skill first", async () => {
	const prompt = await readFile(join(root, "prompts", "graph-create.md"), "utf8");

	assert.match(prompt, /^argument-hint: \[workflow idea\]$/m);
	assert.match(prompt, /Load and follow the `create-graph` skill first/);
	assert.match(prompt, /Preserve the user's presentation language/);
	assert.match(prompt, /\$ARGUMENTS/);
});

test("create-graph reference copyable JSON example parses as a declarative graph spec", async () => {
	const reference = await readFile(join(root, "skills", "create-graph", "references", "graph-spec.md"), "utf8");
	const match = reference.match(/## Copyable Example[\s\S]*?```json\n(?<json>[\s\S]*?)\n```/);

	assert.ok(match?.groups?.json);
	const parsed = parseDeclarativeGraphSpec(JSON.parse(match.groups.json));
	assert.equal(parsed.schemaVersion, 1);
	assert.equal(parsed.name, "review-then-implement");
	assert.match(parsed.description, /检查仓库/);
	assert.deepEqual(parsed.transitionLabels, {
		approved: "已批准",
		declined: "已拒绝",
		default: "其他情况",
		error: "失败",
		next: "继续",
	});
	assert.ok(parsed.nodes.every((node) => typeof node.label === "string" && node.label.length > 0));
	const implement = parsed.nodes.find((node) => node.id === "implement");
	assert.ok(implement?.type === "subagent");
	assert.deepEqual(implement.tools.slice(0, 4), ["read", "bash", "edit", "write"]);
	assert.ok(parsed.nodes.filter((node) => node.type === "subagent").every((node) => Array.isArray(node.skills)));
	const router = parsed.nodes.find((node) => node.id === "route_review");
	assert.ok(router?.type === "router");
	assert.ok(router.cases.every((entry) => typeof entry.label === "string" && entry.label.length > 0));
	assert.equal(router.default.label, "其他结果");
});

test("create-graph reference does not advertise unsupported parallel output keys", async () => {
	const reference = await readFile(join(root, "skills", "create-graph", "references", "graph-spec.md"), "utf8");
	const parallelSection = reference.match(/## Parallel Nodes(?<section>[\s\S]*?)## Copyable Example/)?.groups?.section;

	assert.ok(parallelSection);
	assert.doesNotMatch(parallelSection, /`outputKey`/);
	assert.match(parallelSection, /stored under the parallel node id/);
});
