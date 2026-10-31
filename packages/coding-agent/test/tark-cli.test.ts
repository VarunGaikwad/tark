// Real CLI subprocesses with a local faux provider; never use live model credentials.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
let root: string;
let cwd: string;
let user: string;
const fixture = resolve("test/fixtures/tark-offline.ts");
const source = resolve("src/cli.ts");
const resolver = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "tark-cli-"));
	cwd = join(root, "project");
	user = join(root, "user");
	await mkdir(cwd);
	await mkdir(user);
	await writeFile(
		join(user, "settings.json"),
		JSON.stringify({
			enableInstallTelemetry: false,
			tark: { subagent_variant_overrides: { ask: { model: "tark-offline-test/local", effort: "low" } } },
			extensions: ["-builtin:tark-cache", "-builtin:tark-setup", "-builtin:tark-sound"],
		}),
	);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("Tark CLI delegation", () => {
	it.each([
		["source", "print"],
		["source", "json"],
		["bundle", "json"],
	])(
		"runs a real %s parent and child in %s mode without a second agent registration",
		async (entry, mode) => {
			const running = execute(
				process.execPath,
				[
					...(entry === "source" ? ["--import", resolver, source] : [resolve("dist/bundle/cli.js")]),
					"--offline",
					"--no-session",
					"--no-context-files",
					"--extension",
					fixture,
					"--model",
					"tark-offline-test/local",
					...(mode === "json" ? ["--mode", "json"] : []),
					"--print",
					"Run offline delegation",
				],
				{
					cwd,
					env: {
						PATH: process.env.PATH,
						HOME: root,
						USERPROFILE: root,
						SystemRoot: process.env.SystemRoot,
						TARK_CODING_AGENT_DIR: user,
						PI_OFFLINE: "1",
						PI_TELEMETRY: "0",
					},
					timeout: 20_000,
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			running.child.stdin?.end();
			const { stdout, stderr } = await running;
			expect(stderr).not.toContain("Extension error");
			expect(stdout).toContain("PARENT_VERIFIED");
			expect(stdout).not.toContain("PARENT_FAILED");
			if (mode === "json") {
				const events = stdout
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as {
								type: string;
								message?: { role: string; toolName?: string; isError?: boolean; details?: unknown };
							},
					);
				const result = events.find(
					(event) =>
						event.type === "message_end" &&
						event.message?.role === "toolResult" &&
						event.message.toolName === "subagent",
				)?.message;
				expect(result?.isError).toBe(false);
				expect(result?.details).toMatchObject({
					status: "completed",
					reason: "variant override",
					effort: "low",
					output: "CHILD_VERIFIED",
					mode: "read",
					exitCode: 0,
				});
			}
		},
		30_000,
	);
});
