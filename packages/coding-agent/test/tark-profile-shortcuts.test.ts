// Offline regression coverage for the built-in agent profile shortcut.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { type KeybindingsConfig, KeybindingsManager, type KeyId } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import agentsExtension from "../src/extensions/tark/agents.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("built-in Tark profile shortcuts", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "tark-profile-shortcuts-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv("TARK_SUBAGENT_DEPTH", "0");
		vi.stubEnv("TARK_SUBAGENT_SCOPE", "");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	it.each<{ name: string; config: KeybindingsConfig; expected: KeyId[] }>([
		{ name: "default", config: {}, expected: ["alt+a"] },
		{ name: "remapped", config: { "app.profile.cycle": "alt+j" }, expected: ["alt+j"] },
		{
			name: "multiple",
			config: { "app.profile.cycle": ["alt+j", "alt+k"] },
			expected: ["alt+j", "alt+k"],
		},
		{ name: "disabled", config: { "app.profile.cycle": [] }, expected: [] },
	])("registers $name bindings without a false built-in conflict", async ({ config, expected }) => {
		await writeFile(join(agentDir, "keybindings.json"), JSON.stringify(config));
		const keybindings = KeybindingsManager.create(agentDir);
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			agentsExtension,
			cwd,
			createEventBus(),
			runtime,
			"builtin:tark-agents",
		);
		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner(
			[extension],
			runtime,
			cwd,
			sessionManager,
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const shortcuts = runner.getShortcuts(keybindings.getEffectiveConfig());

		expect([...shortcuts.keys()]).toEqual(expected);
		for (const shortcut of shortcuts.values()) expect(shortcut.extensionPath).toBe("builtin:tark-agents");
		// Wire only the host actions used by cycling; no model configuration or provider calls are needed.
		runtime.getThinkingLevel = () => "off";
		runtime.appendEntry = (customType, data) => sessionManager.appendCustomEntry(customType, data);
		const notify = vi.fn();
		const setStatus = vi.fn();
		runner.setUIContext({ ...runner.getUIContext(), notify, setStatus }, "tui");
		for (const shortcut of shortcuts.values()) {
			for (const agent of ["plan", "orchestrator", "debug", "ask", "code"]) {
				await shortcut.handler(runner.createContext());
				expect(notify).toHaveBeenLastCalledWith(`Agent: ${agent}`, "info");
				expect(setStatus).toHaveBeenCalledWith("tark-agent", `${agent} · read`);
				expect(sessionManager.getBranch().at(-1)).toMatchObject({
					type: "custom",
					customType: "tark-agent",
					data: { agent, origin: "manual", pinned: true },
				});
			}
		}
		expect(runner.getShortcutDiagnostics()).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
	});
});
