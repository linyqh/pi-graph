import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import graphEngineeringExtension, {
	formatGraphListText,
	formatGraphRunModelContent,
	formatGraphRunEntry,
	formatGraphToolDescription,
	formatUnknownGraphMessage,
	graphNameParameter,
} from "../extensions/graph-engine/index.ts";
import { createGraphRegistry } from "../extensions/graph-engine/registry.ts";
import type { RegisteredGraphDefinition } from "../extensions/graph-engine/registry.ts";
import type { GraphRunResult, GraphState } from "../extensions/graph-engine/types.ts";
import { graphDefinitions, graphNames } from "../graphs/index.ts";

const theme = {
	bold: (text: string) => text,
	fg: (_name: string, text: string) => text,
};
type TestTheme = typeof theme;

function renderState(): GraphState {
	return {
		schemaVersion: 1,
		runId: "sample-long-runid1234",
		graphName: "sample",
		graphVersion: "1.0.0",
		goal: "goal",
		cwd: "/workspace",
		status: "failed",
		currentNode: "review",
		data: { finalSummary: "summary text" },
		history: [],
		nodes: {
			plan: { status: "completed", startedAt: 1000, completedAt: 2000 },
			review: { status: "failed", startedAt: 2000, completedAt: 3000, error: "review failed" },
		},
		approvals: [{ nodeId: "approve_plan", approved: true, requestedAt: 1, resolvedAt: 2, resumeCount: 0 }],
		resumeCount: 2,
		startedAt: 1000,
		updatedAt: 3000,
		completedAt: 3000,
		error: "review failed",
		lastFailure: {
			kind: "node",
			nodeId: "review",
			message: "review failed",
			attempt: 1,
			maxAttempts: 1,
			occurredAt: 3000,
			handled: false,
			resumable: true,
		},
	};
}

test("registry-derived list and unknown-graph errors include every graph", () => {
	assert.deepEqual(graphNames, ["research"]);
	for (const name of graphNames) {
		assert.match(formatGraphListText(), new RegExp(name));
		assert.match(formatUnknownGraphMessage("missing"), new RegExp(name));
	}

	const added = {
		...graphDefinitions[0],
		name: "third",
	} as RegisteredGraphDefinition;
	const dynamic = createGraphRegistry([...graphDefinitions, added]);
	assert.deepEqual(dynamic.names, ["research", "third"]);
});

test("graph name parameter accepts dynamic catalog strings instead of a static enum", () => {
	const schema = graphNameParameter() as unknown as { type?: string; enum?: string[] };
	assert.equal(schema.type, "string");
	assert.equal(schema.enum, undefined);
	assert.match(formatGraphToolDescription(), /graph_list/);
});

test("graph-run renderer exposes compact and expanded operational state", () => {
	const state = renderState();
	const compact = formatGraphRunEntry(state, false, theme);
	assert.match(compact, /sample failed/);
	assert.match(compact, /current review/);
	assert.match(compact, /runid123/);
	assert.doesNotMatch(compact, /resumeCount/);

	const expanded = formatGraphRunEntry(state, true, theme);
	assert.match(expanded, /resumeCount 2/);
	assert.match(expanded, /approve_plan: approved/);
	assert.match(expanded, /plan: completed \(1s\)/);
	assert.match(expanded, /review failed/);
	assert.match(expanded, /summary text/);

	const legacy = { ...state, schemaVersion: undefined, approvals: undefined, resumeCount: undefined } as unknown as GraphState;
	const legacyText = formatGraphRunEntry(legacy, true, theme);
	assert.match(legacyText, /legacy checkpoint: view-only/);
	assert.match(legacyText, /resume not resumable/);
});

test("graph-run model content keeps completed output and returns bounded resumable failure JSON", () => {
	const error = `provider failed: ${"x".repeat(10_000)}`;
	const state = {
		...renderState(),
		cwd: "/private/workspace",
		data: { secret: "must not leak" },
		history: [{ id: "history", nodeId: "review", type: "error" as const, timestamp: 1, error: "must not leak" }],
		error,
		nodes: {
			...renderState().nodes,
			review: { ...renderState().nodes.review, error },
		},
	};
	const failed: GraphRunResult = {
		summary: `Graph sample failed: ${error}`,
		status: "failed",
		state,
		projection: {
			kind: "pi.graph-run",
			schemaVersion: 1,
			revision: 2,
			runId: state.runId,
			graphName: state.graphName,
			graphVersion: state.graphVersion,
			goal: state.goal,
			status: "failed",
			currentNodeId: "review",
			mutationPolicy: "read-only",
			startedAt: state.startedAt,
			updatedAt: state.updatedAt,
			completedAt: state.completedAt,
			resumeCount: state.resumeCount,
			progress: { completed: 1, total: 2 },
			nodes: [
				{ id: "plan", label: "plan", type: "prompt", status: "completed" },
				{ id: "review", label: "review", type: "prompt", status: "failed", error },
			],
			edges: [],
		},
	};

	const content = formatGraphRunModelContent(failed);
	const parsed = JSON.parse(content) as {
		kind: string;
		status: string;
		graph: string;
		runId: string;
		resumeNodeId: string;
		resumeCount: number;
		error: string;
		failedNodes: Array<{ id: string; error?: string }>;
		resumable: boolean;
		resume: { tool: string; arguments: { runId: string; expectedResumeCount: number } };
	};
	assert.equal(parsed.kind, "graph_run_failed");
	assert.equal(parsed.status, "failed");
	assert.equal(parsed.graph, "sample");
	assert.equal(parsed.runId, state.runId);
	assert.equal(parsed.resumeNodeId, "review");
	assert.equal(parsed.resumeCount, 2);
	assert.equal(parsed.resumable, true);
	assert.deepEqual(parsed.resume, {
		tool: "graph_resume",
		arguments: { runId: state.runId, expectedResumeCount: 2 },
	});
	assert.equal(parsed.failedNodes[0]?.id, "review");
	assert.ok(parsed.error.length < error.length);
	assert.ok((parsed.failedNodes[0]?.error?.length ?? error.length) < error.length);
	assert.doesNotMatch(content, /private\/workspace|must not leak|history/);

	assert.equal(formatGraphRunModelContent({
		...failed,
		status: "completed",
		summary: "final model-visible output",
		state: { ...state, status: "completed", error: undefined },
		projection: { ...failed.projection, status: "completed" },
	}), "final model-visible output");
	const oversizedCompleted = formatGraphRunModelContent({
		...failed,
		status: "completed",
		summary: "x".repeat(60 * 1024),
		state: { ...state, status: "completed", error: undefined },
		projection: { ...failed.projection, status: "completed" },
	});
	assert.ok(Buffer.byteLength(oversizedCompleted, "utf8") <= 50 * 1024);
	const oversizedStructured = formatGraphRunModelContent({
		...failed,
		status: "completed",
		output: { lanes: Array.from({ length: 8 }, () => "x".repeat(49 * 1024)) },
		summary: "unused structured summary",
		state: { ...state, status: "completed", error: undefined },
		projection: { ...failed.projection, status: "completed" },
	});
	assert.ok(Buffer.byteLength(oversizedStructured, "utf8") <= 50 * 1024);
	const structuredEnvelope = JSON.parse(oversizedStructured) as {
		kind: string;
		modelPreviewTruncated: boolean;
		fullOutputRetainedInHostDetails: boolean;
	};
	assert.equal(structuredEnvelope.kind, "graph_run_output_truncated");
	assert.equal(structuredEnvelope.modelPreviewTruncated, true);
	assert.equal(structuredEnvelope.fullOutputRetainedInHostDetails, true);
	const oversizedStructuredLines = formatGraphRunModelContent({
		...failed,
		status: "completed",
		output: Array.from({ length: 3_000 }, () => 0),
		summary: "unused structured summary",
		state: { ...state, status: "completed", error: undefined },
		projection: { ...failed.projection, status: "completed" },
	});
	assert.equal((JSON.parse(oversizedStructuredLines) as { modelPreviewTruncated: boolean }).modelPreviewTruncated, true);

	const legacyFailure = JSON.parse(formatGraphRunModelContent({
		...failed,
		state: { ...state, lastFailure: undefined },
	})) as { resumable: boolean; resume?: unknown };
	assert.equal(legacyFailure.resumable, false);
	assert.equal(legacyFailure.resume, undefined);

	const nonResumable = JSON.parse(formatGraphRunModelContent({
		...failed,
		state: {
			...state,
			lastFailure: {
				kind: "runtime",
				nodeId: "review",
				message: "Graph exceeded maxSteps (2).",
				attempt: 2,
				maxAttempts: 3,
				occurredAt: 3,
				handled: false,
				resumable: false,
			},
		},
	})) as { resumable: boolean; resume?: unknown };
	assert.equal(nonResumable.resumable, false);
	assert.equal(nonResumable.resume, undefined);

	const escapedError = `${"\u0000\"\\\n".repeat(2_000)}`;
	const manyFailures = formatGraphRunModelContent({
		...failed,
		state: { ...state, error: escapedError },
		projection: {
			...failed.projection,
			nodes: Array.from({ length: 64 }, (_, index) => ({
				id: `failed_${index}`,
				label: `failed_${index}`,
				type: "prompt",
				status: "failed" as const,
				error: escapedError,
			})),
		},
	});
	assert.ok(Buffer.byteLength(manyFailures, "utf8") < 50 * 1024);
	const bounded = JSON.parse(manyFailures) as { failedNodes: unknown[]; omittedFailedNodeCount: number };
	assert.equal(bounded.failedNodes.length, 8);
	assert.equal(bounded.omittedFailedNodeCount, 56);
});

test("extension registration exposes list, create, delete, run, and resume tools with sequential mutating entry points", () => {
	const commands = new Map<string, unknown>();
	const tools = new Map<string, { description?: string; executionMode?: string; parameters?: unknown }>();
	let graphRunRenderer: ((entry: { data?: { state?: GraphState } }, options: { expanded: boolean }, theme: TestTheme) => unknown) | undefined;
	const extensionApi = {
		registerEntryRenderer(customType: string, renderer: typeof graphRunRenderer) {
			if (customType === "graph-run") graphRunRenderer = renderer;
		},
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
		registerTool(value: { name: string; description?: string; executionMode?: string; parameters?: unknown }) {
			tools.set(value.name, value);
		},
		events: { on: () => () => undefined, emit() {} },
		on() {},
	} as unknown as ExtensionAPI;
	graphEngineeringExtension(extensionApi);

	assert.ok(graphRunRenderer);
	const running = { ...renderState(), status: "running" as const };
	assert.equal(graphRunRenderer({ data: { state: running } }, { expanded: false }, theme), undefined);
	assert.ok(graphRunRenderer({ data: { state: renderState() } }, { expanded: false }, theme));
	assert.deepEqual([...commands.keys()].sort(), ["graph", "graph-list", "graph-resume", "graph-status"]);
	assert.deepEqual([...tools.keys()].sort(), ["graph_capabilities", "graph_create", "graph_delete", "graph_history", "graph_list", "graph_resume", "graph_rollback", "graph_run", "graph_update"]);
	assert.equal(tools.get("graph_list")?.executionMode, undefined);
	assert.equal(tools.get("graph_create")?.executionMode, "sequential");
	assert.equal(tools.get("graph_delete")?.executionMode, "sequential");
	assert.equal(tools.get("graph_history")?.executionMode, undefined);
	assert.equal(tools.get("graph_update")?.executionMode, "sequential");
	assert.equal(tools.get("graph_rollback")?.executionMode, "sequential");
	assert.equal(tools.get("graph_resume")?.executionMode, "sequential");
	assert.equal(tools.get("graph_run")?.executionMode, "sequential");
	assert.equal(tools.get("graph_run")?.description, formatGraphToolDescription());
	const parameters = tools.get("graph_run")?.parameters as { properties?: { graph?: { type?: string; enum?: string[] } } };
	assert.equal(parameters.properties?.graph?.type, "string");
	assert.equal(parameters.properties?.graph?.enum, undefined);
	const resumeParameters = tools.get("graph_resume")?.parameters as {
		properties?: {
			runId?: { type?: string };
			expectedResumeCount?: { type?: string; minimum?: number };
		};
		required?: string[];
		additionalProperties?: boolean;
	};
	assert.equal(resumeParameters.properties?.runId?.type, "string");
	assert.equal(resumeParameters.properties?.expectedResumeCount?.type, "integer");
	assert.equal(resumeParameters.properties?.expectedResumeCount?.minimum, 0);
	assert.deepEqual(resumeParameters.required, ["runId", "expectedResumeCount"]);
	assert.equal(resumeParameters.additionalProperties, false);
});
