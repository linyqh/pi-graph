import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import graphEngineeringExtension from "../extensions/graph-engine/index.ts";
import type { GraphCheckpointEntry } from "../extensions/graph-engine/types.ts";

type ToolResult = {
	terminate?: boolean;
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type CapturedTool = {
	name: string;
	executionMode?: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((result: ToolResult) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
};

function registerExtension(overrides: Partial<ExtensionAPI> = {}) {
	const tools = new Map<string, CapturedTool>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const entries: GraphCheckpointEntry[] = [];
	const extensionApi = {
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		registerEntryRenderer() {},
		registerCommand() {},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		events: { on: () => () => undefined, emit() {} },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		...overrides,
	} as unknown as ExtensionAPI;
	graphEngineeringExtension(extensionApi);
	return { tools, entries, handlers };
}

function validSpec(name = "instant-flow") {
	return {
		schemaVersion: 1,
		name,
		version: "1.0.0",
		description: "Summarize a goal through a created project graph.",
		mutationPolicy: "read-only",
		start: "summarize",
		maxSteps: 3,
		nodes: [
			{
				id: "summarize",
				type: "prompt",
				prompt: "Summarize {{ goal }} from {{ cwd }}.",
				outputKey: "finalSummary",
			},
		],
	};
}

async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-create-"));
	return {
		cwd,
		async cleanup() {
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

function context(cwd: string, options: {
	trusted?: boolean;
	hasUI?: boolean;
	approved?: boolean;
	systemPrompt?: string;
	branch?: GraphCheckpointEntry[];
	complete?: () => Promise<{
		stopReason: string;
		content: Array<{ type: "text"; text: string }>;
		usage: Record<string, never>;
	}>;
} = {}): ExtensionContext {
	const trusted = options.trusted ?? true;
	const hasUI = options.hasUI ?? true;
	const approved = options.approved ?? true;
	return {
		cwd,
		hasUI,
		isProjectTrusted: () => trusted,
		getSystemPrompt: () => options.systemPrompt ?? "",
		ui: {
			notify() {},
			setStatus() {},
			confirm: async () => approved,
		},
		model: { provider: "mock", id: "model" },
		modelRegistry: {
			async complete() {
				if (options.complete) return options.complete();
				return {
					stopReason: "stop",
					content: [{ type: "text", text: "created graph ran" }],
					usage: {},
				};
			},
		},
		sessionManager: {
			getBranch() {
				return options.branch ?? [];
			},
		},
	} as unknown as ExtensionContext;
}

async function graphFileNames(cwd: string): Promise<string[]> {
	try {
		return await readdir(join(cwd, ".agent-graph", "graphs"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

test("graph_create returns untrusted status without writing files", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const result = await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, context(cwd, { trusted: false }));

		assert.equal(result.details?.status, "untrusted");
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally {
		await cleanup();
	}
});

test("graph_create requires UI approval before writing files", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const result = await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, context(cwd, { hasUI: false }));

		assert.equal(result.details?.status, "approval_required");
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally {
		await cleanup();
	}
});

test("graph_create writes no files when UI approval is declined", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const result = await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, context(cwd, { approved: false }));

		assert.equal(result.details?.status, "cancelled");
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally {
		await cleanup();
	}
});

test("graph_create writes approved graph specs", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const result = await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, context(cwd));

		assert.equal(result.details?.status, "created");
		const path = join(cwd, ".agent-graph", "graphs", "instant-flow.json");
		assert.equal(result.details?.path, path);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), validSpec());
	} finally {
		await cleanup();
	}
});

test("graph_create makes the new graph immediately visible to graph_list", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const ctx = context(cwd);
		await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, ctx);
		const result = await tools.get("graph_list")!.execute("call", {}, new AbortController().signal, () => {}, ctx);
		const sources = result.details?.sources as Record<string, { kind: string }>;
		const graphs = result.details?.graphs as Array<{ name: string; definitionHash?: string; sourcePath?: string }>;
		const created = graphs.find((graph) => graph.name === "instant-flow");

		assert.match(result.content[0].text, /instant-flow/);
		assert.equal(sources["instant-flow"].kind, "project");
		assert.match(created?.definitionHash ?? "", /^[a-f0-9]{64}$/);
		assert.equal(created?.sourcePath, ".agent-graph/graphs/instant-flow.json");
		assert.match(result.content[0].text, new RegExp(created?.definitionHash ?? "missing-hash"));
	} finally {
		await cleanup();
	}
});

test("graph_run resolves a newly created graph from the cwd catalog", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools, entries } = registerExtension();
		const ctx = context(cwd);
		await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, ctx);
		const result = await tools.get("graph_run")!.execute("call", { graph: "instant-flow", goal: "ship tests" }, new AbortController().signal, () => {}, ctx);

		assert.equal(result.details?.status, "completed");
		assert.equal(result.content[0].text, "created graph ran");
		assert.ok(entries.some((entry) => (entry.data as { state?: { graphName?: string } }).state?.graphName === "instant-flow"));
		const runFiles = await readdir(join(cwd, ".agent-graph", "runs"));
		assert.equal(runFiles.length, 1);
		const storedRun = JSON.parse(await readFile(join(cwd, ".agent-graph", "runs", runFiles[0]), "utf8")) as {
			kind?: string;
			state?: { graphName?: string; status?: string };
		};
		assert.equal(storedRun.kind, "agent-graph.run");
		assert.equal(storedRun.state?.graphName, "instant-flow");
		assert.equal(storedRun.state?.status, "completed");
	} finally {
		await cleanup();
	}
});

test("graph_run returns recommendation output keys as model-visible content", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const ctx = context(cwd);
		const spec = validSpec("recommendation-flow");
		spec.nodes[0].outputKey = "recommendation";
		await tools.get("graph_create")!.execute("call", { spec }, new AbortController().signal, () => {}, ctx);
		const updates: ToolResult[] = [];
		const result = await tools.get("graph_run")!.execute("call", { graph: "recommendation-flow", goal: "ship output" }, new AbortController().signal, (update) => updates.push(update), ctx);

		assert.equal(result.details?.status, "completed");
		assert.equal(result.content[0].text, "created graph ran");
		assert.equal(updates.at(-1)?.content[0].text, "created graph ran");
	} finally {
		await cleanup();
	}
});

test("graph_run rejects the reserved __graphError input key before execution", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools, entries } = registerExtension();
		let promptCalls = 0;
		const ctx = context(cwd, {
			branch: entries,
			complete: async () => {
				promptCalls += 1;
				return { stopReason: "stop", content: [{ type: "text", text: "unexpected" }], usage: {} };
			},
		});
		await tools.get("graph_create")!.execute("call", { spec: validSpec("reserved-input-flow") }, undefined, undefined, ctx);
		const result = await tools.get("graph_run")!.execute(
			"call",
			{ graph: "reserved-input-flow", goal: "goal", input: { __graphError: { message: "spoofed" } } },
			undefined,
			undefined,
			ctx,
		);

		assert.equal(result.details?.status, "rejected");
		assert.equal(result.details?.reason, "reserved_input_key");
		assert.equal(promptCalls, 0);
		assert.equal(entries.length, 0);
	} finally {
		await cleanup();
	}
});

test("graph_run exposes a resumable failure and graph_resume retries the same run with compare-and-swap", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools, entries } = registerExtension();
		let shouldFail = true;
		let promptCalls = 0;
		const ctx = context(cwd, {
			branch: entries,
			complete: async () => {
				promptCalls += 1;
				if (shouldFail) throw new Error("temporary provider failure");
				return {
					stopReason: "stop",
					content: [{ type: "text", text: "recovered graph ran" }],
					usage: {},
				};
			},
		});
		await tools.get("graph_create")!.execute("call", { spec: validSpec("recoverable-flow") }, undefined, undefined, ctx);

		const failed = await tools.get("graph_run")!.execute(
			"call",
			{ graph: "recoverable-flow", goal: "recover this run" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(failed.details?.status, "failed");
		const failure = JSON.parse(failed.content[0].text) as {
			kind: string;
			graph: string;
			runId: string;
			resumeCount: number;
			resume: { tool: string; arguments: { runId: string; expectedResumeCount: number } };
		};
		assert.equal(failure.kind, "graph_run_failed");
		assert.equal(failure.graph, "recoverable-flow");
		assert.equal(failure.resumeCount, 0);
		assert.deepEqual(failure.resume, {
			tool: "graph_resume",
			arguments: { runId: failure.runId, expectedResumeCount: 0 },
		});
		assert.equal(promptCalls, 1);

		const wrongCount = await tools.get("graph_resume")!.execute(
			"call",
			{ runId: failure.runId, expectedResumeCount: 9 },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(wrongCount.details?.status, "rejected");
		assert.equal(wrongCount.details?.reason, "resume_count_mismatch");
		assert.match(wrongCount.content[0].text, /resume count/i);
		assert.equal(promptCalls, 1);

		const wrongCwd = await tools.get("graph_resume")!.execute(
			"call",
			failure.resume.arguments,
			undefined,
			undefined,
			context(join(cwd, "other"), { branch: entries }),
		);
		assert.equal(wrongCwd.details?.status, "rejected");
		assert.equal(wrongCwd.details?.reason, "not_found");
		assert.equal(promptCalls, 1);

		const legacyRunId = `${failure.runId}-legacy`;
		const failedState = failed.details?.state as Record<string, unknown>;
		entries.push({
			type: "custom",
			customType: "graph-run",
			data: {
				state: {
					...failedState,
					schemaVersion: 0,
					runId: legacyRunId,
					updatedAt: Number(failedState.updatedAt) + 1,
				},
			},
		});
		const legacy = await tools.get("graph_resume")!.execute(
			"call",
			{ runId: legacyRunId, expectedResumeCount: 0 },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(legacy.details?.status, "rejected");
		assert.equal(legacy.details?.reason, "legacy_snapshot");
		assert.equal(promptCalls, 1);

		const unclassifiedRunId = `${failure.runId}-unclassified`;
		entries.push({
			type: "custom",
			customType: "graph-run",
			data: {
				state: {
					...failedState,
					runId: unclassifiedRunId,
					lastFailure: undefined,
					updatedAt: Number(failedState.updatedAt) + 1,
				},
			},
		});
		const unclassified = await tools.get("graph_resume")!.execute(
			"call",
			{ runId: unclassifiedRunId, expectedResumeCount: 0 },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(unclassified.details?.status, "rejected");
		assert.equal(unclassified.details?.reason, "non_resumable_failure");
		assert.equal(promptCalls, 1);

		const controlFailureRunId = `${failure.runId}-control`;
		entries.push({
			type: "custom",
			customType: "graph-run",
			data: {
				state: {
					...failedState,
					runId: controlFailureRunId,
					updatedAt: Number(failedState.updatedAt) + 2,
					lastFailure: {
						kind: "runtime",
						nodeId: "summarize",
						message: "Graph exceeded maxSteps (1).",
						attempt: 1,
						maxAttempts: 1,
						occurredAt: Number(failedState.updatedAt) + 2,
						handled: false,
						resumable: false,
					},
				},
			},
		});
		const controlFailure = await tools.get("graph_resume")!.execute(
			"call",
			{ runId: controlFailureRunId, expectedResumeCount: 0 },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(controlFailure.details?.status, "rejected");
		assert.equal(controlFailure.details?.reason, "non_resumable_failure");
		assert.equal(promptCalls, 1);

		shouldFail = false;
		const [resumed, stale] = await Promise.all([
			tools.get("graph_resume")!.execute("call", failure.resume.arguments, undefined, undefined, ctx),
			tools.get("graph_resume")!.execute("call", failure.resume.arguments, undefined, undefined, ctx),
		]);
		assert.equal(resumed.details?.status, "completed");
		assert.equal(resumed.content[0].text, "recovered graph ran");
		const resumedState = resumed.details?.state as { runId?: string; resumeCount?: number };
		assert.equal(resumedState.runId, failure.runId);
		assert.equal(resumedState.resumeCount, 1);
		assert.equal(promptCalls, 2);

		assert.equal(stale.details?.status, "rejected");
		assert.match(stale.content[0].text, /not failed|latest snapshot/i);
		assert.equal(promptCalls, 2);
	} finally {
		await cleanup();
	}
});

test("graph_create validates graph reachability before asking for file approval", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const ctx = context(cwd);
		ctx.ui.confirm = async () => {
			throw new Error("confirmation must not run for an invalid graph");
		};
		const spec = {
			...validSpec("unreachable-flow"),
			nodes: [
				{ id: "summarize", type: "prompt", prompt: "done" },
				{ id: "orphan", type: "prompt", prompt: "never reached" },
			],
		};
		const result = await tools.get("graph_create")!.execute("call", { spec }, new AbortController().signal, () => {}, ctx);

		assert.equal(result.details?.status, "invalid");
		assert.match(result.content[0].text, /not reachable/);
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally {
		await cleanup();
	}
});

test("graph_create rejects an oversized serialized spec before file approval", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const ctx = context(cwd);
		ctx.ui.confirm = async () => {
			throw new Error("confirmation must not run for an oversized graph");
		};
		const spec = {
			schemaVersion: 1,
			name: "oversized-flow",
			version: "1.0.0",
			description: "Oversized tool arguments.",
			mutationPolicy: "read-only",
			start: "read_file",
			maxSteps: 1,
			nodes: [{
				id: "read_file",
				type: "tool",
				tool: "read",
				args: { path: "README.md", padding: "x".repeat(300 * 1024) },
			}],
		};
		const result = await tools.get("graph_create")!.execute("call", { spec }, new AbortController().signal, () => {}, ctx);

		assert.equal(result.details?.status, "invalid");
		assert.match(result.content[0].text, /exceeds 262144 bytes/);
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally {
		await cleanup();
	}
});

test("graph_create never overwrites a catalog name conflict", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const firstContext = context(cwd);
		await tools.get("graph_create")!.execute("call", { spec: validSpec() }, new AbortController().signal, () => {}, firstContext);
		const path = join(cwd, ".agent-graph", "graphs", "instant-flow.json");
		const before = await readFile(path, "utf8");

		const conflictingContext = context(cwd);
		conflictingContext.ui.confirm = async () => {
			throw new Error("confirmation must not run for a name conflict");
		};
		const result = await tools.get("graph_create")!.execute(
			"call",
			{ spec: { ...validSpec(), description: "Attempted replacement." } },
			new AbortController().signal,
			() => {},
			conflictingContext,
		);

		assert.equal(result.details?.status, "invalid");
		assert.match(result.content[0].text, /already exists/);
		assert.equal(await readFile(path, "utf8"), before);
		assert.deepEqual(await graphFileNames(cwd), ["instant-flow.json"]);
	} finally {
		await cleanup();
	}
});

test("graph_create defaults version and previews unbound mutating tools", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const { version: _version, ...withoutVersion } = validSpec("default-version");
		await tools.get("graph_create")!.execute("call", { spec: withoutVersion }, new AbortController().signal, () => {}, context(cwd));
		const defaulted = JSON.parse(await readFile(join(cwd, ".agent-graph", "graphs", "default-version.json"), "utf8")) as { version?: string };
		assert.equal(defaulted.version, "1.0.0");

		let preview = "";
		const mutationContext = context(cwd);
		mutationContext.ui.confirm = async (_title, message) => {
			preview = message;
			return true;
		};
		const mutationSpec = {
			schemaVersion: 1,
			name: "direct-write",
			version: "1.0.0",
			description: "Write directly in a trusted project.",
			mutationPolicy: "mutating",
			start: "write_file",
			maxSteps: 1,
			nodes: [
				{ id: "write_file", type: "tool", tool: "write", args: { path: "README.md", content: "x" } },
			],
		};
		const result = await tools.get("graph_create")!.execute("call", { spec: mutationSpec }, new AbortController().signal, () => {}, mutationContext);

		assert.equal(result.details?.status, "created");
		assert.match(preview, /mutatingTools=write/);
		assert.match(preview, /approvalNodes=none/);
		assert.match(preview, /direct-write\.json/);
	} finally {
		await cleanup();
	}
});

test("graph_create validates assigned Skills and previews the resolved names", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const spec = {
			schemaVersion: 1,
			name: "skill-review",
			version: "1.0.0",
			description: "Review with an assigned Skill.",
			mutationPolicy: "read-only",
			start: "review",
			maxSteps: 1,
			nodes: [{
				id: "review",
				type: "subagent",
				agentName: "reviewer",
				tools: ["read"],
				skills: ["code-review"],
				prompt: "Review {{goal}}.",
			}],
		};
		await writeFile(join(cwd, "SKILL.md"), "---\nname: code-review\ndescription: Review code\n---\n");
		const availableSkillPrompt = `<available_skills><skill><name>code-review</name><description>Review code.</description><location>${join(cwd, "SKILL.md")}</location></skill></available_skills>`;
		let preview = "";
		const acceptedContext = context(cwd, { systemPrompt: availableSkillPrompt });
		acceptedContext.ui.confirm = async (_title, message) => {
			preview = message;
			return true;
		};
		const accepted = await tools.get("graph_create")!.execute("call", { spec }, new AbortController().signal, () => {}, acceptedContext);

		assert.equal(accepted.details?.status, "created");
		assert.match(preview, /subagentSkills=review:\[code-review\]/);
		const saved = JSON.parse(await readFile(join(cwd, ".agent-graph", "graphs", "skill-review.json"), "utf8")) as { nodes: Array<{ skills?: string[] }> };
		assert.deepEqual(saved.nodes[0].skills, ["code-review"]);

		const missingSpec = { ...spec, name: "missing-skill", nodes: [{ ...spec.nodes[0], skills: ["missing"] }] };
		const rejected = await tools.get("graph_create")!.execute("call", { spec: missingSpec }, new AbortController().signal, () => {}, context(cwd, { systemPrompt: availableSkillPrompt }));
		assert.equal(rejected.details?.status, "invalid");
		assert.match(rejected.content[0].text, /Assigned skills are not available.*missing/);
		assert.deepEqual(await graphFileNames(cwd), ["skill-review.json"]);
	} finally {
		await cleanup();
	}
});

test("graph_update, graph_history, and graph_rollback expose controlled project graph evolution", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const ctx = context(cwd);
		const v1 = validSpec("evolving-flow");
		const created = await tools.get("graph_create")!.execute("call", { spec: v1 }, undefined, undefined, ctx);
		assert.equal(created.details?.status, "created");
		const listed = await tools.get("graph_list")!.execute("call", {}, undefined, undefined, ctx);
		const v1Hash = (listed.details?.graphs as Array<{ name: string; definitionHash: string }>).find((item) => item.name === v1.name)!.definitionHash;

		let preview = "";
		ctx.ui.confirm = async (_title, message) => {
			preview = message;
			return true;
		};
		const v2 = { ...v1, version: "2.0.0", description: "A safely evolved graph." };
		const updated = await tools.get("graph_update")!.execute("call", { spec: v2, expectedDefinitionHash: v1Hash }, undefined, undefined, ctx);
		assert.equal(updated.details?.status, "updated");
		assert.match(preview, /replace version/);
		assert.match(preview, /replace description/);
		const v2Hash = updated.details?.definitionHash as string;

		const history = await tools.get("graph_history")!.execute("call", { graph: v1.name, definitionHash: v1Hash }, undefined, undefined, ctx);
		assert.equal(history.details?.status, "ok");
		assert.equal((history.details?.selected as { spec: { version: string } }).spec.version, "1.0.0");
		const rollbackArgs = {
			graph: v1.name,
			targetDefinitionHash: v1Hash,
			expectedDefinitionHash: v2Hash,
		};
		const headlessRollback = await tools.get("graph_rollback")!.execute("call", rollbackArgs, undefined, undefined, context(cwd, { hasUI: false }));
		assert.equal(headlessRollback.details?.status, "approval_required");
		const declinedRollback = await tools.get("graph_rollback")!.execute("call", rollbackArgs, undefined, undefined, context(cwd, { approved: false }));
		assert.equal(declinedRollback.details?.status, "cancelled");

		const rolledBack = await tools.get("graph_rollback")!.execute("call", rollbackArgs, undefined, undefined, ctx);
		assert.equal(rolledBack.details?.status, "rolled_back");
		const after = await tools.get("graph_list")!.execute("call", {}, undefined, undefined, ctx);
		const active = (after.details?.graphs as Array<{ name: string; version: string; definitionHash: string }>).find((item) => item.name === v1.name)!;
		assert.equal(active.version, "1.0.0");
		assert.equal(active.definitionHash, v1Hash);
	} finally {
		await cleanup();
	}
});

test("graph_update requires approval and rejects stale revisions without writes", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const v1 = validSpec("guarded-evolution");
		const ctx = context(cwd);
		await tools.get("graph_create")!.execute("call", { spec: v1 }, undefined, undefined, ctx);
		const listed = await tools.get("graph_list")!.execute("call", {}, undefined, undefined, ctx);
		const hash = (listed.details?.graphs as Array<{ name: string; definitionHash: string }>).find((item) => item.name === v1.name)!.definitionHash;
		const v2 = { ...v1, version: "2.0.0" };

		const headless = await tools.get("graph_update")!.execute("call", { spec: v2, expectedDefinitionHash: hash }, undefined, undefined, context(cwd, { hasUI: false }));
		assert.equal(headless.details?.status, "approval_required");
		const stale = await tools.get("graph_update")!.execute("call", { spec: v2, expectedDefinitionHash: "a".repeat(64) }, undefined, undefined, ctx);
		assert.equal(stale.details?.status, "stale");

		const unchanged = JSON.parse(await readFile(join(cwd, ".agent-graph", "graphs", `${v1.name}.json`), "utf8")) as { version: string };
		assert.equal(unchanged.version, "1.0.0");
	} finally {
		await cleanup();
	}
});

test("graph_update refuses built-in graphs and unavailable tools", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const ctx = context(cwd);
		const builtIn = await tools.get("graph_update")!.execute("call", {
			spec: validSpec("research"),
			expectedDefinitionHash: "a".repeat(64),
		}, undefined, undefined, ctx);
		assert.equal(builtIn.details?.status, "invalid");
		assert.match(builtIn.content[0].text, /Built-in graph cannot be updated/);

		const v1 = validSpec("invalid-tool-update");
		await tools.get("graph_create")!.execute("call", { spec: v1 }, undefined, undefined, ctx);
		const listed = await tools.get("graph_list")!.execute("call", {}, undefined, undefined, ctx);
		const hash = (listed.details?.graphs as Array<{ name: string; definitionHash: string }>).find((item) => item.name === v1.name)!.definitionHash;
		const invalidTool = await tools.get("graph_update")!.execute("call", {
			spec: {
				...v1,
				version: "2.0.0",
				nodes: [{ id: "summarize", type: "tool", tool: "missing_tool", args: {} }],
			},
			expectedDefinitionHash: hash,
		}, undefined, undefined, ctx);
		assert.equal(invalidTool.details?.status, "invalid");
		assert.match(invalidTool.content[0].text, /missing_tool/);
	} finally {
		await cleanup();
	}
});

test("graph_resume uses the archived definition after the active graph is updated", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools, entries } = registerExtension();
		let fail = true;
		const ctx = context(cwd, {
			branch: entries,
			complete: async () => {
				if (fail) throw new Error("temporary model failure");
				return { stopReason: "stop", content: [{ type: "text", text: "resumed old revision" }], usage: {} };
			},
		});
		const v1 = validSpec("revision-resume-flow");
		await tools.get("graph_create")!.execute("call", { spec: v1 }, undefined, undefined, ctx);
		const failed = await tools.get("graph_run")!.execute("call", { graph: v1.name, goal: "resume later" }, undefined, undefined, ctx);
		const failure = JSON.parse(failed.content[0].text) as { resume: { arguments: { runId: string; expectedResumeCount: number } } };
		const v1Hash = (failed.details?.state as { graphDefinitionHash: string }).graphDefinitionHash;
		const updated = await tools.get("graph_update")!.execute("call", {
			spec: { ...v1, version: "2.0.0", description: "New runs use version two." },
			expectedDefinitionHash: v1Hash,
		}, undefined, undefined, ctx);
		assert.equal(updated.details?.status, "updated");

		fail = false;
		const resumed = await tools.get("graph_resume")!.execute("call", failure.resume.arguments, undefined, undefined, ctx);
		assert.equal(resumed.details?.status, "completed");
		assert.equal((resumed.details?.state as { graphVersion: string }).graphVersion, "1.0.0");
		assert.equal(resumed.content[0].text, "resumed old revision");
	} finally {
		await cleanup();
	}
});

test("graph_capabilities paginates inactive tools without enabling them and rejects parent-only assignments", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const extension = join(cwd, "plugin.ts");
		await writeFile(extension, "export default function () {}\n");
		let activations = 0;
		const { tools } = registerExtension({
			getAllTools: () => [
				{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
				{ name: "hidden_query", sourceInfo: { path: extension, source: "local" } },
				{ name: "tool_search", sourceInfo: { path: "<inline:search>", source: "sdk" } },
			] as ReturnType<ExtensionAPI["getAllTools"]>,
			setActiveTools: () => { activations++; },
		});
		const ctx = context(cwd);
		const page = await tools.get("graph_capabilities")!.execute("call", { limit: 1 }, undefined, undefined, ctx);
		assert.equal(page.details?.total, 3);
		assert.equal(page.details?.nextOffset, 1);
		const last = await tools.get("graph_capabilities")!.execute("call", { offset: 2, limit: 1 }, undefined, undefined, ctx);
		assert.equal(last.details?.nextOffset, null);
		const hidden = await tools.get("graph_capabilities")!.execute("call", { query: "hidden_query" }, undefined, undefined, ctx);
		assert.match(hidden.content[0].text, /"subagent":"available"/);
		assert.equal(activations, 0);
		const spec = { ...validSpec("inline-tool"), nodes: [{ id: "summarize", type: "subagent", agentName: "worker", prompt: "Work", tools: ["tool_search"], skills: [] }] };
		const rejected = await tools.get("graph_create")!.execute("call", { spec }, undefined, undefined, ctx);
		assert.equal(rejected.details?.status, "invalid");
		assert.match(rejected.content[0].text, /cannot load.*tool_search/);
		assert.deepEqual(await graphFileNames(cwd), []);
		const acceptedSpec = { ...spec, name: "inactive-tool", nodes: [{ ...spec.nodes[0], tools: ["hidden_query"] }] };
		const accepted = await tools.get("graph_create")!.execute("call", { spec: acceptedSpec }, undefined, undefined, ctx);
		assert.equal(accepted.details?.status, "created", accepted.content[0].text);
		assert.equal(activations, 0);
	} finally {
		await cleanup();
	}
});

test("graph_create validates skill dependencies per parallel child before asking for approval", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const skillPath = join(cwd, "SKILL.md");
		await writeFile(skillPath, "---\nname: inspect\ngraph-required-tools: [query_tool]\n---\n");
		const { tools } = registerExtension({ getAllTools: () => [{ name: "read" }, { name: "query_tool" }] as ReturnType<ExtensionAPI["getAllTools"]> });
		let confirmations = 0;
		const ctx = context(cwd, { systemPrompt: `<skill><name>inspect</name><location>${skillPath}</location></skill>` });
		ctx.ui.confirm = async () => { confirmations++; return true; };
		const spec = { ...validSpec("missing-dependency"), nodes: [{ id: "summarize", type: "parallel", children: [
			{ id: "first", type: "subagent", agentName: "first", prompt: "Inspect", tools: ["read"], skills: ["inspect"] },
			{ id: "second", type: "subagent", agentName: "second", prompt: "Query", tools: ["query_tool"], skills: [] },
		] }] };
		const result = await tools.get("graph_create")!.execute("call", { spec }, undefined, undefined, ctx);
		assert.equal(result.details?.status, "invalid");
		assert.match(result.content[0].text, /requires assigned tools: query_tool/);
		assert.equal(confirmations, 0);
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally {
		await cleanup();
	}
});

test("file drafts validate without writes, preserve fields through approval, and refresh the catalog", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const file = join(cwd, "draft.json");
		const spec = validSpec("file-edit");
		await writeFile(file, JSON.stringify(spec));
		const call = (tool: string, params: Record<string, unknown>, ctx = context(cwd)) => tools.get(tool)!.execute("call", params, undefined, undefined, ctx);
		const preview = await call("graph_create", { specFile: "draft.json", validateOnly: true }, context(cwd, { hasUI: false }));
		assert.equal(preview.details?.status, "validated");
		assert.deepEqual(await graphFileNames(cwd), []);
		assert.deepEqual((await readdir(cwd)).sort(), ["draft.json"]);
		assert.equal((await call("graph_create", { specFile: file }, context(cwd, { approved: false }))).details?.status, "cancelled");
		assert.equal((await call("graph_create", { specFile: file })).details?.status, "created");
		const listed = await call("graph_list", {});
		const hash = (listed.details?.graphs as Array<{ name: string; definitionHash: string }>).find((g) => g.name === "file-edit")!.definitionHash;
		const updated = { ...spec, version: "1.1.0", nodes: [
			{ ...spec.nodes[0], next: "finish", label: "第一步", outputKey: "answer", parseJson: true },
			{ id: "finish", type: "prompt", prompt: 'Result: {{data.answer}}. Example: {"nested":{"status":"ok"}}' },
		] };
		await writeFile(file, JSON.stringify(updated));
		const beforeHistory = await readFile(join(cwd, ".agent-graph/catalog/graph-revisions/file-edit/history.json"), "utf8");
		assert.equal((await call("graph_update", { specFile: file, expectedDefinitionHash: hash, validateOnly: true })).details?.status, "validated");
		assert.equal(await readFile(join(cwd, ".agent-graph/catalog/graph-revisions/file-edit/history.json"), "utf8"), beforeHistory);
		const ctx = context(cwd);
		ctx.ui.confirm = async () => { await writeFile(file, JSON.stringify({ ...updated, version: "9.9.9" })); return true; };
		assert.equal((await call("graph_update", { specFile: file, expectedDefinitionHash: hash }, ctx)).details?.status, "updated");
		const activePath = join(cwd, ".agent-graph/graphs/file-edit.json");
		assert.deepEqual(JSON.parse(await readFile(activePath, "utf8")), updated, "commit the previewed snapshot even if draft changes during confirmation");
		assert.match((await call("graph_list", {})).content[0].text, /file-edit v1.1.0/);
		assert.equal((await call("graph_update", { specFile: file, expectedDefinitionHash: hash })).details?.status, "stale");
		// Simulate a legitimate external writer and ensure list never returns an old snapshot.
		await writeFile(activePath, JSON.stringify({ ...updated, version: "1.2.0" }));
		assert.match((await call("graph_list", {})).content[0].text, /file-edit v1.2.0/);
	} finally { await cleanup(); }
});

test("missing next identifies the broken field; repeated errors stop the turn and mark the result as an error", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools, handlers } = registerExtension();
		const spec = { ...validSpec("broken-links"), nodes: [
			{ id: "summarize", type: "prompt", prompt: "First" },
			{ id: "finish", type: "prompt", prompt: "Last" },
		] };
		const ctx = context(cwd);
		const call = () => tools.get("graph_create")!.execute("call", { spec }, undefined, undefined, ctx);
		const first = await call();
		assert.equal(first.details?.status, "invalid");
		assert.match(first.content[0].text, /nodes.summarize.next/);
		assert.match(first.content[0].text, /specFile/);
		assert.equal(first.terminate, false);
		const second = await call();
		assert.equal(second.terminate, true);
		assert.equal(second.details?.attempts, 2);
		assert.deepEqual(handlers.get("tool_result")![0]({ toolName: "graph_create", details: second.details }), { isError: true });
		for (const handler of handlers.get("before_agent_start") ?? []) await handler({}, ctx);
		assert.equal((await call()).terminate, false);
		const repaired = { ...spec, nodes: [{ ...spec.nodes[0], next: "finish" }, spec.nodes[1]] };
		assert.equal((await tools.get("graph_create")!.execute("call", { spec: repaired }, undefined, undefined, ctx)).details?.status, "created");
	} finally { await cleanup(); }
});

test("file submission rejects absent/ambiguous inputs, invalid JSON, oversized files and untrusted projects", async () => {
	const { cwd, cleanup } = await fixture();
	try {
		const { tools } = registerExtension();
		const call = (params: Record<string, unknown>, ctx = context(cwd)) => tools.get("graph_create")!.execute("call", params, undefined, undefined, ctx);
		assert.equal((await call({})).details?.status, "invalid");
		assert.match((await call({ spec: validSpec(), specFile: "missing" })).content[0].text, /exactly one/);
		assert.match((await call({ specFile: "missing" })).content[0].text, /ENOENT/);
		await writeFile(join(cwd, "bad.json"), "not json");
		assert.equal((await call({ specFile: "bad.json" })).details?.status, "invalid");
		await writeFile(join(cwd, "large.json"), " ".repeat(256 * 1024 + 1));
		assert.match((await call({ specFile: "large.json" })).content[0].text, /exceeds/);
		assert.equal((await call({ specFile: "missing" }, context(cwd, { trusted: false }))).details?.status, "untrusted");
		assert.deepEqual(await graphFileNames(cwd), []);
	} finally { await cleanup(); }
});
