import type { GraphDefinition, GraphMutationPolicy } from "./types.ts";
import { assertValidGraph } from "./validation.ts";

export interface GraphCapability {
	id: string;
	description: string;
	tools: string[];
	skills?: string[];
	mutates: boolean;
}

export interface GraphApprovalBinding {
	node: string;
	capability: string;
	description: string;
}

export interface GraphTransition {
	from: string;
	to?: string;
	when: string;
}

export interface RegisteredGraphDefinition extends GraphDefinition {
	mutationPolicy: GraphMutationPolicy;
	capabilities: GraphCapability[];
	approvalBindings: GraphApprovalBinding[];
	transitions: GraphTransition[];
}

export interface GraphRegistry {
	definitions: RegisteredGraphDefinition[];
	graphs: Record<string, RegisteredGraphDefinition>;
	names: string[];
}

export function createGraphRegistry(definitions: RegisteredGraphDefinition[]): GraphRegistry {
	const graphs = Object.create(null) as Record<string, RegisteredGraphDefinition>;
	for (const graph of definitions) {
		if (Object.hasOwn(graphs, graph.name)) throw new Error(`Duplicate graph registered: ${graph.name}`);
		graphs[graph.name] = graph;
	}

	for (const graph of definitions) {
		assertValidGraph(graph);
	}

	const names = definitions.map((graph) => graph.name).sort();
	return { definitions, graphs, names };
}
