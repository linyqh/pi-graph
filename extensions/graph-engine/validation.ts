import {
	GRAPH_RUN_PROJECTION_MAX_EDGES,
	GRAPH_RUN_PROJECTION_MAX_NODES,
} from "./types.ts";
import type { GraphDefinition, GraphNode, GraphStaticTransition } from "./types.ts";
import { countGraphProjectionEdges, flattenGraphNodes, graphProjectionFitsByteLimit } from "./view-projection.ts";

export interface GraphValidationIssue {
	path: string;
	message: string;
}

export interface GraphValidationResult {
	ok: boolean;
	issues: GraphValidationIssue[];
}

export class GraphValidationError extends Error {
	readonly issues: GraphValidationIssue[];

	constructor(issues: GraphValidationIssue[]) {
		super(`Invalid graph definition:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
		this.name = "GraphValidationError";
		this.issues = issues;
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function transitionTargets(node: GraphNode): string[] {
	const onError = node.failure?.onError;
	return [
		...(node.transitions ?? []).map((transition) => transition.to),
		...(node.routerCandidates ?? []),
		...(isNonEmptyString(onError) ? [onError] : []),
	];
}

function graphTransitionTargets(graph: GraphDefinition, nodeId: string): string[] {
	return (graph.transitions ?? [])
		.filter((transition) => transition.from === nodeId && transition.to)
		.map((transition) => transition.to as string);
}

function canReachNode(graph: GraphDefinition, from: string, target: string): boolean {
	const visited = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const nodeId = stack.pop();
		if (!nodeId) continue;
		if (nodeId === target) return true;
		if (visited.has(nodeId)) continue;
		visited.add(nodeId);
		const node = graph.nodes[nodeId];
		if (!node) continue;
		stack.push(...transitionTargets(node), ...graphTransitionTargets(graph, nodeId));
	}
	return false;
}

function nodeMutates(node: GraphNode): boolean {
	return node.capabilities?.mutatesWorkspace === true || node.capabilities?.readOnly === false;
}

function graphCapabilityMutates(graph: GraphDefinition): boolean {
	return (graph.capabilities ?? []).some((capability) => capability.mutates === true);
}

function validateFailurePolicy(
	node: GraphNode,
	path: string,
	graphNodeIds: Set<string>,
	issues: GraphValidationIssue[],
	isParallelChild: boolean,
): void {
	if (node.failure === undefined) return;
	if (isParallelChild) {
		issues.push({ path: `${path}.failure`, message: "parallel child nodes must not declare failure policy" });
		return;
	}
	if (!new Set(["prompt", "subagent", "tool"]).has(node.type)) {
		issues.push({ path: `${path}.failure`, message: "failure policy is allowed only on top-level prompt, subagent, or tool nodes" });
	}
	if (node.failure === null || typeof node.failure !== "object" || Array.isArray(node.failure)) {
		issues.push({ path: `${path}.failure`, message: "failure policy must be an object" });
		return;
	}
	const { maxAttempts, onError } = node.failure;
	if (maxAttempts === undefined && onError === undefined) {
		issues.push({ path: `${path}.failure`, message: "failure policy must declare at least maxAttempts or onError" });
	}
	if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3)) {
		issues.push({ path: `${path}.failure.maxAttempts`, message: "maxAttempts must be an integer from 1 to 3" });
	}
	if (onError !== undefined) {
		if (!isNonEmptyString(onError)) {
			issues.push({ path: `${path}.failure.onError`, message: "onError must be a non-empty string" });
		} else if (!graphNodeIds.has(onError)) {
			issues.push({ path: `${path}.failure.onError`, message: `unknown onError target: ${onError}` });
		}
		if ((node.transitions ?? []).some((transition) => transition.to === onError)) {
			issues.push({ path: `${path}.failure.onError`, message: "onError must not duplicate a normal transition target" });
		}
	}
	if (
		typeof maxAttempts === "number"
		&& maxAttempts > 1
		&& (node.capabilities?.readOnly !== true || node.capabilities?.mutatesWorkspace === true)
	) {
		issues.push({ path: `${path}.failure.maxAttempts`, message: "automatic retries require a read-only node" });
	}
}

function validateNode(
	node: GraphNode,
	path: string,
	graphNodeIds: Set<string>,
	issues: GraphValidationIssue[],
	seenProjectionNodeIds: Set<string>,
	isParallelChild = false,
): void {
	if (!isNonEmptyString(node.id)) {
		issues.push({ path, message: "node id must be a non-empty string" });
	} else if (Buffer.byteLength(node.id, "utf8") > 128) {
		issues.push({ path: `${path}.id`, message: "node id must be at most 128 UTF-8 bytes" });
	}

	for (const [index, transition] of (node.transitions ?? []).entries()) {
		if (!isNonEmptyString(transition.to)) {
			issues.push({ path: `${path}.transitions[${index}]`, message: "transition target must be a non-empty string" });
		} else if (!graphNodeIds.has(transition.to)) {
			issues.push({ path: `${path}.transitions[${index}]`, message: `unknown transition target: ${transition.to}` });
		}
	}

	for (const [index, target] of (node.routerCandidates ?? []).entries()) {
		if (!isNonEmptyString(target)) {
			issues.push({ path: `${path}.routerCandidates[${index}]`, message: "router candidate must be a non-empty string" });
		} else if (!graphNodeIds.has(target)) {
			issues.push({ path: `${path}.routerCandidates[${index}]`, message: `unknown router candidate: ${target}` });
		}
	}

	if (node.approvalNodeId) {
		if (!graphNodeIds.has(node.approvalNodeId)) {
			issues.push({ path: `${path}.approvalNodeId`, message: `unknown approval node: ${node.approvalNodeId}` });
		}
	}

	validateFailurePolicy(node, path, graphNodeIds, issues, isParallelChild);

	if (node.type === "router" && node.routerCandidates === undefined) {
		issues.push({ path: `${path}.routerCandidates`, message: "router nodes must declare every candidate target" });
	}

	if (node.type === "parallel" || node.children || node.concurrency !== undefined) {
		if (!node.children || node.children.length === 0) {
			issues.push({ path: `${path}.children`, message: "parallel nodes must declare at least one child node" });
		}
		if ((node.children?.length ?? 0) > 8) {
			issues.push({ path: `${path}.children`, message: "parallel nodes support at most 8 child nodes" });
		}

		if (node.concurrency !== undefined && (!Number.isInteger(node.concurrency) || node.concurrency <= 0 || node.concurrency > 4)) {
			issues.push({ path: `${path}.concurrency`, message: "parallel concurrency must be an integer from 1 to 4" });
		}

		for (const [index, child] of (node.children ?? []).entries()) {
			const childPath = `${path}.children[${index}]`;
			if (!isNonEmptyString(child.id)) {
				issues.push({ path: childPath, message: "parallel child id must be a non-empty string" });
			} else if (seenProjectionNodeIds.has(child.id)) {
				issues.push({ path: childPath, message: `duplicate workflow projection node id: ${child.id}` });
			} else {
				seenProjectionNodeIds.add(child.id);
			}

			if (nodeMutates(child)) {
				issues.push({ path: childPath, message: "parallel child nodes must not mutate the workspace" });
			}

			validateNode(child, childPath, graphNodeIds, issues, seenProjectionNodeIds, true);
		}
	}
}

export function validateGraph(graph: GraphDefinition): GraphValidationResult {
	const issues: GraphValidationIssue[] = [];

	if (!isNonEmptyString(graph.name)) {
		issues.push({ path: "name", message: "graph name must be a non-empty string" });
	}

	if (!isNonEmptyString(graph.version)) {
		issues.push({ path: "version", message: "graph version must be a non-empty string" });
	}

	if ((graph.definitionHash === undefined) !== (graph.sourcePath === undefined)) {
		issues.push({ path: "definitionHash", message: "definitionHash and sourcePath must be declared together" });
	}
	if (graph.definitionHash !== undefined && !/^[a-f0-9]{64}$/.test(graph.definitionHash)) {
		issues.push({ path: "definitionHash", message: "definitionHash must be a lowercase SHA-256 hex digest" });
	}
	if (graph.sourcePath !== undefined && !isNonEmptyString(graph.sourcePath)) {
		issues.push({ path: "sourcePath", message: "sourcePath must be a non-empty string" });
	}

	if (!isNonEmptyString(graph.start)) {
		issues.push({ path: "start", message: "start node id must be a non-empty string" });
	}

	if (graph.maxSteps !== undefined && (!Number.isInteger(graph.maxSteps) || graph.maxSteps <= 0 || graph.maxSteps > 256)) {
		issues.push({ path: "maxSteps", message: "maxSteps must be an integer from 1 to 256" });
	}

	const entries = Object.entries(graph.nodes);
	const graphNodeIds = new Set(entries.map(([nodeId]) => nodeId));
	const seenProjectionNodeIds = new Set(graphNodeIds);

	if (entries.length === 0) {
		issues.push({ path: "nodes", message: "graph must define at least one node" });
	}
	const projectionNodeCount = flattenGraphNodes(graph).length;
	if (projectionNodeCount > GRAPH_RUN_PROJECTION_MAX_NODES) {
		issues.push({ path: "nodes", message: `graph may expose at most ${GRAPH_RUN_PROJECTION_MAX_NODES} nodes including parallel children` });
	}
	const projectionEdgeCount = countGraphProjectionEdges(graph);
	if (projectionEdgeCount > GRAPH_RUN_PROJECTION_MAX_EDGES) {
		issues.push({ path: "transitions", message: `graph may expose at most ${GRAPH_RUN_PROJECTION_MAX_EDGES} edges` });
	}
	if (
		projectionNodeCount <= GRAPH_RUN_PROJECTION_MAX_NODES
		&& projectionEdgeCount <= GRAPH_RUN_PROJECTION_MAX_EDGES
		&& !graphProjectionFitsByteLimit(graph)
	) {
		issues.push({ path: "nodes", message: "graph identity and topology exceed the workflow projection byte limit" });
	}

	if (isNonEmptyString(graph.start) && !graphNodeIds.has(graph.start)) {
		issues.push({ path: "start", message: `unknown start node: ${graph.start}` });
	}

	for (const [key, node] of entries) {
		if (!isNonEmptyString(key)) {
			issues.push({ path: "nodes", message: "node keys must be non-empty strings" });
		}
		if (key !== node.id) {
			issues.push({ path: `nodes.${key}.id`, message: `node id must match registry key (${key})` });
		}
		if (graph.mutationPolicy === "read-only" && nodeMutates(node)) {
			issues.push({ path: `nodes.${key}.capabilities`, message: "read-only graphs cannot contain mutating nodes" });
		}
		if (graph.mutationPolicy === "approval-required" && nodeMutates(node) && !node.approvalNodeId) {
			issues.push({ path: `nodes.${key}.approvalNodeId`, message: "mutating nodes must reference an approval node" });
		}
		if (node.approvalNodeId && graph.nodes[node.approvalNodeId]?.type !== "approval") {
			issues.push({ path: `nodes.${key}.approvalNodeId`, message: "approvalNodeId must reference an approval node" });
		}
		validateNode(node, `nodes.${key}`, graphNodeIds, issues, seenProjectionNodeIds);
	}

	for (const [index, transition] of (graph.transitions ?? []).entries()) {
		validateGraphTransition(transition, index, graphNodeIds, issues);
	}

	for (const [nodeId, node] of entries) {
		const onError = node.failure?.onError;
		if (!onError || !graphNodeIds.has(onError)) continue;
		if ((graph.transitions ?? []).some((transition) => transition.from === nodeId && transition.to === onError && transition.when !== "error")) {
			issues.push({ path: `nodes.${nodeId}.failure.onError`, message: "onError must not duplicate a normal transition target" });
		}
		if (nodeMutates(node) && canReachNode(graph, onError, nodeId)) {
			issues.push({ path: `nodes.${nodeId}.failure.onError`, message: "mutating failure routes must not lead back to the mutating node" });
		}
	}

	for (const [index, binding] of (graph.approvalBindings ?? []).entries()) {
		if (!graphNodeIds.has(binding.node)) {
			issues.push({ path: `approvalBindings[${index}].node`, message: `unknown approval node: ${binding.node}` });
		} else if (graph.nodes[binding.node]?.type !== "approval") {
			issues.push({ path: `approvalBindings[${index}].node`, message: "approval binding must reference an approval node" });
		}
		if (!(graph.capabilities ?? []).some((capability) => capability.id === binding.capability)) {
			issues.push({ path: `approvalBindings[${index}].capability`, message: `unknown capability: ${binding.capability}` });
		}
	}

	if (graph.mutationPolicy === "read-only" && graphCapabilityMutates(graph)) {
		issues.push({ path: "capabilities", message: "read-only graphs cannot declare mutating capabilities" });
	}

	if (graph.mutationPolicy === "approval-required") {
		for (const capability of graph.capabilities ?? []) {
			if (!capability.mutates) continue;
			const hasApproval = (graph.approvalBindings ?? []).some((binding) => binding.capability === capability.id);
			if (!hasApproval) {
				issues.push({ path: `capabilities.${capability.id}`, message: "mutating capability must have an approval binding" });
			}
		}
	}

	const reachable = new Set<string>();
	const stack = graphNodeIds.has(graph.start) ? [graph.start] : [];
	while (stack.length > 0) {
		const nodeId = stack.pop();
		if (!nodeId || reachable.has(nodeId)) continue;
		reachable.add(nodeId);
		const node = graph.nodes[nodeId];
		for (const target of [...transitionTargets(node), ...graphTransitionTargets(graph, nodeId)]) {
			if (graphNodeIds.has(target) && !reachable.has(target)) stack.push(target);
		}
	}

	for (const nodeId of graphNodeIds) {
		if (!reachable.has(nodeId)) {
			issues.push({ path: `nodes.${nodeId}`, message: `node is not reachable from start node ${graph.start}` });
		}
	}

	return { ok: issues.length === 0, issues };
}

function validateGraphTransition(
	transition: GraphStaticTransition,
	index: number,
	graphNodeIds: Set<string>,
	issues: GraphValidationIssue[],
): void {
	if (!isNonEmptyString(transition.from)) {
		issues.push({ path: `transitions[${index}].from`, message: "transition source must be a non-empty string" });
	} else if (!graphNodeIds.has(transition.from)) {
		issues.push({ path: `transitions[${index}].from`, message: `unknown transition source: ${transition.from}` });
	}

	if (transition.to !== undefined && !isNonEmptyString(transition.to)) {
		issues.push({ path: `transitions[${index}].to`, message: "transition target must be a non-empty string when provided" });
	} else if (transition.to && !graphNodeIds.has(transition.to)) {
		issues.push({ path: `transitions[${index}].to`, message: `unknown transition target: ${transition.to}` });
	}
}

export function assertValidGraph(graph: GraphDefinition): void {
	const result = validateGraph(graph);
	if (!result.ok) throw new GraphValidationError(result.issues);
}
