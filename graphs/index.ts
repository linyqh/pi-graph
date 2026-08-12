import { createGraphRegistry } from "../extensions/graph-engine/registry.ts";
import { researchGraph } from "./research.ts";

export const graphRegistry = createGraphRegistry([
	researchGraph,
]);

export const graphDefinitions = graphRegistry.definitions;
export const graphs = graphRegistry.graphs;
export const graphNames = graphRegistry.names;
