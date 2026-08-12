import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGraphCatalogStore } from "../extensions/graph-engine/catalog.ts";
import type { ProjectGraphCompiler } from "../extensions/graph-engine/project-graphs.ts";
import {
	AGENT_GRAPH_DIR_NAME,
	declarativeProjectGraphCompiler,
	deleteProjectGraph,
	migrateLegacyProjectGraphs,
	loadProjectGraphs,
	PROJECT_GRAPH_MAX_BYTES,
	projectGraphSourcePath,
	saveProjectGraph,
} from "../extensions/graph-engine/project-graphs.ts";
import type { RegisteredGraphDefinition } from "../extensions/graph-engine/registry.ts";
import { resumeGraph, runGraph } from "../extensions/graph-engine/runtime.ts";
import type { GraphExecutionServices, GraphNode } from "../extensions/graph-engine/types.ts";

function node(id: string): GraphNode {
	return {
		id,
		type: "prompt",
		capabilities: { readOnly: true, mutatesWorkspace: false },
		async run() {
			return { done: true };
		},
	};
}

function graph(name: string): RegisteredGraphDefinition {
	return {
		name,
		version: "1.0.0",
		description: `Project graph ${name}`,
		start: "start",
		maxSteps: 4,
		mutationPolicy: "read-only",
		capabilities: [],
		approvalBindings: [],
		transitions: [],
		nodes: { start: node("start") },
	};
}

function compiler(): ProjectGraphCompiler {
	return {
		parse(source) {
			return JSON.parse(source) as Record<string, unknown>;
		},
		compile(spec) {
			if (spec.failCompile === true) throw new Error("compile failed");
			return graph(spec.name);
		},
		serialize(spec) {
			return `${JSON.stringify(spec, null, "\t")}\n`;
		},
	};
}

async function fixture(): Promise<{ cwd: string; graphDir: string; cleanup(): Promise<void> }> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-project-graphs-"));
	const graphDir = join(cwd, AGENT_GRAPH_DIR_NAME, "graphs");
	await mkdir(graphDir, { recursive: true });
	return {
		cwd,
		graphDir,
		async cleanup() {
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

function declarativeSpec(name = "project-flow") {
	return {
		schemaVersion: 1,
		name,
		version: "1.0.0",
		description: "A project graph used by store tests.",
		mutationPolicy: "read-only",
		start: "finish",
		maxSteps: 2,
		nodes: [{ id: "finish", type: "prompt", prompt: "Finish {{goal}}." }],
	};
}

test("loadProjectGraphs does not read project files when cwd is untrusted", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	try {
		await writeFile(join(graphDir, "broken.json"), "{", "utf8");
		const result = await loadProjectGraphs({ cwd, trusted: false, compiler: compiler() });
		assert.equal(result.graphs.length, 0);
		assert.deepEqual(result.diagnostics.map((item) => item.code), ["untrusted"]);
	} finally {
		await cleanup();
	}
});

test("loadProjectGraphs isolates malformed files and keeps valid project graphs", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	try {
		await writeFile(join(graphDir, "alpha.json"), JSON.stringify({ name: "alpha" }), "utf8");
		await writeFile(join(graphDir, "broken.json"), "{", "utf8");
		await writeFile(join(graphDir, "bad.json"), JSON.stringify({ name: "bad", failCompile: true }), "utf8");
		const result = await loadProjectGraphs({ cwd, trusted: true, compiler: compiler() });
		assert.deepEqual(result.graphs.map((item) => item.definition.name), ["alpha"]);
		assert.deepEqual(result.diagnostics.map((item) => item.code).sort(), ["compile-error", "invalid-json"]);
	} finally {
		await cleanup();
	}
});

test("loadProjectGraphs skips symlinks, oversized files, and filename/spec mismatches", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	try {
		await writeFile(join(graphDir, "target.json"), JSON.stringify({ name: "target" }), "utf8");
		await symlink(join(graphDir, "target.json"), join(graphDir, "linked.json"));
		await writeFile(join(graphDir, "huge.json"), `${" ".repeat(PROJECT_GRAPH_MAX_BYTES + 1)}`, "utf8");
		await writeFile(join(graphDir, "wrong.json"), JSON.stringify({ name: "other" }), "utf8");
		const result = await loadProjectGraphs({ cwd, trusted: true, compiler: compiler() });
		assert.deepEqual(result.graphs.map((item) => item.definition.name), ["target"]);
		assert.deepEqual(result.diagnostics.map((item) => item.code).sort(), ["file-too-large", "filename-mismatch", "unsafe-file"]);
	} finally {
		await cleanup();
	}
});

test("catalog reports project conflicts without shadowing built-in graphs", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	try {
		await writeFile(join(graphDir, "built.json"), JSON.stringify({ name: "built" }), "utf8");
		await writeFile(join(graphDir, "project.json"), JSON.stringify({ name: "project" }), "utf8");
		const store = createGraphCatalogStore({
			builtInDefinitions: [{ ...graph("built"), description: "Built-in graph" }],
			compiler: compiler(),
		});
		const catalog = await store.reload({ cwd, trusted: true });
		assert.deepEqual(catalog.names, ["built", "project"]);
		assert.equal(catalog.sources.built.kind, "built-in");
		assert.equal(catalog.sources.project.kind, "project");
		assert.deepEqual(catalog.diagnostics.map((item) => item.code), ["duplicate-graph"]);
		assert.equal(catalog.graphs.built.description, "Built-in graph");
	} finally {
		await cleanup();
	}
});

test("saveProjectGraph requires trust, writes exclusively, and does not overwrite", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	try {
		await assert.rejects(
			saveProjectGraph({ cwd, trusted: false, compiler: compiler(), spec: { name: "alpha" } }),
			/trusted cwd/,
		);
		const first = await saveProjectGraph({ cwd, trusted: true, compiler: compiler(), spec: { name: "alpha" } });
		assert.equal(first.path, join(graphDir, "alpha.json"));
		assert.deepEqual(JSON.parse(await readFile(first.path, "utf8")), { name: "alpha" });
		await assert.rejects(
			saveProjectGraph({ cwd, trusted: true, compiler: compiler(), spec: { name: "alpha" } }),
			/already exists/,
		);
		assert.deepEqual(JSON.parse(await readFile(first.path, "utf8")), { name: "alpha" });
	} finally {
		await cleanup();
	}
});

test("deleteProjectGraph requires trust and deletes only a loaded regular project graph", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	try {
		await saveProjectGraph({ cwd, trusted: true, compiler: compiler(), spec: { name: "alpha" } });
		await assert.rejects(
			deleteProjectGraph({ cwd, trusted: false, compiler: compiler(), name: "alpha" }),
			/trusted cwd/,
		);
		assert.equal(JSON.parse(await readFile(join(graphDir, "alpha.json"), "utf8")).name, "alpha");

		const deleted = await deleteProjectGraph({ cwd, trusted: true, compiler: compiler(), name: "alpha" });
		assert.equal(deleted.path, join(graphDir, "alpha.json"));
		await assert.rejects(lstat(deleted.path), { code: "ENOENT" });
		await assert.rejects(
			deleteProjectGraph({ cwd, trusted: true, compiler: compiler(), name: "alpha" }),
			/not found/,
		);
	} finally {
		await cleanup();
	}
});

test("deleteProjectGraph refuses symlink graph targets", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	const outside = await mkdtemp(join(tmpdir(), "pi-project-graph-delete-outside-"));
	try {
		const target = join(outside, "linked.json");
		await writeFile(target, JSON.stringify({ name: "linked" }), "utf8");
		await symlink(target, join(graphDir, "linked.json"));

		await assert.rejects(
			deleteProjectGraph({ cwd, trusted: true, compiler: compiler(), name: "linked" }),
			/not found/,
		);
		assert.equal(JSON.parse(await readFile(target, "utf8")).name, "linked");
	} finally {
		await cleanup();
		await rm(outside, { recursive: true, force: true });
	}
});

test("catalog deletion removes project graphs immediately and protects built-ins", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const store = createGraphCatalogStore({
			builtInDefinitions: [graph("built")],
			compiler: compiler(),
		});
		await store.saveProjectGraph({ cwd, trusted: true, spec: { name: "project" } });
		await assert.rejects(
			store.deleteProjectGraph({ cwd, trusted: true, name: "built" }),
			/Built-in graph cannot be deleted/,
		);

		const deleted = await store.deleteProjectGraph({ cwd, trusted: true, name: "project" });
		assert.deepEqual(deleted.catalog.names, ["built"]);
		assert.equal(deleted.catalog.entries.project, undefined);
	} finally {
		await cleanup();
	}
});

test("catalog save adds the graph to the cwd catalog immediately", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const store = createGraphCatalogStore({
			builtInDefinitions: [graph("built")],
			compiler: compiler(),
		});
		const before = await store.getCatalog({ cwd, trusted: true });
		assert.deepEqual(before.names, ["built"]);
		const saved = await store.saveProjectGraph({ cwd, trusted: true, spec: { name: "instant" } });
		assert.equal(saved.catalog.graphs.instant.name, "instant");
		const inheritedName = await store.saveProjectGraph({ cwd, trusted: true, spec: { name: "constructor" } });
		assert.equal(inheritedName.catalog.graphs.constructor.name, "constructor");
		const after = await store.getCatalog({ cwd, trusted: true });
		assert.deepEqual(after.names, ["built", "constructor", "instant"]);
		assert.equal(after.sources.instant.kind, "project");
	} finally {
		await cleanup();
	}
});

test("saveProjectGraph validates and checks size before creating project directories", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-project-graphs-empty-"));
	try {
		await assert.rejects(
			saveProjectGraph({ cwd, trusted: true, compiler: compiler(), spec: { name: "../escape" } }),
			/non-empty name|include a non-empty name/,
		);
		await assert.rejects(lstat(join(cwd, AGENT_GRAPH_DIR_NAME)), { code: "ENOENT" });

		const oversizedCompiler = compiler();
		oversizedCompiler.serialize = () => "x".repeat(PROJECT_GRAPH_MAX_BYTES + 1);
		await assert.rejects(
			saveProjectGraph({ cwd, trusted: true, compiler: oversizedCompiler, spec: { name: "oversized" } }),
			/exceeds/,
		);
		await assert.rejects(lstat(join(cwd, AGENT_GRAPH_DIR_NAME)), { code: "ENOENT" });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("saveProjectGraph rejects a project config symlink that resolves outside cwd", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-project-graphs-cwd-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-project-graphs-outside-"));
	try {
		await symlink(outside, join(cwd, AGENT_GRAPH_DIR_NAME));
		await assert.rejects(
			saveProjectGraph({ cwd, trusted: true, compiler: compiler(), spec: { name: "escape" } }),
			/resolve inside cwd/,
		);
		assert.deepEqual(await readdir(outside), []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("project graph storage rejects symlinked config components even inside cwd", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-project-graphs-symlink-"));
	const actualConfig = join(cwd, "actual-config");
	try {
		await mkdir(join(actualConfig, "graphs"), { recursive: true });
		await symlink(actualConfig, join(cwd, AGENT_GRAPH_DIR_NAME));
		await assert.rejects(
			saveProjectGraph({ cwd, trusted: true, compiler: compiler(), spec: { name: "linked" } }),
			/must not be a symlink/,
		);
		assert.deepEqual(await readdir(join(actualConfig, "graphs")), []);

		const loaded = await loadProjectGraphs({ cwd, trusted: true, compiler: compiler() });
		assert.equal(loaded.graphs.length, 0);
		assert.deepEqual(loaded.diagnostics.map((item) => item.code), ["unsafe-directory"]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("loadProjectGraphs reads legacy definitions while preferring canonical storage", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	const legacyDir = join(cwd, ".pi", "graphs");
	try {
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "legacy.json"), JSON.stringify({ name: "legacy" }), "utf8");
		await writeFile(join(legacyDir, "shared.json"), JSON.stringify({ name: "shared" }), "utf8");
		await writeFile(join(graphDir, "shared.json"), JSON.stringify({ name: "shared" }), "utf8");

		const loaded = await loadProjectGraphs({ cwd, trusted: true, compiler: compiler() });
		assert.deepEqual(loaded.graphs.map((item) => item.definition.name), ["shared", "legacy"]);
		assert.equal(loaded.graphs[0].path, join(graphDir, "shared.json"));
		assert.deepEqual(loaded.diagnostics.map((item) => item.code), ["duplicate-graph"]);
	} finally {
		await cleanup();
	}
});

test("migrateLegacyProjectGraphs moves definitions without overwriting canonical files", async () => {
	const { cwd, graphDir, cleanup } = await fixture();
	const legacyDir = join(cwd, ".pi", "graphs");
	try {
		await mkdir(legacyDir, { recursive: true });
		await writeFile(join(legacyDir, "legacy.json"), JSON.stringify({ name: "legacy" }), "utf8");
		await writeFile(join(legacyDir, "shared.json"), JSON.stringify({ name: "shared", location: "legacy" }), "utf8");
		await writeFile(join(graphDir, "shared.json"), JSON.stringify({ name: "shared", location: "canonical" }), "utf8");

		const migrated = await migrateLegacyProjectGraphs({ cwd, trusted: true });
		assert.deepEqual(migrated.migrated, [{
			from: join(legacyDir, "legacy.json"),
			to: join(graphDir, "legacy.json"),
		}]);
		assert.deepEqual(migrated.diagnostics.map((item) => item.code), ["write-conflict"]);
		assert.equal(JSON.parse(await readFile(join(graphDir, "legacy.json"), "utf8")).name, "legacy");
		assert.equal(JSON.parse(await readFile(join(graphDir, "shared.json"), "utf8")).location, "canonical");
		assert.equal(JSON.parse(await readFile(join(legacyDir, "shared.json"), "utf8")).location, "legacy");
	} finally {
		await cleanup();
	}
});

test("declarative project graphs carry stable source identity and change hash with content", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const spec = declarativeSpec();
		const saved = await saveProjectGraph({ cwd, trusted: true, compiler: declarativeProjectGraphCompiler, spec });
		assert.equal(saved.graph.definition.sourcePath, projectGraphSourcePath(spec.name));
		assert.match(saved.graph.definition.definitionHash ?? "", /^[a-f0-9]{64}$/);

		const unchanged = await loadProjectGraphs({ cwd, trusted: true, compiler: declarativeProjectGraphCompiler });
		assert.equal(unchanged.graphs[0].definition.definitionHash, saved.graph.definition.definitionHash);

		await writeFile(saved.path, JSON.stringify({ ...spec, description: "Changed without a version bump." }), "utf8");
		const changed = await loadProjectGraphs({ cwd, trusted: true, compiler: declarativeProjectGraphCompiler });
		assert.notEqual(changed.graphs[0].definition.definitionHash, saved.graph.definition.definitionHash);
		assert.equal(changed.graphs[0].definition.version, saved.graph.definition.version);
	} finally {
		await cleanup();
	}
});

test("project graph checkpoints resume with an unchanged hash and reject changed content", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const spec = declarativeSpec("resumable-project");
		const saved = await saveProjectGraph({ cwd, trusted: true, compiler: declarativeProjectGraphCompiler, spec });
		let attempts = 0;
		const services: GraphExecutionServices = {
			async completePrompt() {
				attempts += 1;
				if (attempts === 1) throw new Error("retry project graph");
				return { output: "resumed", text: "resumed", meta: { kind: "prompt" } };
			},
			async runSubagent() {
				throw new Error("unexpected subagent");
			},
			async invokeBuiltinTool() {
				throw new Error("unexpected tool");
			},
			truncate(value) {
				return value;
			},
		};
		const pi = { appendEntry() {} } as unknown as ExtensionAPI;
		const first = await runGraph(pi, saved.graph.definition, { goal: "resume me", cwd, services });
		assert.equal(first.status, "failed");

		const resumed = await resumeGraph(pi, saved.graph.definition, first.state, { cwd, services });
		assert.equal(resumed.status, "completed");
		assert.equal(resumed.state.runId, first.state.runId);

		await writeFile(saved.path, JSON.stringify({ ...spec, description: "Changed without a version bump." }), "utf8");
		const changed = await loadProjectGraphs({ cwd, trusted: true, compiler: declarativeProjectGraphCompiler });
		await assert.rejects(
			resumeGraph(pi, changed.graphs[0].definition, first.state, { cwd, services }),
			/definition hash/,
		);
	} finally {
		await cleanup();
	}
});
