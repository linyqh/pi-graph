import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { DeclarativeGraphSpec } from "./declarative.ts";
import { PROJECT_GRAPH_MAX_BYTES } from "./project-graphs.ts";

/** Read once: the exact in-memory candidate is both previewed and committed. */
export async function readGraphEditInput(input: { spec?: unknown; specFile?: string }, cwd: string): Promise<unknown> {
	if ((input.spec !== undefined) === (input.specFile !== undefined)) {
		throw new Error("Provide exactly one of spec or specFile. Prefer specFile for large graphs; edit a draft file, not the active graph.");
	}
	if (input.specFile === undefined) return input.spec;
	const handle = await open(resolve(cwd, input.specFile), constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("specFile must be a regular JSON file.");
		if (stat.size > PROJECT_GRAPH_MAX_BYTES) throw new Error(`specFile exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`);
		const buffer = Buffer.alloc(PROJECT_GRAPH_MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size > PROJECT_GRAPH_MAX_BYTES) throw new Error(`specFile exceeds ${PROJECT_GRAPH_MAX_BYTES} bytes.`);
		return JSON.parse(buffer.toString("utf8", 0, size).replace(/^\uFEFF/, ""));
	} finally {
		await handle.close();
	}
}

export function graphEditError(error: unknown, spec?: DeclarativeGraphSpec): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!spec || !message.includes("not reachable from start")) return message;
	const byId = new Map(spec.nodes.map((node) => [node.id, node]));
	const reached = new Set<string>();
	const pending = [spec.start];
	const missing: string[] = [];
	while (pending.length) {
		const id = pending.pop()!;
		if (reached.has(id)) continue;
		reached.add(id);
		const node = byId.get(id);
		if (!node) continue;
		if (node.type === "router") {
			for (const target of [...node.cases, node.default]) if ("to" in target) pending.push(target.to);
		} else if (node.type === "approval") {
			pending.push(node.yes);
			if (node.no) pending.push(node.no);
		} else if (node.next) pending.push(node.next);
		else missing.push(`nodes.${id}.next`);
	}
	if (!missing.length) return message;
	return `Possible broken links: ${missing.join(", ")}. These reachable nodes have no next, so their normal flow ends here. If they should continue, set next to the intended node id; otherwise connect or remove the unreachable nodes.\n${message}`;
}

/** Scoped to one extension session/turn; no prompt overhead on successful work. */
export class GraphEditFailureTracker {
	private failures = new Map<string, { message: string; count: number }>();
	clear(): void { this.failures.clear(); }
	reset(key: string): void { this.failures.delete(key); }
	record(key: string, message: string): { repeated: boolean; attempts: number; guidance: string } {
		const previous = this.failures.get(key);
		const count = previous?.message === message ? previous.count + 1 : 1;
		this.failures.set(key, { message, count });
		return {
			repeated: count >= 2,
			attempts: count,
			guidance: count >= 2
				? "Stopped this agent turn after two identical graph edit errors. Fix the draft at the indicated fields, then retry with specFile and validateOnly. Do not resubmit the same JSON or bypass the graph tool through bash/internal revision functions."
				: "Fix the indicated fields in a draft file, then call with specFile and validateOnly: true. Do not regenerate the entire graph inline or repeat unchanged arguments.",
		};
	}
}
