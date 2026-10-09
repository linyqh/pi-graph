import { mapNode } from "./nodes/map.ts";
import { createHash } from "node:crypto";
import Type from "typebox";
import Value from "typebox/value";
import type { RegisteredGraphDefinition } from "./registry.ts";
import { approvalNode, parallelNode, promptNode, routerNode, subagentNode, toolNode } from "./nodes/index.ts";
import { isMutatingTool, MAX_SUBAGENT_TOOLS, TOOL_NAME_PATTERN } from "./tool-selection.ts";
import type { GraphNode, GraphNodeContext, GraphNodeFailurePolicy, GraphOutputValidation, GraphBudget, GraphNodeResult, GraphState, GraphToolName, JsonObject } from "./types.ts";
import { assertValidGraph } from "./validation.ts";

const GRAPH_NAME_PATTERN = "^[a-z][a-z0-9-]{0,63}$";
const NODE_ID_PATTERN = "^[a-z][a-z0-9_]{0,63}$";
const SKILL_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const MAX_NODE_COUNT = 64;
const MAX_PROMPT_TEMPLATE_BYTES = 32 * 1024;
const READ_ONLY_PARALLEL_CHILD_TYPES = new Set(["prompt", "subagent", "tool"]);
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const ToolNameSchema = Type.String({ pattern: TOOL_NAME_PATTERN, maxLength: 64 });
const MutatesFieldSchema = {
	mutates: Type.Optional(Type.Boolean({
		description: "Set true when a tool outside Pi's built-in bash/edit/write changes the workspace. Mutating nodes are barred from read-only graphs and parallel children, and require an approval node under approval-required policy.",
	})),
};

const ScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const StringTemplateSchema = Type.String();
const DataKeySchema = Type.String({ pattern: "^[A-Za-z0-9_]{1,64}$" });
const ProviderModelSchema = {
	provider: Type.Optional(Type.String({ minLength: 1 })),
	model: Type.Optional(Type.String({ minLength: 1 })),
};
const BudgetSchema = Type.Object({
	maxInvocations: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
	maxRequests: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000000 })),
	maxCost: Type.Optional(Type.Number({ minimum: 0, maximum: 100000 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86400000 })),
}, { additionalProperties: false });
const BaseNodeSchema = {
	budget: Type.Optional(BudgetSchema),
	id: Type.String({ pattern: NODE_ID_PATTERN }),
	label: Type.Optional(Type.String({ minLength: 1 })),
	next: Type.Optional(Type.String({ pattern: NODE_ID_PATTERN })),
};
const ApprovalReferenceSchema = {
	approvalNodeId: Type.Optional(Type.String({ pattern: NODE_ID_PATTERN })),
};
const FailurePolicySchema = Type.Object({
	maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
	initialDelayMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })),
	maxDelayMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300000 })),
	onError: Type.Optional(Type.String({ pattern: NODE_ID_PATTERN })),
}, { additionalProperties: false });
const FailurePolicyFieldSchema = {
	failure: Type.Optional(FailurePolicySchema),
};
const TransitionLabelsSchema = Type.Object({
	next: Type.Optional(Type.String({ minLength: 1 })),
	approved: Type.Optional(Type.String({ minLength: 1 })),
	declined: Type.Optional(Type.String({ minLength: 1 })),
	default: Type.Optional(Type.String({ minLength: 1 })),
	error: Type.Optional(Type.String({ minLength: 1 })),
}, {
	additionalProperties: false,
	description: "Localized labels for compiler-derived graph edges. Omitted fields keep the legacy English labels.",
});
const PromptFieldsSchema = {
	validation: Type.Optional(Type.Object({
		schema: Type.Record(Type.String(), Type.Unknown()),
		validator: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		maxCorrections: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
	}, { additionalProperties: false })),
	systemPrompt: Type.Optional(StringTemplateSchema),
	prompt: StringTemplateSchema,
	outputKey: Type.Optional(DataKeySchema),
	parseJson: Type.Optional(Type.Boolean()),
	...ProviderModelSchema,
};

const PromptNodeSchema = Type.Object({
	...BaseNodeSchema,
	type: Type.Literal("prompt"),
	...PromptFieldsSchema,
	...FailurePolicyFieldSchema,
}, { additionalProperties: false });

const SubagentNodeSchema = Type.Object({
	...BaseNodeSchema,
	type: Type.Literal("subagent"),
	...PromptFieldsSchema,
	agentName: Type.String({ minLength: 1 }),
	tools: Type.Array(ToolNameSchema, {
		uniqueItems: true,
		maxItems: MAX_SUBAGENT_TOOLS,
		description: "Explicit allowlist of tool names the current Pi session exposes. Built-in coding tools are read,bash,edit,write,grep,find,ls; any other registered tool (from an installed package or extension) may be named here too. Read-only graphs and parallel children must omit bash,edit,write and any tool the node marks as mutating.",
	}),
	skills: Type.Optional(Type.Array(Type.String({
		pattern: SKILL_NAME_PATTERN,
		maxLength: 64,
	}), {
		uniqueItems: true,
		maxItems: 16,
		description: "Explicit allowlist of Skill names currently exposed by Pi in <available_skills>. Use an empty array when no Skill matches. Assigned skills require the read tool.",
	})),
	...MutatesFieldSchema,
	...ApprovalReferenceSchema,
	...FailurePolicyFieldSchema,
}, { additionalProperties: false });

const ToolNodeSchema = Type.Object({
	...BaseNodeSchema,
	type: Type.Literal("tool"),
	tool: ToolNameSchema,
	args: Type.Record(Type.String(), Type.Any()),
	outputKey: Type.Optional(DataKeySchema),
	...MutatesFieldSchema,
	...ApprovalReferenceSchema,
	...FailurePolicyFieldSchema,
}, { additionalProperties: false });

const ApprovalNodeSchema = Type.Object({
	id: Type.String({ pattern: NODE_ID_PATTERN }),
	label: Type.Optional(Type.String({ minLength: 1 })),
	type: Type.Literal("approval"),
	title: StringTemplateSchema,
	message: StringTemplateSchema,
	yes: Type.String({ pattern: NODE_ID_PATTERN }),
	no: Type.Optional(Type.String({ pattern: NODE_ID_PATTERN })),
	outputKey: Type.Optional(DataKeySchema),
}, { additionalProperties: false });

const RouterTargetCaseSchema = Type.Object({
	equals: ScalarSchema,
	to: Type.String({ pattern: NODE_ID_PATTERN }),
	label: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const RouterDoneCaseSchema = Type.Object({
	equals: ScalarSchema,
	done: Type.Literal(true),
	label: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const RouterCaseSchema = Type.Union([RouterTargetCaseSchema, RouterDoneCaseSchema]);

const RouterTargetDefaultSchema = Type.Object({
	to: Type.String({ pattern: NODE_ID_PATTERN }),
	label: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const RouterDoneDefaultSchema = Type.Object({
	done: Type.Literal(true),
	label: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const RouterDefaultSchema = Type.Union([RouterTargetDefaultSchema, RouterDoneDefaultSchema]);

const RouterNodeSchema = Type.Object({
	id: Type.String({ pattern: NODE_ID_PATTERN }),
	label: Type.Optional(Type.String({ minLength: 1 })),
	type: Type.Literal("router"),
	path: Type.String({ pattern: "^data(?:\\.[A-Za-z0-9_]+)+$" }),
	cases: Type.Array(RouterCaseSchema, { minItems: 1 }),
	default: RouterDefaultSchema,
}, { additionalProperties: false });

const ParallelChildSchema = Type.Union([
	PromptNodeSchema,
	SubagentNodeSchema,
	ToolNodeSchema,
]);

const ParallelNodeSchema = Type.Object({
	...BaseNodeSchema,
	type: Type.Literal("parallel"),
	children: Type.Array(ParallelChildSchema, { minItems: 1, maxItems: 8 }),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
}, { additionalProperties: false });

const MapNodeSchema = Type.Object({
	id: Type.String({ pattern: NODE_ID_PATTERN }), label: Type.Optional(Type.String({ minLength: 1 })),
	type: Type.Literal("map"), itemsPath: Type.String({ minLength: 1 }),
	templates: Type.Array(ParallelChildSchema, { minItems: 1, maxItems: 8 }),
	maxItems: Type.Integer({ minimum: 1, maximum: 16 }),
	minItems: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
	next: Type.Optional(Type.String({ pattern: NODE_ID_PATTERN })),
}, { additionalProperties: false });

const DeclarativeGraphNodeSchema = Type.Union([
	PromptNodeSchema,
	SubagentNodeSchema,
	ToolNodeSchema,
	ApprovalNodeSchema,
	RouterNodeSchema,
	ParallelNodeSchema,
	MapNodeSchema,
]);

export const DeclarativeGraphSpecSchema = Type.Object({
	schemaVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
	guard: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9._-]{0,127}$" })),
	budget: Type.Optional(BudgetSchema),
	name: Type.String({ pattern: GRAPH_NAME_PATTERN }),
	version: Type.Optional(Type.String({ minLength: 1, default: "1.0.0" })),
	description: Type.String({ minLength: 1 }),
	mutationPolicy: Type.Union([Type.Literal("read-only"), Type.Literal("mutating"), Type.Literal("approval-required")]),
	transitionLabels: Type.Optional(TransitionLabelsSchema),
	start: Type.String({ pattern: NODE_ID_PATTERN }),
	maxSteps: Type.Integer({ minimum: 1, maximum: 256 }),
	nodes: Type.Array(DeclarativeGraphNodeSchema, { minItems: 1, maxItems: MAX_NODE_COUNT }),
}, { additionalProperties: false });

export type DeclarativeToolName = GraphToolName;
export type DeclarativeScalar = string | number | boolean | null;
export type DeclarativeTemplate = string;
export type DeclarativeNodeFailurePolicy = GraphNodeFailurePolicy;
export interface DeclarativeTransitionLabels {
	next?: string;
	approved?: string;
	declined?: string;
	default?: string;
	error?: string;
}
export type DeclarativePromptLikeNode = {
	id: string;
	type: "prompt" | "subagent";
	budget?: GraphBudget;
	label?: string;
	systemPrompt?: DeclarativeTemplate;
	prompt: DeclarativeTemplate;
	outputKey?: string;
	parseJson?: boolean;
	validation?: GraphOutputValidation;
	next?: string;
	provider?: string;
	model?: string;
	failure?: DeclarativeNodeFailurePolicy;
};
export type DeclarativePromptNode = DeclarativePromptLikeNode & { type: "prompt" };
export type DeclarativeSubagentNode = DeclarativePromptLikeNode & {
	type: "subagent";
	agentName: string;
	tools: DeclarativeToolName[];
	skills?: string[];
	mutates?: boolean;
	approvalNodeId?: string;
};
export type DeclarativeToolNode = {
	id: string;
	type: "tool";
	budget?: GraphBudget;
	label?: string;
	tool: DeclarativeToolName;
	args: JsonObject;
	outputKey?: string;
	next?: string;
	mutates?: boolean;
	approvalNodeId?: string;
	failure?: DeclarativeNodeFailurePolicy;
};
export type DeclarativeApprovalNode = {
	id: string;
	type: "approval";
	label?: string;
	title: DeclarativeTemplate;
	message: DeclarativeTemplate;
	yes: string;
	no?: string;
	outputKey?: string;
};
export type DeclarativeRouterNode = {
	id: string;
	type: "router";
	label?: string;
	path: string;
	cases: Array<
		| { equals: DeclarativeScalar; to: string; label?: string }
		| { equals: DeclarativeScalar; done: true; label?: string }
	>;
	default: { to: string; label?: string } | { done: true; label?: string };
};
export type DeclarativeParallelNode = {
	id: string;
	type: "parallel";
	budget?: GraphBudget;
	label?: string;
	children: Array<
		| DeclarativePromptNode
		| DeclarativeSubagentNode
		| DeclarativeToolNode
	>;
	concurrency?: number;
	next?: string;
};
export type DeclarativeMapNode = {
	id: string; type: "map"; label?: string; itemsPath: string;
	templates: DeclarativeParallelNode["children"];
	maxItems: number; minItems?: number; concurrency?: number; next?: string;
};
export type DeclarativeGraphNode =
	| DeclarativePromptNode
	| DeclarativeSubagentNode
	| DeclarativeToolNode
	| DeclarativeApprovalNode
	| DeclarativeRouterNode
	| DeclarativeParallelNode
	| DeclarativeMapNode;
export interface DeclarativeGraphSpec {
	[key: string]: unknown;
	schemaVersion: 1 | 2;
	guard?: string;
	budget?: GraphBudget;
	name: string;
	version: string;
	description: string;
	mutationPolicy: "read-only" | "mutating" | "approval-required";
	transitionLabels?: DeclarativeTransitionLabels;
	start: string;
	maxSteps: number;
	nodes: DeclarativeGraphNode[];
}

export class DeclarativeGraphError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`Invalid declarative graph specification:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
		this.name = "DeclarativeGraphError";
		this.issues = issues;
	}
}

export interface DeclarativeGraphSerialization {
	json: string;
	sha256: string;
}

function issue(path: string, message: string): string {
	return `${path}: ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonCompatible(value: unknown, path: string, issues: string[]): void {
	if (value === null) return;
	if (["string", "number", "boolean"].includes(typeof value)) {
		if (typeof value === "number" && !Number.isFinite(value)) issues.push(issue(path, "number must be finite"));
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => assertJsonCompatible(item, `${path}[${index}]`, issues));
		return;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			if (BLOCKED_PATH_SEGMENTS.has(key)) issues.push(issue(`${path}.${key}`, "prototype-chain object keys are not allowed"));
			assertJsonCompatible(child, `${path}.${key}`, issues);
		}
		return;
	}
	issues.push(issue(path, "value must be JSON-compatible"));
}

function schemaIssues(value: unknown): string[] {
	if (Value.Check(DeclarativeGraphSpecSchema, value)) return [];
	return [...toolNameIssues(value), ...[...Value.Errors(DeclarativeGraphSpecSchema, value)].map((error) => {
		const path = error.instancePath || "/";
		return issue(path, error.message);
	})];
}

/**
 * Malformed tool names, reported by name. A bad name fails every branch of the node union, and
 * TypeBox reports only some branches' errors — which ones varies by version — so the pattern
 * violation itself can go unmentioned.
 */
function toolNameIssues(value: unknown): string[] {
	const pattern = new RegExp(TOOL_NAME_PATTERN);
	const bad = (name: unknown) => typeof name !== "string" || !pattern.test(name);
	const out: string[] = [];
	const visit = (node: unknown, path: string) => {
		if (!isRecord(node)) return;
		if (node.type === "tool" && bad(node.tool)) out.push(issue(`${path}/tool`, `tool name must match pattern ${TOOL_NAME_PATTERN}`));
		if (node.type === "subagent" && Array.isArray(node.tools)) {
			node.tools.forEach((name, i) => { if (bad(name)) out.push(issue(`${path}/tools/${i}`, `tool name must match pattern ${TOOL_NAME_PATTERN}`)); });
		}
		for (const key of ["children", "templates"]) {
			const list = node[key];
			if (Array.isArray(list)) list.forEach((child, i) => visit(child, `${path}/${key}/${i}`));
		}
	};
	if (isRecord(value) && Array.isArray(value.nodes)) value.nodes.forEach((node, i) => visit(node, `/nodes/${i}`));
	return out;
}

function assertProviderModelPair(node: DeclarativeGraphNode, path: string, issues: string[]): void {
	if (!("provider" in node) && !("model" in node)) return;
	const provider = "provider" in node ? node.provider : undefined;
	const model = "model" in node ? node.model : undefined;
	if ((provider === undefined) !== (model === undefined)) {
		issues.push(issue(path, "provider and model must be supplied together"));
	}
}

function templateReferences(template: string): string[] {
	return [...template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim());
}

function validatePathExpression(expression: string, path: string, issues: string[]): void {
	const parts = expression.split(".");
	const [root, ...segments] = parts;
	if (!["goal", "cwd", "data", "context"].includes(root)
		|| (root === "data" ? segments.length === 0 : root === "context" ? segments.length !== 1 : segments.length > 0)
		|| parts.some((part) => part.length === 0)) {
		issues.push(issue(path, `template reference "${expression}" must be goal, cwd, data dot path, or context dot path`));
		return;
	}
	for (const segment of segments) {
		if (!/^[A-Za-z0-9_-]+$/.test(segment) || BLOCKED_PATH_SEGMENTS.has(segment)) {
			issues.push(issue(path, `template reference "${expression}" contains an unsafe path segment`));
		}
	}
}

function validateTemplate(template: string, path: string, issues: string[], enforcePromptLimit = false): void {
	if (enforcePromptLimit && Buffer.byteLength(template, "utf8") > MAX_PROMPT_TEMPLATE_BYTES) {
		issues.push(issue(path, `prompt template must be at most ${MAX_PROMPT_TEMPLATE_BYTES} bytes`));
	}
	for (const expression of templateReferences(template)) validatePathExpression(expression, path, issues);
	if (template.replaceAll(/\{\{\s*([^{}]+?)\s*\}\}/g, "").includes("{{")) {
		issues.push(issue(path, "template contains an unclosed or malformed placeholder"));
	}
}

function collectTemplateFields(node: DeclarativeGraphNode, path: string, issues: string[]): void {
	if (node.type === "prompt" || node.type === "subagent") {
		validateTemplate(node.prompt, `${path}.prompt`, issues, true);
		if (node.systemPrompt !== undefined) validateTemplate(node.systemPrompt, `${path}.systemPrompt`, issues, true);
		return;
	}
	if (node.type === "approval") {
		validateTemplate(node.title, `${path}.title`, issues);
		validateTemplate(node.message, `${path}.message`, issues);
	}
}

function collectArgTemplates(value: unknown, path: string, issues: string[]): void {
	if (typeof value === "string") {
		validateTemplate(value, path, issues);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => collectArgTemplates(item, `${path}[${index}]`, issues));
		return;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) collectArgTemplates(child, `${path}.${key}`, issues);
	}
}

export function allNodes(spec: DeclarativeGraphSpec): DeclarativeGraphNode[] {
	const nodes: DeclarativeGraphNode[] = [];
	for (const node of spec.nodes) {
		nodes.push(node);
		if (node.type === "parallel") nodes.push(...node.children);
		if (node.type === "map") nodes.push(...node.templates);
	}
	return nodes;
}

/**
 * A node mutates when it uses one of Pi's built-in write tools, or when it
 * declares that a custom tool does. The engine cannot tell what a registered
 * tool does, so custom tools are read-only until a node says otherwise.
 */
function nodeMutates(node: DeclarativeGraphNode): boolean {
	if (node.type !== "tool" && node.type !== "subagent") return false;
	if (node.mutates === true) return true;
	return node.type === "tool" ? isMutatingTool(node.tool) : node.tools.some(isMutatingTool);
}

function nodeApprovalNodeId(node: DeclarativeGraphNode): string | undefined {
	return node.type === "tool" || node.type === "subagent" ? node.approvalNodeId : undefined;
}

function validateOutputKey(node: DeclarativeGraphNode, path: string, issues: string[]): void {
	if (!("outputKey" in node) || !node.outputKey) return;
	if (node.outputKey === "__graphError") {
		issues.push(issue(`${path}.outputKey`, "__graphError is reserved for graph failures"));
	} else if (BLOCKED_PATH_SEGMENTS.has(node.outputKey)) {
		issues.push(issue(`${path}.outputKey`, "prototype-chain output keys are not allowed"));
	}
}

function validateFailurePolicy(
	node: DeclarativeGraphNode,
	path: string,
	graphNodeIds: Set<string>,
	issues: string[],
): void {
	if (!("failure" in node) || node.failure === undefined) return;
	if (node.failure.maxAttempts === undefined && node.failure.onError === undefined) {
		issues.push(issue(`${path}.failure`, "failure policy must declare at least maxAttempts or onError"));
	}
	if (node.failure.onError !== undefined && !graphNodeIds.has(node.failure.onError)) {
		issues.push(issue(`${path}.failure.onError`, `unknown onError target: ${node.failure.onError}`));
	}
	if (node.failure.onError !== undefined && "next" in node && node.next === node.failure.onError) {
		issues.push(issue(`${path}.failure.onError`, "onError must not duplicate the normal next target"));
	}
	if ((node.failure.maxAttempts ?? 1) > 1 && nodeMutates(node)) {
		issues.push(issue(`${path}.failure.maxAttempts`, "automatic retries require a read-only node"));
	}
}

function declarativeTargets(node: DeclarativeGraphNode): string[] {
	const targets: string[] = [];
	if ("next" in node && node.next) targets.push(node.next);
	if (node.type === "approval") targets.push(node.yes, ...(node.no ? [node.no] : []));
	if (node.type === "router") {
		targets.push(...node.cases.flatMap((entry) => "to" in entry ? [entry.to] : []));
		if ("to" in node.default) targets.push(node.default.to);
	}
	if ("failure" in node && node.failure?.onError) targets.push(node.failure.onError);
	return targets;
}

function declarativeCanReach(spec: DeclarativeGraphSpec, from: string, target: string): boolean {
	const nodes = new Map(spec.nodes.map((node) => [node.id, node]));
	const visited = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const nodeId = stack.pop();
		if (!nodeId) continue;
		if (nodeId === target) return true;
		if (visited.has(nodeId)) continue;
		visited.add(nodeId);
		const node = nodes.get(nodeId);
		if (node) stack.push(...declarativeTargets(node));
	}
	return false;
}

function validateSemantic(spec: DeclarativeGraphSpec): void {
	const issues: string[] = [];
	if (spec.guard && spec.schemaVersion !== 2) issues.push(issue("guard", "guard requires schemaVersion 2"));
	if (spec.budget && spec.schemaVersion !== 2) issues.push(issue("budget", "budget requires schemaVersion 2"));
	for (const node of allNodes(spec)) {
		if ("budget" in node && node.budget && spec.schemaVersion !== 2) issues.push(issue(node.id, "budget requires schemaVersion 2"));
		if ("budget" in node && node.budget && node.type === "parallel") issues.push(issue(node.id, "set budget on graph or leaf tasks, not parallel groups"));
		if ("validation" in node && node.validation) {
			if (spec.schemaVersion !== 2) issues.push(issue(node.id, "output validation requires schemaVersion 2"));
			if (nodeMutates(node)) issues.push(issue(node.id, "output repair requires read-only nodes"));
		}
		if ("failure" in node && node.failure && spec.schemaVersion === 1
			&& (node.failure.initialDelayMs !== undefined || node.failure.maxDelayMs !== undefined)) {
			issues.push(issue(node.id, "retry delays require schemaVersion 2"));
		}
	}
	const graphNodeIds = new Set(spec.nodes.map((node) => node.id));
	const globalIds = new Set<string>();
	const approvalIds = new Set(spec.nodes.filter((node) => node.type === "approval").map((node) => node.id));
	let mutatingNodeCount = 0;

	if (!graphNodeIds.has(spec.start)) issues.push(issue("start", `unknown start node: ${spec.start}`));

	for (const [index, node] of spec.nodes.entries()) {
		const nodePath = `nodes[${index}]`;
		if (globalIds.has(node.id)) issues.push(issue(`${nodePath}.id`, `duplicate node id: ${node.id}`));
		globalIds.add(node.id);
		assertProviderModelPair(node, nodePath, issues);
		validateOutputKey(node, nodePath, issues);
		validateFailurePolicy(node, nodePath, graphNodeIds, issues);
		collectTemplateFields(node, nodePath, issues);
		if (node.type === "subagent" && (node.skills?.length ?? 0) > 0 && !node.tools.includes("read")) {
			issues.push(issue(`${nodePath}.tools`, "subagents with assigned skills must include the read tool"));
		}

		if ("next" in node && node.next && !graphNodeIds.has(node.next)) {
			issues.push(issue(`${nodePath}.next`, `unknown next node: ${node.next}`));
		}

		if (node.type === "tool") {
			assertJsonCompatible(node.args, `${nodePath}.args`, issues);
			collectArgTemplates(node.args, `${nodePath}.args`, issues);
		}

		if (node.type === "approval") {
			if (!graphNodeIds.has(node.yes)) issues.push(issue(`${nodePath}.yes`, `unknown yes target: ${node.yes}`));
			if (node.no && !graphNodeIds.has(node.no)) issues.push(issue(`${nodePath}.no`, `unknown no target: ${node.no}`));
		}

		if (node.type === "router") {
			validatePathExpression(node.path, `${nodePath}.path`, issues);
			for (const [caseIndex, entry] of node.cases.entries()) {
				if ("to" in entry && !graphNodeIds.has(entry.to)) issues.push(issue(`${nodePath}.cases[${caseIndex}].to`, `unknown route target: ${entry.to}`));
			}
			if ("to" in node.default && !graphNodeIds.has(node.default.to)) issues.push(issue(`${nodePath}.default.to`, `unknown default target: ${node.default.to}`));
		}

		if (node.type === "map") {
			if (spec.schemaVersion !== 2) issues.push(issue(nodePath, "map requires schemaVersion 2"));
			if ((node.minItems ?? 0) > node.maxItems) issues.push(issue(nodePath, "map minItems exceeds maxItems"));
			validatePathExpression(node.itemsPath, `${nodePath}.itemsPath`, issues);
		}
		if (node.type === "parallel" || node.type === "map") {
			for (const [childIndex, child] of (node.type === "map" ? node.templates : node.children).entries()) {
				const childPath = `${nodePath}.children[${childIndex}]`;
				if ("failure" in child && child.failure) {
					if (spec.schemaVersion !== 2) issues.push(issue(childPath, "parallel failure policy requires schemaVersion 2"));
					if (child.failure.onError) issues.push(issue(childPath, "parallel child cannot route onError outside its parent"));
					validateFailurePolicy(child, childPath, graphNodeIds, issues);
				}
				if (globalIds.has(child.id)) issues.push(issue(`${childPath}.id`, `duplicate node id: ${child.id}`));
				globalIds.add(child.id);
				if (!READ_ONLY_PARALLEL_CHILD_TYPES.has(child.type)) {
					issues.push(issue(childPath, "parallel children may only be prompt, subagent, or tool nodes"));
				}
				if (child.next) issues.push(issue(`${childPath}.next`, "parallel child nodes must not declare next"));
				if (nodeMutates(child)) issues.push(issue(childPath, "parallel child nodes must be read-only"));
				if (!nodeMutates(child) && nodeApprovalNodeId(child)) issues.push(issue(`${childPath}.approvalNodeId`, "read-only nodes must not declare approvalNodeId"));
				assertProviderModelPair(child, childPath, issues);
				validateOutputKey(child, childPath, issues);
				collectTemplateFields(child, childPath, issues);
				if (child.type === "subagent" && (child.skills?.length ?? 0) > 0 && !child.tools.includes("read")) {
					issues.push(issue(`${childPath}.tools`, "subagents with assigned skills must include the read tool"));
				}
				if (child.type === "tool") {
					assertJsonCompatible(child.args, `${childPath}.args`, issues);
					collectArgTemplates(child.args, `${childPath}.args`, issues);
				}
			}
		}

		if (nodeMutates(node)) mutatingNodeCount++;
		const approvalNodeId = nodeApprovalNodeId(node);
		if (!nodeMutates(node) && approvalNodeId) {
			issues.push(issue(`${nodePath}.approvalNodeId`, "read-only nodes must not declare approvalNodeId"));
		}
		if (nodeMutates(node) && spec.mutationPolicy === "read-only") {
			issues.push(issue(nodePath, "read-only mutationPolicy cannot contain mutating tool or subagent nodes"));
		}
		if (nodeMutates(node) && spec.mutationPolicy === "approval-required") {
			if (!approvalNodeId) {
				issues.push(issue(`${nodePath}.approvalNodeId`, "mutating nodes must explicitly declare approvalNodeId under approval-required policy"));
			} else if (!approvalIds.has(approvalNodeId)) {
				issues.push(issue(`${nodePath}.approvalNodeId`, `unknown approval node: ${approvalNodeId}`));
			}
		}
	}

	if (globalIds.size > MAX_NODE_COUNT) issues.push(issue("nodes", `graph may contain at most ${MAX_NODE_COUNT} nodes including parallel children`));
	if (mutatingNodeCount > 0 && spec.mutationPolicy === "approval-required" && approvalIds.size === 0) {
		issues.push(issue("nodes", "mutating nodes require at least one approval node"));
	}
	for (const [index, node] of spec.nodes.entries()) {
		if (!("failure" in node) || !node.failure?.onError || !nodeMutates(node)) continue;
		if (declarativeCanReach(spec, node.failure.onError, node.id)) {
			issues.push(issue(`nodes[${index}].failure.onError`, "mutating failure routes must not lead back to the mutating node"));
		}
	}
	if (issues.length > 0) throw new DeclarativeGraphError(issues);
}

export function parseDeclarativeGraphSpec(value: unknown): DeclarativeGraphSpec {
	const normalized = isRecord(value) && !Object.hasOwn(value, "version")
		? { ...value, version: "1.0.0" }
		: value;
	const issues = schemaIssues(normalized);
	assertJsonCompatible(normalized, "/", issues);
	if (issues.length > 0) throw new DeclarativeGraphError(issues);
	const spec = Value.Clone(normalized) as DeclarativeGraphSpec;
	validateSemantic(spec);
	return spec;
}

function readPath(state: GraphState, expression: string): unknown {
	const parts = expression.split(".");
	const [root, ...segments] = parts;
	let current: unknown = root === "goal" ? state.goal : root === "cwd" ? state.cwd : root === "context" ? state.context ?? {} : state.data;
	for (const segment of segments) {
		if (BLOCKED_PATH_SEGMENTS.has(segment)) throw new DeclarativeGraphError([issue("template", `unsafe path segment: ${segment}`)]);
		if (!isRecord(current) || !Object.hasOwn(current, segment)) {
			throw new DeclarativeGraphError([issue("template", `missing template value: ${expression}`)]);
		}
		current = current[segment];
	}
	return current;
}

function stringifyTemplateValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function renderTemplate(template: string, state: GraphState): string {
	return template.replaceAll(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expression: string) => stringifyTemplateValue(readPath(state, expression.trim())));
}

function renderJsonTemplates(value: unknown, state: GraphState): unknown {
	if (typeof value === "string") {
		const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
		if (exact) return readPath(state, exact[1].trim());
		return renderTemplate(value, state);
	}
	if (Array.isArray(value)) return value.map((item) => renderJsonTemplates(item, state));
	if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, renderJsonTemplates(child, state)]));
	return value;
}

function compileTextTemplate(template: string): (state: GraphState) => string {
	return (state) => renderTemplate(template, state);
}

function compileToolArgs(args: JsonObject): (state: GraphState) => JsonObject {
	return (state) => renderJsonTemplates(args, state) as JsonObject;
}

function routerPathValue(ctx: GraphNodeContext, path: string): unknown {
	const expression = path.startsWith("data.") ? path : `data.${path}`;
	return readPath(ctx.state, expression);
}

function compileDeclarativeNode(node: DeclarativeGraphNode): GraphNode {
	if (node.type === "prompt") {
		return promptNode({
			id: node.id,
			label: node.label,
			provider: node.provider,
			model: node.model,
			systemPrompt: node.systemPrompt ? compileTextTemplate(node.systemPrompt) : undefined,
			prompt: compileTextTemplate(node.prompt),
			outputKey: node.outputKey,
			parseJson: node.parseJson,
			validation: node.validation,
			next: node.next,
			failure: node.failure,
			budget: node.budget,
		});
	}
	if (node.type === "subagent") {
		return subagentNode({
			id: node.id,
			label: node.label,
			agentName: node.agentName,
			tools: [...node.tools],
			skills: [...(node.skills ?? [])],
			mutates: nodeMutates(node),
			provider: node.provider,
			model: node.model,
			systemPrompt: node.systemPrompt ? compileTextTemplate(node.systemPrompt) : undefined,
			prompt: compileTextTemplate(node.prompt),
			outputKey: node.outputKey,
			parseJson: node.parseJson,
			validation: node.validation,
			next: node.next,
			approvalNodeId: node.approvalNodeId,
			failure: node.failure,
			budget: node.budget,
		});
	}
	if (node.type === "tool") {
		return toolNode({
			id: node.id,
			label: node.label,
			tool: node.tool,
			args: compileToolArgs(node.args),
			outputKey: node.outputKey,
			next: node.next,
			mutates: nodeMutates(node),
			approvalNodeId: node.approvalNodeId,
			failure: node.failure,
			budget: node.budget,
		});
	}
	if (node.type === "approval") {
		return approvalNode({
			id: node.id,
			label: node.label,
			title: compileTextTemplate(node.title),
			message: compileTextTemplate(node.message),
			yes: node.yes,
			no: node.no,
			outputKey: node.outputKey,
		});
	}
	if (node.type === "router") {
		const targets = [...new Set([
			...node.cases.map((entry) => "to" in entry ? entry.to : undefined),
			"to" in node.default ? node.default.to : undefined,
		].filter((target): target is string => Boolean(target)))];
		return routerNode({
			id: node.id,
			label: node.label,
			targets,
			route(ctx): GraphNodeResult {
				const value = routerPathValue(ctx, node.path);
				for (const entry of node.cases) {
					if (value === entry.equals) {
						if ("done" in entry) return { done: true, summary: `Router ${node.id} completed graph.` };
						return { next: entry.to, summary: `Router ${node.id} -> ${entry.to}` };
					}
				}
				if ("done" in node.default) return { done: true, summary: `Router ${node.id} used default and completed graph.` };
				return {
					next: node.default.to,
					summary: `Router ${node.id} used default.`,
				};
			},
		});
	}
	if (node.type === "map") return mapNode({
		id: node.id, label: node.label, items: (state) => readPath(state, node.itemsPath),
		templates: node.templates.map(compileDeclarativeNode), maxItems: node.maxItems, minItems: node.minItems,
		concurrency: node.concurrency, next: node.next,
	});
	const children = node.children.map((child) => compileDeclarativeNode(child));
	return parallelNode({
		id: node.id,
		label: node.label,
		children,
		concurrency: node.concurrency,
		next: node.next,
	});
}

function deriveCapability(node: DeclarativeGraphNode) {
	if (node.type === "approval" || node.type === "router") return undefined;
	if (node.type === "parallel" || node.type === "map") {
		const children = node.type === "map" ? node.templates : node.children;
		const tools = [...new Set(children.flatMap((child) => child.type === "tool" ? [child.tool] : child.type === "subagent" ? child.tools : []))].sort();
		const skills = [...new Set(children.flatMap((child) => child.type === "subagent" ? child.skills ?? [] : []))].sort();
		return {
			id: node.id,
			description: node.label ?? `Run parallel node ${node.id}.`,
			tools,
			skills,
			mutates: false,
		};
	}
	const tools = node.type === "tool" ? [node.tool] : node.type === "subagent" ? node.tools : [];
	return {
		id: node.id,
		description: node.label ?? `Run ${node.type} node ${node.id}.`,
		tools: [...tools].sort(),
		skills: node.type === "subagent" ? [...(node.skills ?? [])].sort() : [],
		mutates: nodeMutates(node),
	};
}

function deriveTransitions(spec: DeclarativeGraphSpec) {
	const transitions: RegisteredGraphDefinition["transitions"] = [];
	for (const node of spec.nodes) {
		if ("next" in node && node.next) {
			transitions.push({
				from: node.id,
				to: node.next,
				when: "next",
				...(spec.transitionLabels?.next ? { label: spec.transitionLabels.next } : {}),
			});
		} else if (node.type === "approval") {
			transitions.push({
				from: node.id,
				to: node.yes,
				when: "approved",
				...(spec.transitionLabels?.approved ? { label: spec.transitionLabels.approved } : {}),
			});
			if (node.no) {
				transitions.push({
					from: node.id,
					to: node.no,
					when: "declined",
					...(spec.transitionLabels?.declined ? { label: spec.transitionLabels.declined } : {}),
				});
			}
		} else if (node.type === "router") {
			for (const entry of node.cases) {
				transitions.push({
					from: node.id,
					to: "to" in entry ? entry.to : undefined,
					when: `${node.path} equals ${JSON.stringify(entry.equals)}`,
					...(entry.label ? { label: entry.label } : {}),
				});
			}
			transitions.push({
				from: node.id,
				to: "to" in node.default ? node.default.to : undefined,
				when: "default",
				...(node.default.label || spec.transitionLabels?.default
					? { label: node.default.label ?? spec.transitionLabels?.default }
					: {}),
			});
		}
		if ("failure" in node && node.failure?.onError) {
			transitions.push({
				from: node.id,
				to: node.failure.onError,
				when: "error",
				...(spec.transitionLabels?.error ? { label: spec.transitionLabels.error } : {}),
			});
		}
	}
	return transitions;
}

export function compileDeclarativeGraphSpec(value: unknown, options?: { sourcePath?: string }): RegisteredGraphDefinition {
	const serialization = serializeDeclarativeGraphSpec(value);
	const spec = parseDeclarativeGraphSpec(value);
	const nodes = Object.create(null) as Record<string, GraphNode>;
	for (const node of spec.nodes) {
		nodes[node.id] = compileDeclarativeNode(node);
	}
	const capabilities = spec.nodes.map(deriveCapability).filter((capability): capability is NonNullable<typeof capability> => Boolean(capability));
	const mutatingCapabilities = capabilities.filter((capability) => capability.mutates);
	const approvalBindings = mutatingCapabilities.flatMap((capability) => {
		const source = spec.nodes.find((node) => node.id === capability.id);
		const approvalId = source ? nodeApprovalNodeId(source) : undefined;
		return approvalId ? [{
			node: approvalId,
			capability: capability.id,
			description: `Approval required before ${capability.id} mutates the workspace.`,
		}] : [];
	});
	const graph: RegisteredGraphDefinition = {
		name: spec.name,
		guard: spec.guard,
		...(spec.schemaVersion === 2 ? { executionVersion: 2 as const, definitionHash: serialization.sha256 } : {}),
		version: spec.version,
		description: spec.description,
		start: spec.start,
		...(spec.budget ? { budget: spec.budget } : {}),
		maxSteps: spec.maxSteps,
		mutationPolicy: spec.mutationPolicy,
		capabilities,
		approvalBindings,
		transitions: deriveTransitions(spec),
		nodes,
		...(options?.sourcePath ? { definitionHash: serialization.sha256, sourcePath: options.sourcePath } : {}),
	};
	assertValidGraph(graph);
	return graph;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function serializeDeclarativeGraphSpec(value: unknown): DeclarativeGraphSerialization {
	const spec = parseDeclarativeGraphSpec(value);
	const json = JSON.stringify(canonicalize(spec));
	return {
		json,
		sha256: createHash("sha256").update(json).digest("hex"),
	};
}

export function collectDeclarativeSkillNames(value: unknown): string[] {
	const spec = parseDeclarativeGraphSpec(value);
	return [...new Set(allNodes(spec).flatMap((node) => node.type === "subagent" ? node.skills ?? [] : []))].sort();
}

/** Every tool name a graph asks for, across subagent allowlists and tool nodes. */
export function collectDeclarativeToolNames(value: unknown): string[] {
	const spec = parseDeclarativeGraphSpec(value);
	return [...new Set(allNodes(spec).flatMap((node) => {
		if (node.type === "subagent") return node.tools;
		return node.type === "tool" ? [node.tool] : [];
	}))].sort();
}

export function renderDeclarativeGraphSummary(value: unknown): string {
	const spec = parseDeclarativeGraphSpec(value);
	const serialization = serializeDeclarativeGraphSpec(spec);
	const nodes = allNodes(spec);
	const mutating = nodes.filter(nodeMutates);
	// A node that declared `mutates` names no specific write tool, so the whole
	// allowlist is what the approver has to weigh.
	const mutatingTools = [...new Set(mutating.flatMap((node) => {
		if (node.type === "tool") return [node.tool];
		if (node.type !== "subagent") return [];
		return node.mutates === true ? node.tools : node.tools.filter(isMutatingTool);
	}))].sort();
	const subagentTools = nodes
		.filter((node): node is DeclarativeSubagentNode => node.type === "subagent")
		.map((node) => `${node.id}:[${node.tools.join(",")}]`);
	const subagentSkills = nodes
		.filter((node): node is DeclarativeSubagentNode => node.type === "subagent")
		.map((node) => `${node.id}:[${(node.skills ?? []).join(",")}]`);
	const approvalNodes = spec.nodes.filter((node) => node.type === "approval").map((node) => node.id).sort();
	const failurePolicies = spec.nodes.flatMap((node) => {
		if (!("failure" in node) || !node.failure) return [];
		return [`${node.id}:[maxAttempts=${node.failure.maxAttempts ?? 1},onError=${node.failure.onError ?? "none"}]`];
	});
	return [
		`${spec.name}@${spec.version}`,
		`${nodes.length} nodes, start=${spec.start}, maxSteps=${spec.maxSteps}`,
		`mutationPolicy=${spec.mutationPolicy}`,
		...(spec.transitionLabels ? [`transitionLabels=${JSON.stringify(spec.transitionLabels)}`] : []),
		`sha256=${serialization.sha256}`,
		mutating.length > 0 ? `mutatingNodes=${mutating.map((node) => node.id).join(",")}` : "mutatingNodes=none",
		mutatingTools.length > 0 ? `mutatingTools=${mutatingTools.join(",")}` : "mutatingTools=none",
		subagentTools.length > 0 ? `subagentTools=${subagentTools.join(";")}` : "subagentTools=none",
		subagentSkills.length > 0 ? `subagentSkills=${subagentSkills.join(";")}` : "subagentSkills=none",
		approvalNodes.length > 0 ? `approvalNodes=${approvalNodes.join(",")}` : "approvalNodes=none",
		failurePolicies.length > 0 ? `failurePolicies=${failurePolicies.join(";")}` : "failurePolicies=none",
	].join("\n");
}
