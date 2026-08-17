import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_GRAPH_TOOLS,
	isMutatingTool,
	listAvailableToolNames,
	resolveAssignedTools,
} from "../extensions/graph-engine/tool-selection.ts";

function toolLister(names: string[]): Pick<ExtensionAPI, "getAllTools"> {
	return {
		getAllTools: () => names.map((name) => ({ name })),
	} as unknown as Pick<ExtensionAPI, "getAllTools">;
}

test("available tool names come from the live session, not a fixed list", () => {
	assert.deepEqual(
		listAvailableToolNames(toolLister(["read", "fpa_query", "fpa_calc"])),
		["fpa_calc", "fpa_query", "read"],
	);
});

test("available tool names fall back to the built-in coding tools without a session", () => {
	assert.deepEqual(listAvailableToolNames(), [...BUILTIN_GRAPH_TOOLS]);
	assert.deepEqual(listAvailableToolNames(toolLister([])), [...BUILTIN_GRAPH_TOOLS]);
	assert.deepEqual(
		listAvailableToolNames({ getAllTools: () => { throw new Error("session gone"); } } as unknown as Pick<ExtensionAPI, "getAllTools">),
		[...BUILTIN_GRAPH_TOOLS],
	);
});

test("assigned tools resolve by name and name what is available when one is missing", () => {
	const available = ["read", "fpa_query"];
	assert.deepEqual(resolveAssignedTools(available, ["fpa_query", "read"]), ["fpa_query", "read"]);
	assert.deepEqual(resolveAssignedTools(available, []), []);
	assert.throws(
		() => resolveAssignedTools(available, ["read", "fpa_nope"]),
		/not available in the current Pi session: fpa_nope\. Available: fpa_query, read\./,
	);
});

test("only the built-in write tools are mutating without an explicit declaration", () => {
	assert.equal(isMutatingTool("bash"), true);
	assert.equal(isMutatingTool("edit"), true);
	assert.equal(isMutatingTool("write"), true);
	assert.equal(isMutatingTool("read"), false);
	assert.equal(isMutatingTool("fpa_query"), false);
});
