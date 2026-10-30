// Faux-provider RPC subprocess fixture with an unapproved plan; never calls real providers.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import agents from "../../src/extensions/tark/agents.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "../suite/harness.ts";

if (Object.keys(process.env).some((name) => /RPC|IPC|^NODE_CHANNEL_|^LISTEN_/i.test(name)))
	throw new Error("RPC fixture inherited a reserved control-plane environment variable");
const [cwd, agentDir] = process.argv.slice(-2);
process.env.TARK_CODING_AGENT_DIR = agentDir;
initTheme("dark");
const harness = await createHarness({ cwd, extensionFactories: [agents] });
await harness.session.bindExtensions({ mode: "json" });
harness.setResponses([
	fauxAssistantMessage(
		[
			fauxToolCall("save_plan", {
				action: "save",
				text: "RPC approval fixture",
				tasks: [{ id: "source", text: "Scoped change", allowed_paths: ["src"] }],
			}),
		],
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage("Saved unapproved fixture plan"),
]);
await harness.session.prompt("Save the unapproved fixture plan");
await runRpcMode({
	session: harness.session,
	setRebindSession() {},
	async dispose() {
		harness.cleanup();
	},
} as unknown as AgentSessionRuntime);
