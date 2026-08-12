import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectGraphRunStore } from "../extensions/graph-engine/run-store.ts";
import { GRAPH_STATE_SCHEMA_VERSION } from "../extensions/graph-engine/types.ts";
import type { GraphState } from "../extensions/graph-engine/types.ts";

function state(cwd: string, patch: Partial<GraphState> = {}): GraphState {
	return {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: "example-run-1",
		graphName: "example",
		graphVersion: "1.0.0",
		goal: "test storage",
		cwd,
		status: "running",
		currentNode: "start",
		data: { goal: "test storage" },
		history: [],
		nodes: { start: { status: "running" } },
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 2,
		...patch,
	};
}

test("ProjectGraphRunStore atomically persists and replaces the latest run snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-graph-runs-"));
	try {
		const store = createProjectGraphRunStore(cwd);
		store.persist(state(cwd));
		store.persist(state(cwd, { status: "completed", currentNode: undefined, completedAt: 3, updatedAt: 3 }));

		const loaded = await store.load();
		assert.equal(loaded.runs.length, 1);
		assert.equal(loaded.runs[0].state.status, "completed");
		assert.equal(loaded.runs[0].state.updatedAt, 3);
		assert.equal(loaded.directory, join(cwd, ".agent-graph", "runs"));
		const serialized = JSON.parse(await readFile(join(loaded.directory, "example-run-1.json"), "utf8"));
		assert.equal(serialized.kind, "agent-graph.run");
		assert.equal(serialized.schemaVersion, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("ProjectGraphRunStore isolates malformed records and refuses symlinked storage", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "agent-graph-runs-invalid-"));
	try {
		const directory = join(cwd, ".agent-graph", "runs");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "broken.json"), "{", "utf8");
		const loaded = await createProjectGraphRunStore(cwd).load();
		assert.equal(loaded.runs.length, 0);
		assert.equal(loaded.diagnostics.length, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}

	const linkedCwd = await mkdtemp(join(tmpdir(), "agent-graph-runs-linked-"));
	const outside = await mkdtemp(join(tmpdir(), "agent-graph-runs-outside-"));
	try {
		await symlink(outside, join(linkedCwd, ".agent-graph"));
		assert.throws(
			() => createProjectGraphRunStore(linkedCwd).persist(state(linkedCwd)),
			/real directory inside cwd/,
		);
	} finally {
		await rm(linkedCwd, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
