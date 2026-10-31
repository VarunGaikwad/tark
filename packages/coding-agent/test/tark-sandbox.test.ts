// Strict real-bubblewrap isolation proofs: Linux tests fail, never mock/pass-fallback, when isolation is unavailable.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/extensions/tark/host.ts";
import { CheckPolicy } from "../src/extensions/tark/lib/check-policy.ts";
import { executeArgv, executeReadOnlySandbox, executionEnv } from "../src/extensions/tark/lib/command-execution.ts";

const directories: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "tark-real-sandbox-"));
	directories.push(root);
	const cwd = join(root, "project");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src/source.ts"), "original");
	const outside = join(root, "outside.ts");
	writeFileSync(outside, "outside original");
	return { root, cwd, outside };
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("real Linux/WSL2 filesystem sandbox", () => {
	it("runs reviewed run_checks configuration inside real isolation", async () => {
		const { cwd } = fixture();
		mkdirSync(join(cwd, ".tark"));
		const script =
			"const fs=require('node:fs');try{fs.writeFileSync('src/source.ts','escaped');process.exit(2)}catch(error){if(error.code!=='EROFS'&&error.code!=='EACCES')throw error}fs.writeFileSync(process.env.TMPDIR+'/check-output','ok');console.log('trusted check isolated')";
		writeFileSync(
			join(cwd, ".tark/checks.json"),
			JSON.stringify({ test: { executable: process.execPath, args: ["-e", script] } }),
		);
		const ctx = {
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "real-sandbox-check" },
			ui: { confirm: async () => true },
		} as unknown as ExtensionContext; // Only the check-policy context fields are used by this consent fixture.
		const result = await new CheckPolicy().run("test", ctx);
		expect(result).toMatchObject({ passed: true, isolation: "sandboxed" });
		expect(result.output).toContain("trusted check isolated");
		expect(readFileSync(join(cwd, "src/source.ts"), "utf8")).toBe("original");
	});

	it("blocks project writes outside allowed_paths and writes outside the project", async () => {
		const { cwd, outside } = fixture();
		// Phase 2 gives checks no source-write scope at all: even a plan's allowed_paths stay read-only.
		const script =
			"const fs=require('node:fs');for(const path of process.argv.slice(1)){try{fs.writeFileSync(path,'escaped');process.exit(2)}catch(error){if(error.code!=='EROFS'&&error.code!=='EACCES')throw error}}console.log('all writes denied')";
		const result = await executeReadOnlySandbox(
			process.execPath,
			["-e", script, "src/source.ts", "src/outside-task.ts", outside],
			cwd,
		);
		expect(result).toMatchObject({ exitCode: 0, termination: "exit" });
		expect(result.output).toContain("all writes denied");
		expect(readFileSync(join(cwd, "src/source.ts"), "utf8")).toBe("original");
		expect(readFileSync(outside, "utf8")).toBe("outside original");
		expect(existsSync(join(cwd, "src/outside-task.ts"))).toBe(false);
	});

	it("blocks existing and temporary symlink escapes", async () => {
		const { cwd, outside } = fixture();
		symlinkSync(outside, join(cwd, "src/link.ts"));
		const script =
			"const fs=require('node:fs');const link=process.env.TMPDIR+'/escape';fs.symlinkSync(process.argv[1],link);for(const path of ['src/link.ts',link]){try{fs.writeFileSync(path,'escaped');process.exit(2)}catch(error){if(error.code!=='EROFS'&&error.code!=='EACCES')throw error}}console.log('symlinks denied')";
		const result = await executeReadOnlySandbox(process.execPath, ["-e", script, outside], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("symlinks denied");
		expect(readFileSync(outside, "utf8")).toBe("outside original");
	});

	it("blocks child-process source writes", async () => {
		const { cwd } = fixture();
		const child =
			"try{require('node:fs').writeFileSync('src/source.ts','escaped');process.exit(2)}catch(error){if(error.code==='EROFS'||error.code==='EACCES')process.exit(43);throw error}";
		const script = `const result=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}]);if(result.status!==43)process.exit(2);console.log('child write denied')`;
		const result = await executeReadOnlySandbox(process.execPath, ["-e", script], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("child write denied");
		expect(readFileSync(join(cwd, "src/source.ts"), "utf8")).toBe("original");
	});

	it("allows dedicated temporary/home/cache outputs but exposes no RPC environment or parent PID", async () => {
		const { cwd } = fixture();
		const script =
			"const fs=require('node:fs');for(const key of ['TMPDIR','HOME','XDG_CACHE_HOME']){const path=process.env[key]+'/output';fs.writeFileSync(path,'ok');if(fs.readFileSync(path,'utf8')!=='ok')process.exit(2)}if(Object.keys(process.env).some(k=>/RPC|IPC|NODE_CHANNEL|LISTEN_/i.test(k)))process.exit(3);if(fs.existsSync('/proc/'+process.argv[1]+'/environ'))process.exit(4);console.log('dedicated outputs writable; control plane absent')";
		const result = await executeReadOnlySandbox(process.execPath, ["-e", script, String(process.pid)], cwd);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("control plane absent");
	});

	it("blocks execution when bubblewrap is actually hidden, without an unrestricted fallback", async () => {
		const { root, cwd } = fixture();
		const sandbox = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", join(homedir(), ".local/bin/bwrap")].find(existsSync);
		if (!sandbox) throw new Error("Real bubblewrap required for the unavailable-backend isolation test");
		const hide = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", join(homedir(), ".local/bin/bwrap")].filter(existsSync);
		const result = await executeArgv(
			realpathSync(sandbox),
			[
				"--unshare-user",
				"--unshare-pid",
				"--ro-bind",
				"/",
				"/",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				...hide.flatMap((path) => ["--ro-bind", "/dev/null", realpathSync(path)]),
				"--",
				process.execPath,
				resolve("test/fixtures/tark-sandbox-unavailable.ts"),
				cwd,
			],
			cwd,
			{ env: { ...executionEnv(), HOME: root } },
		);
		expect(result.exitCode, result.output).toBe(0);
		expect(result.output).toContain("unavailable backend blocked before command execution");
		expect(result.output).not.toContain("UNRESTRICTED COMMAND EXECUTED");
	});
});
