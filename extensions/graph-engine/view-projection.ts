import {
	GRAPH_RUN_PROJECTION_KIND,
	GRAPH_RUN_PROJECTION_MAX_BYTES,
	GRAPH_RUN_PROJECTION_SCHEMA_VERSION,
} from "./types.ts";
import type {
	GraphDefinition,
	GraphEvent,
	GraphNode,
	GraphRunProjection,
	GraphRunProjectionEdge,
	GraphRunProjectionEdgeKind,
	GraphRunProjectionNode,
	GraphState,
} from "./types.ts";

interface FlatNode {
	node: GraphNode;
	parentId?: string;
}

interface RawEdge {
	from: string;
	to: string;
	label?: string;
	kind: Exclude<GraphRunProjectionEdgeKind, "loop">;
	runtimeFrom?: string;
}

export function flattenGraphNodes(graph: GraphDefinition): FlatNode[] {
	const result: FlatNode[] = [];
	const visit = (node: GraphNode, parentId?: string) => {
		result.push({ node, parentId });
		for (const child of node.children ?? []) visit(child, node.id);
	};
	for (const node of Object.values(graph.nodes)) visit(node);
	return result;
}

function transitionList(graph: GraphDefinition): Array<{ from: string; to: string; label?: string }> {
	if (graph.transitions && graph.transitions.length > 0) {
		const declared = graph.transitions
			.filter((edge): edge is typeof edge & { to: string } => Boolean(edge.to))
			.map((edge) => ({ from: edge.from, to: edge.to, label: edge.when }));
		const declaredKeys = new Set(declared.map((edge) => `${edge.from}\0${edge.to}\0${edge.label ?? ""}`));
		const fallbackFailures = Object.values(graph.nodes).flatMap((node) => {
			const target = node.failure?.onError;
			if (!target) return [];
			const edge = { from: node.id, to: target, label: "error" };
			return declaredKeys.has(`${edge.from}\0${edge.to}\0${edge.label}`) ? [] : [edge];
		});
		return [...declared, ...fallbackFailures];
	}
	return Object.values(graph.nodes).flatMap((node) => [
		...(node.transitions ?? []).map((edge) => ({ from: node.id, to: edge.to, label: edge.label })),
		...(node.failure?.onError ? [{ from: node.id, to: node.failure.onError, label: "error" }] : []),
	]);
}

function rawEdges(graph: GraphDefinition): RawEdge[] {
	const outgoingCounts = new Map<string, number>();
	for (const edge of transitionList(graph)) {
		outgoingCounts.set(edge.from, (outgoingCounts.get(edge.from) ?? 0) + 1);
	}

	const result: RawEdge[] = [];
	const parallelJoins = new Map<string, RawEdge[]>();
	for (const edge of transitionList(graph)) {
		const source = graph.nodes[edge.from];
		if (source?.type === "parallel" && source.children && source.children.length > 0) {
			parallelJoins.set(source.id, source.children.map((child) => ({
					from: child.id,
					to: edge.to,
					label: edge.label,
					kind: "parallel",
					runtimeFrom: source.id,
				})));
			continue;
		}
		result.push({
			...edge,
			kind: (outgoingCounts.get(edge.from) ?? 0) > 1 ? "branch" : "transition",
		});
	}

	for (const node of Object.values(graph.nodes)) {
		for (const child of node.children ?? []) {
			result.push({ from: node.id, to: child.id, kind: "parallel" });
		}
		result.push(...(parallelJoins.get(node.id) ?? []));
	}
	return result;
}

export function countGraphProjectionEdges(graph: GraphDefinition): number {
	return rawEdges(graph).length;
}

function boundedText(value: string | undefined, maxBytes: number): string | undefined {
	if (value === undefined || Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(`${value.slice(0, middle)}…`, "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return `${value.slice(0, low)}…`;
}

function fitProjectionToByteLimit(projection: GraphRunProjection): GraphRunProjection {
	if (Buffer.byteLength(JSON.stringify(projection), "utf8") <= GRAPH_RUN_PROJECTION_MAX_BYTES) return projection;
	const compact: GraphRunProjection = {
		...projection,
		description: undefined,
		nodes: projection.nodes.map((node) => ({
			...node,
			label: boundedText(node.label, 64)!,
			error: undefined,
			capabilities: undefined,
			subagent: node.subagent ? {
				...node.subagent,
				description: undefined,
				prompt: undefined,
				systemPrompt: undefined,
			} : undefined,
		})),
		edges: projection.edges.map((edge) => ({ ...edge, label: undefined })),
	};
	if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= GRAPH_RUN_PROJECTION_MAX_BYTES) return compact;
	throw new Error(`Graph run projection exceeds ${GRAPH_RUN_PROJECTION_MAX_BYTES} bytes.`);
}

function loopEdgeIndexes(edges: RawEdge[], start: string): Set<number> {
	const outgoing = new Map<string, number[]>();
	for (const [index, edge] of edges.entries()) {
		const list = outgoing.get(edge.from) ?? [];
		list.push(index);
		outgoing.set(edge.from, list);
	}
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const loops = new Set<number>();
	const visit = (nodeId: string) => {
		if (visited.has(nodeId)) return;
		visiting.add(nodeId);
		for (const edgeIndex of outgoing.get(nodeId) ?? []) {
			const target = edges[edgeIndex]!.to;
			if (visiting.has(target)) loops.add(edgeIndex);
			else visit(target);
		}
		visiting.delete(nodeId);
		visited.add(nodeId);
	};
	visit(start);
	for (const nodeId of outgoing.keys()) visit(nodeId);
	return loops;
}

interface TopLevelStart {
	nodeId: string;
	resumeCount: number;
}

function topLevelStarts(graph: GraphDefinition, history: GraphEvent[]): TopLevelStart[] {
	const ids = new Set(Object.keys(graph.nodes));
	return history
		.filter((event) => event.type === "start" && (event.attempt === undefined || event.attempt === 1) && ids.has(event.nodeId))
		.map((event) => ({ nodeId: event.nodeId, resumeCount: event.resumeCount ?? 0 }));
}

function countTraversals(starts: TopLevelStart[], from: string, to: string): number {
	let count = 0;
	for (let index = 1; index < starts.length; index += 1) {
		const previous = starts[index - 1]!;
		const current = starts[index]!;
		if (previous.resumeCount === current.resumeCount && previous.nodeId === from && current.nodeId === to) count += 1;
	}
	return count;
}

function childTraversalCount(history: GraphEvent[], parentId: string, childId: string): number {
	let parentSeen = false;
	let count = 0;
	for (const event of history) {
		if (event.type !== "start" || (event.attempt !== undefined && event.attempt !== 1)) continue;
		if (event.nodeId === parentId) parentSeen = true;
		else if (event.nodeId === childId && parentSeen) count += 1;
	}
	return count;
}

export function projectGraphRunView(graph: GraphDefinition, state: GraphState): GraphRunProjection {
	const flatNodes = flattenGraphNodes(graph);
	const nodes: GraphRunProjectionNode[] = flatNodes.map(({ node, parentId }) => {
		const runtime = state.nodes[node.id] ?? { status: "pending" as const };
		return {
			id: node.id,
			parentId,
			label: boundedText(node.label ?? node.id, 128)!,
			type: node.type,
			status: runtime.status,
			startedAt: runtime.startedAt,
			completedAt: runtime.completedAt,
			error: boundedText(runtime.error, 256),
			attempts: runtime.attempts,
			maxAttempts: runtime.maxAttempts,
			capabilities: node.capabilities ? { ...node.capabilities } : undefined,
			subagent: runtime.subagent ? {
				...runtime.subagent,
				title: boundedText(runtime.subagent.title, 256),
				description: boundedText(runtime.subagent.description, 2 * 1024),
				model: boundedText(runtime.subagent.model, 256),
				thinkingLevel: boundedText(runtime.subagent.thinkingLevel, 32),
				prompt: boundedText(runtime.subagent.prompt, 16 * 1024),
				systemPrompt: boundedText(runtime.subagent.systemPrompt, 16 * 1024),
			} : undefined,
		};
	});
	const starts = topLevelStarts(graph, state.history);
	const lastTopLevelStart = starts.at(-1)?.nodeId;
	const raw = rawEdges(graph);
	const loopEdges = loopEdgeIndexes(raw, graph.start);
	const edges: GraphRunProjectionEdge[] = raw.map((edge, index) => {
		const runtimeFrom = edge.runtimeFrom ?? edge.from;
		const traversedCount = edge.kind === "parallel" && !edge.runtimeFrom && graph.nodes[edge.from]?.children?.some((child) => child.id === edge.to)
			? childTraversalCount(state.history, edge.from, edge.to)
			: countTraversals(starts, runtimeFrom, edge.to);
		return {
			id: `${edge.from}->${edge.to}:${index}`,
			from: edge.from,
			to: edge.to,
			label: boundedText(edge.label, 128),
			kind: loopEdges.has(index) ? "loop" : edge.kind,
			traversedCount,
			active: state.status === "running" && lastTopLevelStart === runtimeFrom && state.currentNode === edge.to,
		};
	});

	const projection: GraphRunProjection = {
		kind: GRAPH_RUN_PROJECTION_KIND,
		schemaVersion: GRAPH_RUN_PROJECTION_SCHEMA_VERSION,
		revision: state.history.length,
		runId: boundedText(state.runId, 128)!,
		graphName: boundedText(state.graphName, 128)!,
		graphVersion: boundedText(state.graphVersion, 64),
		description: boundedText(graph.description, 2 * 1024),
		goal: boundedText(state.goal, 4 * 1024)!,
		status: state.status,
		currentNodeId: state.currentNode,
		mutationPolicy: graph.mutationPolicy,
		startedAt: state.startedAt,
		updatedAt: state.updatedAt,
		completedAt: state.completedAt,
		resumeCount: state.resumeCount,
		progress: {
			completed: nodes.filter((node) => node.status === "completed").length,
			total: nodes.length,
		},
		nodes,
		edges,
	};
	return fitProjectionToByteLimit(projection);
}

export function graphProjectionFitsByteLimit(graph: GraphDefinition): boolean {
	const timestamp = Number.MAX_SAFE_INTEGER;
	const nodes = Object.fromEntries(flattenGraphNodes(graph).map(({ node }) => [node.id, {
		status: "failed" as const,
		startedAt: timestamp,
		completedAt: timestamp,
		error: "e".repeat(256),
	}]));
	try {
		projectGraphRunView(graph, {
			schemaVersion: 1,
			runId: "r".repeat(128),
			graphName: graph.name,
			graphVersion: graph.version,
			goal: "g".repeat(4 * 1024),
			cwd: "",
			status: "failed",
			currentNode: graph.start,
			data: {},
			history: [],
			nodes,
			approvals: [],
			resumeCount: Number.MAX_SAFE_INTEGER,
			startedAt: timestamp,
			updatedAt: timestamp,
			completedAt: timestamp,
		});
		return true;
	} catch (error) {
		if (error instanceof Error && error.message.includes("Graph run projection exceeds")) return false;
		throw error;
	}
}
