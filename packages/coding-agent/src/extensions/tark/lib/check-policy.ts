// Trusted fixed check definitions and configuration-change approval snapshots.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { ExtensionContext } from "../host.ts";
import { type CommandResult, executeArgv, executeReadOnlySandbox } from "./command-execution.ts";
import { commandTimeout, MAX_COMMAND_TIMEOUT } from "./command-policy.ts";

export const checkNames = ["typecheck", "lint", "test"] as const;
export type CheckName = (typeof checkNames)[number];
const commandSchema = z
	.object({
		executable: z.string().min(1).max(4096),
		args: z.array(z.string().max(4096)).max(64),
	})
	.strict();
const configSchema = z
	.object({
		typecheck: commandSchema.optional(),
		lint: commandSchema.optional(),
		test: commandSchema.optional(),
		timeoutSeconds: z.number().positive().max(MAX_COMMAND_TIMEOUT).optional(),
	})
	.strict();
export type CheckConfig = z.infer<typeof configSchema>;
export interface CheckSnapshot {
	revision: string;
	config: CheckConfig;
	files: string[];
	scripts: Record<string, Record<string, string>>;
}
export interface CheckResult extends CommandResult {
	check: CheckName;
	isolation: "sandboxed" | "unsandboxed";
	passed: boolean;
	tests: { passed: number | null; failed: number | null };
}

/** Configuration paths need explicit file scopes, not broad directory ownership. */
export function isCheckConfig(path: string): boolean {
	const name = path.replaceAll("\\", "/").split("/").at(-1)!;
	return (
		path.replaceAll("\\", "/") === ".tark/checks.json" ||
		/^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig.*\.json|(?:eslint|vitest|vite|jest|biome)\.config\..*|\.eslintrc.*|biome\.jsonc?)$/.test(
			name,
		)
	);
}

/** Fingerprint commands and project check configuration before every execution. */
export async function readCheckSnapshot(cwd: string): Promise<CheckSnapshot> {
	const root = await realpath(cwd);
	const config = configSchema.parse(JSON.parse(await readFile(join(root, ".tark/checks.json"), "utf8")));
	commandTimeout(config.timeoutSeconds);
	for (const name of checkNames) {
		const command = config[name];
		if (command && (!isAbsolute(command.executable) || /[\x00\r\n]/.test(command.executable)))
			throw new Error("Trusted checks require an absolute executable path (no PATH resolution or shell)");
	}
	const hash = createHash("sha256").update(JSON.stringify(config));
	const files: string[] = [];
	const scripts: CheckSnapshot["scripts"] = {};
	let entries = 0;
	let bytes = 0;
	async function walk(directory: string): Promise<void> {
		const children = await readdir(directory, { withFileTypes: true });
		children.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			if (++entries > 50_000) throw new Error("Too many project entries to validate check configuration");
			if (["node_modules", ".git", "dist", ".cache"].includes(child.name)) continue;
			const path = join(directory, child.name);
			const local = relative(root, path).replaceAll("\\", "/");
			if (child.isSymbolicLink())
				throw new Error(`Symlinked project entries prevent check configuration validation: ${local}`);
			if (child.isDirectory()) await walk(path);
			else if (isCheckConfig(local)) {
				if ((await lstat(path)).isSymbolicLink())
					throw new Error(`Symlinked check configuration blocked: ${local}`);
				const data = await readFile(path);
				bytes += data.length;
				if (bytes > 8 * 1024 * 1024 || files.length >= 2000)
					throw new Error("Check configuration exceeds validation budget");
				if (child.name === "package.json") {
					const metadata = z
						.object({ scripts: z.record(z.string(), z.string()).optional() })
						.parse(JSON.parse(data.toString("utf8")));
					if (metadata.scripts) scripts[local] = metadata.scripts;
				}
				hash.update(JSON.stringify([local, data.length]));
				hash.update(data);
				files.push(local);
			}
		}
	}
	await walk(root);
	if (Buffer.byteLength(JSON.stringify({ config, files, scripts })) > 64 * 1024)
		throw new Error(
			"Effective command review exceeds 64 KiB; reduce configured project scope before trusting checks",
		);
	return { revision: hash.digest("hex"), config, files, scripts };
}

/** Own command trust and native Windows consent for exactly one extension session. */
export class CheckPolicy {
	private trusted: CheckSnapshot | undefined;
	private windowsConsent = false;
	private generation = 0;
	private owner: string | undefined;

	/** Revoke all effective-command trust and Windows opt-in on session replacement. */
	reset(): void {
		this.generation++;
		this.owner = undefined;
		this.trusted = undefined;
		this.windowsConsent = false;
	}

	/** Run only a named, reviewed command; changed config requires fresh explicit consent. */
	async run(check: CheckName, ctx: ExtensionContext, signal?: AbortSignal): Promise<CheckResult> {
		if (!checkNames.includes(check)) throw new Error("Unknown fixed check name");
		if (!ctx.isProjectTrusted()) throw new Error("Checks require a trusted project");
		const session = ctx.sessionManager.getSessionId();
		const owner = JSON.stringify([session, await realpath(ctx.cwd)]);
		if (this.owner !== owner) {
			this.reset();
			this.owner = owner;
		}
		const generation = this.generation;
		const next = await readCheckSnapshot(ctx.cwd);
		if (!next.config[check]) throw new Error(`No trusted ${check} configured in .tark/checks.json`);
		if (this.trusted?.revision !== next.revision) {
			const description = `Working directory: ${ctx.cwd}\nOld commands: ${JSON.stringify(this.trusted?.config ?? null)}\nNew commands: ${JSON.stringify(next.config)}\nOld package scripts: ${JSON.stringify(this.trusted?.scripts ?? null)}\nNew package scripts: ${JSON.stringify(next.scripts)}\nOld configuration revision: ${this.trusted?.revision ?? "none"}\nNew configuration revision: ${next.revision}\nProtected configuration files: ${next.files.join(", ")}`;
			if (
				!ctx.hasUI ||
				!(await ctx.ui.confirm("Approve effective check commands/configuration?", description, { signal }))
			)
				throw new Error("Effective check commands/configuration not approved");
			if (
				generation !== this.generation ||
				signal?.aborted ||
				session !== ctx.sessionManager.getSessionId() ||
				(await readCheckSnapshot(ctx.cwd)).revision !== next.revision
			)
				throw new Error("Check configuration or session changed during approval; retry");
			this.trusted = next;
		}
		if (process.platform === "win32" && !this.windowsConsent) {
			if (
				!ctx.hasUI ||
				!(await ctx.ui.confirm(
					"Allow unsandboxed checks for this session?",
					"Native Windows filesystem isolation is unavailable. These trusted checks can modify project files. This grants neither bash nor builder shell access.",
					{ signal },
				))
			)
				throw new Error("Native Windows checks require per-session unsandboxed opt-in");
			if (generation !== this.generation || signal?.aborted || session !== ctx.sessionManager.getSessionId())
				throw new Error("Session changed during opt-in");
			this.windowsConsent = true;
		}
		signal?.throwIfAborted();
		if (
			(await readCheckSnapshot(ctx.cwd)).revision !== next.revision ||
			generation !== this.generation ||
			signal?.aborted ||
			!ctx.isProjectTrusted()
		)
			throw new Error("Check configuration changed before execution");
		const command = next.config[check]!;
		const isolation = process.platform === "win32" ? "unsandboxed" : "sandboxed";
		const run = isolation === "unsandboxed" ? executeArgv : executeReadOnlySandbox;
		const result = await run(command.executable, command.args, ctx.cwd, {
			signal,
			timeout: next.config.timeoutSeconds,
		});
		return {
			...result,
			check,
			isolation,
			passed: result.exitCode === 0 && result.termination === "exit",
			// Framework-specific output is not a trusted structured count protocol.
			tests: { passed: null, failed: null },
		};
	}
}
