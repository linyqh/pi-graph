import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GraphValidationContext } from "./types.ts";

export const GRAPH_CONTRACT_REQUEST = "pi-graph:contracts:request";
export const GRAPH_CONTRACT_REGISTER = "pi-graph:contracts:register";
export interface GraphRegisteredContract {
	id: string;
	validateRun?(run: GraphValidationContext, ctx?: ExtensionContext, signal?: AbortSignal): Promise<void>;
	validateOutput?(output: unknown, run: GraphValidationContext, ctx?: ExtensionContext, signal?: AbortSignal): Promise<{ valid: boolean; feedback?: string; blocked?: boolean }>;
}

/** Event-bus registrations are trusted plugin code, not serialized graph/task inputs. */
export function isGraphContract(value: unknown): value is GraphRegisteredContract {
	if (!value || typeof value !== "object") return false;
	const contract = value as GraphRegisteredContract;
	return typeof contract.id === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(contract.id)
		&& (typeof contract.validateRun === "function" || typeof contract.validateOutput === "function");
}
