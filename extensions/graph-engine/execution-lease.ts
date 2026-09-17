import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphExecutionLease } from "./types.ts";
import { GraphControlFlowError } from "./types.ts";

interface ExecutionOwner { token: string; pid: number; children: number[] }

function processIsAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Local process ownership, not a time-based lease: a slow worker never loses ownership. */
export function acquireExecutionLease(directory: string): GraphExecutionLease {
	const guard = join(directory, ".execution-guard");
	const file = join(directory, ".execution-owner");
	const owner: ExecutionOwner = { token: randomUUID(), pid: process.pid, children: [] };
	const enter = () => {
		try { mkdirSync(guard, { mode: 0o700 }); }
		catch { throw new GraphControlFlowError("Execution ownership is being updated or its guard survived a crash; verify old workers have exited before recovery."); }
	};
	const readOwner = (): ExecutionOwner | undefined => {
		let fd: number;
		try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 65536) throw new GraphControlFlowError("Invalid execution owner file.");
			const value = JSON.parse(readFileSync(fd, "utf8")) as ExecutionOwner;
			if (!value || typeof value.token !== "string" || !Number.isInteger(value.pid) || value.pid < 1 || !Array.isArray(value.children)
				|| value.children.some((pid) => !Number.isInteger(pid) || pid < 1)) throw new GraphControlFlowError("Invalid execution owner record.");
			return value;
		} finally { closeSync(fd); }
	};
	const writeOwner = () => {
		const temporary = `${file}.${owner.token}.tmp`;
		const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try { writeFileSync(fd, JSON.stringify(owner)); fsyncSync(fd); }
		finally { closeSync(fd); }
		renameSync(temporary, file);
	};
	const assertOwner = () => {
		if (readOwner()?.token !== owner.token) throw new GraphControlFlowError("Execution ownership changed; refusing to launch a duplicate worker.");
	};

	enter();
	try {
		const previous = readOwner();
		if (previous && [previous.pid, ...previous.children].some(processIsAlive)) {
			throw new GraphControlFlowError("An execution owner or child process is still alive; wait for it to exit before recovery.");
		}
		writeOwner();
	} finally { rmdirSync(guard); }

	return {
		spawnProcess(create) {
			enter();
			let created = false;
			try {
				assertOwner();
				const child = create();
				created = true;
				if (child.pid) { owner.children.push(child.pid); writeOwner(); }
				rmdirSync(guard);
				return child;
			} catch (error) {
				// A crash/write failure between spawn and PID commit must fail closed.
				// Keep the guard when a child may exist, never guess it is safe to retry.
				if (!created) rmdirSync(guard);
				throw error;
			}
		},
		release() {
			if (existsSync(guard)) return;
			enter();
			try {
				assertOwner();
				if (owner.children.some(processIsAlive)) return;
				unlinkSync(file);
			} finally { rmdirSync(guard); }
		},
	};
}
