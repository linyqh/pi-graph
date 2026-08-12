import assert from "node:assert/strict";
import test from "node:test";
import { createGraphRegistry } from "../extensions/graph-engine/registry.ts";
import type { RegisteredGraphDefinition } from "../extensions/graph-engine/registry.ts";
import type { GraphDefinition, GraphNode } from "../extensions/graph-engine/types.ts";
import { validateGraph } from "../extensions/graph-engine/validation.ts";

function node(id: string, transitions: string[] = []): GraphNode {
	return {
		id,
		type: "prompt",
		transitions: transitions.map((to) => ({ to })),
		capabilities: { readOnly: true, mutatesWorkspace: false },
		async run() {
			return { done: true };
		},
	};
}

function definition(patch: Partial<GraphDefinition> = {}): GraphDefinition {
	return {
		name: "valid",
		version: "1.0.0",
		mutationPolicy: "read-only",
		start: "start",
		maxSteps: 8,
		nodes: { start: node("start") },
		...patch,
	};
}

function messages(graph: GraphDefinition): string {
	return validateGraph(graph).issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

test("validateGraph rejects bad start, transitions, ids, reachability, and maxSteps", () => {
	assert.match(messages(definition({ start: "missing" })), /unknown start node/);
	assert.match(messages(definition({ nodes: { start: node("wrong") } })), /must match registry key/);
	assert.match(messages(definition({ nodes: { start: node("start", ["missing"]) } })), /unknown transition target/);
	assert.match(messages(definition({ nodes: { start: node("start"), orphan: node("orphan") } })), /not reachable/);
	assert.match(messages(definition({ maxSteps: 0 })), /integer from 1 to 256/);
	assert.match(messages(definition({ maxSteps: 257 })), /integer from 1 to 256/);
});

test("validateGraph enforces the workflow projection topology bounds", () => {
	const nodes = Object.fromEntries(Array.from({ length: 65 }, (_, index) => {
		const id = `node_${index}`;
		return [id, node(id, index < 64 ? [`node_${index + 1}`] : [])];
	}));
	assert.match(messages(definition({ start: "node_0", nodes })), /at most 64 nodes/);

	const fanout = node("start");
	fanout.transitions = Array.from({ length: 257 }, () => ({ to: "end" }));
	assert.match(messages(definition({ nodes: { start: fanout, end: node("end") } })), /at most 256 edges/);

	const longId = "n".repeat(129);
	assert.match(messages(definition({ start: longId, nodes: { [longId]: node(longId) } })), /at most 128 UTF-8 bytes/);
});

test("validateGraph requires project definition identity fields to be paired", () => {
	const missingSource = definition();
	missingSource.definitionHash = "a".repeat(64);
	assert.equal(validateGraph(missingSource).ok, false);

	const badHash = definition();
	badHash.definitionHash = "not-a-hash";
	badHash.sourcePath = ".pi/graphs/example.json";
	assert.match(validateGraph(badHash).issues.map((issue) => issue.message).join("\n"), /SHA-256/);

	const valid = definition();
	valid.definitionHash = "a".repeat(64);
	valid.sourcePath = ".pi/graphs/example.json";
	assert.equal(validateGraph(valid).ok, true);
});

test("validateGraph requires router candidates to be explicit and valid", () => {
	const missingTargets = node("route");
	missingTargets.type = "router";
	assert.match(messages(definition({ start: "route", nodes: { route: missingTargets } })), /must declare every candidate target/);

	const terminalOnly = node("route");
	terminalOnly.type = "router";
	terminalOnly.routerCandidates = [];
	assert.equal(validateGraph(definition({ start: "route", nodes: { route: terminalOnly } })).ok, true);

	const badTarget = node("route");
	badTarget.type = "router";
	badTarget.routerCandidates = ["missing"];
	assert.match(messages(definition({ start: "route", nodes: { route: badTarget } })), /unknown router candidate/);
});

test("validateGraph accepts failure policies on top-level prompt, subagent, and tool nodes", () => {
	for (const type of ["prompt", "subagent", "tool"] as const) {
		const fragile = node("fragile");
		fragile.type = type;
		fragile.failure = { maxAttempts: 3, onError: "repair" };
		assert.equal(validateGraph(definition({
			start: "fragile",
			nodes: { fragile, repair: node("repair") },
		})).ok, true);
	}
});

test("validateGraph rejects malformed, unsafe, and unsupported failure policies", () => {
	const empty = node("start");
	empty.failure = {};
	assert.match(messages(definition({ nodes: { start: empty } })), /at least maxAttempts or onError/);

	for (const maxAttempts of [0, 1.5, 4]) {
		const fragile = node("start");
		fragile.failure = { maxAttempts };
		assert.match(messages(definition({ nodes: { start: fragile } })), /integer from 1 to 3/);
	}

	const missingTarget = node("start");
	missingTarget.failure = { onError: "missing" };
	assert.match(messages(definition({ nodes: { start: missingTarget } })), /unknown onError target/);

	const blankTarget = node("start");
	blankTarget.failure = { onError: " " };
	assert.match(messages(definition({ nodes: { start: blankTarget } })), /non-empty string/);

	for (const type of ["approval", "router", "parallel"] as const) {
		const unsupported = node("start");
		unsupported.type = type;
		unsupported.failure = { maxAttempts: 1 };
		if (type === "router") unsupported.routerCandidates = [];
		if (type === "parallel") unsupported.children = [node("child")];
		assert.match(messages(definition({ nodes: { start: unsupported } })), /only.*top-level prompt, subagent, or tool nodes/);
	}
});

test("validateGraph allows automatic retries only for read-only top-level nodes", () => {
	const mutate = node("mutate");
	mutate.type = "tool";
	mutate.capabilities = { readOnly: false, mutatesWorkspace: true };
	mutate.failure = { maxAttempts: 2 };
	assert.match(messages(definition({
		mutationPolicy: "mutating",
		start: "mutate",
		nodes: { mutate },
	})), /automatic retries require a read-only node/);

	const unknownCapabilities = node("unknown_capabilities");
	unknownCapabilities.type = "tool";
	unknownCapabilities.capabilities = undefined;
	unknownCapabilities.failure = { maxAttempts: 2 };
	assert.match(
		messages(definition({ start: "unknown_capabilities", nodes: { unknown_capabilities: unknownCapabilities } })),
		/automatic retries require a read-only node/,
	);

	const child = node("child");
	child.failure = { maxAttempts: 2 };
	const parallel = node("parallel");
	parallel.type = "parallel";
	parallel.children = [child];
	assert.match(
		messages(definition({ start: "parallel", nodes: { parallel } })),
		/parallel child nodes must not declare failure policy/,
	);
});

test("validateGraph rejects ambiguous error edges and mutating failure cycles", () => {
	const duplicate = node("start", ["repair"]);
	duplicate.failure = { onError: "repair" };
	assert.match(
		messages(definition({ nodes: { start: duplicate, repair: node("repair") } })),
		/duplicate a normal transition target/,
	);

	const mutate = node("mutate");
	mutate.type = "tool";
	mutate.capabilities = { readOnly: false, mutatesWorkspace: true };
	mutate.failure = { onError: "repair" };
	const repair = node("repair", ["mutate"]);
	assert.match(messages(definition({
		mutationPolicy: "mutating",
		start: "mutate",
		nodes: { mutate, repair },
	})), /must not lead back to the mutating node/);
});

test("validateGraph rejects unsafe or invalid parallel definitions", () => {
	const child = node("child");
	const parallel = node("parallel");
	parallel.type = "parallel";
	parallel.children = [child];
	parallel.concurrency = 5;
	assert.match(messages(definition({ start: "parallel", nodes: { parallel } })), /integer from 1 to 4/);

	parallel.concurrency = 2;
	parallel.children = new Array(9).fill(undefined).map((_, index) => node(`child_${index}`));
	assert.match(messages(definition({ start: "parallel", nodes: { parallel } })), /at most 8/);

	const mutatingChild = node("mutating_child");
	mutatingChild.capabilities = { readOnly: false, mutatesWorkspace: true };
	parallel.children = [mutatingChild];
	assert.match(messages(definition({ start: "parallel", nodes: { parallel } })), /must not mutate/);

	const otherParallel = node("other_parallel");
	otherParallel.type = "parallel";
	otherParallel.children = [node("shared_child")];
	parallel.children = [node("shared_child")];
	parallel.transitions = [{ to: "other_parallel" }];
	assert.match(
		messages(definition({ start: "parallel", nodes: { parallel, other_parallel: otherParallel } })),
		/duplicate workflow projection node id/,
	);

	parallel.children = [node("other_parallel")];
	assert.match(
		messages(definition({ start: "parallel", nodes: { parallel, other_parallel: otherParallel } })),
		/duplicate workflow projection node id/,
	);
});

test("validateGraph checks approval references for mutating nodes", () => {
	const mutate = node("mutate");
	mutate.type = "tool";
	mutate.capabilities = { readOnly: false, mutatesWorkspace: true, requiresApproval: true };
	const approvalRequired = definition({
		mutationPolicy: "approval-required",
		nodes: { mutate },
		start: "mutate",
	});
	assert.match(messages(approvalRequired), /must reference an approval node/);

	mutate.approvalNodeId = "missing";
	assert.match(messages(approvalRequired), /unknown approval node/);

	mutate.approvalNodeId = "not_approval";
	mutate.transitions = [{ to: "not_approval" }];
	assert.match(messages({ ...approvalRequired, nodes: { mutate, not_approval: node("not_approval") } }), /must reference an approval node/);
});

test("validateGraph allows unbound mutation under mutating policy", () => {
	const mutate = node("mutate");
	mutate.type = "tool";
	mutate.capabilities = { readOnly: false, mutatesWorkspace: true, requiresApproval: false };
	const graph = definition({
		mutationPolicy: "mutating",
		nodes: { mutate },
		start: "mutate",
		capabilities: [{ id: "mutate", mutates: true }],
		approvalBindings: [],
	});

	assert.equal(validateGraph(graph).ok, true);
});

test("validateGraph allows declared cycles while maxSteps remains the runtime guard", () => {
	const graph = definition({
		start: "a",
		nodes: {
			a: node("a", ["b"]),
			b: node("b", ["a"]),
		},
	});
	assert.equal(validateGraph(graph).ok, true);
});

test("createGraphRegistry rejects duplicate names before registry construction", () => {
	const graph = {
		...definition(),
		capabilities: [],
		approvalBindings: [],
		transitions: [],
	} as RegisteredGraphDefinition;
	assert.throws(() => createGraphRegistry([graph, { ...graph }]), /Duplicate graph registered/);
});

test("registry maps safely support graph names inherited by ordinary objects", () => {
	const graph = {
		...definition({ name: "constructor" }),
		capabilities: [],
		approvalBindings: [],
		transitions: [],
	} as RegisteredGraphDefinition;
	const registry = createGraphRegistry([graph]);

	assert.equal(Object.getPrototypeOf(registry.graphs), null);
	assert.equal(registry.graphs.constructor.name, "constructor");
	assert.equal(registry.graphs.toString, undefined);
});
