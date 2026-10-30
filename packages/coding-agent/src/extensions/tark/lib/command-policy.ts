// Fail-closed command classification and shell-free read command validation.

import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";

export type CommandPolicy =
	| { tier: "safe"; executable: string; args: string[] }
	| { tier: "normal" | "dangerous"; executable: string; args: string[] };

export const DEFAULT_COMMAND_TIMEOUT = 120;
export const MAX_COMMAND_TIMEOUT = 600;

/** Validate host configuration even when a per-call override is present. */
export function commandTimeout(override?: number): number {
	const configured = process.env.TARK_COMMAND_TIMEOUT_SECONDS;
	const fallback = configured === undefined ? DEFAULT_COMMAND_TIMEOUT : Number(configured);
	for (const value of [fallback, override ?? fallback]) {
		if (!Number.isFinite(value) || value <= 0 || value > MAX_COMMAND_TIMEOUT)
			throw new Error(`Command timeout must be > 0 and <= ${MAX_COMMAND_TIMEOUT} seconds`);
	}
	return override ?? fallback;
}

/** Parse a deliberately small argv language; no shell syntax is interpreted, even inside quotes. */
export function commandArgv(command: string): string[] {
	if (!command.trim() || command.length > 16_384 || /[\x00-\x1f\x7f;&|<>`$(){}[\]*?!#~\\]/.test(command))
		throw new Error("Shell metacharacters, escapes, substitutions and compound commands are unavailable");
	const result: string[] = [];
	let word = "";
	let quote = "";
	let started = false;
	for (const character of command) {
		if (quote) {
			if (character === quote) quote = "";
			else word += character;
		} else if (character === '"' || character === "'") {
			quote = character;
			started = true;
		} else if (character === " ") {
			if (started) result.push(word);
			word = "";
			started = false;
		} else {
			word += character;
			started = true;
		}
	}
	if (quote) throw new Error("Unclosed command quote");
	if (started) result.push(word);
	return result;
}

/** Resolve only OS-owned Git locations, never a project/PATH-provided executable. */
export async function trustedGit(): Promise<string> {
	const candidates =
		process.platform === "win32"
			? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe")]
			: ["/usr/bin/git", "/bin/git"];
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return await realpath(candidate);
		} catch (error) {
			if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	throw new Error("No supported system Git found; prefer built-in ls/find/read tools");
}

/** Allow only complete, audited read forms; unknown arguments never become safe by executable name. */
export async function classifyCommand(command: string): Promise<CommandPolicy> {
	const [executable, ...args] = commandArgv(command);
	if (executable === "git") {
		const [operation, ...flags] = args;
		const allowed: Record<string, string[]> = {
			status: ["--short", "--branch", "--untracked-files=no"],
			diff: ["--stat", "--name-only", "--name-status", "--cached", "--staged"],
			log: ["--oneline", "-1", "-5", "-10"],
		};
		if (Object.hasOwn(allowed, operation) && flags.every((flag) => allowed[operation].includes(flag))) {
			return {
				tier: "safe",
				executable: await trustedGit(),
				args: [
					"--no-pager",
					"--no-optional-locks",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.hooksPath=",
					...args,
					...(operation === "diff" ? ["--no-ext-diff", "--no-textconv", "--ignore-submodules=all"] : []),
					...(operation === "status" ? ["--ignore-submodules=all"] : []),
					...(operation === "log" ? ["--no-show-signature", "--format=oneline"] : []),
				],
			};
		}
	}
	// Project code, wrappers, and unknown executables are never classified as read-only.
	const normal = executable === "npm" && ["test", "install", "ci", "run"].includes(args[0]);
	return { tier: normal ? "normal" : "dangerous", executable, args };
}
