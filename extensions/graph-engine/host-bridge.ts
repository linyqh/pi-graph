import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Integration points for a host that embeds Pi instead of running its CLI.
 *
 * Both registries live on globalThis rather than in module scope on purpose:
 * the host's bundler and Pi's extension loader instantiate this module
 * separately, so a module-level singleton would not be shared between them. A
 * host can therefore either import this file or write the well-known symbol
 * keys directly, whichever its build allows.
 */

const TOOL_RESOLVER_KEY = Symbol.for("pi-graph.tool-resolver");
const HOST_ENVIRONMENT_KEY = Symbol.for("pi-graph.host-environment");

export type GraphToolResolver = (name: string, ctx?: ExtensionContext) => ToolDefinition | undefined;

export interface GraphHostEnvironment {
	/**
	 * The agent directory the host passes to the SDK. Child Pi processes have no
	 * other way to find it — without it they read the default `~/.pi/agent`,
	 * which holds neither the host's credentials nor its installed packages.
	 */
	agentDir?: string;
}

type BridgeHolder = {
	[TOOL_RESOLVER_KEY]?: GraphToolResolver;
	[HOST_ENVIRONMENT_KEY]?: GraphHostEnvironment;
};

/**
 * `tool` nodes execute a tool definition in-process, but ExtensionAPI exposes
 * only tool metadata — `getToolDefinition` lives on AgentSession, which an
 * extension never receives. Hosts that do hold the session install a resolver
 * here so `tool` nodes can run tools beyond Pi's built-in coding set.
 */
export function registerGraphToolResolver(resolver: GraphToolResolver | undefined): void {
	(globalThis as BridgeHolder)[TOOL_RESOLVER_KEY] = resolver;
}

export function resolveGraphTool(name: string, ctx?: ExtensionContext): ToolDefinition | undefined {
	const resolver = (globalThis as BridgeHolder)[TOOL_RESOLVER_KEY];
	if (typeof resolver !== "function") return undefined;
	try {
		return resolver(name, ctx);
	} catch {
		return undefined;
	}
}

export function registerGraphHostEnvironment(environment: GraphHostEnvironment | undefined): void {
	(globalThis as BridgeHolder)[HOST_ENVIRONMENT_KEY] = environment;
}

export function getGraphHostEnvironment(): GraphHostEnvironment | undefined {
	const environment = (globalThis as BridgeHolder)[HOST_ENVIRONMENT_KEY];
	return environment && typeof environment === "object" ? environment : undefined;
}

/**
 * The environment a child Pi process runs with. Inherits the current one and
 * overlays the host's agent directory, which is passed explicitly rather than
 * mutated into `process.env`: hosts serving several tenants from one process
 * cannot safely change a variable the SDK re-reads on every call.
 */
export function graphChildProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const agentDir = getGraphHostEnvironment()?.agentDir;
	if (!agentDir) return base;
	return { ...base, PI_CODING_AGENT_DIR: agentDir };
}
