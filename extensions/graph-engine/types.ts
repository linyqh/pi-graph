import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, unknown>;
export type GraphRunContext = Readonly<Record<string, string>>;
export const GRAPH_STATE_SCHEMA_VERSION = 1;

export type GraphStatus = "running" | "paused" | "interrupted" | "completed" | "failed";
export type GraphEventType = "start" | "success" | "error" | "retry" | "checkpoint";
export type GraphMutationPolicy = "read-only" | "mutating" | "approval-required";
export const GRAPH_RUN_PROJECTION_KIND = "pi.graph-run";
export const GRAPH_RUN_PROJECTION_SCHEMA_VERSION = 1;
export const GRAPH_RUN_PROJECTION_MAX_BYTES = 128 * 1024;
export const GRAPH_RUN_PROJECTION_MAX_NODES = 64;
export const GRAPH_RUN_PROJECTION_MAX_EDGES = 256;

export class GraphControlFlowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphControlFlowError";
	}
}

export interface GraphEvent {
	id: string;
	nodeId: string;
	type: GraphEventType;
	timestamp: number;
	message?: string;
	input?: unknown;
	output?: unknown;
	error?: string;
	attempt?: number;
	maxAttempts?: number;
	resumeCount?: number;
}

export interface GraphNodeStatus {
	status: "pending" | "running" | "paused" | "interrupted" | "completed" | "failed";
	startedAt?: number;
	completedAt?: number;
	error?: string;
	attempts?: number;
	maxAttempts?: number;
	/**
	 * Why the model behind a prompt or subagent node stopped, and how much it
	 * wrote getting there.
	 *
	 * A node that ran out of output budget is failed outright, so these exist for
	 * the case just short of that: a node quietly spending most of its budget is
	 * the one about to break, and without a number on it that is invisible until
	 * it does.
	 */
	stopReason?: string;
	outputTokens?: number;
	subagent?: GraphSubagentExecution;
}

export interface GraphNodeFailurePolicy {
	maxAttempts?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	onError?: string;
}

export interface GraphFailure {
	kind: "node" | "runtime";
	nodeId: string;
	message: string;
	attempt: number;
	maxAttempts: number;
	occurredAt: number;
	handled: boolean;
	onError?: string;
	resumable: boolean;
}

export interface GraphSubagentExecution {
	sessionId: string;
	agentName: string;
	title?: string;
	description?: string;
	tools: GraphToolName[];
	skills: string[];
	model?: string;
	thinkingLevel?: string;
	prompt?: string;
	systemPrompt?: string;
}

export interface GraphApprovalRecord {
	nodeId: string;
	approved: boolean;
	requestedAt: number;
	resolvedAt: number;
	resumeCount: number;
}

export interface GraphBudget {
	maxInvocations?: number;
	maxRequests?: number;
	maxTokens?: number;
	maxCost?: number;
	timeoutMs?: number;
}
export interface GraphUsage { invocations: number; requests: number; tokens: number; cost: number }

export interface GraphOutputValidation {
	schema: JsonObject;
	validator?: string;
	maxCorrections?: number;
}

export interface GraphTaskRecord {
	inputHash: string;
	usage?: GraphUsage;
	deadlineAt?: number;
	result?: GraphNodeResult;
	resultHash?: string;
	attempts: number;
	nextRetryAt?: number;
	errorKind?: string;
	corrections?: number;
	feedback?: string;
	invalidOutputHash?: string;
}

export interface GraphState {
	tasks?: Record<string, GraphTaskRecord>;
	usage?: GraphUsage;
	deadlineAt?: number;
	schemaVersion: number;
	runId: string;
	graphName: string;
	graphVersion?: string;
	graphDefinitionHash?: string;
	graphSourcePath?: string;
	goal: string;
	cwd: string;
	readonly context?: GraphRunContext;
	status: GraphStatus;
	currentNode?: string;
	data: JsonObject;
	finalOutput?: unknown;
	history: GraphEvent[];
	nodes: Record<string, GraphNodeStatus>;
	approvals: GraphApprovalRecord[];
	resumeCount: number;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	lastFailure?: GraphFailure;
}

export interface GraphNodeContext {
	/** Process ownership supplied by the runtime store. */
	spawnProcess?: GraphExecutionLease["spawnProcess"];
	reportUsage?: (usage: Partial<GraphUsage>) => void;
	feedback?: string;
	pi: ExtensionAPI;
	graph: GraphDefinition;
	state: GraphState;
	cwd: string;
	signal?: AbortSignal;
	extensionContext?: ExtensionContext;
	ui?: ExtensionContext["ui"];
	services: GraphExecutionServices;
	emit(message: string, data?: JsonObject): void;
	runChildNode(node: GraphNode, state?: GraphState): Promise<GraphNodeResult>;
	setSubagentExecution?(execution: GraphSubagentExecution): void;
}

export interface GraphNodeResult {
	data?: JsonObject;
	output?: unknown;
	next?: string;
	done?: boolean;
	pause?: { reason: string };
	summary?: string;
}

export interface GraphNodeTransition {
	to: string;
	label?: string;
}

export interface GraphStaticTransition {
	from: string;
	to?: string;
	when?: string;
	label?: string;
}

export interface GraphNodeCapabilities {
	readOnly?: boolean;
	mutatesWorkspace?: boolean;
	usesNetwork?: boolean;
	usesShell?: boolean;
	requiresApproval?: boolean;
}

export interface GraphNode {
	id: string;
	type: string;
	label?: string;
	deleted?: boolean;
	transitions?: GraphNodeTransition[];
	routerCandidates?: string[];
	children?: GraphNode[];
	concurrency?: number;
	approvalNodeId?: string;
	failure?: GraphNodeFailurePolicy;
	validation?: GraphOutputValidation;
	budget?: GraphBudget;
	capabilities?: GraphNodeCapabilities;
	metadata?: JsonObject;
	run(ctx: GraphNodeContext): Promise<GraphNodeResult>;
}

export interface GraphCapability {
	id: string;
	description?: string;
	tools?: string[];
	skills?: string[];
	mutates?: boolean;
}

export interface GraphApprovalBinding {
	node: string;
	capability: string;
	description?: string;
}

export interface GraphDefinition {
	executionVersion?: 1 | 2;
	budget?: GraphBudget;
	name: string;
	version: string;
	definitionHash?: string;
	sourcePath?: string;
	description?: string;
	start: string;
	maxSteps?: number;
	mutationPolicy: GraphMutationPolicy;
	deleted?: boolean;
	capabilities?: GraphCapability[];
	approvalBindings?: GraphApprovalBinding[];
	transitions?: GraphStaticTransition[];
	nodes: Record<string, GraphNode>;
}

export interface GraphCheckpointEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface GraphCheckpointEnvelope {
	runId: string;
	graphName: string;
	status: GraphStatus;
	currentNode?: string;
	state: GraphState;
	projection?: GraphRunProjection;
}

export type GraphRunProjectionEdgeKind = "transition" | "branch" | "loop" | "parallel";

export interface GraphRunProjectionNode {
	id: string;
	parentId?: string;
	label: string;
	type: string;
	status: GraphNodeStatus["status"];
	startedAt?: number;
	completedAt?: number;
	error?: string;
	attempts?: number;
	maxAttempts?: number;
	stopReason?: string;
	outputTokens?: number;
	capabilities?: GraphNodeCapabilities;
	subagent?: GraphSubagentExecution;
}

export interface GraphRunProjectionEdge {
	id: string;
	from: string;
	to: string;
	label?: string;
	kind: GraphRunProjectionEdgeKind;
	traversedCount: number;
	active: boolean;
}

export interface GraphRunProjection {
	kind: typeof GRAPH_RUN_PROJECTION_KIND;
	schemaVersion: typeof GRAPH_RUN_PROJECTION_SCHEMA_VERSION;
	revision: number;
	runId: string;
	graphName: string;
	graphVersion?: string;
	description?: string;
	goal: string;
	context?: GraphRunContext;
	status: GraphStatus;
	currentNodeId?: string;
	mutationPolicy: GraphMutationPolicy;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	resumeCount: number;
	progress: {
		completed: number;
		total: number;
	};
	nodes: GraphRunProjectionNode[];
	edges: GraphRunProjectionEdge[];
}

/**
 * Any tool name the running Pi session exposes. Graph specs are validated
 * against the live tool list rather than against a fixed set — see
 * `tool-selection.ts`.
 */
export type GraphToolName = string;

export interface GraphPromptRequest {
	/** Process ownership supplied by the runtime store. */
	spawnProcess?: GraphExecutionLease["spawnProcess"];
	preserveOutput?: boolean;
	reportUsage?: (usage: Partial<GraphUsage>) => void;
	prompt: string;
	systemPrompt?: string;
	model?: string;
	provider?: string;
	cwd: string;
	signal?: AbortSignal;
	parseJson?: boolean;
}

export interface GraphSubagentRequest extends GraphPromptRequest {
	agentName: string;
	sessionId?: string;
	tools: GraphToolName[];
	skills: string[];
}

export interface GraphToolRequest {
	preserveOutput?: boolean;
	tool: GraphToolName;
	args: JsonObject;
	cwd: string;
	signal?: AbortSignal;
}

export interface GraphExecutionOutput {
	output: unknown;
	text: string;
	meta: JsonObject;
}

export interface GraphExecutionServices {
	/** Default Pi services require local process ownership for durable execution. */
	requiresProcessOwnership?: boolean;
	validateOutput?(validator: string, output: unknown, signal?: AbortSignal): Promise<{ valid: boolean; feedback?: string; blocked?: boolean }>;
	completePrompt(request: GraphPromptRequest): Promise<GraphExecutionOutput>;
	runSubagent(request: GraphSubagentRequest): Promise<GraphExecutionOutput>;
	invokeTool(request: GraphToolRequest): Promise<GraphExecutionOutput>;
	truncate(value: unknown): unknown;
}

export interface GraphRunOptions {
	/** Process ownership supplied by the runtime store. */
	spawnProcess?: GraphExecutionLease["spawnProcess"];
	goal: string;
	cwd: string;
	input?: JsonObject;
	context?: GraphRunContext;
	signal?: AbortSignal;
	extensionContext?: ExtensionContext;
	ui?: ExtensionContext["ui"];
	onUpdate?: (partial: GraphToolUpdate) => void;
	resumeFrom?: GraphState;
	checkpoints?: GraphCheckpointEntry[];
	services?: GraphExecutionServices;
	runtimeServices?: Partial<GraphRuntimeServices>;
	runStore?: GraphRunStore;
}

export interface GraphExecutionLease {
	spawnProcess<T extends ChildProcess>(create: () => T): T;
	release(): void;
}

export interface GraphRunStore {
	readCheckpoint?(runId: string): GraphState | undefined;
	acquireExecutionLease?(): GraphExecutionLease;
	persist(state: GraphState, projection?: GraphRunProjection): void;
}

export interface GraphRuntimeServices {
	now(): number;
	createRunId(graphName: string): string;
	persistCheckpoint(state: GraphState): void;
	emitUpdate(state: GraphState, message?: string): void;
	setStatus(state: GraphState): void;
	clearStatus(): void;
	confirmResume(state: GraphState, node: GraphNode, signal?: AbortSignal): Promise<boolean>;
}

export interface GraphRunResult {
	summary: string;
	status: GraphStatus;
	output?: unknown;
	state: GraphState;
	projection: GraphRunProjection;
}

export interface GraphToolUpdate {
	content: Array<{ type: "text"; text: string }>;
	details: GraphRunResult;
}
