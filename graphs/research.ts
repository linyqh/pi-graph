import type { RegisteredGraphDefinition } from "../extensions/graph-engine/registry.ts";
import { parallelNode, promptNode, routerNode, subagentNode, toolNode } from "../extensions/graph-engine/nodes/index.ts";

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

const researchLaneA = subagentNode({
	id: "research_lane_a",
	label: "Research Lane A",
	agentName: "research_lane_a",
	tools: ["read", "grep", "find", "ls"],
	skills: [],
	systemPrompt: `You are a read-only research agent. Inspect files and commands only.
Do not edit, write, install, or mutate the workspace. Return concise findings with file references.`,
	prompt: (state) => `Goal: ${state.goal}

Assigned lane:
${asText((state.data.researchPlan as { laneA?: unknown } | undefined)?.laneA)}

Success criteria:
${asText((state.data.researchPlan as { successCriteria?: unknown } | undefined)?.successCriteria)}`,
	outputKey: "laneAFindings",
});

const researchLaneB = subagentNode({
	id: "research_lane_b",
	label: "Research Lane B",
	agentName: "research_lane_b",
	tools: ["read", "grep", "find", "ls"],
	skills: [],
	systemPrompt: `You are a read-only research agent. Inspect files and commands only.
Do not edit, write, install, or mutate the workspace. Return concise findings with file references.`,
	prompt: (state) => `Goal: ${state.goal}

Assigned lane:
${asText((state.data.researchPlan as { laneB?: unknown } | undefined)?.laneB)}

Success criteria:
${asText((state.data.researchPlan as { successCriteria?: unknown } | undefined)?.successCriteria)}`,
	outputKey: "laneBFindings",
});

export const researchGraph: RegisteredGraphDefinition = {
	name: "research",
	description: "ls -> decompose -> parallel read-only research -> route -> synthesize",
	version: "1.0.0",
	mutationPolicy: "read-only",
	capabilities: [
		{
			id: "inspect",
			description: "List workspace files with the built-in shell tool.",
			tools: ["ls"],
			mutates: false,
		},
		{
			id: "decompose",
			description: "Break the research goal into two independent read-only lanes.",
			tools: [],
			mutates: false,
		},
		{
			id: "parallel_research",
			description: "Run two read-only subagents in parallel and collect findings.",
			tools: ["read", "grep", "find", "ls"],
			mutates: false,
		},
		{
			id: "synthesize",
			description: "Produce a concise grounded research answer.",
			tools: [],
			mutates: false,
		},
	],
	approvalBindings: [],
	transitions: [
		{ from: "list_workspace", to: "decompose", when: "workspace listing succeeds" },
		{ from: "decompose", to: "parallel_research", when: "research lanes are defined" },
		{ from: "parallel_research", to: "route_findings", when: "both read-only agents complete" },
		{ from: "route_findings", to: "synthesize", when: "findings are available" },
		{ from: "route_findings", when: "findings are missing or invalid" },
		{ from: "synthesize", when: "final synthesis is complete" },
	],
	start: "list_workspace",
	maxSteps: 8,
	nodes: {
		list_workspace: toolNode({
			id: "list_workspace",
			label: "List Workspace",
			tool: "ls",
			args: { path: "." },
			outputKey: "workspaceListing",
			next: "decompose",
		}),

		decompose: promptNode({
			id: "decompose",
			label: "Decompose",
			parseJson: true,
			systemPrompt: `You decompose a repository research task into exactly two independent read-only lanes.
Return only JSON:
{
  "laneA": "first concrete read-only research prompt",
  "laneB": "second concrete read-only research prompt",
  "successCriteria": ["specific evidence needed"]
}`,
			prompt: (state) => `Goal: ${state.goal}

Workspace listing:
${asText(state.data.workspaceListing)}

Create two independent read-only research prompts that can run in parallel.`,
			outputKey: "researchPlan",
			next: "parallel_research",
		}),

		parallel_research: parallelNode({
			id: "parallel_research",
			label: "Parallel Research",
			concurrency: 2,
			children: [researchLaneA, researchLaneB],
			reduce(results) {
				return {
					lanes: Object.fromEntries(results.map(({ node, result }) => [node.id, result.data ?? {}])),
				};
			},
			next: "route_findings",
		}),

		route_findings: routerNode({
			id: "route_findings",
			label: "Route Findings",
			targets: ["synthesize"],
			route(ctx) {
				const findings = ctx.state.data.parallel_research as { lanes?: Record<string, unknown> } | undefined;
				if (!findings?.lanes?.research_lane_a || !findings.lanes.research_lane_b) {
					return {
						data: { finalSummary: "Research graph stopped because one or more read-only lanes returned no findings." },
						done: true,
						summary: "Research findings were incomplete.",
					};
				}
				return {
					next: "synthesize",
					summary: "Research findings available. Routing to synthesis.",
				};
			},
		}),

		synthesize: promptNode({
			id: "synthesize",
			label: "Synthesize",
			systemPrompt: `You synthesize read-only repository research.
Return a concise answer grounded in the supplied lane findings. Include concrete file references when present.`,
			prompt: (state) => `Goal: ${state.goal}

Research plan:
${asText(state.data.researchPlan)}

Parallel findings:
${asText(state.data.parallel_research)}

Produce the final synthesis.`,
			outputKey: "finalSummary",
		}),
	},
};
