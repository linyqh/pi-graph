import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireExecutionLease } from "../extensions/graph-engine/execution-lease.ts";

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

test("local execution ownership rejects competing processes and retained crash guards", () => {
	const dir = mkdtempSync(join(tmpdir(), "graph-lease-"));
	try {
		const first = acquireExecutionLease(dir);
		assert.throws(() => acquireExecutionLease(dir), /still alive/);
		first.release();
		const next = acquireExecutionLease(dir);
		next.release();
		mkdirSync(join(dir, ".execution-guard"));
		assert.throws(() => acquireExecutionLease(dir), /guard survived a crash/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("host crash cannot replay while its old Pi worker is alive", { skip: process.platform === "win32", timeout: 10000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "graph-orphan-"));
	const leaseUrl = new URL("../extensions/graph-engine/execution-lease.ts", import.meta.url).href;
	const script = `import {spawn} from 'node:child_process';
import {acquireExecutionLease} from ${JSON.stringify(leaseUrl)};
const lease=acquireExecutionLease(${JSON.stringify(dir)});
const child=lease.spawnProcess(()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}));
console.log(child.pid);
setInterval(()=>{},1000);`;
	const parent = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	let childPid: number | undefined;
	try {
		const [chunk] = await once(parent.stdout, "data");
		childPid = Number(String(chunk).trim());
		assert.ok(childPid > 0);
		const closed = once(parent, "close");
		parent.kill("SIGKILL");
		await closed;
		assert.equal(alive(childPid), true);
		assert.throws(() => acquireExecutionLease(dir), /child process is still alive/);
		process.kill(childPid, "SIGKILL");
		for (let attempt = 0; attempt < 100 && alive(childPid); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(alive(childPid), false);
		const recovered = acquireExecutionLease(dir);
		recovered.release();
	} finally {
		parent.kill("SIGKILL");
		if (childPid && alive(childPid)) process.kill(childPid, "SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});

test("v2 graph store registers the actual Pi process before releasing ownership", { skip: process.platform === "win32" }, async () => {
	const { writeFileSync, chmodSync, existsSync } = await import("node:fs");
	const { runGraph } = await import("../extensions/graph-engine/runtime.ts");
	const { compileDeclarativeGraphSpec } = await import("../extensions/graph-engine/declarative.ts");
	const { createProjectGraphRunStore } = await import("../extensions/graph-engine/run-store.ts");
	const dir = mkdtempSync(join(tmpdir(), "graph-process-owner-"));
	const previousPath = process.env.PATH;
	try {
		const executable = join(dir, "pi");
		writeFileSync(executable, `#!${process.execPath}\nimport {readFileSync} from 'node:fs';
const owner=JSON.parse(readFileSync('.agent-graph/runs/.execution-owner','utf8'));
console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({registered:owner.children.includes(process.pid)})}],stopReason:'stop'}}));`);
		chmodSync(executable, 0o755);
		process.env.PATH = `${dir}:${previousPath ?? ""}`;
		const graph = compileDeclarativeGraphSpec({ schemaVersion: 2, name: "process-owner", version: "1.0.0", description: "smoke", mutationPolicy: "read-only", start: "worker", maxSteps: 2,
			nodes: [{ id: "worker", type: "subagent", agentName: "worker", tools: [], prompt: "x", parseJson: true }] });
		const result = await runGraph({ appendEntry() {} } as any, graph, { cwd: dir, goal: "smoke", runStore: createProjectGraphRunStore(dir) });
		assert.equal(result.status, "completed", result.state.error);
		assert.deepEqual(result.output, { registered: true });
		assert.equal(existsSync(join(dir, ".agent-graph/runs/.execution-owner")), false);
	} finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		rmSync(dir, { recursive: true, force: true });
	}
});
