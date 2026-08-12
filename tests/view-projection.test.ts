import assert from "node:assert/strict";
import test from "node:test";
import { parallelNode, promptNode, routerNode } from "../extensions/graph-engine/nodes/index.ts";
import { projectGraphRunView } from "../extensions/graph-engine/view-projection.ts";
import { GRAPH_STATE_SCHEMA_VERSION } from "../extensions/graph-engine/types.ts";
import type { GraphDefinition, GraphState } from "../extensions/graph-engine/types.ts";

function fixture(): { graph: GraphDefinition; state: GraphState } {
	const laneA = promptNode({ id: "lane_a", label: "Lane A", prompt: "A" });
	const laneB = promptNode({ id: "lane_b", label: "Lane B", prompt: "B" });
	const graph: GraphDefinition = {
		name: "projection-test",
		version: "1.0.0",
		description: "Projection contract fixture",
		mutationPolicy: "read-only",
		start: "route",
		maxSteps: 6,
		transitions: [
			{ from: "route", to: "parallel", when: "ready" },
			{ from: "parallel", to: "route", when: "retry" },
		],
		nodes: {
			route: routerNode({ id: "route", label: "Route", targets: ["parallel"], route: () => "parallel" }),
			parallel: parallelNode({ id: "parallel", label: "Parallel", children: [laneA, laneB], next: "route" }),
		},
	};
	const state: GraphState = {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: "projection-test-run-1",
		graphName: graph.name,
		graphVersion: graph.version,
		goal: "show progress",
		cwd: "/workspace",
		status: "running",
		currentNode: "parallel",
		data: { goal: "show progress" },
		history: [
			{ id: "e1", nodeId: "route", type: "start", timestamp: 1 },
			{ id: "e2", nodeId: "route", type: "success", timestamp: 2 },
			{ id: "e3", nodeId: "parallel", type: "start", timestamp: 3 },
		],
		nodes: {
			route: { status: "completed", startedAt: 1, completedAt: 2 },
			parallel: { status: "running", startedAt: 3 },
			lane_a: { status: "completed", startedAt: 3, completedAt: 4 },
			lane_b: { status: "running", startedAt: 3 },
		},
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 4,
	};
	return { graph, state };
}

test("projectGraphRunView exposes stable topology and runtime status without graph data", () => {
	const { graph, state } = fixture();
	const projection = projectGraphRunView(graph, state);

	assert.equal(projection.kind, "pi.graph-run");
	assert.equal(projection.schemaVersion, 1);
	assert.equal(projection.revision, 3);
	assert.deepEqual(projection.progress, { completed: 2, total: 4 });
	assert.deepEqual(
		projection.nodes.map(({ id, parentId, label, type, status }) => ({ id, parentId, label, type, status })),
		[
			{ id: "route", parentId: undefined, label: "Route", type: "router", status: "completed" },
			{ id: "parallel", parentId: undefined, label: "Parallel", type: "parallel", status: "running" },
			{ id: "lane_a", parentId: "parallel", label: "Lane A", type: "prompt", status: "completed" },
			{ id: "lane_b", parentId: "parallel", label: "Lane B", type: "prompt", status: "running" },
		],
	);
	assert.deepEqual(
		projection.edges.map(({ from, to, kind, traversedCount }) => ({ from, to, kind, traversedCount })),
		[
			{ from: "route", to: "parallel", kind: "transition", traversedCount: 1 },
			{ from: "parallel", to: "lane_a", kind: "parallel", traversedCount: 0 },
			{ from: "parallel", to: "lane_b", kind: "parallel", traversedCount: 0 },
			{ from: "lane_a", to: "route", kind: "loop", traversedCount: 0 },
			{ from: "lane_b", to: "route", kind: "loop", traversedCount: 0 },
		],
	);
	assert.equal("data" in projection, false);
});

test("projectGraphRunView bounds user-controlled display text and total bytes", () => {
	const { graph, state } = fixture();
	graph.description = "d".repeat(10_000);
	graph.nodes.route.label = "路".repeat(1_000);
	state.goal = "g".repeat(20_000);
	state.nodes.route.error = "e".repeat(10_000);
	const projection = projectGraphRunView(graph, state);

	assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 128 * 1024);
	assert.ok(Buffer.byteLength(projection.goal, "utf8") <= 4 * 1024);
	assert.ok(Buffer.byteLength(projection.nodes[0]!.label, "utf8") <= 128);
	assert.ok(Buffer.byteLength(projection.nodes[0]!.error ?? "", "utf8") <= 256);
});

test("projectGraphRunView exposes failure routes for TypeScript graphs", () => {
	const repair = promptNode({ id: "repair", prompt: "repair" });
	const fragile = promptNode({
		id: "fragile",
		prompt: "fragile",
		failure: { maxAttempts: 2, onError: "repair" },
	});
	const graph: GraphDefinition = {
		name: "failure-projection",
		version: "1.0.0",
		mutationPolicy: "read-only",
		start: "fragile",
		nodes: { fragile, repair },
	};
	const state: GraphState = {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: "failure-projection-1",
		graphName: graph.name,
		graphVersion: graph.version,
		goal: "repair failure",
		cwd: "/workspace",
		status: "running",
		currentNode: "repair",
		data: {},
		history: [
			{ id: "e1", nodeId: "fragile", type: "start", timestamp: 1 },
			{ id: "e2", nodeId: "fragile", type: "error", timestamp: 2, error: "failed" },
			{ id: "e3", nodeId: "repair", type: "start", timestamp: 3 },
		],
		nodes: {
			fragile: { status: "failed", startedAt: 1, completedAt: 2, error: "failed" },
			repair: { status: "running", startedAt: 3 },
		},
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 3,
	};

	assert.deepEqual(
		projectGraphRunView(graph, state).edges.map(({ from, to, label, traversedCount }) => ({ from, to, label, traversedCount })),
		[{ from: "fragile", to: "repair", label: "error", traversedCount: 1 }],
	);
});

test("projectGraphRunView does not count retry attempts as graph edge traversal", () => {
	const start = promptNode({
		id: "start",
		prompt: "start",
		next: "done",
		failure: { maxAttempts: 2 },
	});
	start.transitions = [{ to: "start", label: "explicit loop" }, { to: "done", label: "success" }];
	const done = promptNode({ id: "done", prompt: "done" });
	const graph: GraphDefinition = {
		name: "retry-projection",
		version: "1.0.0",
		mutationPolicy: "read-only",
		start: "start",
		nodes: { start, done },
	};
	const state: GraphState = {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: "retry-projection-1",
		graphName: graph.name,
		graphVersion: graph.version,
		goal: "retry",
		cwd: "/workspace",
		status: "running",
		currentNode: "done",
		data: {},
		history: [
			{ id: "e1", nodeId: "start", type: "start", timestamp: 1, attempt: 1, maxAttempts: 2 },
			{ id: "e2", nodeId: "start", type: "error", timestamp: 2, attempt: 1, maxAttempts: 2 },
			{ id: "e3", nodeId: "start", type: "retry", timestamp: 3, attempt: 1, maxAttempts: 2 },
			{ id: "e4", nodeId: "start", type: "start", timestamp: 4, attempt: 2, maxAttempts: 2 },
			{ id: "e5", nodeId: "start", type: "success", timestamp: 5 },
			{ id: "e6", nodeId: "done", type: "start", timestamp: 6, attempt: 1, maxAttempts: 1 },
		],
		nodes: {
			start: { status: "completed", startedAt: 4, completedAt: 5, attempts: 2, maxAttempts: 2 },
			done: { status: "running", startedAt: 6, attempts: 1, maxAttempts: 1 },
		},
		approvals: [],
		resumeCount: 0,
		startedAt: 1,
		updatedAt: 6,
	};

	const projection = projectGraphRunView(graph, state);
	const traversals = Object.fromEntries(projection.edges.map((edge) => [`${edge.from}->${edge.to}`, edge.traversedCount]));
	assert.deepEqual(traversals, { "start->start": 0, "start->done": 1 });
	assert.deepEqual(
		projection.nodes.map(({ id, attempts, maxAttempts }) => ({ id, attempts, maxAttempts })),
		[
			{ id: "start", attempts: 2, maxAttempts: 2 },
			{ id: "done", attempts: 1, maxAttempts: 1 },
		],
	);
});

test("projectGraphRunView does not count resume re-entry as a self-loop traversal", () => {
	const start = promptNode({ id: "start", prompt: "start", next: "done" });
	start.transitions = [{ to: "start", label: "explicit loop" }, { to: "done", label: "success" }];
	const done = promptNode({ id: "done", prompt: "done" });
	const graph: GraphDefinition = {
		name: "resume-projection",
		version: "1.0.0",
		mutationPolicy: "read-only",
		start: "start",
		nodes: { start, done },
	};
	const state: GraphState = {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: "resume-projection-1",
		graphName: graph.name,
		graphVersion: graph.version,
		goal: "resume",
		cwd: "/workspace",
		status: "running",
		currentNode: "done",
		data: {},
		history: [
			{ id: "e1", nodeId: "start", type: "start", timestamp: 1, attempt: 1, maxAttempts: 2, resumeCount: 0 },
			{ id: "e2", nodeId: "start", type: "start", timestamp: 2, attempt: 2, maxAttempts: 2, resumeCount: 0 },
			{ id: "e3", nodeId: "start", type: "start", timestamp: 3, attempt: 1, maxAttempts: 2, resumeCount: 1 },
			{ id: "e4", nodeId: "done", type: "start", timestamp: 4, attempt: 1, maxAttempts: 1, resumeCount: 1 },
		],
		nodes: {
			start: { status: "completed", startedAt: 3, completedAt: 4, attempts: 1, maxAttempts: 2 },
			done: { status: "running", startedAt: 4, attempts: 1, maxAttempts: 1 },
		},
		approvals: [],
		resumeCount: 1,
		startedAt: 1,
		updatedAt: 4,
	};

	const traversals = Object.fromEntries(projectGraphRunView(graph, state).edges.map((edge) => [`${edge.from}->${edge.to}`, edge.traversedCount]));
	assert.deepEqual(traversals, { "start->start": 0, "start->done": 1 });
});
