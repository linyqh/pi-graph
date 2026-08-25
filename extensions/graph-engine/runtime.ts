import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	GraphCheckpointEntry,
	GraphCheckpointEnvelope,
	GraphDefinition,
	GraphEvent,
	GraphFailure,
	GraphNode,
	GraphNodeResult,
	GraphNodeStatus,
	GraphRunOptions,
	GraphRunResult,
	GraphRuntimeServices,
	GraphState,
	JsonObject,
} from "./types.ts";
import { GRAPH_STATE_SCHEMA_VERSION, GraphControlFlowError } from "./types.ts";
import { createGraphExecutionServices } from "./services.ts";
import { projectGraphSourcePathsEquivalent } from "./storage.ts";
import { assertValidGraph } from "./validation.ts";
import { flattenGraphNodes, projectGraphRunView } from "./view-projection.ts";

const activeRunByCwd = new Map<string, string>();

function now(): number {
	return Date.now();
}

function createRunId(graphName: string): string {
	return `${graphName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function copyJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function mergeData(target: JsonObject, source?: JsonObject): void {
	if (!source) return;
	for (const [key, value] of Object.entries(source)) {
		target[key] = value;
	}
}

function stringifySummaryValue(value: unknown): string | undefined {
	if (typeof value === "string") return value.length > 0 ? value : undefined;
	if (value === undefined) return undefined;
	return JSON.stringify(value, null, 2);
}

function runtimeNow(services: GraphRuntimeServices): number {
	try {
		return services.now();
	} catch (error) {
		if (error instanceof GraphControlFlowError) throw error;
		throw new GraphControlFlowError(error instanceof Error ? error.message : String(error));
	}
}

function makeEvent(
	services: GraphRuntimeServices,
	nodeId: string,
	type: GraphEvent["type"],
	patch: Omit<GraphEvent, "id" | "nodeId" | "type" | "timestamp"> = {},
): GraphEvent {
	return {
		id: `${nodeId}-${runtimeNow(services).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		nodeId,
		type,
		timestamp: runtimeNow(services),
		...patch,
	};
}

function summarizeState(state: GraphState): string {
	if (state.status === "completed") {
		const final = state.finalOutput !== undefined
			? state.finalOutput
			: state.data.finalSummary ?? state.data.review ?? state.data.implementation ?? state.data.plan;
		return stringifySummaryValue(final) ?? `Graph ${state.graphName} completed.`;
	}
	if (state.status === "failed") return `Graph ${state.graphName} failed: ${state.error ?? "unknown error"}`;
	if (state.status === "interrupted") return `Graph ${state.graphName} interrupted at ${state.currentNode ?? "unknown"}.`;
	if (state.status === "paused") return `Graph ${state.graphName} paused at ${state.currentNode ?? "unknown"}.`;
	return `Graph ${state.graphName} running at ${state.currentNode ?? "unknown"}.`;
}

function resultFor(graph: GraphDefinition, state: GraphState): GraphRunResult {
	const copiedState = copyJson(state);
	const resultState: GraphState = { ...copiedState, context: validateGraphRunContext(copiedState.context) };
	return {
		summary: summarizeState(state),
		status: state.status,
		output: state.finalOutput === undefined ? undefined : copyJson(state.finalOutput),
		state: resultState,
		projection: projectGraphRunView(graph, state),
	};
}

function effectiveUi(options: GraphRunOptions): GraphRunOptions["ui"] {
	return options.ui ?? (options.extensionContext?.hasUI ? options.extensionContext.ui : undefined);
}

function defaultRuntimeServices(pi: ExtensionAPI, graph: GraphDefinition | undefined, options: GraphRunOptions): GraphRuntimeServices {
	const ui = effectiveUi(options);
	return {
		now,
		createRunId,
		persistCheckpoint(state) {
			const projection = graph ? projectGraphRunView(graph, state) : undefined;
			options.runStore?.persist(copyJson(state), projection ? copyJson(projection) : undefined);
			pi.appendEntry("graph-run", copyJson({
				runId: state.runId,
				graphName: state.graphName,
				status: state.status,
				currentNode: state.currentNode,
				state,
				...(projection ? { projection } : {}),
			}));
		},
		emitUpdate(state, message) {
			if (!graph) return;
			options.onUpdate?.({
				content: [{ type: "text", text: message ?? summarizeState(state) }],
				details: resultFor(graph, state),
			});
		},
		setStatus(state) {
			ui?.setStatus("graph-engine", `${state.graphName}: ${state.currentNode ?? state.status}`);
		},
		clearStatus() {
			ui?.setStatus("graph-engine", undefined);
		},
		async confirmResume(state, node) {
			if (!ui) return false;
			return ui.confirm(
				"Resume graph node?",
				`Resume ${node.label ?? node.id} for graph ${state.graphName}. This node may modify the workspace.`,
			);
		},
	};
}

function resolveRuntimeServices(pi: ExtensionAPI, graph: GraphDefinition | undefined, options: GraphRunOptions): GraphRuntimeServices {
	return {
		...defaultRuntimeServices(pi, graph, options),
		...(options.runtimeServices ?? {}),
	};
}

function persist(services: GraphRuntimeServices, state: GraphState): void {
	try {
		services.persistCheckpoint(copyJson(state));
	} catch (error) {
		if (error instanceof GraphControlFlowError) throw error;
		throw new GraphControlFlowError(error instanceof Error ? error.message : String(error));
	}
}

function emitUpdate(services: GraphRuntimeServices, state: GraphState, message?: string): void {
	try {
		services.emitUpdate(state, message);
		services.setStatus(state);
	} catch {
		// Rendering and progress callbacks are observational. They must not alter
		// persisted workflow semantics or turn completed work into a failed node.
	}
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError";
}

function nodeMayModify(node: GraphNode): boolean {
	return node.capabilities?.mutatesWorkspace === true || node.capabilities?.readOnly === false;
}

function contextIsTrusted(options: GraphRunOptions): boolean {
	const trust = (options.extensionContext as { isProjectTrusted?: unknown } | undefined)?.isProjectTrusted;
	if (typeof trust === "function") return Boolean((trust as () => boolean)());
	return false;
}

function assertMutationAuthorized(graph: GraphDefinition, state: GraphState, node: GraphNode, options: GraphRunOptions): void {
	if (!nodeMayModify(node)) return;
	if (graph.mutationPolicy === "read-only") {
		throw new Error(`Graph ${graph.name} does not allow workspace mutation.`);
	}
	if (!contextIsTrusted(options)) {
		throw new Error(`Node ${node.id} requires a trusted project before mutating workspace state.`);
	}
	if (graph.mutationPolicy === "mutating" && !node.approvalNodeId) return;
	if (!node.approvalNodeId) {
		throw new Error(`Node ${node.id} has no approval binding.`);
	}
	const approval = [...state.approvals].reverse().find((record) => record.nodeId === node.approvalNodeId);
	if (!approval?.approved) {
		throw new Error(`Node ${node.id} requires approval from ${node.approvalNodeId}.`);
	}
}

function assertKnownTransition(graph: GraphDefinition, node: GraphNode, next: string): void {
	if (!graph.nodes[next]) throw new Error(`Unknown graph node: ${next}`);
	const allowed = new Set([
		...(node.transitions ?? []).map((transition) => transition.to),
		...(node.routerCandidates ?? []),
		...(graph.transitions ?? [])
			.filter((transition) => transition.from === node.id && transition.to)
			.map((transition) => transition.to as string),
	]);
	if (allowed.size > 0 && !allowed.has(next)) {
		throw new Error(`Node ${node.id} returned undeclared transition: ${next}`);
	}
}

function extractApproval(state: GraphState, node: GraphNode, result: GraphNodeResult, timestamp: number): void {
	if (node.type !== "approval") return;
	const candidates = Object.values(result.data ?? {});
	const approvalValue = candidates.find((value): value is { approved: boolean } => {
		return typeof value === "object" && value !== null && typeof (value as { approved?: unknown }).approved === "boolean";
	});
	if (!approvalValue) return;
	state.approvals.push({
		nodeId: node.id,
		approved: approvalValue.approved,
		requestedAt: timestamp,
		resolvedAt: timestamp,
		resumeCount: state.resumeCount,
	});
}

function pauseReason(result: GraphNodeResult): string | undefined {
	if (result.pause) return result.pause.reason;
	const pausedValue = Object.values(result.data ?? {}).find((value) => {
		return typeof value === "object" && value !== null && (value as { paused?: unknown }).paused === true;
	});
	if (!pausedValue || typeof pausedValue !== "object") return undefined;
	const reason = (pausedValue as { reason?: unknown }).reason;
	return typeof reason === "string" && reason.trim() ? reason : "pause_requested";
}

function errorMessage(options: GraphRunOptions, error: unknown): string {
	const executionServices = options.services ?? createGraphExecutionServices(options.extensionContext);
	return executionServices.truncate(error instanceof Error ? error.message : String(error)) as string;
}

function exposeFailure(state: GraphState, failure: GraphFailure): void {
	state.lastFailure = copyJson(failure);
	state.data.__graphError = copyJson(failure);
}

/**
 * Lift the stop reason and output size a node's meta already carries up onto the
 * node's own status, where a reader looking at the run can see them without
 * knowing that `<id>Meta` exists.
 */
function executionTelemetry(node: GraphNode, data: JsonObject | undefined): Pick<GraphNodeStatus, "stopReason" | "outputTokens"> {
	const meta = data?.[`${node.id}Meta`];
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	const source = meta as { stopReason?: unknown; usage?: { output?: unknown } };
	const stopReason = typeof source.stopReason === "string" ? source.stopReason : undefined;
	const output = source.usage?.output;
	const outputTokens = typeof output === "number" && Number.isFinite(output) ? output : undefined;
	return { ...(stopReason ? { stopReason } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
}

async function executeNode(
	pi: ExtensionAPI,
	services: GraphRuntimeServices,
	graph: GraphDefinition,
	state: GraphState,
	node: GraphNode,
	options: GraphRunOptions,
	observableState: GraphState = state,
): Promise<GraphNodeResult> {
	const executionServices = options.services ?? createGraphExecutionServices(options.extensionContext, pi);
	return node.run({
		pi,
		graph,
		state,
		cwd: options.cwd,
		signal: options.signal,
		extensionContext: options.extensionContext,
		ui: effectiveUi(options),
		services: executionServices,
		setSubagentExecution(execution) {
			const subagent = executionServices.truncate(execution) as typeof execution;
			state.nodes[node.id] = { ...state.nodes[node.id], subagent };
			observableState.nodes[node.id] = { ...observableState.nodes[node.id], subagent };
			const timestamp = runtimeNow(services);
			state.updatedAt = timestamp;
			observableState.updatedAt = timestamp;
			persist(services, observableState);
			emitUpdate(services, observableState, `Initialized Subagent ${execution.agentName}.`);
		},
		emit(message, data) {
			const truncatedData = data ? executionServices.truncate(data) as JsonObject : undefined;
			const truncatedMessage = executionServices.truncate(message) as string;
			mergeData(state.data, truncatedData);
			const timestamp = runtimeNow(services);
			state.updatedAt = timestamp;
			observableState.updatedAt = timestamp;
			observableState.history.push(makeEvent(services, node.id, "checkpoint", { message: truncatedMessage, output: truncatedData }));
			emitUpdate(services, observableState, truncatedMessage);
		},
		async runChildNode(childNode, childState = copyJson(state)) {
			const startedAt = runtimeNow(services);
			const startEvent = makeEvent(services, childNode.id, "start");
			const stagedState = copyJson(observableState);
			stagedState.nodes[childNode.id] = { status: "running", startedAt };
			stagedState.updatedAt = startedAt;
			stagedState.history.push(startEvent);
			persist(services, stagedState);
			observableState.nodes[childNode.id] = { status: "running", startedAt };
			observableState.updatedAt = startedAt;
			observableState.history.push(startEvent);
			childState.nodes[childNode.id] = { status: "running", startedAt };
			emitUpdate(services, observableState, `Running ${childNode.label ?? childNode.id}...`);
			try {
				const result = await executeNode(pi, services, graph, childState, childNode, options, observableState);
				const completedAt = runtimeNow(services);
				observableState.nodes[childNode.id] = { ...observableState.nodes[childNode.id], status: "completed", startedAt, completedAt };
				observableState.updatedAt = completedAt;
				observableState.history.push(makeEvent(services, childNode.id, "success", { message: result.summary }));
				persist(services, observableState);
				emitUpdate(services, observableState, result.summary);
				return result;
			} catch (error) {
				const completedAt = runtimeNow(services);
				const message = executionServices.truncate(error instanceof Error ? error.message : String(error)) as string;
				const interrupted = isAbortError(error, options.signal);
				observableState.nodes[childNode.id] = {
					...observableState.nodes[childNode.id],
					status: interrupted ? "interrupted" : "failed",
					startedAt,
					completedAt,
					error: interrupted ? undefined : message,
				};
				observableState.updatedAt = completedAt;
				observableState.history.push(makeEvent(services, childNode.id, interrupted ? "checkpoint" : "error", {
					error: interrupted ? undefined : message,
					message: interrupted ? message : undefined,
				}));
				persist(services, observableState);
				emitUpdate(services, observableState, message);
				throw error;
			}
		},
	});
}

function resetNodeTreeForResume(state: GraphState, node: GraphNode): void {
	state.nodes[node.id] = { status: "pending" };
	for (const child of node.children ?? []) resetNodeTreeForResume(state, child);
}

const GRAPH_CONTEXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const BLOCKED_CONTEXT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function validateGraphRunContext(value: unknown): Readonly<Record<string, string>> {
	if (value === undefined) return Object.freeze({});
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new GraphControlFlowError("Graph context must be an object.");
	const entries = Object.entries(value);
	if (entries.length > 16) throw new GraphControlFlowError("Graph context may contain at most 16 entries.");
	const result: Record<string, string> = {};
	for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
		if (!GRAPH_CONTEXT_KEY_RE.test(key) || BLOCKED_CONTEXT_KEYS.has(key)) throw new GraphControlFlowError(`Graph context key is unsafe: ${key}`);
		if (typeof item !== "string" || Buffer.byteLength(item, "utf8") > 256) {
			throw new GraphControlFlowError(`Graph context value for ${key} must be a string of at most 256 UTF-8 bytes.`);
		}
		result[key] = item;
	}
	return Object.freeze(result);
}

function createInitialState(graph: GraphDefinition, options: GraphRunOptions, services: GraphRuntimeServices): GraphState {
	const startedAt = runtimeNow(services);
	const executionServices = options.services ?? createGraphExecutionServices(options.extensionContext);
	const goal = executionServices.truncate(options.goal) as string;
	const input = executionServices.truncate(options.input ?? {}) as JsonObject;
	if (Object.hasOwn(input, "__graphError")) {
		throw new GraphControlFlowError("Graph input cannot use reserved key: __graphError");
	}
	return {
		schemaVersion: GRAPH_STATE_SCHEMA_VERSION,
		runId: services.createRunId(graph.name),
		graphName: graph.name,
		graphVersion: graph.version,
		graphDefinitionHash: graph.definitionHash,
		graphSourcePath: graph.sourcePath,
		goal,
		cwd: options.cwd,
		context: validateGraphRunContext(options.context),
		status: "running",
		currentNode: graph.start,
		data: { goal, ...input },
		history: [],
		nodes: Object.fromEntries(flattenGraphNodes(graph).map(({ node }) => [node.id, { status: "pending" as const }])),
		approvals: [],
		resumeCount: 0,
		startedAt,
		updatedAt: startedAt,
	};
}

function latestStateFromEntry(entry: GraphCheckpointEntry): GraphState | undefined {
	if (entry.type !== "custom" || entry.customType !== "graph-run") return undefined;
	const data = entry.data as Partial<GraphCheckpointEnvelope> | undefined;
	if (!data?.state || typeof data.state !== "object") return undefined;
	return data.state as GraphState;
}

export function isLegacyGraphState(state: unknown): boolean {
	if (!state || typeof state !== "object") return true;
	return (state as { schemaVersion?: unknown }).schemaVersion !== GRAPH_STATE_SCHEMA_VERSION;
}

export function findLatestGraphRuns(entries: GraphCheckpointEntry[]): GraphState[] {
	const latestByRunId = new Map<string, { state: GraphState; index: number }>();
	for (const [index, entry] of entries.entries()) {
		const state = latestStateFromEntry(entry);
		if (!state?.runId) continue;
		latestByRunId.set(state.runId, { state, index });
	}
	return [...latestByRunId.values()]
		.sort((left, right) => right.index - left.index)
		.map(({ state }) => state);
}

function assertNoOtherActiveRun(cwd: string, checkpoints: GraphCheckpointEntry[] | undefined): void {
	const activeInMemory = activeRunByCwd.get(cwd);
	if (activeInMemory) {
		throw new Error(`Another graph run is already active for cwd: ${cwd}`);
	}

	for (const state of findLatestGraphRuns(checkpoints ?? [])) {
		if (state.cwd !== cwd) continue;
		if (state.status === "running") {
			throw new Error(`Graph run ${state.runId} is already active for cwd: ${cwd}`);
		}
	}
}

async function prepareResumeState(
	graph: GraphDefinition,
	options: GraphRunOptions,
	services: GraphRuntimeServices,
): Promise<GraphState> {
	const checkpoint = options.resumeFrom;
	if (!checkpoint) throw new Error("Missing resume checkpoint.");
	if (isLegacyGraphState(checkpoint)) {
		throw new Error(`Cannot resume legacy graph state schema: ${String(checkpoint.schemaVersion)}`);
	}
	if (graph.deleted) throw new Error(`Cannot resume deleted graph: ${graph.name}`);
	if (checkpoint.graphName !== graph.name) {
		throw new Error(`Cannot resume ${checkpoint.graphName} state with graph ${graph.name}.`);
	}
	if (checkpoint.graphVersion !== graph.version) {
		throw new Error(`Cannot resume graph ${graph.name}: checkpoint version ${checkpoint.graphVersion ?? "none"} does not match graph version ${graph.version ?? "none"}.`);
	}
	if (checkpoint.graphDefinitionHash !== graph.definitionHash) {
		throw new Error(`Cannot resume graph ${graph.name}: graph definition hash does not match the checkpoint.`);
	}
	if (!projectGraphSourcePathsEquivalent(checkpoint.graphSourcePath, graph.sourcePath)) {
		throw new Error(`Cannot resume graph ${graph.name}: graph source path does not match the checkpoint.`);
	}
	if (checkpoint.cwd !== options.cwd) {
		throw new Error(`Cannot resume graph ${graph.name}: cwd mismatch (${checkpoint.cwd} !== ${options.cwd}).`);
	}
	if (checkpoint.status === "completed") {
		throw new Error(`Cannot resume completed graph run: ${checkpoint.runId}`);
	}
	if (checkpoint.status !== "paused" && checkpoint.status !== "interrupted" && checkpoint.status !== "failed") {
		throw new Error(`Cannot resume graph run ${checkpoint.runId} from status ${checkpoint.status}.`);
	}
	if (!checkpoint.currentNode) throw new Error(`Cannot resume graph run ${checkpoint.runId}: missing current node.`);
	const currentNode = checkpoint.currentNode;
	const node = graph.nodes[currentNode];
	if (!node || node.deleted) throw new Error(`Cannot resume graph run ${checkpoint.runId}: node ${currentNode} no longer exists.`);

	if (nodeMayModify(node)) {
		const approved = await services.confirmResume(checkpoint, node);
		if (!approved) {
			const paused = copyJson(checkpoint);
			paused.status = "paused";
			paused.updatedAt = runtimeNow(services);
			paused.error = undefined;
			paused.completedAt = undefined;
			persist(services, paused);
			emitUpdate(services, paused, `Graph ${graph.name} remains paused at ${node.label ?? node.id}.`);
			return paused;
		}
	}

	const checkpointContext = validateGraphRunContext(checkpoint.context);
	if (options.context && JSON.stringify(validateGraphRunContext(options.context)) !== JSON.stringify(checkpointContext)) {
		throw new Error(`Cannot resume graph ${graph.name}: immutable context does not match the checkpoint.`);
	}
	const state: GraphState = { ...copyJson(checkpoint), context: checkpointContext };
	for (const { node: graphNode } of flattenGraphNodes(graph)) {
		state.nodes[graphNode.id] ??= { status: "pending" };
	}
	state.status = "running";
	state.error = undefined;
	state.completedAt = undefined;
	state.resumeCount += 1;
	state.updatedAt = runtimeNow(services);
	resetNodeTreeForResume(state, node);
	return state;
}

async function createRunnableState(
	graph: GraphDefinition,
	options: GraphRunOptions,
	services: GraphRuntimeServices,
): Promise<GraphState> {
	if (options.resumeFrom) return prepareResumeState(graph, options, services);
	return createInitialState(graph, options, services);
}

type NodeExecutionOutcome =
	| { kind: "success"; result: GraphNodeResult }
	| { kind: "routed"; failure: GraphFailure; target: string }
	| { kind: "terminal"; failure: GraphFailure };

async function executeNodeWithPolicy(
	pi: ExtensionAPI,
	services: GraphRuntimeServices,
	graph: GraphDefinition,
	state: GraphState,
	node: GraphNode,
	options: GraphRunOptions,
	claimStep: () => void,
): Promise<NodeExecutionOutcome> {
	const maxAttempts = node.failure?.maxAttempts ?? 1;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (options.signal?.aborted) throw new Error("Graph run was aborted.");
		claimStep();

		const startedAt = runtimeNow(services);
		state.nodes[node.id] = {
			...state.nodes[node.id],
			status: "running",
			startedAt,
			completedAt: undefined,
			error: undefined,
			attempts: attempt,
			maxAttempts,
			subagent: undefined,
		};
		state.history.push(makeEvent(services, node.id, "start", { attempt, maxAttempts, resumeCount: state.resumeCount }));
		state.updatedAt = startedAt;
		persist(services, state);
		emitUpdate(
			services,
			state,
			maxAttempts > 1
				? `Running ${node.label ?? node.id} (attempt ${attempt}/${maxAttempts})...`
				: `Running ${node.label ?? node.id}...`,
		);

		try {
			const immutableContext = state.context;
			const result = await executeNode(pi, services, graph, state, node, options);
			if (state.context !== immutableContext) throw new GraphControlFlowError("Graph nodes cannot replace immutable run context.");
			return { kind: "success", result };
		} catch (error) {
			if (isAbortError(error, options.signal)) throw error;
			if (error instanceof GraphControlFlowError) throw error;
			const occurredAt = runtimeNow(services);
			const message = errorMessage(options, error);
			const retrying = attempt < maxAttempts;
			const onError = retrying ? undefined : node.failure?.onError;
			const failure: GraphFailure = {
				kind: "node",
				nodeId: node.id,
				message,
				attempt,
				maxAttempts,
				occurredAt,
				handled: Boolean(onError),
				...(onError ? { onError } : {}),
				resumable: !onError,
			};

			state.nodes[node.id] = {
				...state.nodes[node.id],
				status: retrying ? "pending" : "failed",
				completedAt: occurredAt,
				error: message,
				attempts: attempt,
				maxAttempts,
			};
			state.history.push(makeEvent(services, node.id, "error", {
				error: message,
				attempt,
				maxAttempts,
			}));
			state.updatedAt = occurredAt;

			if (retrying) {
				state.history.push(makeEvent(services, node.id, "retry", {
					message: `Retrying ${node.label ?? node.id} after attempt ${attempt}/${maxAttempts}.`,
					attempt,
					maxAttempts,
				}));
				persist(services, state);
				emitUpdate(services, state, `Retrying ${node.label ?? node.id} (${attempt + 1}/${maxAttempts})...`);
				continue;
			}

			exposeFailure(state, failure);
			if (onError) {
				return { kind: "routed", failure, target: onError };
			}
			return { kind: "terminal", failure };
		}
	}

	throw new Error(`Node ${node.id} exhausted its failure policy without an outcome.`);
}

async function executeState(
	pi: ExtensionAPI,
	services: GraphRuntimeServices,
	graph: GraphDefinition,
	state: GraphState,
	options: GraphRunOptions,
): Promise<GraphRunResult> {
	if (state.status !== "running") return resultFor(graph, state);

	let steps = 0;
	const maxSteps = graph.maxSteps ?? 32;

	try {
		persist(services, state);
		emitUpdate(services, state, options.resumeFrom ? `Graph ${graph.name} resumed.` : `Graph ${graph.name} started.`);
		while (state.status === "running") {
			if (options.signal?.aborted) throw new Error("Graph run was aborted.");
			if (!state.currentNode) throw new Error("Graph has no current node.");

			const node = graph.nodes[state.currentNode];
			if (!node || node.deleted) throw new Error(`Unknown graph node: ${state.currentNode}`);
			assertMutationAuthorized(graph, state, node, options);

			const outcome = await executeNodeWithPolicy(pi, services, graph, state, node, options, () => {
				if (steps >= maxSteps) throw new Error(`Graph exceeded maxSteps (${maxSteps}).`);
				steps += 1;
			});
			if (outcome.kind === "terminal") {
				state.status = "failed";
				state.error = outcome.failure.message;
				state.updatedAt = outcome.failure.occurredAt;
				state.completedAt = outcome.failure.occurredAt;
				persist(services, state);
				emitUpdate(services, state, outcome.failure.message);
				break;
			}
			if (outcome.kind === "routed") {
				const routedState = { ...state, currentNode: outcome.target };
				persist(services, routedState);
				state.currentNode = outcome.target;
				emitUpdate(services, state, `Node ${node.label ?? node.id} failed; routing to ${outcome.target}.`);
				continue;
			}

			const rawNodeResult = outcome.result;
			const executionServices = options.services ?? createGraphExecutionServices(options.extensionContext);
			const nodeResult: GraphNodeResult = {
				...rawNodeResult,
				data: rawNodeResult.data ? executionServices.truncate(rawNodeResult.data) as JsonObject : undefined,
				output: rawNodeResult.output === undefined ? undefined : executionServices.truncate(rawNodeResult.output),
				summary: rawNodeResult.summary ? executionServices.truncate(rawNodeResult.summary) as string : undefined,
			};
			mergeData(state.data, nodeResult.data);

			const completed = runtimeNow(services);
			let nextNode: string | undefined;
			state.nodes[node.id] = {
				...state.nodes[node.id],
				status: "completed",
				startedAt: state.nodes[node.id].startedAt,
				completedAt: completed,
				...executionTelemetry(node, nodeResult.data),
			};
			extractApproval(state, node, nodeResult, completed);
			state.history.push(makeEvent(services, node.id, "success", { message: nodeResult.summary }));
			state.updatedAt = completed;

			const pause = pauseReason(nodeResult);
			if (pause) {
				state.status = "paused";
				state.nodes[node.id] = { ...state.nodes[node.id], status: "paused" };
				state.history.push(makeEvent(services, node.id, "checkpoint", { message: pause }));
			} else if (nodeResult.done) {
				state.status = "completed";
				state.currentNode = undefined;
				state.completedAt = completed;
			} else if (nodeResult.next) {
				assertKnownTransition(graph, node, nodeResult.next);
				nextNode = nodeResult.next;
			} else {
				state.status = "completed";
				state.currentNode = undefined;
				state.completedAt = completed;
			}
			if (state.status === "completed" && nodeResult.output !== undefined) {
				state.finalOutput = nodeResult.output;
			}

			if (nextNode) {
				persist(services, { ...state, currentNode: nextNode });
				state.currentNode = nextNode;
			} else {
				persist(services, state);
			}
			emitUpdate(services, state, state.status === "completed" ? undefined : nodeResult.summary);
		}
	} catch (error) {
		const message = errorMessage(options, error);
		const interrupted = isAbortError(error, options.signal);
		const completedAt = runtimeNow(services);
		if (state.currentNode) {
			state.nodes[state.currentNode] = {
				...state.nodes[state.currentNode],
				status: interrupted ? "interrupted" : "failed",
				startedAt: state.nodes[state.currentNode]?.startedAt,
				completedAt,
				error: interrupted ? undefined : message,
			};
			state.history.push(makeEvent(services, state.currentNode, interrupted ? "checkpoint" : "error", {
				error: interrupted ? undefined : message,
				message: interrupted ? message : undefined,
			}));
		}
		if (!interrupted) {
			const nodeId = state.currentNode ?? "runtime";
			const nodeStatus = state.nodes[nodeId];
			exposeFailure(state, {
				kind: "runtime",
				nodeId,
				message,
				attempt: nodeStatus?.attempts ?? 0,
				maxAttempts: nodeStatus?.maxAttempts ?? 1,
				occurredAt: completedAt,
				handled: false,
				resumable: false,
			});
		}
		state.status = interrupted ? "interrupted" : "failed";
		state.error = interrupted ? undefined : message;
		state.updatedAt = completedAt;
		state.completedAt = state.updatedAt;
		persist(services, state);
		emitUpdate(services, state, message);
	}

	return resultFor(graph, state);
}

export async function runGraph(
	pi: ExtensionAPI,
	graph: GraphDefinition,
	options: GraphRunOptions,
): Promise<GraphRunResult> {
	assertValidGraph(graph);
	const resolvedOptions: GraphRunOptions = {
		...options,
		services: options.services ?? createGraphExecutionServices(options.extensionContext),
	};
	const services = resolveRuntimeServices(pi, graph, resolvedOptions);
	const claimId = `claim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	assertNoOtherActiveRun(options.cwd, options.checkpoints);
	activeRunByCwd.set(options.cwd, claimId);

	let state: GraphState | undefined;
	try {
		state = await createRunnableState(graph, resolvedOptions, services);
		if (state.status !== "running") return resultFor(graph, state);
		return await executeState(pi, services, graph, state, resolvedOptions);
	} finally {
		if (activeRunByCwd.get(options.cwd) === claimId) {
			activeRunByCwd.delete(options.cwd);
		}
		try {
			services.clearStatus();
		} catch {
			// UI cleanup is observational and must not change a run result.
		}
	}
}

export async function resumeGraph(
	pi: ExtensionAPI,
	graph: GraphDefinition,
	state: GraphState,
	options: Omit<GraphRunOptions, "goal" | "resumeFrom">,
): Promise<GraphRunResult> {
	return runGraph(pi, graph, {
		...options,
		goal: state.goal,
		resumeFrom: state,
	});
}

export function findLastGraphRun(entries: GraphCheckpointEntry[]): GraphState | undefined {
	return findLatestGraphRuns(entries)[0];
}

export function interruptOrphanedGraphRuns(
	pi: ExtensionAPI,
	entries: GraphCheckpointEntry[],
	options: Pick<GraphRunOptions, "cwd" | "ui" | "onUpdate" | "runStore"> & { graphForName?: (name: string) => GraphDefinition | undefined },
): GraphState[] {
	const interrupted: GraphState[] = [];

	for (const state of findLatestGraphRuns(entries)) {
		if (state.cwd !== options.cwd || state.status !== "running") continue;
		const graph = options.graphForName?.(state.graphName);
		const services = resolveRuntimeServices(pi, graph, {
			goal: "",
			cwd: options.cwd,
			ui: options.ui,
			onUpdate: options.onUpdate,
		});
		const next = copyJson(state);
		next.status = "interrupted";
		if (next.currentNode && next.nodes[next.currentNode]) {
			next.nodes[next.currentNode] = { ...next.nodes[next.currentNode], status: "interrupted" };
		}
		next.updatedAt = runtimeNow(services);
		next.completedAt = next.updatedAt;
		persist(services, next);
		interrupted.push(next);
	}

	return interrupted;
}
