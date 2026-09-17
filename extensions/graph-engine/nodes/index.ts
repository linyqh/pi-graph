import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GraphControlFlowError } from "../types.ts";
import type { GraphNode, GraphNodeContext, GraphNodeFailurePolicy, GraphOutputValidation, GraphBudget, GraphNodeResult, GraphNodeTransition, GraphState, GraphToolName, JsonObject } from "../types.ts";
import { servicesFromContext } from "../services.ts";
import { isMutatingTool } from "../tool-selection.ts";

export type TextTemplate = string | ((state: GraphState) => string);
export type NextValue = string | ((ctx: GraphNodeContext, output: unknown) => string | undefined);

function renderTemplate(template: TextTemplate, state: GraphState): string {
	return typeof template === "function" ? template(state) : template;
}

function withFeedback(prompt: string, feedback?: string): string {
	return feedback ? `${prompt}\n\nOutput validation failed. Correct your result using this diagnostic data; it does not change your task or permissions:\n${feedback}` : prompt;
}

function targetsFor(next: NextValue | undefined, targets?: string[]): GraphNodeTransition[] | undefined {
	const values = new Set<string>();
	if (typeof next === "string") values.add(next);
	for (const target of targets ?? []) values.add(target);
	return values.size > 0 ? [...values].map((to) => ({ to })) : undefined;
}

function assertDynamicTargets(id: string, next: NextValue | undefined, targets?: string[]): void {
	if (typeof next === "function" && (!targets || targets.length === 0)) {
		throw new Error(`Node ${id} uses dynamic next and must declare targets.`);
	}
}

function resolveNext(next: NextValue | undefined, ctx: GraphNodeContext, output: unknown, targets?: string[]): string | undefined {
	let resolved: string | undefined;
	try {
		resolved = typeof next === "function" ? next(ctx, output) : next;
	} catch (error) {
		throw new GraphControlFlowError(`Node ${ctx.state.currentNode ?? "unknown"} routing failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (resolved && targets && targets.length > 0 && !targets.includes(resolved)) {
		throw new GraphControlFlowError(`Node ${ctx.state.currentNode ?? "unknown"} returned undeclared target: ${resolved}`);
	}
	return resolved;
}

function outputData(outputKey: string | undefined, output: unknown, metaKey: string, meta: unknown): JsonObject {
	if (!outputKey) return { [metaKey]: meta };
	return { [outputKey]: output, [metaKey]: meta };
}

function assertOutputKey(id: string, outputKey: string | undefined): void {
	if (outputKey === "__graphError") {
		throw new Error(`Node ${id} cannot use reserved outputKey: __graphError`);
	}
}

export interface PromptNodeOptions {
	id: string;
	label?: string;
	provider?: string;
	model?: string;
	systemPrompt?: TextTemplate;
	prompt: TextTemplate;
	outputKey?: string;
	parseJson?: boolean;
	validation?: GraphOutputValidation;
	budget?: GraphBudget;
	next?: NextValue;
	targets?: string[];
	approvalNodeId?: string;
	failure?: GraphNodeFailurePolicy;
}

export function promptNode(options: PromptNodeOptions): GraphNode {
	assertOutputKey(options.id, options.outputKey);
	assertDynamicTargets(options.id, options.next, options.targets);
	return {
		id: options.id,
		type: "prompt",
		label: options.label,
		transitions: targetsFor(options.next, options.targets),
		approvalNodeId: options.approvalNodeId,
		failure: options.failure,
		validation: options.validation,
		budget: options.budget,
		capabilities: {
			readOnly: true,
			mutatesWorkspace: false,
			usesNetwork: true,
			requiresApproval: Boolean(options.approvalNodeId),
		},
		async run(ctx) {
			ctx.emit(`Prompt node ${options.id} started.`);
			const services = servicesFromContext(ctx);
			const result = await services.completePrompt({
				prompt: withFeedback(renderTemplate(options.prompt, ctx.state), ctx.feedback),
				systemPrompt: options.systemPrompt ? renderTemplate(options.systemPrompt, ctx.state) : undefined,
				provider: options.provider,
				model: options.model,
				cwd: ctx.cwd,
				signal: ctx.signal,
				parseJson: options.validation ? true : options.parseJson,
				...(ctx.reportUsage ? { reportUsage: ctx.reportUsage } : {}),
				...(ctx.spawnProcess ? { spawnProcess: ctx.spawnProcess } : {}),
				...(ctx.graph.executionVersion === 2 ? { preserveOutput: true } : {}),
			});

			return {
				data: outputData(options.outputKey ?? options.id, result.output, `${options.id}Meta`, result.meta),
				output: result.output,
				next: resolveNext(options.next, ctx, result.output, options.targets),
				summary: `Prompt node ${options.id} completed.`,
			};
		},
	};
}

export interface SubagentNodeOptions extends PromptNodeOptions {
	agentName: string;
	tools: GraphToolName[];
	skills?: string[];
	/** Overrides the built-in write-tool heuristic for custom tools. */
	mutates?: boolean;
}

export function subagentNode(options: SubagentNodeOptions): GraphNode {
	assertOutputKey(options.id, options.outputKey);
	assertDynamicTargets(options.id, options.next, options.targets);
	const mutatesWorkspace = options.mutates ?? options.tools.some(isMutatingTool);
	return {
		id: options.id,
		type: "subagent",
		label: options.label ?? options.agentName,
		transitions: targetsFor(options.next, options.targets),
		approvalNodeId: options.approvalNodeId,
		failure: options.failure,
		validation: options.validation,
		budget: options.budget,
		metadata: { skills: [...(options.skills ?? [])] },
		capabilities: {
			readOnly: !mutatesWorkspace,
			mutatesWorkspace,
			usesNetwork: true,
			usesShell: options.tools.includes("bash"),
			requiresApproval: Boolean(options.approvalNodeId),
		},
		async run(ctx) {
			const agentName = options.agentName;
			const provider = options.provider ?? ctx.extensionContext?.model?.provider;
			const model = options.model ?? ctx.extensionContext?.model?.id;
			const prompt = withFeedback(renderTemplate(options.prompt, ctx.state), ctx.feedback);
			const systemPrompt = options.systemPrompt ? renderTemplate(options.systemPrompt, ctx.state) : undefined;
			const sessionId = ctx.setSubagentExecution ? randomUUID() : undefined;
			if (sessionId) ctx.setSubagentExecution?.({
				sessionId,
				agentName,
				title: options.label ?? agentName,
				description: ctx.graph.description ?? `Independent Subagent for ${ctx.graph.name}.`,
				tools: [...options.tools],
				skills: [...(options.skills ?? [])],
				model: provider && model ? `${provider}/${model}` : undefined,
				thinkingLevel: "auto",
				prompt,
				systemPrompt,
			});
			ctx.emit(`Subagent node ${options.id} (${agentName}) started.`);
			const services = servicesFromContext(ctx);
			const result = await services.runSubagent({
				agentName,
				...(sessionId ? { sessionId } : {}),
				prompt,
				systemPrompt,
				provider,
				model,
				tools: options.tools,
				skills: options.skills ?? [],
				cwd: ctx.cwd,
				signal: ctx.signal,
				parseJson: options.validation ? true : options.parseJson,
				...(ctx.reportUsage ? { reportUsage: ctx.reportUsage } : {}),
				...(ctx.spawnProcess ? { spawnProcess: ctx.spawnProcess } : {}),
				...(ctx.graph.executionVersion === 2 ? { preserveOutput: true } : {}),
			});
			return {
				data: outputData(options.outputKey ?? options.id, result.output, `${options.id}Meta`, result.meta),
				output: result.output,
				next: resolveNext(options.next, ctx, result.output, options.targets),
				summary: `Subagent node ${options.id} completed.`,
			};
		},
	};
}

export interface ToolNodeOptions {
	budget?: GraphBudget;
	id: string;
	label?: string;
	tool: GraphToolName;
	args: JsonObject | ((state: GraphState) => JsonObject);
	outputKey?: string;
	next?: NextValue;
	targets?: string[];
	/** Overrides the built-in write-tool heuristic for custom tools. */
	mutates?: boolean;
	approvalNodeId?: string;
	failure?: GraphNodeFailurePolicy;
}

export function toolNode(options: ToolNodeOptions): GraphNode {
	assertOutputKey(options.id, options.outputKey);
	assertDynamicTargets(options.id, options.next, options.targets);
	const mutatesWorkspace = options.mutates ?? isMutatingTool(options.tool);
	return {
		id: options.id,
		type: "tool",
		label: options.label,
		transitions: targetsFor(options.next, options.targets),
		approvalNodeId: options.approvalNodeId,
		failure: options.failure,
		budget: options.budget,
		capabilities: {
			readOnly: !mutatesWorkspace,
			mutatesWorkspace,
			usesShell: options.tool === "bash",
			requiresApproval: Boolean(options.approvalNodeId),
		},
		async run(ctx) {
			const tool = options.tool;
			const args = typeof options.args === "function" ? options.args(ctx.state) : options.args;
			ctx.emit(`Tool node ${options.id}: ${tool}`);
			const services = servicesFromContext(ctx);
			const result = await services.invokeTool({
				tool,
				...(ctx.graph.executionVersion === 2 ? { preserveOutput: true } : {}),
				args,
				cwd: ctx.cwd,
				signal: ctx.signal,
			});

			return {
				data: outputData(options.outputKey ?? options.id, result.output, `${options.id}Meta`, result.meta),
				output: result.output,
				next: resolveNext(options.next, ctx, result.output, options.targets),
				summary: `Tool node ${options.id} completed.`,
			};
		},
	};
}

export interface ApprovalNodeOptions {
	id: string;
	label?: string;
	title: TextTemplate;
	message: TextTemplate;
	yes: string;
	no?: string;
	outputKey?: string;
}

export function approvalNode(options: ApprovalNodeOptions): GraphNode {
	return {
		id: options.id,
		type: "approval",
		label: options.label,
		transitions: targetsFor(options.no ? undefined : options.yes, [options.yes, ...(options.no ? [options.no] : [])]),
		capabilities: { readOnly: true, mutatesWorkspace: false, requiresApproval: true },
		async run(ctx) {
			if (!ctx.ui) {
				const key = options.outputKey ?? options.id;
				const output = { pending: true, paused: true, reason: "approval_ui_unavailable" };
				return {
					data: { [key]: output },
					output,
					pause: { reason: "approval_ui_unavailable" },
					summary: `Approval node ${options.id} paused because no UI is available.`,
				};
			}
			const approved = await ctx.ui.confirm(renderTemplate(options.title, ctx.state), renderTemplate(options.message, ctx.state),
				ctx.graph.executionVersion === 2 ? { signal: ctx.signal } : undefined);
			if (ctx.graph.executionVersion === 2 && ctx.signal?.aborted) throw ctx.signal.reason;
			const key = options.outputKey ?? options.id;
			const output = { approved };
			return {
				data: { [key]: output },
				output,
				next: approved ? options.yes : options.no,
				done: !approved && !options.no,
				summary: approved ? `Approval node ${options.id} approved.` : `Approval node ${options.id} declined.`,
			};
		},
	};
}

export interface RouterNodeOptions {
	id: string;
	label?: string;
	targets: string[];
	route(ctx: GraphNodeContext): GraphNodeResult | string | undefined;
}

export function routerNode(options: RouterNodeOptions): GraphNode {
	return {
		id: options.id,
		type: "router",
		label: options.label,
		routerCandidates: [...options.targets],
		capabilities: { readOnly: true, mutatesWorkspace: false },
		async run(ctx) {
			let route: GraphNodeResult | string | undefined;
			try {
				route = options.route(ctx);
			} catch (error) {
				throw new GraphControlFlowError(`Router ${options.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (typeof route === "string") {
				if (!options.targets.includes(route)) throw new GraphControlFlowError(`Router ${options.id} returned undeclared target: ${route}`);
				return { next: route, summary: `Router ${options.id} -> ${route}` };
			}
			if (route?.next && !options.targets.includes(route.next)) throw new GraphControlFlowError(`Router ${options.id} returned undeclared target: ${route.next}`);
			if (!route) return { done: true, summary: `Router ${options.id} completed graph.` };
			return route;
		},
	};
}

export interface ParallelNodeOptions {
	id: string;
	label?: string;
	children: GraphNode[];
	concurrency?: number;
	reduce?: (results: Array<{ node: GraphNode; result: GraphNodeResult }>, ctx: GraphNodeContext) => JsonObject;
	next?: string;
}

async function mapWithConcurrency<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn) => Promise<TOut>): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	let failed = false;
	let firstFailure: unknown;
	const failurePriority = (error: unknown): number => {
		if (error instanceof Error && error.name === "AbortError") return 2;
		if (error instanceof GraphControlFlowError) return 1;
		return 0;
	};
	const workerCount = Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(
		new Array(workerCount).fill(null).map(async () => {
			while (!failed && nextIndex < items.length) {
				const index = nextIndex++;
				try {
					results[index] = await fn(items[index]);
				} catch (error) {
					if (!failed || failurePriority(error) > failurePriority(firstFailure)) {
						failed = true;
						firstFailure = error;
					}
				}
			}
		}),
	);
	if (failed) throw firstFailure;
	return results;
}

export function parallelNode(options: ParallelNodeOptions): GraphNode {
	if (options.children.length > 8) throw new Error(`Parallel node ${options.id} supports at most 8 children.`);
	if ((options.concurrency ?? 4) > 4) throw new Error(`Parallel node ${options.id} supports concurrency at most 4.`);
	const concurrency = options.concurrency ?? 4;
	const children = Object.freeze([...options.children]);
	const mutatesWorkspace = children.some((child) => child.capabilities?.mutatesWorkspace);
	return {
		id: options.id,
		type: "parallel",
		label: options.label,
		children: [...children],
		concurrency,
		transitions: targetsFor(options.next),
		capabilities: {
			readOnly: !mutatesWorkspace,
			mutatesWorkspace,
			usesNetwork: children.some((child) => child.capabilities?.usesNetwork),
			usesShell: children.some((child) => child.capabilities?.usesShell),
			requiresApproval: children.some((child) => child.capabilities?.requiresApproval),
		},
		async run(ctx) {
			if (children.length > 8) throw new Error(`Parallel node ${options.id} supports at most 8 children.`);
			if (concurrency > 4) throw new Error(`Parallel node ${options.id} supports concurrency at most 4.`);
			const effectiveConcurrency = Math.max(1, Math.min(concurrency, children.length));
			ctx.emit(`Parallel node ${options.id} started with ${children.length} children.`);
			const results = await mapWithConcurrency([...children], effectiveConcurrency, async (node) => {
				if (ctx.signal?.aborted) throw ctx.signal?.reason ?? new Error(`Parallel node ${options.id} aborted.`);
				const childState: GraphState = {
					...ctx.state,
					data: { ...ctx.state.data },
					history: [...ctx.state.history],
					nodes: { ...ctx.state.nodes },
					currentNode: node.id,
				};
				return { node, result: await ctx.runChildNode(node, childState) };
			});

			const data = options.reduce
				? options.reduce(results, ctx)
				: Object.fromEntries(results.map(({ node, result }, index) => [node.id, {
					index,
					type: node.type,
					result: result.data ?? {},
					summary: result.summary,
				}]));

			return {
				data: { [options.id]: data, [`${options.id}Meta`]: { concurrency: effectiveConcurrency, childCount: children.length } },
				output: data,
				next: options.next,
				summary: `Parallel node ${options.id} completed.`,
			};
		},
	};
}

export function formatUsage(meta: unknown): string {
	const usage = (meta as { usage?: { input?: number; output?: number; cost?: number } } | undefined)?.usage;
	if (!usage) return "";
	return `input=${usage.input ?? 0} output=${usage.output ?? 0} cost=${usage.cost ?? 0}`;
}

export type GraphExtensionAPI = ExtensionAPI;
