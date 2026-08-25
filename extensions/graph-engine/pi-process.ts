import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillSelectionArgs, type AssignedSkill } from "./skill-selection.ts";
import { graphChildProcessEnv } from "./host-bridge.ts";

const MAX_CAPTURED_STDERR = 50 * 1024;

export interface PiPromptOptions {
	prompt: string;
	cwd: string;
	systemPrompt?: string;
	provider?: string;
	model?: string;
	tools: string[];
	skills: AssignedSkill[];
	sessionId?: string;
	sessionDir?: string;
	sessionName?: string;
	thinkingLevel?: string;
	signal?: AbortSignal;
	agentName?: string;
}

export interface PiPromptResult {
	exitCode: number;
	stderr: string;
	finalText: string;
	usage: {
		turns: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens: number;
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sessionId?: string;
}

/**
 * Whether a `pi` executable is reachable on PATH.
 *
 * Node has no `which`, and getting this wrong matters: a Pi installed by the
 * user must keep winning over the copy this package happens to sit next to.
 */
function hasPiOnPath(): boolean {
	const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat"] : ["pi"];
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		for (const name of names) {
			try {
				if (fs.statSync(path.join(directory, name)).isFile()) return true;
			} catch {
				// Unreadable or missing PATH entries simply do not provide Pi.
			}
		}
	}
	return false;
}

/**
 * The Pi CLI entrypoint of the package this extension is installed alongside.
 *
 * Hosts that embed Pi rather than running its CLI — Pi Web, for one — have no
 * `pi` on PATH, so falling straight through to the bare command turns every
 * subagent node into an ENOENT.
 *
 * Walks the node_modules directories Node itself would search instead of
 * resolving the package: `@earendil-works/pi-coding-agent` publishes an
 * `exports` map that does not list `./package.json`, so asking for it throws.
 */
export function resolveInstalledPiCli(): string | undefined {
	const packageName = "@earendil-works/pi-coding-agent";
	try {
		const candidates = createRequire(import.meta.url).resolve.paths(packageName) ?? [];
		for (const directory of candidates) {
			const cli = path.join(directory, packageName, "dist", "cli.js");
			if (fs.existsSync(cli)) return cli;
		}
	} catch {
		// Fall through to the Pi command when the install cannot be located.
	}
	return undefined;
}

interface PiInvocation {
	command: string;
	args: string[];
	electronRunAsNode?: true;
}

function getPiInvocation(args: string[]): PiInvocation {
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (process.versions.electron) {
		if (hasPiOnPath()) return { command: "pi", args };
		const installedCli = resolveInstalledPiCli();
		if (installedCli) {
			return {
				command: process.execPath,
				args: [installedCli, ...args],
				electronRunAsNode: true,
			};
		}
		return { command: "pi", args };
	}
	if (!isGenericRuntime) return { command: process.execPath, args };

	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/")) {
		try {
			const resolvedScript = fs.realpathSync(currentScript).replaceAll("\\", "/").toLowerCase();
			const isPiCliScript = /\/(?:@[^/]+\/)?pi-coding-agent\/(?:dist|src)\/cli(?:-new)?\.[cm]?[jt]s$/.test(resolvedScript);
			if (isPiCliScript) return { command: process.execPath, args: [currentScript, ...args] };
		} catch {
			// Fall through to the Pi command when the embedding host entrypoint cannot be resolved.
		}
	}

	if (!hasPiOnPath()) {
		const installedCli = resolveInstalledPiCli();
		if (installedCli) return { command: process.execPath, args: [installedCli, ...args] };
	}

	return { command: "pi", args };
}

function getTextFromMessage(message: any): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

async function writeSystemPrompt(systemPrompt: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-graph-prompt-"));
	const file = path.join(dir, "system.md");
	await fs.promises.writeFile(file, systemPrompt, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

export function buildToolSelectionArgs(tools: string[]): string[] {
	return tools.length > 0 ? ["--tools", tools.join(",")] : ["--no-tools"];
}

export function buildPiPromptArgs(options: PiPromptOptions): string[] {
	const args = ["--mode", "json", "-p"];
	if (options.sessionId) args.push("--session-id", options.sessionId);
	if (options.sessionDir) args.push("--session-dir", options.sessionDir);
	if (options.sessionName) args.push("--name", options.sessionName);
	if (options.provider) args.push("--provider", options.provider);
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	args.push(...buildToolSelectionArgs(options.tools));
	args.push(...buildSkillSelectionArgs(options.skills));
	return args;
}

export async function runPiPrompt(options: PiPromptOptions): Promise<PiPromptResult> {
	const args = buildPiPromptArgs(options);

	let temp: { dir: string; file: string } | undefined;
	if (options.systemPrompt?.trim()) {
		temp = await writeSystemPrompt(options.systemPrompt);
		args.push("--append-system-prompt", temp.file);
	}

	args.push(options.prompt);

	const result: PiPromptResult = {
		exitCode: 0,
		stderr: "",
		finalText: "",
		sessionId: options.sessionId,
		usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
	};

	try {
		const invocation = getPiInvocation(args);
		let wasAborted = false;

		result.exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				env: {
					...graphChildProcessEnv(),
					...(invocation.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
				},
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let killTimer: NodeJS.Timeout | undefined;
			let abortHandler: (() => void) | undefined;
			let settled = false;
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
				resolve(code);
			};
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "session" && typeof event.id === "string") {
					result.sessionId = event.id;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message;
					if (message.role === "assistant") {
						const text = getTextFromMessage(message);
						if (text) result.finalText = text;
						result.usage.turns += 1;
						const usage = message.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
						}
						if (message.model) result.model = message.model;
						if (message.stopReason) result.stopReason = message.stopReason;
						if (message.errorMessage) result.errorMessage = message.errorMessage;
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr = `${result.stderr}${data.toString()}`.slice(0, MAX_CAPTURED_STDERR);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			});

			proc.on("error", (error) => {
				result.stderr = `${result.stderr}${error.message}`.slice(0, MAX_CAPTURED_STDERR);
				finish(1);
			});

			if (options.signal) {
				abortHandler = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (proc.exitCode === null) proc.kill("SIGKILL");
					}, 5000);
				};
				if (options.signal.aborted) abortHandler();
				else options.signal.addEventListener("abort", abortHandler, { once: true });
			}
		});

		if (wasAborted) {
			result.stopReason = "aborted";
			result.errorMessage = "Graph child pi process was aborted.";
		}
		return result;
	} finally {
		if (temp) {
			await fs.promises.rm(temp.dir, { recursive: true, force: true });
		}
	}
}

export function buildSubagentSystemPrompt(agentName: string, skills: AssignedSkill[], systemPrompt?: string): string {
	const assignedSkills = skills.map((skill) => skill.name);
	return [
		`You are subagent "${agentName}" running in an isolated persistent pi --mode json -p child session.`,
		assignedSkills.length > 0
			? `Assigned skills: ${assignedSkills.join(", ")}. Before acting, use the read tool to load every assigned SKILL.md and follow its instructions.`
			: "No skills are assigned to this subagent.",
		systemPrompt,
	].filter(Boolean).join("\n\n");
}

export function runPiSubagent(options: PiPromptOptions & { agentName: string }): Promise<PiPromptResult> {
	const systemPrompt = buildSubagentSystemPrompt(options.agentName, options.skills, options.systemPrompt);
	return runPiPrompt({ ...options, systemPrompt });
}

export function parseJsonFromText(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("No text to parse as JSON.");

	try {
		return JSON.parse(trimmed);
	} catch {
		const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced?.[1]) return JSON.parse(fenced[1].trim());

		const firstObject = trimmed.indexOf("{");
		const lastObject = trimmed.lastIndexOf("}");
		if (firstObject >= 0 && lastObject > firstObject) {
			return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
		}

		throw new Error("Model output was not valid JSON.");
	}
}
