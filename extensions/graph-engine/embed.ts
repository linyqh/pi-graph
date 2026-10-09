/**
 * 嵌入宿主入口：宿主进程（例如 FPA 的 Web 服务）把图运行时当作库使用，而不是作为 Pi 扩展加载。
 *
 * 宿主自己提供三样东西——模型调用与工具执行（`GraphExecutionServices`）、检查点存储（`GraphRunStore`）、
 * 取消信号——引擎负责依赖编排、并发上限、失败重试、输出校验修正、预算、检查点与局部恢复。
 * 这里只导出宿主需要的最小面；其余模块是引擎内部实现，不保证稳定。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resumeGraph, runGraph } from "./runtime.ts";
import type {
	GraphDefinition,
	GraphExecutionServices,
	GraphRunOptions,
	GraphRunResult,
	GraphRunStore,
	GraphState,
} from "./types.ts";

/**
 * Hosts that keep a graph's source in code write it to `.agent-graph/graphs/<name>.json` themselves:
 * parse validates exactly as graph_create does, serialize produces the canonical file contents.
 */
export { compileDeclarativeGraphSpec, parseDeclarativeGraphSpec, serializeDeclarativeGraphSpec } from "./declarative.ts";
export { GraphExecutionError } from "./execution-policy.ts";
export { parseJsonFromText } from "./pi-process.ts";
export { GraphControlFlowError } from "./types.ts";
export { projectGraphRunView } from "./view-projection.ts";

export type { ExecutionErrorKind } from "./execution-policy.ts";
export type { DeclarativeGraphSerialization, DeclarativeGraphSpec } from "./declarative.ts";
export type { RegisteredGraphDefinition } from "./registry.ts";
export type {
	GraphBudget,
	GraphDefinition,
	GraphExecutionOutput,
	GraphExecutionServices,
	GraphPromptRequest,
	GraphRunProjection,
	GraphRunProjectionNode,
	GraphRunResult,
	GraphRunStore,
	GraphState,
	GraphStatus,
	GraphToolRequest,
	GraphUsage,
	GraphValidationContext,
	JsonObject,
} from "./types.ts";

/**
 * 引擎只用 `appendEntry` 把检查点投影进 Pi 会话；嵌入宿主没有会话，用空实现占位。
 * 检查点的持久化只走宿主传入的 `GraphRunStore`。
 */
const detachedPi = { appendEntry() {} } as unknown as ExtensionAPI;

/**
 * 嵌入运行的选项：`services` 与 `runStore` 必填——没有 Pi 会话，引擎无从默认；
 * 也不接受 `extensionContext` / `ui` / `checkpoints`，它们都属于 Pi 会话。
 * 宿主的 `services.requiresProcessOwnership` 保持未设置：进程所有权租约只用于派生子 Pi 进程的 subagent 节点，
 * 嵌入宿主没有子进程；需要跨进程互斥时由宿主在 `runStore` 之外自行保证。
 */
export type EmbeddedRunOptions = Omit<GraphRunOptions, "services" | "runStore" | "extensionContext" | "ui" | "checkpoints"> & {
	services: GraphExecutionServices;
	runStore: GraphRunStore;
};

export function runEmbeddedGraph(graph: GraphDefinition, options: EmbeddedRunOptions): Promise<GraphRunResult> {
	return runGraph(detachedPi, graph, options);
}

/** 从宿主存下的 `paused/interrupted/failed` 检查点继续：已完成的任务复用保存的结果，只重跑未完成的。 */
export function resumeEmbeddedGraph(
	graph: GraphDefinition,
	state: GraphState,
	options: Omit<EmbeddedRunOptions, "goal" | "resumeFrom">,
): Promise<GraphRunResult> {
	return resumeGraph(detachedPi, graph, state, options);
}
