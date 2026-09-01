import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import graphEngineeringExtension from "../extensions/graph-engine/index.ts";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type CapturedTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: (result: ToolResult) => void,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
};

function registerExtension(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const extensionApi = {
		registerEntryRenderer() {},
		registerCommand() {},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		events: { on: () => () => undefined, emit() {} },
		on() {},
	} as unknown as ExtensionAPI;
	graphEngineeringExtension(extensionApi);
	return tools;
}

function validSpec(name = "deletable-flow") {
	return {
		schemaVersion: 1,
		name,
		version: "1.0.0",
		description: "A project graph that can be deleted safely.",
		mutationPolicy: "read-only",
		start: "finish",
		maxSteps: 2,
		nodes: [{ id: "finish", type: "prompt", prompt: "Finish {{goal}}." }],
	};
}

function context(cwd: string, options: { trusted?: boolean; hasUI?: boolean; approved?: boolean } = {}): ExtensionContext {
	return {
		cwd,
		hasUI: options.hasUI ?? true,
		isProjectTrusted: () => options.trusted ?? true,
		ui: {
			notify() {},
			setStatus() {},
			confirm: async () => options.approved ?? true,
		},
		sessionManager: {
			getBranch() {
				return [];
			},
		},
	} as unknown as ExtensionContext;
}

async function invoke(tool: CapturedTool, params: Record<string, unknown>, ctx: ExtensionContext): Promise<ToolResult> {
	return tool.execute("call", params, new AbortController().signal, () => {}, ctx);
}

async function graphFileNames(cwd: string): Promise<string[]> {
	try {
		return await readdir(join(cwd, ".agent-graph", "graphs"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

test("graph_delete removes an approved project graph and refreshes graph_list immediately", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-delete-"));
	try {
		const tools = registerExtension();
		const ctx = context(cwd);
		await invoke(tools.get("graph_create")!, { spec: validSpec() }, ctx);

		const deleted = await invoke(tools.get("graph_delete")!, { graph: "deletable-flow" }, ctx);
		assert.equal(deleted.details?.status, "deleted");
		assert.equal(deleted.details?.path, join(cwd, ".agent-graph", "graphs", "deletable-flow.json"));
		assert.deepEqual(await graphFileNames(cwd), []);

		const listed = await invoke(tools.get("graph_list")!, {}, ctx);
		assert.doesNotMatch(listed.content[0].text, /deletable-flow/);
		assert.equal((listed.details?.sources as Record<string, unknown>)["deletable-flow"], undefined);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("graph_delete requires trust, an interactive UI, and explicit approval", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-delete-approval-"));
	try {
		const tools = registerExtension();
		await invoke(tools.get("graph_create")!, { spec: validSpec() }, context(cwd));
		const path = join(cwd, ".agent-graph", "graphs", "deletable-flow.json");

		const untrusted = await invoke(tools.get("graph_delete")!, { graph: "deletable-flow" }, context(cwd, { trusted: false }));
		assert.equal(untrusted.details?.status, "untrusted");
		assert.equal(JSON.parse(await readFile(path, "utf8")).name, "deletable-flow");

		const headless = await invoke(tools.get("graph_delete")!, { graph: "deletable-flow" }, context(cwd, { hasUI: false }));
		assert.equal(headless.details?.status, "approval_required");
		assert.equal(JSON.parse(await readFile(path, "utf8")).name, "deletable-flow");

		const declined = await invoke(tools.get("graph_delete")!, { graph: "deletable-flow" }, context(cwd, { approved: false }));
		assert.equal(declined.details?.status, "cancelled");
		assert.equal(JSON.parse(await readFile(path, "utf8")).name, "deletable-flow");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("graph_delete refuses built-in and unknown graphs before confirmation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-delete-refuse-"));
	try {
		const tools = registerExtension();
		const ctx = context(cwd);
		ctx.ui.confirm = async () => {
			throw new Error("confirmation must not run for a graph that cannot be deleted");
		};

		const builtIn = await invoke(tools.get("graph_delete")!, { graph: "research" }, ctx);
		assert.equal(builtIn.details?.status, "built_in");
		assert.match(builtIn.content[0].text, /cannot be deleted/);

		const unknown = await invoke(tools.get("graph_delete")!, { graph: "missing" }, ctx);
		assert.equal(unknown.details?.status, "not_found");
		assert.match(unknown.content[0].text, /Unknown graph/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
