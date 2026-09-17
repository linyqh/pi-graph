import { boundedExecutionValue } from "./output-contract.ts";
import { GraphExecutionError, providerExecutionError } from "./execution-policy.ts";
import { GraphControlFlowError } from "./types.ts";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { resolveSubagentExtensions, validateSkillTools } from "./capabilities.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import type {
	GraphExecutionOutput,
	GraphExecutionServices,
	GraphPromptRequest,
	GraphSubagentRequest,
	GraphToolName,
	GraphToolRequest,
	JsonObject,
} from "./types.ts";
import { parseJsonFromText, runPiSubagent } from "./pi-process.ts";
import { resolveGraphTool, getGraphHostEnvironment } from "./host-bridge.ts";
import { resolveAssignedSkills, type AssignedSkill } from "./skill-selection.ts";
import { listAvailableToolNames } from "./tool-selection.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;

type ToolMap = ReturnType<typeof createToolMap>;

/**
 * The coding tools the engine can build for itself. Everything else a `tool`
 * node names is resolved from the session that registered it.
 */
function createToolMap(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
	};
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function truncateText(text: string): { text: string; truncated: boolean; bytes: number; lines: number } {
	const lines = text.split("\n");
	let truncated = false;
	let selected = lines;
	const marker = `[graph-engine truncated output to ${MAX_OUTPUT_BYTES} bytes / ${MAX_OUTPUT_LINES} lines]`;

	if (lines.length > MAX_OUTPUT_LINES) {
		selected = lines.slice(0, MAX_OUTPUT_LINES - 1);
		truncated = true;
	}

	let output = selected.join("\n");
	const markerBytes = byteLength(`\n${marker}`);
	while (byteLength(output) + (truncated ? markerBytes : 0) > MAX_OUTPUT_BYTES) {
		output = output.slice(0, Math.max(0, output.length - 512));
		truncated = true;
	}

	if (truncated) {
		while (byteLength(output) + markerBytes > MAX_OUTPUT_BYTES) {
			output = output.slice(0, Math.max(0, output.length - 128));
		}
		output = `${output}\n${marker}`;
	}

	return {
		text: output,
		truncated,
		bytes: byteLength(text),
		lines: lines.length,
	};
}

function truncateValue(value: unknown): unknown {
	if (typeof value === "string") return truncateText(value).text;
	if (Array.isArray(value)) return value.map((item) => truncateValue(item));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, truncateValue(entry)]));
}

function parseOutput(text: string): unknown {
	try { return parseJsonFromText(text); }
	catch { throw new GraphExecutionError(`Model output was not valid JSON. Previous output: ${text.slice(0, 8192)}`, "output"); }
}

function normalizeError(error: unknown, kind: string): Error {
	if (error instanceof GraphExecutionError) return new GraphExecutionError(`${kind}: ${error.message}`, error.kind, error.retryAfterMs);
	if (error instanceof GraphControlFlowError) return error;
	if (error instanceof Error) {
		const normalized = new Error(`${kind}: ${error.message}`, { cause: error });
		normalized.name = error.name;
		return normalized;
	}
	return new Error(`${kind}: ${String(error)}`);
}

function abortedError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

/**
 * A model that stops on `length` was cut off mid-sentence: its last tool call
 * may never have been emitted, and the text left behind is whatever partial
 * turn happened to be in flight. Treating that as success is how a node gets
 * marked completed while the work it was supposed to durably commit never
 * happened, so the engine fails the node instead and says why.
 */
function truncatedError(subject: string): Error {
	return new Error(
		`${subject} hit the model output limit and stopped mid-generation, so its work is incomplete. `
			+ "Split the node into smaller steps, or move the large payload into a file the node writes across turns.",
	);
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
				return String((part as { text?: unknown }).text ?? "");
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function resolveModel(context: ExtensionContext, provider?: string, model?: string) {
	if (provider || model) {
		const providerName = provider ?? context.model?.provider;
		if (!providerName || !model) throw new Error("Prompt node model override requires both provider and model when no current provider is available.");
		const found = context.modelRegistry.find(providerName, model);
		if (!found) throw new Error(`Prompt node model not found: ${providerName}/${model}`);
		return found;
	}
	if (!context.model) throw new Error("Prompt node requires an active ExtensionContext model.");
	return context.model;
}

function buildPromptMessages(request: GraphPromptRequest) {
	return [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: request.prompt }],
			timestamp: Date.now(),
		},
	];
}

function metadataBase(kind: string, extra: JsonObject = {}): JsonObject {
	return {
		kind,
		trust: "project",
		approval: "host-compatible",
		...extra,
	};
}

export function createGraphExecutionServices(
	context?: ExtensionContext,
	api?: Pick<ExtensionAPI, "getAllTools">,
	registeredSkills: () => Iterable<AssignedSkill> = () => [],
): GraphExecutionServices {
	const toolsByCwd = new Map<string, ToolMap>();

	function getBuiltinTools(cwd: string): ToolMap {
		let tools = toolsByCwd.get(cwd);
		if (!tools) {
			tools = createToolMap(cwd);
			toolsByCwd.set(cwd, tools);
		}
		return tools;
	}

	/**
	 * Built-in coding tools first, then whatever the host resolver can hand
	 * back for a tool the session registered. Without a resolver a `tool` node
	 * cannot execute a custom tool in-process, so say so precisely rather than
	 * failing as "unknown tool".
	 */
	function getTool(request: GraphToolRequest): ToolDefinition {
		const builtin = (getBuiltinTools(request.cwd) as Record<string, ToolDefinition | undefined>)[request.tool];
		if (builtin) return builtin;

		const resolved = resolveGraphTool(request.tool, context);
		if (resolved) return resolved;

		const available = listAvailableToolNames(api);
		if (available.includes(request.tool)) {
			throw new Error(
				`Tool ${request.tool} is registered in this Pi session but no executor is reachable from the graph engine. `
					+ "Run it from a subagent node, or have the host install a graph tool resolver.",
			);
		}
		throw new Error(`Unsupported graph tool: ${request.tool}. Available: ${available.join(", ") || "none"}.`);
	}

	return {
		async completePrompt(request) {
			if (!context) throw new Error("Prompt node requires injectable GraphExecutionServices with an ExtensionContext.");
			if (!request.prompt.trim()) throw new Error("Prompt node prompt was empty.");

			const model = resolveModel(context, request.provider, request.model);
			try {
				request.reportUsage?.({ requests: 1 });
				const response = await context.modelRegistry.complete(
					model,
					{
						systemPrompt: request.systemPrompt,
						messages: buildPromptMessages(request),
					},
					{
						signal: request.signal,
						cacheRetention: "none",
					},
				).catch((error: unknown) => { throw providerExecutionError(error); });
				request.reportUsage?.({ tokens: (response.usage?.input ?? 0) + (response.usage?.output ?? 0) + (response.usage?.cacheRead ?? 0) + (response.usage?.cacheWrite ?? 0), cost: response.usage?.cost?.total ?? 0 });
				if (response.stopReason === "aborted") {
					throw abortedError(response.errorMessage || "Prompt model was aborted.");
				}
				if (response.stopReason === "error") {
					throw providerExecutionError(new Error(response.errorMessage || "Prompt model stopped with an error."));
				}
				if (response.stopReason === "length") {
					throw truncatedError("Prompt node");
				}
				const rawText = textFromContent(response.content);
				if (!rawText.trim()) throw new Error("Prompt node returned empty output.");
				const truncated = truncateText(rawText);
				const output = request.parseJson ? parseOutput(rawText) : request.preserveOutput ? rawText : truncated.text;
				return {
					output: request.preserveOutput ? boundedExecutionValue(output) : truncateValue(output),
					text: truncated.text,
					meta: metadataBase("prompt", {
						model: `${model.provider}/${model.id}`,
						usage: response.usage,
						truncated: truncated.truncated,
						bytes: truncated.bytes,
						lines: truncated.lines,
						tools: [],
					}),
				};
			} catch (error) {
				throw normalizeError(error, "Prompt node failed");
			}
		},

		async validateOutput(validator, output, signal) {
			const validate = getGraphHostEnvironment()?.validateOutput;
			if (!validate) throw new GraphControlFlowError(`Output validator is not registered: ${validator}`);
			return validate(validator, output, context, signal);
		},

		async runSubagent(request) {
			if (!request.agentName.trim()) throw new Error("Subagent node requires agentName.");
			if (!request.prompt.trim()) throw new Error(`Subagent node ${request.agentName} prompt was empty.`);

			try {
				const sessionId = request.sessionId ?? randomUUID();
				const provider = request.provider ?? context?.model?.provider;
				const model = request.model ?? context?.model?.id;
				const systemPrompt = context?.getSystemPrompt?.() ?? "";
				const skills = resolveAssignedSkills(systemPrompt, request.skills, registeredSkills());
				validateSkillTools(skills, request.tools);
				const extensionPaths = resolveSubagentExtensions(api, request.tools);
				const result = await runPiSubagent({
					extensionPaths,
					agentName: request.agentName,
					sessionId,
					sessionDir: context?.sessionManager.getSessionDir(),
					sessionName: `Subagent · ${request.agentName}`,
					prompt: request.prompt,
					systemPrompt: request.systemPrompt,
					model,
					provider,
					tools: request.tools,
					skills,
					cwd: request.cwd,
					signal: request.signal,
					reportUsage: request.reportUsage,
					spawnProcess: request.spawnProcess,
				});

				if (result.stopReason === "aborted") {
					throw abortedError(result.errorMessage || result.stderr || `Subagent ${request.agentName} was aborted.`);
				}
				if (result.exitCode !== 0 || result.stopReason === "error") {
					const error = new Error(result.errorMessage || result.stderr || `Subagent ${request.agentName} failed.`);
					throw result.errorOrigin === "model" ? providerExecutionError(error) : error;
				}
				if (result.stopReason === "length") {
					throw truncatedError(`Subagent ${request.agentName}`);
				}
				if (!result.finalText.trim()) throw new Error(`Subagent ${request.agentName} returned empty output.`);

				const output = request.parseJson ? parseOutput(result.finalText) : result.finalText;
				return {
					output: request.preserveOutput ? boundedExecutionValue(output) : truncateValue(output),
					text: truncateText(result.finalText).text,
					meta: metadataBase("subagent", {
						agentName: request.agentName,
						model: result.model,
						usage: result.usage,
						stopReason: result.stopReason,
						tools: request.tools,
						skills: request.skills,
						child: {
							agentName: request.agentName,
							sessionId: result.sessionId ?? sessionId,
							isolation: "pi-json-session",
							messagesRetained: result.usage.turns,
						},
					}),
				};
			} catch (error) {
				throw normalizeError(error, `Subagent ${request.agentName} failed`);
			}
		},

		async invokeTool(request) {
			const tool = getTool(request);

			const prepared = typeof tool.prepareArguments === "function" ? tool.prepareArguments(request.args) : request.args;
			const validator = Compile(tool.parameters);
			if (!validator.Check(prepared)) {
				const detail = validator.Errors(prepared)
					.slice(0, 3)
					.map((error) => error.message)
					.join("; ");
				throw new Error(`Tool ${request.tool} arguments failed schema validation${detail ? `: ${detail}` : "."}`);
			}

			try {
				const result = await tool.execute(
					`graph-${request.tool}-${Date.now().toString(36)}`,
					prepared as never,
					request.signal,
					undefined,
					context as ExtensionContext,
				);
				if ((result as { isError?: boolean }).isError) {
					const text = textFromContent(result.content);
					throw new Error(text || `Tool ${request.tool} returned an error result.`);
				}
				const text = textFromContent(result.content);
				return {
					output: (request.preserveOutput ? boundedExecutionValue : truncateValue)({
						tool: request.tool,
						args: request.args,
						content: result.content,
						details: result.details,
					}),
					text: truncateText(text).text,
					meta: metadataBase("tool", {
						tool: request.tool,
						args: request.args,
						details: truncateValue(result.details),
					}),
				};
			} catch (error) {
				throw normalizeError(error, `Tool ${request.tool} failed`);
			}
		},

		truncate: truncateValue,
	};
}

export function servicesFromContext(ctx: unknown): GraphExecutionServices {
	const holder = ctx as {
		services?: GraphExecutionServices;
		extensionContext?: ExtensionContext;
		pi?: ExtensionAPI;
	};
	return holder.services ?? createGraphExecutionServices(holder.extensionContext, holder.pi);
}
