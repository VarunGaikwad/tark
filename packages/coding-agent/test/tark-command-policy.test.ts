// Phase-2 argv policy, deadlines, debug evidence and real platform execution proofs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/extensions/tark/host.ts";
import { CheckPolicy, type CheckResult, readCheckSnapshot } from "../src/extensions/tark/lib/check-policy.ts";
import { executeArgv, executeReadOnlySandbox, executeSafeGit } from "../src/extensions/tark/lib/command-execution.ts";
import { classifyCommand, commandArgv, commandTimeout } from "../src/extensions/tark/lib/command-policy.ts";
import { DebugWorkflow } from "../src/extensions/tark/lib/debug-workflow.ts";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "tark-policy-test-"));
	directories.push(directory);
	return directory;
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function context(cwd: string, confirm: ExtensionContext["ui"]["confirm"]): ExtensionContext {
	// Only the check-policy boundary's context fields are needed by this unit fixture.
	return {
		cwd,
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session" },
		ui: { confirm },
	} as ExtensionContext;
}
function configure(cwd: string, script = "process.stdout.write('ok')") {
	mkdirSync(join(cwd, ".tark"), { recursive: true });
	writeFileSync(
		join(cwd, ".tark/checks.json"),
		JSON.stringify({ test: { executable: process.execPath, args: ["-e", script] } }),
	);
}

describe("validated command policy", () => {
	it.each([
		"git diff; id",
		"git diff && id",
		"git diff > x",
		"git diff | sh",
		"git $(id)",
		"git `id`",
		"git diff\nnode x",
		"git 'diff; id'",
		"git diff *",
		"git diff\\x",
		"git diff # comment",
	])("rejects shell syntax: %s", (command) => {
		expect(() => commandArgv(command)).toThrow();
	});
	it("parses only literal argv and rejects unclosed quoting", () => {
		expect(commandArgv('npm run "test name"')).toEqual(["npm", "run", "test name"]);
		expect(() => commandArgv("git 'diff")).toThrow();
	});
	it("uses fixed safe arguments and never trusts wrappers, paths or output/external flags", async () => {
		const safe = await classifyCommand("git diff --stat");
		expect(safe.tier).toBe("safe");
		expect(safe.executable).not.toBe("git");
		expect(safe.args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--no-optional-locks"]));
		for (const command of [
			"git -c core.pager=evil diff",
			"git diff --output=file",
			"git diff --ext-diff",
			"env git diff",
			"./git diff",
			"git push --force",
			"rm -rf target",
			"ls -la",
		]) {
			expect((await classifyCommand(command)).tier).toBe("dangerous");
		}
		expect((await classifyCommand("npm install")).tier).toBe("normal");
	});
	it("enforces the 120s default, configurable default and finite 600s hard cap", () => {
		vi.stubEnv("TARK_COMMAND_TIMEOUT_SECONDS", undefined);
		expect(commandTimeout()).toBe(120);
		vi.stubEnv("TARK_COMMAND_TIMEOUT_SECONDS", "240");
		expect(commandTimeout()).toBe(240);
		expect(commandTimeout(600)).toBe(600);
		for (const timeout of [0, -1, NaN, Infinity, 601]) expect(() => commandTimeout(timeout)).toThrow();
		vi.stubEnv("TARK_COMMAND_TIMEOUT_SECONDS", "unlimited");
		expect(() => commandTimeout(1)).toThrow();
	});
});

describe("bounded direct execution", () => {
	it("does not interpret shell arguments and bounds long output", async () => {
		const result = await executeArgv(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], fixture());
		expect(result.exitCode).toBe(0);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(8192);
		expect(result.omittedBytes).toBe(100000 - Buffer.byteLength(result.output));
	});
	it.each(["timeout", "cancelled"] as const)("terminates a command and its child on %s", async (reason) => {
		const cwd = fixture();
		const marker = join(cwd, "survived");
		const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1200)`;
		const parentScript = `const child=require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio:'ignore'}); child.once('spawn',()=>console.log('descendant:'+child.pid)); setInterval(() => {}, 1000)`;
		const controller = new AbortController();
		const timer = reason === "cancelled" ? setTimeout(() => controller.abort(), 350) : undefined;
		try {
			const result = await executeArgv(process.execPath, ["-e", parentScript], cwd, {
				signal: controller.signal,
				timeout: reason === "timeout" ? 0.35 : 5,
			});
			expect(result.termination).toBe(reason);
			expect(result.output).toContain("descendant:");
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(existsSync(marker)).toBe(false);
		} finally {
			clearTimeout(timer);
		}
	});
	it("does not invoke repository filesystem-monitor hooks for Safe Git", async () => {
		const cwd = fixture();
		const policy = await classifyCommand("git status --short");
		await executeArgv(policy.executable, ["init", "--quiet"], cwd);
		const marker = join(cwd, "hook-ran");
		const hook = join(cwd, "hook.cjs");
		writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`);
		await executeArgv(policy.executable, ["config", "core.fsmonitor", `"${process.execPath}" "${hook}"`], cwd);
		expect((await executeSafeGit(policy.executable, policy.args, cwd)).exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
		await executeArgv(policy.executable, ["config", "filter.fixture.clean", `"${process.execPath}" "${hook}"`], cwd);
		await expect(executeSafeGit(policy.executable, policy.args, cwd)).rejects.toThrow("repository filters");
		expect(existsSync(marker)).toBe(false);
	});

	it("does not start an already-cancelled process", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			executeArgv(process.execPath, ["-e", "process.exit(0)"], fixture(), { signal: controller.signal }),
		).rejects.toThrow();
	});
});

describe("check trust and platform isolation", () => {
	it("hashes effective commands and all package/tsconfig changes", async () => {
		const cwd = fixture();
		configure(cwd);
		const first = await readCheckSnapshot(cwd);
		writeFileSync(join(cwd, "package.json"), '{"scripts":{"test":"evil"}}');
		const second = await readCheckSnapshot(cwd);
		expect(second.revision).not.toBe(first.revision);
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		expect((await readCheckSnapshot(cwd)).revision).not.toBe(second.revision);
	});
	it("blocks missing command approval, arbitrary names, config changes during approval and non-absolute executables", async () => {
		const cwd = fixture();
		configure(cwd);
		const policy = new CheckPolicy();
		await expect(
			policy.run(
				"test",
				context(cwd, async () => false),
			),
		).rejects.toThrow("not approved");
		await expect(
			policy.run(
				"test; id" as "test",
				context(cwd, async () => true),
			),
		).rejects.toThrow("Unknown fixed");
		await expect(
			policy.run(
				"test",
				context(cwd, async () => {
					configure(cwd, "process.exit(1)");
					return true;
				}),
			),
		).rejects.toThrow("changed during approval");
		writeFileSync(join(cwd, ".tark/checks.json"), '{"test":{"executable":"npm","args":["test"]}}');
		await expect(readCheckSnapshot(cwd)).rejects.toThrow("absolute executable");
	});
	it.runIf(process.platform === "linux")(
		"never executes an unrestricted fallback when the real sandbox backend is unusable",
		async () => {
			const cwd = fixture();
			writeFileSync(join(cwd, "source"), "original");
			const script =
				"const fs=require('node:fs');const alias=process.env.TMPDIR+'/alias';fs.symlinkSync(process.cwd()+'/source',alias); for(const p of ['source','created',alias]){try{fs.writeFileSync(p,'bad');process.exit(2)}catch{}} const child=require('node:child_process').spawnSync(process.execPath,['-e',\"require('node:fs').writeFileSync('source','bad')\"]);if(child.status===0)process.exit(3);fs.writeFileSync(process.env.TMPDIR+'/out','ok');fs.writeFileSync(process.env.XDG_CACHE_HOME+'/cache','ok');console.log('isolated')";
			try {
				const result = await executeReadOnlySandbox(process.execPath, ["-e", script], cwd);
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("isolated");
			} catch (error) {
				if (process.env.TARK_REQUIRE_SANDBOX === "1") throw error;
				expect(String(error)).toMatch(/isolation (?:unavailable|failed)/);
			}
			expect(readFileSync(join(cwd, "source"), "utf8")).toBe("original");
			expect(existsSync(join(cwd, "created"))).toBe(false);
		},
	);
	it.runIf(process.platform === "win32")(
		"requires native Windows session consent, labels every result, resets consent and reviews command changes",
		async () => {
			const cwd = fixture();
			configure(cwd);
			const policy = new CheckPolicy();
			const prompts: string[] = [];
			const denied = context(cwd, async (title) => {
				prompts.push(title);
				return !title.includes("unsandboxed");
			});
			await expect(policy.run("test", denied)).rejects.toThrow("per-session");
			const approve = vi.fn(async () => true);
			const ctx = context(cwd, approve);
			expect(await policy.run("test", ctx)).toMatchObject({
				isolation: "unsandboxed",
				passed: true,
				tests: { passed: null, failed: null },
			});
			expect(await policy.run("test", ctx)).toMatchObject({ isolation: "unsandboxed" });
			expect(approve).toHaveBeenCalledTimes(1);
			await expect(executeReadOnlySandbox(process.execPath, ["-e", "process.exit(0)"], cwd)).rejects.toThrow(
				"requires Linux/WSL2",
			);
			configure(cwd, "console.log('new')");
			expect(await policy.run("test", ctx)).toMatchObject({ isolation: "unsandboxed" });
			expect(approve.mock.calls).toHaveLength(2);
			const nextSession = {
				...denied,
				sessionManager: { ...denied.sessionManager, getSessionId: () => "new-session" },
			};
			await expect(policy.run("test", nextSession)).rejects.toThrow("per-session");
			policy.reset();
			await expect(policy.run("test", denied)).rejects.toThrow("per-session");
		},
	);
});

describe("debug evidence progression", () => {
	const result = (passed: boolean): CheckResult => ({
		check: "test",
		passed,
		exitCode: passed ? 0 : 1,
		output: "",
		omittedBytes: 0,
		termination: "exit",
		isolation: "sandboxed",
		tests: { passed: null, failed: null },
	});
	it("requires reproduction, a failing regression and post-fix verification", () => {
		const debug = new DebugWorkflow();
		expect(() => debug.assertWrite("src/file.ts")).toThrow("reproduction");
		debug.report("reproduce", "Request fails with status 500 on fixture input");
		debug.assertWrite("test/regression.test.ts");
		expect(() => debug.assertWrite("src/file.ts")).toThrow("regression");
		expect(() => debug.report("regression", "new fixture")).toThrow("failing regression");
		debug.observe(result(false));
		debug.report("regression", "new fixture fails for the reproduced reason");
		debug.assertWrite("src/file.ts");
		expect(() => debug.assertComplete()).toThrow("incomplete");
		debug.observe(result(true));
		debug.assertComplete();
		debug.assertWrite("src/file.ts");
		expect(() => debug.assertComplete()).toThrow();
	});
	it("documents test infeasibility without inventing regression coverage and resets evidence", () => {
		const debug = new DebugWorkflow();
		debug.report("reproduce", "Concrete trace");
		debug.report("infeasible", "Hardware unavailable; alternative: fixture typecheck; hardware test unexecuted");
		expect(debug.state).toMatchObject({ stage: "fix", regression: expect.stringContaining("infeasible") });
		debug.observe(result(true));
		debug.assertComplete();
		debug.reset();
		expect(() => debug.assertComplete()).toThrow();
	});
});
