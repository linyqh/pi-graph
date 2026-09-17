import type { GraphNodeFailurePolicy } from "./types.ts";

export type ExecutionErrorKind = "transient" | "output" | "budget" | "business" | "unknown";

export class GraphExecutionError extends Error {
	readonly kind: ExecutionErrorKind;
	readonly retryAfterMs?: number;
	constructor(message: string, kind: ExecutionErrorKind, retryAfterMs?: number) {
		super(message);
		this.name = "GraphExecutionError";
		this.kind = kind;
		this.retryAfterMs = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : undefined;
	}
}

export function executionErrorKind(error: unknown): ExecutionErrorKind {
	if (error instanceof GraphExecutionError) return error.kind;
	if (!(error instanceof Error)) return "unknown";
	// Legacy provider adaptation is deliberately narrow. Business/tool errors do
	// not become retryable merely because they contain the word "timeout".
	if (/Our servers are currently overloaded|rate limit exceeded|too many requests|ECONNRESET|EAI_AGAIN/i.test(error.message)) return "transient";
	return "unknown";
}

export function retryDelay(policy: GraphNodeFailurePolicy | undefined, attempt: number, error: unknown): number {
	const base = policy?.initialDelayMs ?? 2000;
	const cap = policy?.maxDelayMs ?? 60000;
	const delay = Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
	return Math.ceil(Math.max(delay, error instanceof GraphExecutionError ? error.retryAfterMs ?? 0 : 0));
}

export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
		const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
