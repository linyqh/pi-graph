import { readGraphEditInput, graphEditError, GraphEditFailureTracker } from "./edit-input.ts";
import { listGraphToolCapabilities, listGraphSkillCapabilities, resolveSubagentExtensions, validateSkillTools } from "./capabilities.ts";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { graphDefinitions, graphRegistry } from "../../graphs/index.ts";
import type { GraphCatalog } from "./catalog.ts";
import { createGraphCatalogStore } from "./catalog.ts";
import { type DeclarativeGraphSpec, allNodes, collectDeclarativeSkillNames, collectDeclarativeToolNames, DeclarativeGraphSpecSchema, parseDeclarativeGraphSpec, renderDeclarativeGraphSummary, serializeDeclarativeGraphSpec } from "./declarative.ts";
import { ProjectGraphRevisionConflictError, type GraphSpecChange } from "./graph-revisions.ts";
import { declarativeProjectGraphCompiler, migrateLegacyProjectGraphs, PROJECT_GRAPH_MAX_BYTES, resolveProjectGraphsDirectory } from "./project-graphs.ts";
import { createProjectGraphRunStore } from "./run-store.ts";
import { findLastGraphRun, findLatestGraphRuns, interruptOrphanedGraphRuns, isLegacyGraphState, resumeGraph, runGraph } from "./runtime.ts";
import { createGraphExecutionServices, truncateText } from "./services.ts";
import {
	GRAPH_ASSIGNED_SKILL_REGISTER_CHANNEL,
	GRAPH_ASSIGNED_SKILL_REQUEST_CHANNEL,
	parseRegisteredAssignedSkill,
	resolveAssignedSkills,
	type AssignedSkill,
} from "./skill-selection.ts";
import { listAvailableToolNames, resolveAssignedTools } from "./tool-selection.ts";
import type { GraphCheckpointEntry, GraphRunResult, GraphState } from "./types.ts";
import { projectGraphRunView } from "./view-projection.ts";

type RenderableGraphState = GraphState;
type ThemeLike = {
	bold(text: string): string;
	fg(name: string, text: string): string;
};

let graphQueue: Promise<void> = Promise.resolve();

const builtInCatalog: GraphCatalog = {
	definitions: graphDefinitions,
	graphs: graphRegistry.graphs,
	names: graphDefinitions.map((graph) => graph.name).sort(),
	entries: Object.fromEntries(graphDefinitions.map((definition) => [definition.name, {
		definition,
		source: { kind: "built-in" as const },
	}])),
	sources: Object.fromEntries(graphDefinitions.map((graph) => [graph.name, { kind: "built-in" as const }])),
	diagnostics: [],
};

function parseGraphArgs(args: string): { graphName?: string; goal?: string } {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const [graphName, ...goalParts] = trimmed.split(/\s+/);
	return { graphName, goal: goalParts.join(" ").trim() };
}

function parseResumeArgs(args: string): { runId?: string } {
	const runId = args.trim();
	return runId ? { runId } : {};
}

function shortRunId(runId: string): string {
	const parts = runId.split("-");
	const suffix = parts.at(-1) ?? runId;
	return suffix.length > 8 ? suffix.slice(0, 8) : suffix;
}

function duration(startedAt?: number, completedAt?: number): string {
	if (!startedAt) return "n/a";
	const end = completedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function statusColor(status: RenderableGraphState["status"]): string {
	if (status === "failed") return "error";
	if (status === "completed") return "success";
	if (status === "interrupted") return "warning";
	return "warning";
}

export function formatGraphListText(catalog: GraphCatalog = builtInCatalog): string {
	const graphs = catalog.definitions
		.map((graph) => {
			const approvals = graph.approvalBindings.length > 0
				? ` approvals=${graph.approvalBindings.map((binding) => `${binding.node}->${binding.capability}`).join(",")}`
				: "";
			const sourceInfo = catalog.sources[graph.name];
			const source = sourceInfo?.kind === "project" ? `project:${sourceInfo.path ?? "unknown"}` : "built-in";
			const identity = graph.definitionHash ? ` hash=${graph.definitionHash} sourcePath=${graph.sourcePath ?? "unknown"}` : "";
			return `${graph.name} v${graph.version} [${graph.mutationPolicy}] [${source}] - ${graph.description ?? "No description."}${approvals}${identity}`;
		});
	const diagnostics = catalog.diagnostics.map((item) => `! ${item.path ?? item.graphName ?? "project graph"}: ${item.message}`);
	return truncateText([...graphs, ...diagnostics].join("\n")).text;
}

export function formatUnknownGraphMessage(graphName: string, catalog: GraphCatalog = builtInCatalog): string {
	return truncateText(`Unknown graph: ${graphName}. Available: ${catalog.names.join(", ")}`).text;
}

export function formatGraphToolDescription(): string {
	return "Run a built-in or trusted project graph for a goal. Use graph_list to discover graph names available in the current cwd. If it returns a resumable failure, diagnose and repair the reported cause before calling graph_resume with the exact returned arguments; do not blindly retry.";
}

export function graphNameParameter() {
	return Type.String({
		description: "Graph name returned by graph_list or /graph-list.",
	});
}

function formatStatus(result: Pick<GraphRunResult, "state">): string {
	const state = result.state;
	const lines = [`${state.graphName} ${state.status} (${state.runId})`];
	for (const [nodeId, node] of Object.entries(state.nodes)) {
		lines.push(`- ${nodeId}: ${node.status}${node.error ? ` - ${node.error}` : ""}`);
	}
	if (state.error) lines.push(`error: ${state.error}`);
	if (isLegacyGraphState(state)) lines.push("legacy checkpoint: view-only; this run cannot be resumed");
	return truncateText(lines.join("\n")).text;
}

function formatGraphChanges(changes: GraphSpecChange[]): string {
	if (changes.length === 0) return "changes=none";
	const lines = changes.map((change) => {
		const before = change.before === undefined ? "" : ` before=${JSON.stringify(change.before)}`;
		const after = change.after === undefined ? "" : ` after=${JSON.stringify(change.after)}`;
		return `- ${change.kind} ${change.path || "/"}${before}${after}`;
	});
	return truncateText(`changes=${changes.length}\n${lines.join("\n")}`).text;
}

const GRAPH_RUN_MODEL_ERROR_MAX_BYTES = 512;
const GRAPH_RUN_MODEL_FAILED_NODE_LIMIT = 8;
const GRAPH_RUN_MODEL_MAX_BYTES = 50 * 1024;
const GRAPH_RUN_MODEL_MAX_LINES = 2000;

function boundGraphRunModelError(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "unknown error");
	if (Buffer.byteLength(text, "utf8") <= GRAPH_RUN_MODEL_ERROR_MAX_BYTES) return text;

	const marker = "…";
	let bounded = "";
	for (const character of text) {
		if (Buffer.byteLength(`${bounded}${character}${marker}`, "utf8") > GRAPH_RUN_MODEL_ERROR_MAX_BYTES) break;
		bounded += character;
	}
	return `${bounded}${marker}`;
}

export function formatGraphRunModelContent(result: GraphRunResult): string {
	if (result.status !== "failed") {
		if (result.output !== undefined && typeof result.output !== "string") {
			const serialized = JSON.stringify(result.output, null, 2);
			if (
				Buffer.byteLength(serialized, "utf8") <= GRAPH_RUN_MODEL_MAX_BYTES
				&& serialized.split("\n").length <= GRAPH_RUN_MODEL_MAX_LINES
			) return serialized;
			return JSON.stringify({
				kind: "graph_run_output_truncated",
				status: result.status,
				graph: result.projection.graphName,
				runId: result.projection.runId,
				outputType: Array.isArray(result.output) ? "array" : "object",
				preview: boundGraphRunModelError(serialized),
				modelPreviewTruncated: true,
				fullOutputRetainedInHostDetails: true,
			});
		}
		return truncateText(result.summary).text;
	}

	const projection = result.projection;
	const errorSource = result.state.error ?? result.summary;
	const error = boundGraphRunModelError(errorSource);
	const resumable = Boolean(projection.currentNodeId) && result.state.lastFailure?.resumable === true;
	const failedNodes = projection.nodes
		.filter((node) => node.status === "failed")
		.slice(0, GRAPH_RUN_MODEL_FAILED_NODE_LIMIT)
		.map((node) => ({
			id: node.id,
			error: boundGraphRunModelError(node.error ?? errorSource),
		}));

	return JSON.stringify({
		kind: "graph_run_failed",
		status: result.status,
		graph: projection.graphName,
		runId: projection.runId,
		resumeNodeId: projection.currentNodeId ?? null,
		resumeCount: projection.resumeCount,
		error,
		failedNodes,
		omittedFailedNodeCount: Math.max(0, projection.nodes.filter((node) => node.status === "failed").length - failedNodes.length),
		resumable,
		...(resumable ? { resume: {
			tool: "graph_resume",
			arguments: {
				runId: projection.runId,
				expectedResumeCount: projection.resumeCount,
			},
		} } : {}),
	});
}

function findGraphRun(entries: GraphCheckpointEntry[], cwd: string, runId?: string): GraphState | undefined {
	for (const state of findLatestGraphRuns(entries)) {
		if (state.cwd !== cwd) continue;
		if (runId && state.runId !== runId) continue;
		if (state.status === "completed" || state.status === "running") continue;
		return state;
	}
	return undefined;
}

function approvalLines(state: RenderableGraphState): string[] {
	const lines = (state.approvals ?? []).map((approval) => {
		const status = approval.approved ? "approved" : "declined";
		return `${approval.nodeId}: ${status} (resume ${approval.resumeCount})`;
	});
	for (const [key, value] of Object.entries(state.data)) {
		if (!value || typeof value !== "object" || !("approved" in value)) continue;
		if (lines.some((line) => line.startsWith(`${key}:`))) continue;
		const approved = (value as { approved?: unknown }).approved;
		lines.push(`${key}: ${approved === true ? "approved" : approved === false ? "declined" : "unknown"}`);
	}
	return lines;
}

function nodeLines(state: RenderableGraphState): string[] {
	return Object.entries(state.nodes).map(([nodeId, node]) => {
		let line = `${nodeId}: ${node.status} (${duration(node.startedAt, node.completedAt)})`;
		if (node.error) line += ` - ${node.error}`;
		return line;
	});
}

function errorLines(state: RenderableGraphState): string[] {
	const lines = Object.entries(state.nodes)
		.filter(([, node]) => typeof node.error === "string")
		.map(([nodeId, node]) => `${nodeId}: ${node.error}`);
	if (state.error) lines.push(`graph: ${state.error}`);
	return lines;
}

export function formatGraphRunEntry(state: RenderableGraphState, expanded: boolean, theme: ThemeLike, summary?: string): string {
	let text = `${theme.fg("toolTitle", theme.bold(state.graphName))} ${theme.fg(statusColor(state.status), state.status)}`;
	text += ` ${theme.fg("dim", `#${shortRunId(state.runId)}`)}`;
	text += `\n${theme.fg("muted", "current ")}${theme.fg("accent", state.currentNode ?? "done")}`;

	if (!expanded) return truncateText(text).text;

	text += `\n${theme.fg("muted", "duration ")}${duration(state.startedAt, state.completedAt)}`;
	text += `\n${theme.fg("muted", "updated ")}${new Date(state.updatedAt).toISOString()}`;
	text += `\n${theme.fg("muted", "resumeCount ")}${String(state.resumeCount ?? 0)}`;

	const approvals = approvalLines(state);
	text += `\n${theme.fg("muted", "approvals ")}${approvals.length > 0 ? approvals.join(", ") : "none"}`;

	const nodes = nodeLines(state);
	text += `\n${theme.fg("muted", "nodes ")}${nodes.length > 0 ? nodes.join("; ") : "none"}`;

	const resumable = !isLegacyGraphState(state) && ["paused", "interrupted", "failed"].includes(state.status);
	text += `\n${theme.fg("muted", "resume ")}${resumable ? `/graph-resume ${state.runId}` : "not resumable"}`;
	if (isLegacyGraphState(state)) text += `\n${theme.fg("warning", "legacy checkpoint: view-only")}`;

	const errors = errorLines(state);
	if (errors.length > 0) text += `\n${theme.fg("muted", "errors ")}${errors.join("; ")}`;

	const summaryText = summary ?? (typeof state.data.finalSummary === "string" ? state.data.finalSummary : undefined);
	if (summaryText) text += `\n\n${theme.fg("dim", summaryText)}`;

	return truncateText(text).text;
}

async function runQueued<T>(run: () => Promise<T>): Promise<T> {
	const result = graphQueue.then(run, run);
	graphQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export default function graphEngineeringExtension(pi: ExtensionAPI) {
	const editFailures = new GraphEditFailureTracker();
	let editTurnStopped = false;
	const resetEditFailures = () => { editFailures.clear(); editTurnStopped = false; };
	pi.on("before_agent_start", resetEditFailures);
	pi.on("session_start", resetEditFailures);
	pi.on("tool_call", () => editTurnStopped ? {
		block: true, terminate: true,
		reason: "This turn stopped after repeated graph edit errors. Fix the draft and retry on a new user turn; do not bypass graph_update through other tools.",
	} : undefined);
	pi.on("tool_result", (event) => {
		if (!["graph_create", "graph_update", "graph_rollback", "graph_history"].includes(event.toolName)) return;
		const status = (event.details as { status?: string } | undefined)?.status;
		if (status && ["invalid", "stale", "untrusted", "error"].includes(status)) return { isError: true };
	});
	function editFailure(ctx: ExtensionContext, tool: string, error: unknown, spec?: DeclarativeGraphSpec) {
		const message = graphEditError(error, spec);
		const key = `${ctx.cwd}\0${tool}\0${spec?.name ?? "unknown"}`;
		const recovery = editFailures.record(key, message);
		if (recovery.repeated) editTurnStopped = true;
		const stale = error instanceof ProjectGraphRevisionConflictError;
		return {
			content: [{ type: "text" as const, text: truncateText(`Graph ${tool === "graph_create" ? "creation" : "update"} ${stale ? "rejected as stale" : "failed validation"}: ${message}\n${recovery.guidance}`).text }],
			details: { status: stale ? "stale" : "invalid", error: message, repeatedFailure: recovery.repeated, attempts: recovery.attempts, actualDefinitionHash: stale ? error.actualDefinitionHash : undefined },
			isError: true,
			terminate: recovery.repeated,
		};
	}

	const registeredSkills: AssignedSkill[] = [];
	pi.events.on(GRAPH_ASSIGNED_SKILL_REGISTER_CHANNEL, (value) => {
		const skill = parseRegisteredAssignedSkill(value);
		if (!skill) return;
		if (!registeredSkills.some((entry) => entry.name === skill.name && entry.path === skill.path)) {
			registeredSkills.push(skill);
		}
	});
	const requestRegisteredSkills = () => {
		registeredSkills.length = 0;
		pi.events.emit(GRAPH_ASSIGNED_SKILL_REQUEST_CHANNEL, { schemaVersion: 1 });
	};
	const servicesFor = (ctx: ExtensionContext) => createGraphExecutionServices(ctx, pi, () => registeredSkills);
	requestRegisteredSkills();

	const catalogStore = createGraphCatalogStore({
		builtInDefinitions: graphDefinitions,
		compiler: declarativeProjectGraphCompiler,
	});
	let activeCatalog = builtInCatalog;

	async function catalogFor(ctx: ExtensionContext, reload = false): Promise<GraphCatalog> {
		const request = { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() };
		const catalog = reload ? await catalogStore.reload(request) : await catalogStore.getCatalog(request);
		activeCatalog = catalog;
		return catalog;
	}

	function validateSpecResources(ctx: ExtensionContext, value: unknown) {
		const spec = parseDeclarativeGraphSpec(value);
		const skillNames = collectDeclarativeSkillNames(spec);
		if (skillNames.length > 0) resolveAssignedSkills(ctx.getSystemPrompt(), skillNames, registeredSkills);
		resolveAssignedTools(listAvailableToolNames(pi), collectDeclarativeToolNames(spec));
		for (const node of allNodes(spec)) {
			if (node.type !== "subagent") continue;
			resolveSubagentExtensions(pi, node.tools);
			validateSkillTools(resolveAssignedSkills(ctx.getSystemPrompt(), node.skills ?? [], registeredSkills), node.tools);
		}
		return spec;
	}

	async function runnableGraph(ctx: ExtensionContext, catalog: GraphCatalog, name: string): Promise<GraphCatalog["graphs"][string]> {
		const graph = catalog.graphs[name];
		if (!graph) throw new Error(`Unknown graph: ${name}`);
		if (catalog.entries[name]?.source.kind !== "project" || !ctx.isProjectTrusted()) return graph;
		const ensured = await catalogStore.ensureProjectGraphRevision({ cwd: ctx.cwd, trusted: true, name });
		return ensured?.graph.definition ?? graph;
	}

	async function graphForCheckpoint(ctx: ExtensionContext, state: GraphState): Promise<GraphCatalog["graphs"][string]> {
		const catalog = await catalogFor(ctx, true);
		const current = catalog.graphs[state.graphName];
		if (
			current
			&& current.version === state.graphVersion
			&& current.definitionHash === state.graphDefinitionHash
			&& current.sourcePath === state.graphSourcePath
		) return current;
		if (ctx.isProjectTrusted() && state.graphSourcePath?.startsWith(".agent-graph/graphs/")) {
			return catalogStore.resolveProjectGraphRevision({
				cwd: ctx.cwd,
				trusted: true,
				name: state.graphName,
				version: state.graphVersion,
				definitionHash: state.graphDefinitionHash,
				sourcePath: state.graphSourcePath,
			});
		}
		if (current) return current;
		throw new Error(`Graph unavailable for checkpoint: ${state.graphName}`);
	}

	pi.registerEntryRenderer<{ state?: RenderableGraphState; summary?: string }>("graph-run", (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data?.state) return new Text("Graph run checkpoint unavailable.", 0, 0);
		if (data.state.status === "running") return undefined;
		return new Text(formatGraphRunEntry(data.state, expanded ?? false, theme, data.summary), 0, 0);
	});

	pi.on("session_start", () => {
		requestRegisteredSkills();
	});

	pi.registerCommand("graph-list", {
		description: "List available agent graphs",
		handler: async (_args, ctx) => {
			const catalog = await catalogFor(ctx);
			ctx.ui.notify(catalog.definitions.length > 0 ? formatGraphListText(catalog) : "No graphs registered.", "info");
		},
	});

	pi.registerCommand("graph-status", {
		description: "Show the latest graph run checkpoint in this session",
		handler: async (_args, ctx) => {
			const last = findLastGraphRun(ctx.sessionManager.getBranch() as GraphCheckpointEntry[]);
			if (!last) {
				ctx.ui.notify("No graph run checkpoint found in this session.", "info");
				return;
			}
			ctx.ui.notify(formatStatus({ state: last }), last.status === "failed" ? "error" : "info");
		},
	});

	pi.registerCommand("graph", {
		description: "Run an agent graph: /graph <name> <goal>",
		getArgumentCompletions: (prefix) => {
			const firstToken = prefix.trimStart().split(/\s+/)[0] ?? "";
			if (prefix.includes(" ")) return null;
			const items = activeCatalog.names
				.filter((name) => name.startsWith(firstToken))
				.map((name) => ({ value: name, label: name, description: activeCatalog.graphs[name].description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const { graphName, goal } = parseGraphArgs(args);
			if (!graphName || !goal) {
				ctx.ui.notify("Usage: /graph <name> <goal>", "warning");
				return;
			}
			const catalog = await catalogFor(ctx);
			const graph = catalog.graphs[graphName];
			if (!graph) {
				ctx.ui.notify(formatUnknownGraphMessage(graphName, catalog), "error");
				return;
			}

			try {
				const result = await runQueued(async () => {
					const currentCatalog = await catalogFor(ctx, true);
					const executableGraph = await runnableGraph(ctx, currentCatalog, graphName);
					const checkpoints = ctx.sessionManager.getBranch() as GraphCheckpointEntry[];
					return runGraph(pi, executableGraph, {
						goal,
						cwd: ctx.cwd,
						extensionContext: ctx,
						ui: ctx.hasUI ? ctx.ui : undefined,
						checkpoints,
						runStore: ctx.isProjectTrusted() ? createProjectGraphRunStore(ctx.cwd) : undefined,
						services: servicesFor(ctx),
					});
				});
				ctx.ui.notify(formatStatus(result), result.status === "failed" ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("graph-resume", {
		description: "Resume the latest graph run for this branch and cwd, or /graph-resume <runId>",
		handler: async (args, ctx) => {
			const { runId } = parseResumeArgs(args);
			try {
				await runQueued(async () => {
					const checkpoints = ctx.sessionManager.getBranch() as GraphCheckpointEntry[];
					const last = findGraphRun(checkpoints, ctx.cwd, runId);
					if (!last) {
						ctx.ui.notify(runId ? `No resumable graph run found for ${runId}.` : "No resumable graph run found for this branch and cwd.", "warning");
						return;
					}
					if (isLegacyGraphState(last)) {
						ctx.ui.notify(`Graph run ${last.runId} is a legacy view-only checkpoint and cannot be resumed.`, "warning");
						return;
					}

					const graph = await graphForCheckpoint(ctx, last);

					const result = await resumeGraph(pi, graph, last, {
						cwd: ctx.cwd,
						extensionContext: ctx,
						ui: ctx.hasUI ? ctx.ui : undefined,
						checkpoints,
						runStore: ctx.isProjectTrusted() ? createProjectGraphRunStore(ctx.cwd) : undefined,
						services: servicesFor(ctx),
					});
					ctx.ui.notify(formatStatus(result), result.status === "failed" ? "error" : "info");
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "graph_capabilities",
		label: "Graph Capabilities",
		description: "Discover all registered tools (including inactive ones) and skills for graph node assignment, with child-loadability and required tools. Does not enable tools. Call before graph_create/update; paginate until nextOffset is null.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Filter names/descriptions; omit for the full catalog." })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = (params.query ?? "").trim().toLowerCase();
			const entries = [
				...listGraphToolCapabilities(pi, ctx).map((tool) => ({ kind: "tool", ...tool })),
				...listGraphSkillCapabilities(ctx.getSystemPrompt(), registeredSkills).map((skill) => ({ kind: "skill", ...skill })),
			].filter((entry) => !query || JSON.stringify(entry).toLowerCase().includes(query));
			const offset = params.offset ?? 0;
			const limit = params.limit ?? 40;
			const end = offset + limit;
			const details = { entries: entries.slice(offset, end), total: entries.length, nextOffset: end < entries.length ? end : null };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});

	pi.registerTool({
		name: "graph_list",
		label: "Graph List",
		description: "List built-in and trusted project graphs available in the current cwd, including load diagnostics.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const catalog = await catalogFor(ctx, true);
			const text = catalog.definitions.length > 0 ? formatGraphListText(catalog) : "No graphs registered.";
			return {
				content: [{ type: "text", text }],
				details: {
					names: catalog.names,
					graphs: catalog.names.map((name) => ({
						name,
						version: catalog.graphs[name].version,
						mutationPolicy: catalog.graphs[name].mutationPolicy,
						definitionHash: catalog.graphs[name].definitionHash,
						sourcePath: catalog.graphs[name].sourcePath,
						source: catalog.sources[name],
					})),
					sources: catalog.sources,
					diagnostics: catalog.diagnostics,
				},
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("graph_list")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const content = result.content[0];
			return new Text(theme.fg("muted", content?.type === "text" ? content.text : "No graph catalog."), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_create",
		label: "Graph Create",
		description: "Validate and save a confirmed declarative graph in the trusted current project. Inspect graph_capabilities first; call only after the create-graph skill reaches shared understanding.",
		executionMode: "sequential",
		parameters: Type.Object({
			spec: Type.Optional(DeclarativeGraphSpecSchema),
			specFile: Type.Optional(Type.String({ minLength: 1, description: "Path to a draft JSON file (relative to cwd or absolute). Prefer this for large graphs. Supply exactly one of spec/specFile." })),
			validateOnly: Type.Optional(Type.Boolean({ description: "Validate and preview without asking for approval or writing any graph/history files." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) {
				const text = "Project graph creation requires a trusted cwd.";
				return { content: [{ type: "text", text }], details: { status: "untrusted" } };
			}

			let spec: DeclarativeGraphSpec | undefined;
			try {
				spec = validateSpecResources(ctx, await readGraphEditInput(params, ctx.cwd));
				const catalog = await catalogFor(ctx);
				if (catalog.graphs[spec.name]) {
					throw new Error(`Graph already exists in catalog: ${spec.name}`);
				}
				const path = join(resolveProjectGraphsDirectory(ctx.cwd), `${spec.name}.json`);
				declarativeProjectGraphCompiler.compile(spec, {
					cwd: ctx.cwd,
					path,
				});
				const serialized = serializeDeclarativeGraphSpec(spec);
				if (Buffer.byteLength(`${serialized.json}\n`, "utf8") > PROJECT_GRAPH_MAX_BYTES) {
					throw new Error(`Project graph exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`);
				}
				const summary = `${renderDeclarativeGraphSummary(spec)}\npath=${path}`;

				editFailures.reset(`${ctx.cwd}\0graph_create\0${spec.name}`);
				if (params.validateOnly) {
					return { content: [{ type: "text", text: `Graph validated. No files were written.\n${summary}` }], details: { status: "validated", graph: spec.name, summary } };
				}
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: truncateText(`Graph validated but was not written because interactive approval is unavailable.\n${summary}`).text }],
						details: { status: "approval_required", path, summary },
					};
				}

				const approved = await ctx.ui.confirm("Create project graph?", summary);
				if (!approved) {
					return {
						content: [{ type: "text", text: truncateText(`Graph creation cancelled. No file was written.\n${summary}`).text }],
						details: { status: "cancelled", path, summary },
					};
				}

				const saved = await catalogStore.saveProjectGraph({ cwd: ctx.cwd, trusted: true, spec });
				activeCatalog = saved.catalog;
				return {
					content: [{ type: "text", text: truncateText(`Created graph ${spec.name}. It is available immediately.\n${summary}`).text }],
					details: { status: "created", graph: spec.name, path: saved.path, summary },
				};
			} catch (error) {
				return editFailure(ctx, "graph_create", error, spec);
			}
		},
		renderCall(args, theme) {
			const spec = args.spec as { name?: unknown } | undefined;
			return new Text(
				theme.fg("toolTitle", theme.bold("graph_create ")) + theme.fg("accent", String(spec?.name ?? args.specFile ?? "...")),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const content = result.content[0];
			return new Text(theme.fg("muted", content?.type === "text" ? content.text : "No graph creation result."), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_history",
		label: "Graph History",
		description: "Inspect immutable revisions for a trusted project graph. Optionally select one revision to return its spec and diff from the active definition.",
		parameters: Type.Object({
			graph: graphNameParameter(),
			definitionHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) {
				return { content: [{ type: "text", text: "Project graph history requires a trusted cwd." }], details: { status: "untrusted" } };
			}
			try {
				const inspection = await catalogStore.getProjectGraphHistory({
					cwd: ctx.cwd,
					trusted: true,
					name: params.graph,
					definitionHash: params.definitionHash,
				});
				const text = truncateText(JSON.stringify({ status: "ok", ...inspection }, null, 2)).text;
				return { content: [{ type: "text", text }], details: { status: "ok", ...inspection } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: truncateText(`Graph history failed: ${message}`).text }], details: { status: "error", graph: params.graph, error: message } };
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("graph_history ")) + theme.fg("accent", String(args.graph ?? "...")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const content = result.content[0];
			return new Text(theme.fg("muted", content?.type === "text" ? content.text : "No graph history."), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_update",
		label: "Graph Update",
		description: "Validate, diff, confirm, and atomically activate a project graph. Prefer specFile to preserve draft fields; use validateOnly to preview. After an error, fix the draft instead of repeating inline JSON.",
		executionMode: "sequential",
		parameters: Type.Object({
			spec: Type.Optional(DeclarativeGraphSpecSchema),
			specFile: Type.Optional(Type.String({ minLength: 1, description: "Path to a draft JSON file (relative to cwd or absolute). Prefer this for large graphs. Supply exactly one of spec/specFile." })),
			validateOnly: Type.Optional(Type.Boolean({ description: "Validate and preview without asking for approval or writing any graph/history files." })),
			expectedDefinitionHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) {
				return { content: [{ type: "text", text: "Project graph update requires a trusted cwd." }], details: { status: "untrusted" } };
			}
			let spec: DeclarativeGraphSpec | undefined;
			try {
				spec = validateSpecResources(ctx, await readGraphEditInput(params, ctx.cwd));
				const prepared = await catalogStore.prepareProjectGraphUpdate({
					cwd: ctx.cwd,
					trusted: true,
					spec,
					expectedDefinitionHash: params.expectedDefinitionHash,
				});
				if (prepared.noChange) {
					return { content: [{ type: "text", text: `Graph ${spec.name} is already at the requested definition.` }], details: { status: "no_change", graph: spec.name, definitionHash: params.expectedDefinitionHash } };
				}
				const summary = truncateText([
					`graph=${spec.name}`,
					`from=${prepared.current.definition.version}@${prepared.current.definition.definitionHash}`,
					`to=${prepared.candidate.definition.version}@${prepared.candidate.definition.definitionHash}`,
					formatGraphChanges(prepared.diff),
					renderDeclarativeGraphSummary(spec),
				].join("\n")).text;
				editFailures.reset(`${ctx.cwd}\0graph_update\0${spec.name}`);
				if (params.validateOnly) {
					return { content: [{ type: "text", text: `Graph validated. No files were written.\n${summary}` }], details: { status: "validated", graph: spec.name, summary } };
				}
				if (!ctx.hasUI) {
					return { content: [{ type: "text", text: `Graph validated but was not updated because interactive approval is unavailable.\n${summary}` }], details: { status: "approval_required", graph: spec.name, summary } };
				}
				if (!await ctx.ui.confirm("Update project graph?", summary)) {
					return { content: [{ type: "text", text: `Graph update cancelled. No active definition was changed.\n${summary}` }], details: { status: "cancelled", graph: spec.name, summary } };
				}
				const updated = await catalogStore.updateProjectGraph({
					cwd: ctx.cwd,
					trusted: true,
					spec,
					expectedDefinitionHash: params.expectedDefinitionHash,
				});
				activeCatalog = updated.catalog;
				return {
					content: [{ type: "text", text: truncateText(`Updated graph ${spec.name}.\n${summary}`).text }],
					details: { status: "updated", graph: spec.name, definitionHash: updated.graph.definition.definitionHash, previousDefinitionHash: params.expectedDefinitionHash, diff: updated.diff },
				};
			} catch (error) {
				return editFailure(ctx, "graph_update", error, spec);
			}
		},
		renderCall(args, theme) {
			const spec = args.spec as { name?: unknown } | undefined;
			return new Text(theme.fg("toolTitle", theme.bold("graph_update ")) + theme.fg("accent", String(spec?.name ?? args.specFile ?? "...")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const content = result.content[0];
			return new Text(theme.fg("muted", content?.type === "text" ? content.text : "No graph update result."), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_rollback",
		label: "Graph Rollback",
		description: "Confirm and reactivate an exact immutable revision of a trusted project graph.",
		executionMode: "sequential",
		parameters: Type.Object({
			graph: graphNameParameter(),
			targetDefinitionHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
			expectedDefinitionHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) {
				return { content: [{ type: "text", text: "Project graph rollback requires a trusted cwd." }], details: { status: "untrusted" } };
			}
			try {
				const inspection = await catalogStore.getProjectGraphHistory({ cwd: ctx.cwd, trusted: true, name: params.graph, definitionHash: params.targetDefinitionHash });
				if (!inspection.selected) throw new Error(`Graph revision not found: ${params.targetDefinitionHash}`);
				validateSpecResources(ctx, inspection.selected.spec);
				if (inspection.history.headDefinitionHash !== params.expectedDefinitionHash) {
					throw new ProjectGraphRevisionConflictError("Project graph changed since rollback was requested.", inspection.history.headDefinitionHash);
				}
				if (params.targetDefinitionHash === params.expectedDefinitionHash) {
					return { content: [{ type: "text", text: `Graph ${params.graph} is already at revision ${params.targetDefinitionHash}.` }], details: { status: "no_change", graph: params.graph, definitionHash: params.targetDefinitionHash } };
				}
				const target = inspection.history.revisions.find((item) => item.definitionHash === params.targetDefinitionHash);
				const active = inspection.history.revisions.find((item) => item.definitionHash === params.expectedDefinitionHash);
				const summary = truncateText([
					`graph=${params.graph}`,
					`from=${active?.version ?? "unknown"}@${params.expectedDefinitionHash}`,
					`to=${target?.version ?? "unknown"}@${params.targetDefinitionHash}`,
					formatGraphChanges(inspection.selected.diffFromActive),
				].join("\n")).text;
				if (!ctx.hasUI) {
					return { content: [{ type: "text", text: `Graph was not rolled back because interactive approval is unavailable.\n${summary}` }], details: { status: "approval_required", graph: params.graph, summary } };
				}
				if (!await ctx.ui.confirm("Rollback project graph?", summary)) {
					return { content: [{ type: "text", text: `Graph rollback cancelled. No active definition was changed.\n${summary}` }], details: { status: "cancelled", graph: params.graph, summary } };
				}
				const rolledBack = await catalogStore.rollbackProjectGraph({
					cwd: ctx.cwd,
					trusted: true,
					name: params.graph,
					targetDefinitionHash: params.targetDefinitionHash,
					expectedDefinitionHash: params.expectedDefinitionHash,
				});
				activeCatalog = rolledBack.catalog;
				return { content: [{ type: "text", text: `Rolled back graph ${params.graph} to ${params.targetDefinitionHash}.` }], details: { status: "rolled_back", graph: params.graph, definitionHash: params.targetDefinitionHash, previousDefinitionHash: params.expectedDefinitionHash, diff: rolledBack.diff } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const stale = error instanceof ProjectGraphRevisionConflictError;
				return { content: [{ type: "text", text: truncateText(`Graph rollback ${stale ? "rejected as stale" : "failed"}: ${message}`).text }], details: { status: stale ? "stale" : "error", graph: params.graph, error: message, actualDefinitionHash: stale ? error.actualDefinitionHash : undefined } };
			}
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("graph_rollback ")) + theme.fg("accent", String(args.graph ?? "...")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const content = result.content[0];
			return new Text(theme.fg("muted", content?.type === "text" ? content.text : "No graph rollback result."), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_delete",
		label: "Graph Delete",
		description: "Delete an existing trusted project graph after interactive confirmation. Built-in graphs cannot be deleted.",
		executionMode: "sequential",
		parameters: Type.Object({
			graph: graphNameParameter(),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.isProjectTrusted()) {
				const text = "Project graph deletion requires a trusted cwd.";
				return { content: [{ type: "text", text }], details: { status: "untrusted" } };
			}

			try {
				const catalog = await catalogFor(ctx, true);
				const entry = catalog.entries[params.graph];
				if (!entry) {
					return {
						content: [{ type: "text", text: formatUnknownGraphMessage(params.graph, catalog) }],
						details: { status: "not_found", graph: params.graph, available: catalog.names },
					};
				}
				if (entry.source.kind !== "project") {
					const text = `Built-in graph cannot be deleted: ${params.graph}`;
					return { content: [{ type: "text", text }], details: { status: "built_in", graph: params.graph } };
				}

				const path = entry.source.path;
				if (!path) throw new Error(`Project graph path is unavailable: ${params.graph}`);
				const summary = `graph=${params.graph}\npath=${path}\nThis permanently deletes the project graph definition.`;
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: truncateText(`Graph was not deleted because interactive approval is unavailable.\n${summary}`).text }],
						details: { status: "approval_required", graph: params.graph, path },
					};
				}

				const approved = await ctx.ui.confirm("Delete project graph?", summary);
				if (!approved) {
					return {
						content: [{ type: "text", text: truncateText(`Graph deletion cancelled. No file was deleted.\n${summary}`).text }],
						details: { status: "cancelled", graph: params.graph, path },
					};
				}

				const deleted = await catalogStore.deleteProjectGraph({ cwd: ctx.cwd, trusted: true, name: params.graph });
				activeCatalog = deleted.catalog;
				return {
					content: [{ type: "text", text: `Deleted graph ${params.graph}.` }],
					details: { status: "deleted", graph: params.graph, path: deleted.path },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: truncateText(`Graph deletion failed: ${message}`).text }],
					details: { status: "error", graph: params.graph, error: message },
				};
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("graph_delete ")) + theme.fg("accent", String(args.graph ?? "...")),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const content = result.content[0];
			return new Text(theme.fg("muted", content?.type === "text" ? content.text : "No graph deletion result."), 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_run",
		label: "Graph Run",
		description: formatGraphToolDescription(),
		executionMode: "sequential",
		parameters: Type.Object({
			graph: graphNameParameter(),
			goal: Type.String({ description: "Goal for the graph" }),
			input: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional initial graph state data" })),
			context: Type.Optional(Type.Record(
				Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
				Type.String({ maxLength: 256 }),
				{ description: "Bounded immutable run identity projected to the UI", maxProperties: 16 },
			)),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.input && Object.hasOwn(params.input, "__graphError")) {
				const text = "Graph run rejected: input cannot use reserved key __graphError.";
				return { content: [{ type: "text", text }], details: { status: "rejected", reason: "reserved_input_key" } };
			}
			const catalog = await catalogFor(ctx);
			const graph = catalog.graphs[params.graph];
			if (!graph) {
				return {
					content: [{ type: "text", text: formatUnknownGraphMessage(params.graph, catalog) }],
					details: { graph: params.graph, available: catalog.names },
				};
			}

			const result = await runQueued(async () => {
				const currentCatalog = await catalogFor(ctx, true);
				const executableGraph = await runnableGraph(ctx, currentCatalog, params.graph);
				const checkpoints = ctx.sessionManager.getBranch() as GraphCheckpointEntry[];
				return runGraph(pi, executableGraph, {
					goal: params.goal,
					input: params.input,
					context: params.context,
					cwd: ctx.cwd,
					signal,
					extensionContext: ctx,
					ui: ctx.hasUI ? ctx.ui : undefined,
					onUpdate,
					checkpoints,
					runStore: ctx.isProjectTrusted() ? createProjectGraphRunStore(ctx.cwd) : undefined,
					services: servicesFor(ctx),
				});
			});

			return {
				content: [{ type: "text", text: formatGraphRunModelContent(result) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("graph_run ")) +
					theme.fg("accent", String(args.graph ?? "...")) +
					theme.fg("dim", ` ${String(args.goal ?? "")}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as GraphRunResult | undefined;
			if (!details?.state) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "No graph result.", 0, 0);
			}
			const state = details.state;
			let text = formatGraphRunEntry(state, false, theme, details.summary);
			for (const [nodeId, node] of Object.entries(state.nodes)) {
				if (!expanded && node.status === "pending") continue;
				text += `\n${theme.fg("muted", "- ")}${theme.fg("accent", nodeId)} ${node.status}`;
				if (node.error) text += ` ${theme.fg("error", node.error)}`;
			}
			if (expanded) text = formatGraphRunEntry(state, true, theme, details.summary);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "graph_resume",
		label: "Graph Resume",
		description: "Resume the exact latest failed graph snapshot in the current session branch and cwd. Pass the runId and resumeCount returned by graph_run.",
		executionMode: "sequential",
		parameters: Type.Object({
			runId: Type.String({ description: "Failed graph run ID returned by graph_run.", minLength: 1, maxLength: 128 }),
			expectedResumeCount: Type.Integer({ description: "Compare-and-swap resumeCount returned by graph_run.", minimum: 0 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runQueued(async () => {
				const reject = (reason: string, message: string, extra: Record<string, unknown> = {}) => ({
					content: [{ type: "text" as const, text: message }],
					details: {
						status: "rejected" as const,
						reason,
						runId: params.runId,
						expectedResumeCount: params.expectedResumeCount,
						...extra,
					},
				});

				try {
					const checkpoints = ctx.sessionManager.getBranch() as GraphCheckpointEntry[];
					const latest = findLatestGraphRuns(checkpoints).find((state) => state.runId === params.runId);
					if (!latest || latest.cwd !== ctx.cwd) {
						return reject(
							"not_found",
							`Graph resume rejected: no latest snapshot for ${params.runId} in the current branch and cwd.`,
						);
					}
					if (isLegacyGraphState(latest)) {
						return reject(
							"legacy_snapshot",
							`Graph resume rejected: the latest snapshot for ${params.runId} is legacy and view-only.`,
						);
					}
					if (latest.status !== "failed") {
						return reject(
							"not_failed",
							`Graph resume rejected: the latest snapshot for ${params.runId} is not failed (status ${latest.status}).`,
							{ actualStatus: latest.status, actualResumeCount: latest.resumeCount },
						);
					}
					if (latest.resumeCount !== params.expectedResumeCount) {
						return reject(
							"resume_count_mismatch",
							`Graph resume rejected: expected resume count ${params.expectedResumeCount} does not match latest resume count ${latest.resumeCount}.`,
							{ actualResumeCount: latest.resumeCount },
						);
					}
					if (latest.lastFailure?.resumable !== true) {
						return reject(
							"non_resumable_failure",
							`Graph resume rejected: the latest failure for ${params.runId} is not explicitly marked resumable by this runtime.`,
							{ failureKind: latest.lastFailure?.kind ?? "unknown" },
						);
					}

					const graph = await graphForCheckpoint(ctx, latest);

					const result = await resumeGraph(pi, graph, latest, {
						cwd: ctx.cwd,
						signal,
						extensionContext: ctx,
						ui: ctx.hasUI ? ctx.ui : undefined,
						onUpdate,
						checkpoints,
						runStore: ctx.isProjectTrusted() ? createProjectGraphRunStore(ctx.cwd) : undefined,
						services: servicesFor(ctx),
					});
					return {
						content: [{ type: "text" as const, text: formatGraphRunModelContent(result) }],
						details: result,
					};
				} catch (error) {
					const message = boundGraphRunModelError(error instanceof Error ? error.message : error);
					return reject(
						"resume_rejected",
						`Graph resume rejected: ${message}`,
						{ error: message },
					);
				}
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("graph_resume ")) +
					theme.fg("accent", String(args.runId ?? "...")) +
					theme.fg("dim", ` @${String(args.expectedResumeCount ?? "...")}`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as GraphRunResult | undefined;
			if (!details?.state) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "No graph resume result.", 0, 0);
			}
			return new Text(formatGraphRunEntry(details.state, expanded, theme, details.summary), 0, 0);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const trusted = ctx.isProjectTrusted();
		let migrationDiagnostics = 0;
		try {
			const migration = await migrateLegacyProjectGraphs({ cwd: ctx.cwd, trusted });
			migrationDiagnostics = migration.diagnostics.filter((item) => item.code !== "untrusted").length;
			if (migration.migrated.length > 0) {
				ctx.ui.notify(`Migrated ${migration.migrated.length} project graph definition(s) to ${migration.directory}.`, "info");
			}
			const catalog = await catalogFor(ctx, true);
			const actionableDiagnostics = catalog.diagnostics.filter((item) => item.code !== "untrusted").length + migrationDiagnostics;
			if (actionableDiagnostics > 0) {
				ctx.ui.notify(`${actionableDiagnostics} project graph storage issue(s) need attention. Run /graph-list for definition details.`, "warning");
			}
		} catch (error) {
			ctx.ui.notify(`Project graph catalog failed to load: ${error instanceof Error ? error.message : String(error)}`, "error");
		}

		const runStore = createProjectGraphRunStore(ctx.cwd);
		if (trusted) {
			try {
				for (const state of findLatestGraphRuns(ctx.sessionManager.getBranch() as GraphCheckpointEntry[])) {
					// v2 project checkpoints are authoritative; stale session logs must never overwrite them.
					if (state.schemaVersion === 2) continue;
					const graph = activeCatalog.graphs[state.graphName];
					runStore.persist(state, graph ? projectGraphRunView(graph, state) : undefined);
				}
			} catch (error) {
				ctx.ui.notify(`Project graph run migration failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		const interrupted = interruptOrphanedGraphRuns(pi, ctx.sessionManager.getBranch() as GraphCheckpointEntry[], {
			cwd: ctx.cwd,
			ui: ctx.hasUI ? ctx.ui : undefined,
			graphForName: (name) => activeCatalog.graphs[name],
			...(trusted ? { runStore } : {}),
		});
		if (interrupted.length > 0) {
			const last = interrupted[0];
			ctx.ui.setStatus("graph-engine", `${last.graphName}: interrupted`);
		}
	});
}
