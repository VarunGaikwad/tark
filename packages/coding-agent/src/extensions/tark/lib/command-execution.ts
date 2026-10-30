// Bounded argv execution and Linux/WSL2 read-only filesystem isolation.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { truncateTail } from "../../../core/tools/truncate.ts";
import { waitForChildProcess } from "../../../utils/child-process.ts";
import { withoutRpcEnvironment } from "../../../utils/rpc-environment.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../../utils/shell.ts";
import { commandTimeout } from "./command-policy.ts";

export interface CommandResult {
	exitCode: number;
	output: string;
	omittedBytes: number;
	termination: "exit" | "timeout" | "cancelled";
}

/** Execute directly with bounded retained output and process-tree cancellation. */
export async function executeArgv(
	executable: string,
	args: string[],
	cwd: string,
	options: { signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
	const timeout = commandTimeout(options.timeout);
	options.signal?.throwIfAborted();
	const child = spawn(executable, args, {
		cwd,
		shell: false,
		detached: process.platform !== "win32",
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: withoutRpcEnvironment(options.env ?? executionEnv()),
	});
	if (child.pid) trackDetachedChildPid(child.pid);
	let termination: CommandResult["termination"] = "exit";
	let output = "";
	let totalBytes = 0;
	const stdout = new StringDecoder("utf8");
	const stderr = new StringDecoder("utf8");
	const receive = (chunk: Buffer, decoder: StringDecoder) => {
		totalBytes += chunk.length;
		output = truncateTail(output + decoder.write(chunk), { maxLines: 200, maxBytes: 8192 }).content;
	};
	child.stdout.on("data", (chunk: Buffer) => receive(chunk, stdout));
	child.stderr.on("data", (chunk: Buffer) => receive(chunk, stderr));
	const stop = (reason: CommandResult["termination"]) => {
		termination = reason;
		if (child.pid) killProcessTree(child.pid);
	};
	const abort = () => stop("cancelled");
	const timer = setTimeout(() => stop("timeout"), timeout * 1000);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		const code = await waitForChildProcess(child);
		output = truncateTail(output + stdout.end() + stderr.end(), { maxLines: 200, maxBytes: 8192 }).content;
		return {
			exitCode: code ?? 1,
			output,
			omittedBytes: Math.max(0, totalBytes - Buffer.byteLength(output)),
			termination,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		// Do not leave quiet descendants running when their parent exits successfully.
		if (child.pid) {
			killProcessTree(child.pid);
			untrackDetachedChildPid(child.pid);
		}
	}
}

/** Reject repositories whose clean/process filters could execute project code during a read-only Git command. */
export async function executeSafeGit(
	executable: string,
	args: string[],
	cwd: string,
	options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<CommandResult> {
	const timeout = commandTimeout(options.timeout);
	const started = performance.now();
	const config = await executeArgv(
		executable,
		["--no-pager", "config", "--includes", "--name-only", "--get-regexp", "^filter[.]"],
		cwd,
		{ ...options, timeout },
	);
	if (config.termination !== "exit") return config;
	if (config.omittedBytes || config.exitCode !== 1 || config.output.trim())
		throw new Error(
			"Safe Git blocked: repository filters or unreadable configuration could execute project code; use built-in read/grep/find/ls",
		);
	const remaining = timeout - (performance.now() - started) / 1000;
	if (remaining <= 0) return { exitCode: 1, output: "", omittedBytes: 0, termination: "timeout" };
	return executeArgv(executable, args, cwd, { ...options, timeout: remaining });
}

/** Keep startup hooks, Git environment overrides and shell setup out of validated commands. */
export function executionEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.platform === "win32" ? process.env.PATH : "/usr/local/bin:/usr/bin:/bin",
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		LANG: "C.UTF-8",
		CI: "1",
		NO_COLOR: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

/** Use bubblewrap or fail closed; this is not a network or credential boundary. */
export async function executeReadOnlySandbox(
	executable: string,
	args: string[],
	cwd: string,
	options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<CommandResult> {
	commandTimeout(options.timeout);
	if (process.platform !== "linux") throw new Error("Filesystem isolation requires Linux/WSL2; execution blocked");
	let sandbox: string | undefined;
	for (const candidate of ["/usr/bin/bwrap", "/usr/local/bin/bwrap", join(homedir(), ".local/bin/bwrap")]) {
		try {
			await access(candidate, constants.X_OK);
			sandbox = await realpath(candidate);
			break;
		} catch (error) {
			if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	if (!sandbox)
		throw new Error("Filesystem isolation unavailable: install bubblewrap; execution blocked (no fallback)");
	const root = await realpath(cwd);
	const temporary = await mkdtemp(join(tmpdir(), "tark-check-"));
	try {
		const directory = await realpath(temporary);
		const local = relative(root, directory);
		if (local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)))
			throw new Error("Sandbox temporary storage must be outside the project");
		const home = join(directory, "home");
		const cache = join(directory, "cache");
		await mkdir(home);
		await mkdir(cache);
		const result = await executeArgv(
			sandbox,
			[
				"--die-with-parent",
				"--new-session",
				"--unshare-user",
				"--unshare-pid",
				"--unshare-ipc",
				"--unshare-uts",
				"--ro-bind",
				"/",
				"/",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--bind",
				directory,
				directory,
				"--chdir",
				root,
				"--",
				executable,
				...args,
			],
			root,
			{
				...options,
				env: {
					...executionEnv(),
					HOME: home,
					USERPROFILE: home,
					TMPDIR: directory,
					TMP: directory,
					TEMP: directory,
					XDG_CACHE_HOME: cache,
					npm_config_cache: cache,
				},
			},
		);
		if (result.exitCode !== 0 && /bwrap:/.test(result.output))
			throw new Error(`Filesystem isolation failed; no unrestricted fallback: ${result.output}`);
		return result;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
