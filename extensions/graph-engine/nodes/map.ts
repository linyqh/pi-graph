import { GraphControlFlowError } from "../types.ts";
import type { GraphNode, GraphState } from "../types.ts";
import { mapWithConcurrency } from "./index.ts";

export interface MapNodeOptions {
	id: string;
	label?: string;
	items(state: GraphState): unknown;
	templates: GraphNode[];
	maxItems: number;
	minItems?: number;
	concurrency?: number;
	next?: string;
}

export function mapNode(options: MapNodeOptions): GraphNode {
	return {
		id: options.id, type: "map", label: options.label,
		children: options.templates, concurrency: options.concurrency ?? 4,
		map: { maxItems: options.maxItems, minItems: options.minItems ?? 0 },
		transitions: options.next ? [{ to: options.next }] : [],
		capabilities: { readOnly: true, mutatesWorkspace: false },
		async run(ctx) {
			if (!ctx.prepareTaskBatch) throw new GraphControlFlowError("map requires durable v2 task execution.");
			const batch = ctx.prepareTaskBatch(() => options.items(ctx.state));
			const results = await mapWithConcurrency(batch.tasks, options.concurrency ?? 4, async (task) => {
				if (ctx.signal?.aborted) throw ctx.signal.reason;
				const template = options.templates.find((item) => item.id === task.template)!;
				const node = { ...template, id: `${options.id}:${task.taskId}`, label: task.label ?? task.taskId };
				const state = { ...ctx.state, currentNode: node.id, data: { ...batch.data, mapTask: { ...task, batchId: batch.id } } };
				try {
					const result = await ctx.runChildNode(node, state);
					return { taskId: task.taskId, template: task.template, required: task.required, status: "completed", output: result.output, result: result.data };
				} catch (error) {
					// Optional analytical gaps stay visible. Cancellation, budgets and runtime
					// integrity failures always stop the batch, regardless of optionality.
					if (task.required || ctx.signal?.aborted || error instanceof GraphControlFlowError || ["budget", "business"].includes((error as { kind?: string })?.kind ?? "")) throw error;
					return { taskId: task.taskId, template: task.template, required: false, status: "failed", error: error instanceof Error ? error.message : String(error) };
				}
			});
			return { data: { [options.id]: results }, output: results, next: options.next, summary: `Map ${options.id} completed ${results.length} task(s).` };
		},
	};
}
