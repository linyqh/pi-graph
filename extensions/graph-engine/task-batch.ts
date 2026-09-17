import { createHash, randomUUID } from "node:crypto";
import { GraphControlFlowError } from "./types.ts";
import type { GraphMapTask, GraphNode, GraphState, GraphTaskBatch } from "./types.ts";

function batchHash(batch: Omit<GraphTaskBatch, "hash">): string {
	return createHash("sha256").update(JSON.stringify(batch)).digest("hex");
}

export function prepareTaskBatch(node: GraphNode, state: GraphState, items: () => unknown, persist: (next: GraphState) => void): GraphTaskBatch {
	if (state.schemaVersion !== 2 || node.type !== "map" || !node.map) throw new GraphControlFlowError("Task batches require a v2 map node.");
	const existing = state.batches?.[node.id];
	if (existing) {
		const { hash, ...body } = existing;
		if (batchHash(body) !== hash) throw new GraphControlFlowError("Saved task batch integrity check failed.");
		return structuredClone(existing);
	}
	const values = items();
	if (!Array.isArray(values) || values.length < node.map.minItems || values.length > node.map.maxItems) throw new GraphControlFlowError("Task list is missing or outside the declared item bounds.");
	const ids = new Set<string>();
	const templates = new Set(node.children?.map((child) => child.id));
	const tasks: GraphMapTask[] = values.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["taskId", "template", "input", "required", "label"].includes(key))) throw new GraphControlFlowError("Task contains unsupported fields.");
		const { taskId, template, input, required = true, label } = value;
		if (typeof taskId !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(taskId) || ids.has(taskId)) throw new GraphControlFlowError("Task ID is invalid or duplicated.");
		if (!templates.has(template)) throw new GraphControlFlowError("Task template is not in the declared allowlist.");
		if (!input || typeof input !== "object" || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 65536) throw new GraphControlFlowError("Task input must be an object of at most 64 KiB.");
		if (typeof required !== "boolean" || (label !== undefined && (typeof label !== "string" || label.length > 128))) throw new GraphControlFlowError("Task required/label is invalid.");
		ids.add(taskId);
		return { taskId, template, input, required, ...(label ? { label } : {}) };
	});
	const data = JSON.parse(JSON.stringify(state.data));
	delete data.__graphError;
	const body = { id: randomUUID(), tasks, data };
	const batch = { ...body, hash: batchHash(body) };
	const staged = JSON.parse(JSON.stringify(state)) as GraphState;
	staged.batches ??= {};
	staged.batches[node.id] = batch;
	persist(staged);
	state.batches ??= {};
	state.batches[node.id] = batch;
	return structuredClone(batch);
}
