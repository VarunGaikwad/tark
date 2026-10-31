// Real child processes receive neither RPC control-plane environment nor parent RPC stdin/descriptors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { executeArgv } from "../src/extensions/tark/lib/command-execution.ts";
import { subagentEnvironment } from "../src/extensions/tark/lib/subagent-runner.ts";
import { spawnProcess, waitForChildProcess } from "../src/utils/child-process.ts";
import { withoutRpcEnvironment } from "../src/utils/rpc-environment.ts";
import { getShellConfig, getShellEnv } from "../src/utils/shell.ts";

const reserved = [
	"TARK_RPC_TOKEN",
	"PI_RPC_ENDPOINT",
	"rpc_socket_path",
	"GRPC_AUTH_TOKEN",
	"NODE_CHANNEL_FD",
	"NODE_CHANNEL_SERIALIZATION_MODE",
	"LISTEN_FDS",
	"LISTEN_PID",
	"LISTEN_FDNAMES",
];
// Git Bash rewrites slash-delimited regex literals in native-process arguments as paths.
const probe =
	'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k=>new RegExp("RPC|IPC|NODE_CHANNEL|LISTEN_","i").test(k))))';
function seed() {
	for (const name of reserved) vi.stubEnv(name, "not-a-real-credential");
}
afterEach(() => vi.unstubAllEnvs());

describe("RPC capability stripping at spawn boundaries", () => {
	it("filters caller overrides and inherited environment without mutating them", () => {
		seed();
		for (const environment of [withoutRpcEnvironment(), getShellEnv(), subagentEnvironment(1)])
			for (const name of reserved) expect(environment[name]).toBeUndefined();
		expect(process.env.TARK_RPC_TOKEN).toBe("not-a-real-credential");
	});

	it("scrubs real argv/check/job launches even when their caller supplies an environment", async () => {
		seed();
		const result = await executeArgv(process.execPath, ["-e", probe], process.cwd(), { env: { ...process.env } });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual([]);
	});

	it("scrubs real extension exec subprocesses", async () => {
		seed();
		const result = await execCommand(process.execPath, ["-e", probe], process.cwd());
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual([]);
	});

	it("scrubs real shared process launches used by check/job adapters", async () => {
		seed();
		const child = spawnProcess(process.execPath, ["-e", probe], {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		expect(await waitForChildProcess(child)).toBe(0);
		expect(JSON.parse(output)).toEqual([]);
	});

	it("scrubs real bash launches after spawn-hook environment overrides", async () => {
		seed();
		const output: Buffer[] = [];
		const shell = getShellConfig();
		const executable = process.execPath.replaceAll("\\", "/");
		const result = await createLocalBashOperations().exec(`"${executable}" -e '${probe}'`, process.cwd(), {
			env: { ...process.env },
			timeout: 10,
			onData: (chunk) => output.push(chunk),
		});
		const text = Buffer.concat(output).toString();
		expect(
			result.exitCode,
			JSON.stringify({ shell, output: text.replaceAll("not-a-real-credential", "[redacted]").slice(-4096) }),
		).toBe(0);
		expect(JSON.parse(text)).toEqual([]);
	});
});
