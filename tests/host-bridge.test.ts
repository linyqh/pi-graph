import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	graphChildProcessEnv,
	registerGraphHostEnvironment,
	registerGraphToolResolver,
	resolveGraphTool,
} from "../extensions/graph-engine/host-bridge.ts";

test("the tool resolver is shared through globalThis and never throws through to the caller", () => {
	const definition = { name: "fpa_query" } as unknown as ToolDefinition;
	try {
		assert.equal(resolveGraphTool("fpa_query"), undefined);

		registerGraphToolResolver((name) => name === "fpa_query" ? definition : undefined);
		assert.equal(resolveGraphTool("fpa_query"), definition);
		assert.equal(resolveGraphTool("fpa_missing"), undefined);

		registerGraphToolResolver(() => { throw new Error("host blew up"); });
		assert.equal(resolveGraphTool("fpa_query"), undefined);
	} finally {
		registerGraphToolResolver(undefined);
	}
});

test("a host installs its resolver through the well-known symbol without importing this module", () => {
	const definition = { name: "fpa_calc" } as unknown as ToolDefinition;
	const holder = globalThis as Record<symbol, unknown>;
	try {
		holder[Symbol.for("pi-graph.tool-resolver")] = (name: string) => name === "fpa_calc" ? definition : undefined;
		assert.equal(resolveGraphTool("fpa_calc"), definition);
	} finally {
		registerGraphToolResolver(undefined);
	}
});

test("child Pi processes inherit the host agent directory instead of reading the default one", () => {
	const base = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
	try {
		assert.equal(graphChildProcessEnv(base), base);

		registerGraphHostEnvironment({ agentDir: "/srv/fpa/shared" });
		assert.deepEqual(graphChildProcessEnv(base), { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/srv/fpa/shared" });
		// The host's own process environment is never mutated: several tenants
		// share one process, and the SDK re-reads this variable on every call.
		assert.equal(base.PI_CODING_AGENT_DIR, undefined);

		registerGraphHostEnvironment({});
		assert.equal(graphChildProcessEnv(base), base);
	} finally {
		registerGraphHostEnvironment(undefined);
	}
});
