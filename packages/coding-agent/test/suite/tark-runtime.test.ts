// Exercise Tark hooks through a real AgentSession with the local faux provider only.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import accessGuard from "../../src/extensions/tark/access-guard.ts";
import agents from "../../src/extensions/tark/agents.ts";
import questions from "../../src/extensions/tark/ask-question.ts";
import { agentNames, profiles } from "../../src/extensions/tark/lib/agents.ts";
import * as subagentRunner from "../../src/extensions/tark/lib/subagent-runner.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const workflowDirs: string[] = [];
beforeEach(() => {
	initTheme("dark");
	vi.stubEnv("TARK_SUBAGENT_DEPTH", "0");
	vi.stubEnv("TARK_SUBAGENT_SCOPE", "");
});
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
	for (const path of workflowDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Tark agent model setup", () => {
	it.each(["plan", "orchestrator", "debug", "ask", "code"])(
		"searches and saves %s without switching the active profile or model",
		async (profile) => {
			const harness = await createHarness({
				extensionFactories: [agents],
				models: [{ id: "main" }, { id: "replacement" }],
			});
			harnesses.push(harness);
			vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
			const path = join(harness.tempDir, ".tark", "settings.json");
			mkdirSync(join(harness.tempDir, ".tark"));
			const original = {
				theme: "orange",
				tark: { agentSetup: "disabled", subagent_variant_overrides: { [profile]: { effort: "high" } } },
			};
			writeFileSync(path, JSON.stringify(original));
			const notify = vi.fn();
			const select = vi.fn(async (title: string, choices: string[]) => {
				expect(title).toContain(".tark/settings.json");
				expect(choices).toHaveLength(5);
				expect(choices.every((choice) => choice.includes("/main (inherited)"))).toBe(true);
				return choices.find((choice) => choice.startsWith(`${profile} ·`));
			});
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					select,
					notify,
					async custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
						let result: unknown;
						const component = await factory(
							{ requestRender() {} } as TUI,
							theme,
							new KeybindingsManager(),
							(value) => {
								result = value;
							},
						);
						for (const char of "replacement") component.handleInput?.(char);
						const lines = component.render(80);
						expect(lines.join("\n")).toContain("replacement");
						expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
						expect(component.render(30).every((line) => visibleWidth(line) <= 30)).toBe(true);
						component.handleInput?.("\r");
						// The picker returns the string selected by this real component.
						return result as T;
					},
				}),
			});
			const initialModel = harness.session.model;
			await harness.session.prompt("/setup-agents");
			expect(notify.mock.calls.filter(([, level]) => level === "warning")).toEqual([]);
			const selected = `${harness.getModel().provider}/replacement`;
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				...original,
				tark: { ...original.tark, subagent_variant_overrides: { [profile]: { effort: "high", model: selected } } },
			});
			expect(harness.session.model).toBe(initialModel);
			expect(notify).toHaveBeenCalledWith(expect.stringContaining(`Use /profile ${profile} to apply`), "info");
			expect(harness.session.messages).toHaveLength(0);
			await harness.session.prompt(`/profile ${profile}`);
			expect(harness.session.model?.id).toBe("replacement");
		},
	);

	it.each(["profile", "model"])("cancels at the %s menu without creating settings", async (stage) => {
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		const notify = vi.fn();
		let modelMenuOpened = false;
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				notify,
				select: async (_title, choices) => (stage === "profile" ? undefined : choices[0]),
				async custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
					modelMenuOpened = true;
					let result: unknown = "not cancelled";
					const keys = new KeybindingsManager({ "tui.select.cancel": "ctrl+x" });
					const component = await factory({ requestRender() {} } as TUI, theme, keys, (value) => {
						result = value;
					});
					component.handleInput?.("\x18");
					expect(result).toBeUndefined();
					return result as T;
				},
			}),
		});
		await harness.session.prompt("/setup-agents");
		expect(modelMenuOpened).toBe(stage === "model");
		expect(notify.mock.calls.filter(([, level]) => level === "warning")).toEqual([]);
		expect(existsSync(join(harness.tempDir, ".tark"))).toBe(false);
	});

	it.each(["untrusted", "rpc", "json", "print", "invalid argument"])(
		"rejects %s without prompting or writing",
		async (scenario) => {
			const harness = await createHarness({ extensionFactories: [agents] });
			harnesses.push(harness);
			vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
			if (scenario === "untrusted") harness.settingsManager.setProjectTrusted(false);
			const select = vi.fn();
			const notify = vi.fn();
			await harness.session.bindExtensions({
				mode: scenario === "rpc" || scenario === "json" || scenario === "print" ? scenario : "tui",
				uiContext: createTestUiContext({ select, notify }),
			});
			await harness.session.prompt(scenario === "invalid argument" ? "/setup-agents typo" : "/setup-agents");
			expect(select).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(expect.any(String), "warning");
			expect(existsSync(join(harness.tempDir, ".tark"))).toBe(false);
		},
	);

	it.each(["unavailable model", "trust changed"])(
		"leaves settings unchanged when %s during selection",
		async (scenario) => {
			const harness = await createHarness({ extensionFactories: [agents] });
			harnesses.push(harness);
			vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
			mkdirSync(join(harness.tempDir, ".tark"));
			const path = join(harness.tempDir, ".tark", "settings.json");
			writeFileSync(path, '{"theme":"orange"}');
			const notify = vi.fn();
			await harness.session.bindExtensions({
				mode: "tui",
				uiContext: createTestUiContext({
					select: async (_title, choices) => choices[0],
					notify,
					async custom<T>() {
						if (scenario === "trust changed") harness.settingsManager.setProjectTrusted(false);
						return "missing/model" as T;
					},
				}),
			});
			await harness.session.prompt("/setup-agents");
			expect(readFileSync(path, "utf8")).toBe('{"theme":"orange"}');
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("was not updated"), "warning");
		},
	);

	it("reports an empty authenticated catalog without opening the model picker", async () => {
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		const custom = vi.fn();
		const notify = vi.fn();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({
				select: async (_title, choices) => choices[0],
				custom,
				notify,
			}),
		});
		const snapshot = vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([]);
		try {
			await harness.session.prompt("/setup-agents");
			expect(custom).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("No authenticated models"), "warning");
			expect(existsSync(join(harness.tempDir, ".tark"))).toBe(false);
		} finally {
			snapshot.mockRestore();
		}
	});

	it("rejects setup while a faux response is running instead of waiting and opening a menu later", async () => {
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		const select = vi.fn();
		const notify = vi.fn();
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ select, notify }) });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const response = harness.session.prompt("hello");
		await started.promise;
		try {
			await harness.session.prompt("/setup-agents");
			expect(select).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("Wait for the current agent and subagents"),
				"warning",
			);
			expect(existsSync(join(harness.tempDir, ".tark"))).toBe(false);
		} finally {
			release.resolve();
			await response;
		}
	});

	it("blocks concurrent setup and input while a menu is open, then releases the guard on cancel", async () => {
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		const opened = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string | undefined>();
		const notify = vi.fn();
		const select = vi.fn(async () => {
			opened.resolve();
			return release.promise;
		});
		await harness.session.bindExtensions({ mode: "tui", uiContext: createTestUiContext({ select, notify }) });
		const setup = harness.session.prompt("/setup-agents");
		await opened.promise;
		try {
			await harness.session.prompt("/setup-agents");
			await harness.session.prompt("Implement a feature", { source: "interactive" });
			expect(select).toHaveBeenCalledTimes(1);
			expect(notify).toHaveBeenCalledWith("Finish agent setup before submitting a request.", "warning");
			expect(harness.session.messages).toHaveLength(0);
		} finally {
			release.resolve(undefined);
			await setup;
		}
		await harness.session.prompt("/setup-agents");
		expect(select).toHaveBeenCalledTimes(2);
		expect(existsSync(join(harness.tempDir, ".tark"))).toBe(false);
	});

	it("retains explicit defaults setup without opening a menu", async () => {
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		const select = vi.fn();
		await harness.session.bindExtensions({ mode: "json", uiContext: createTestUiContext({ select }) });
		await harness.session.prompt("/setup-agents defaults");
		const settings = JSON.parse(readFileSync(join(harness.tempDir, ".tark", "settings.json"), "utf8"));
		expect(settings.tark).not.toHaveProperty("codeHealth");
		expect(settings.tark.subagent_variant_overrides.plan).toEqual({
			model: `${harness.getModel().provider}/${harness.getModel().id}`,
			effort: "high",
		});
		expect(select).not.toHaveBeenCalled();
	});
});

describe("Tark core exploration", () => {
	it.each(["no config", "small model", "obsolete false", "untrusted config"])(
		"delegates read-only exploration with %s",
		async (scenario) => {
			const run = vi.spyOn(subagentRunner, "runSubagent").mockResolvedValue({
				output: "src/loader.ts:1 — loader entry point",
				exitCode: 0,
				stderr: "",
				usage: subagentRunner.emptyUsage(),
			});
			const harness = await createHarness({
				extensionFactories: [agents],
				models: [{ id: "main" }, { id: "small" }, { id: "override" }],
				initialActiveToolNames: ["read", "grep", "find", "ls", "bash", "edit", "write", "subagent"],
			});
			harnesses.push(harness);
			vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
			const provider = harness.getModel().provider;
			if (scenario !== "no config") {
				mkdirSync(join(harness.tempDir, ".tark"));
				writeFileSync(
					join(harness.tempDir, ".tark", "settings.json"),
					JSON.stringify({
						tark:
							scenario === "obsolete false"
								? { delegate_exploration: false }
								: {
										small_model: `${provider}/small`,
										subagent_variant_overrides: { ask: { model: `${provider}/override`, effort: "high" } },
									},
					}),
				);
			}
			if (scenario === "untrusted config") harness.settingsManager.setProjectTrusted(false);
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("subagent", { agent: "ask", purpose: "explore", task: "Find the loader" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Explore the loader", { source: "interactive" });
			const model = `${provider}/${scenario === "small model" ? "small" : "main"}`;
			expect(getToolResult(harness, "subagent")).toMatchObject({
				isError: false,
				details: {
					model,
					effort: "low",
					mode: "read",
					status: "completed",
					reason: scenario === "small model" ? "configured exploration small model" : "exploration current model",
				},
			});
			expect(run).toHaveBeenCalledTimes(1);
			const child = run.mock.calls[0][0];
			expect(child.depth).toBe(1);
			expect(child.args[child.args.indexOf("--model") + 1]).toBe(model);
			expect(child.args[child.args.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
			expect(child.args).toEqual(expect.arrayContaining(["--no-mcp", "--exclude-tools", "mcp__*"]));
			expect(child.args).toContain(scenario === "untrusted config" ? "--no-approve" : "--approve");
			const tool = harness.session.getAllTools().find((tool) => tool.name === "subagent")!;
			expect(tool.description).toContain("otherwise the current model");
			expect(tool.description).toContain("exploration ignores variant overrides");
			expect(tool.description).toContain(
				"Concurrency depends on the parent's profile, not the selected child agent",
			);
			expect(tool.description).toContain("up to two read children concurrently");
			expect(tool.description).toContain("builders are unavailable");
			expect(tool.description).toContain("Other parent profiles run children sequentially");
			expect(JSON.stringify(tool)).not.toContain("delegate_exploration");
		},
	);

	it.each([1, 2])("respects the delegation depth cap from depth %s", async (depth) => {
		vi.stubEnv("TARK_SUBAGENT_DEPTH", String(depth));
		vi.stubEnv("TARK_SUBAGENT_SCOPE", JSON.stringify({ mode: "read", paths: [] }));
		const run = vi.spyOn(subagentRunner, "runSubagent").mockResolvedValue({
			output: "found",
			exitCode: 0,
			stderr: "",
			usage: subagentRunner.emptyUsage(),
		});
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		await harness.session.bindExtensions({ mode: "json", uiContext: createTestUiContext() });
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("subagent", { agent: "ask", purpose: "explore", task: "Find the loader" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Explore");
		if (depth === 1) {
			expect(getToolResult(harness, "subagent").isError).toBe(false);
			expect(run.mock.calls[0][0].depth).toBe(2);
			expect(run.mock.calls[0][0].args[run.mock.calls[0][0].args.indexOf("--tools") + 1]).toBe("read");
		} else {
			expect(harness.session.getActiveToolNames()).not.toContain("subagent");
			expect(getToolResult(harness, "subagent").isError).toBe(true);
			expect(run).not.toHaveBeenCalled();
		}
	});
});

describe("Tark runtime", () => {
	it.each(agentNames.flatMap((profile) => [0, 1].map((depth) => ({ profile, depth }))))(
		"shares readability guidance for $profile at depth $depth without replacing role or repository context",
		async ({ profile, depth }) => {
			vi.stubEnv("TARK_SUBAGENT_DEPTH", String(depth));
			if (depth > 0) vi.stubEnv("TARK_SUBAGENT_SCOPE", JSON.stringify({ mode: "read", paths: [] }));
			const harness = await createHarness({ extensionFactories: [agents] });
			harnesses.push(harness);
			vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
			await harness.session.prompt(`/profile ${profile}`);
			let prompt = "";
			harness.setResponses([
				(context) => {
					prompt = getCurrentSystemPrompt(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("Handle the supplied task");
			expect(prompt).toContain(`Tark agent profile: ${profile}`);
			expect(prompt).toContain(profiles[profile]);
			expect(prompt).toContain("<tark_profile>");
			expect(prompt).toContain(harness.tempDir);
			const guidance = prompt.match(/For authorized edits: [^\n]+/g);
			expect(guidance).toHaveLength(1);
			expect(guidance![0]).toContain("inspect and reuse repository patterns");
			expect(guidance![0]).toContain("keep files cohesive and separate unrelated responsibilities");
			expect(guidance![0]).toContain("focused, clearly named functions and straightforward control flow");
			expect(guidance![0]).toContain("without tiny-file fragmentation, unnecessary abstractions, or hard size caps");
			expect(guidance![0]).toContain("Reread changed code and run relevant checks before completing edits");
			if (profile === "plan") expect(prompt).toContain("Do not implement or delegate implementation");
			if (profile === "ask") expect(prompt).toContain("Do not change files or delegate changes");
			if (profile === "orchestrator") {
				expect(prompt).toContain("ask with purpose: explore for read-only codebase exploration");
				expect(prompt).toContain(
					"Use orchestrator children only for a distinct coordination task, not ordinary fan-out",
				);
				expect(prompt).toContain("Orchestrator is always read-only and never repairs source itself");
				expect(prompt).toContain("no parallel builders");
			}
			if (depth > 0) {
				expect(prompt).toContain("You are a delegated subagent");
				expect(prompt).toContain("Declared ownership: read");
				expect(prompt).toContain("use purpose: explore only for bounded read-only codebase exploration");
			} else {
				expect(prompt).toContain("agent: ask and purpose: explore");
				expect(prompt).toContain("otherwise the current model");
			}
			expect(prompt).not.toContain("delegate_exploration");
		},
	);

	it("completes edits without health notices, review calls, or rewriting obsolete settings", async () => {
		const harness = await createHarness({
			extensionFactories: builtInExtensions.filter(
				(extension) => typeof extension !== "function" && extension.name.startsWith("tark-"),
			),
		});
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		mkdirSync(join(harness.tempDir, ".tark"));
		const path = join(harness.tempDir, ".tark", "settings.json");
		const settings = JSON.stringify({
			tark: { codeHealth: { enabled: true, enableAiReview: true, enableRuff: true } },
		});
		writeFileSync(path, settings);
		const agentDir = `${harness.tempDir}-agent`;
		workflowDirs.push(agentDir);
		vi.stubEnv("TARK_CODING_AGENT_DIR", agentDir);
		const notify = vi.fn();
		const complete = vi.spyOn(harness.session.modelRuntime, "complete");
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				notify,
				editor: async (_title, prefill) => prefill,
				select: async (_title, choices) => choices.find((choice) => choice === "Approve & start code"),
			}),
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("save_plan", {
							action: "save",
							text: "Write the requested example",
							tasks: [{ id: "example", text: "Write example.py", allowed_paths: ["example.py"] }],
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Plan saved"),
			]);
			await harness.session.prompt("Save the example plan");
			expect(getToolResult(harness, "save_plan").isError).toBe(false);
			await harness.session.prompt("/approve-plan");
			const content = `def example():\n${"    print('unchanged')\n".repeat(900)}`;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: "example.py", content })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
				fauxAssistantMessage("unexpected extra review"),
			]);
			await harness.session.prompt("Write the requested example");
			expect(getToolResult(harness, "write").isError).toBe(false);
			expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(complete).not.toHaveBeenCalled();
			expect(notify.mock.calls.flat().join("\n")).not.toMatch(/code health|\/health/i);
			expect(harness.session.extensionRunner.getRegisteredCommands().map((command) => command.name)).not.toContain(
				"health",
			);
			expect(harness.sessionManager.getBranch()).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ customType: "tark-code-health-review" })]),
			);
			expect(readFileSync(join(harness.tempDir, "example.py"), "utf8")).toBe(content);
			expect(readFileSync(path, "utf8")).toBe(settings);
		} finally {
			await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}
	});

	it("does not automatically route clear requests even when auto_profile is configured", async () => {
		const harness = await createHarness({ extensionFactories: [agents] });
		harnesses.push(harness);
		vi.stubEnv("TARK_CODING_AGENT_DIR", join(harness.tempDir, "user"));
		mkdirSync(join(harness.tempDir, ".tark"));
		writeFileSync(join(harness.tempDir, ".tark", "settings.json"), '{"tark":{"auto_profile":true}}');
		let prompt = "";
		harness.setResponses([
			(context) => {
				prompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("explanation");
			},
		]);
		await harness.session.prompt("Explain how the loader works", { source: "interactive" });
		expect(prompt).toContain("Tark agent profile: code");
		expect(prompt).toContain("Permission: read");
	});

	it("collects grouped RPC answers through a faux-provider tool call", async () => {
		const harness = await createHarness({ extensionFactories: [questions] });
		harnesses.push(harness);
		const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
		const editor = vi.fn(async (_title: string, prefill?: string) => `${prefill}\nanswer`);
		const confirm = vi.fn(async () => true);
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({ select, editor, confirm }),
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("askquestions", {
						questions: [
							{ question: "Pick", options: [{ id: "stable", label: "A" }] },
							{ question: "Text", type: "text", defaultValue: "initial" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Ask through RPC");
		expect(getToolResult(harness, "askquestions").details).toMatchObject({
			status: "answered",
			answers: [{ optionIds: ["stable"] }, { answer: "initial\nanswer" }],
		});
		expect(select).toHaveBeenCalledTimes(2);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("settles pending RPC editors on session shutdown without opening review", async () => {
		const harness = await createHarness({ extensionFactories: [questions] });
		harnesses.push(harness);
		const opened = Promise.withResolvers<void>();
		const late = Promise.withResolvers<string | undefined>();
		const editor = vi.fn(async () => {
			opened.resolve();
			return late.promise;
		});
		const select = vi.fn();
		await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext({ editor, select }) });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("askquestions", { questions: [{ question: "Text", type: "text" }] })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const prompt = harness.session.prompt("Ask through RPC");
		await opened.promise;
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await prompt;
		expect(getToolResult(harness, "askquestions").details).toMatchObject({ status: "aborted" });
		late.resolve("late answer");
		await Promise.resolve();
		expect(select).not.toHaveBeenCalled();
	});

	it.each(["json", "print"] as const)(
		"returns a structured %s question result instead of reading stdin",
		async (mode) => {
			const harness = await createHarness({ extensionFactories: [questions] });
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode, uiContext: createTestUiContext() });
			harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("askquestions", { questions: [{ question: "Which target?", type: "text" }] })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Need interactive input"),
			]);
			await harness.session.prompt("Ask a question");
			expect(getToolResult(harness, "askquestions").details).toMatchObject({ status: "requires_interaction" });
		},
	);

	it("blocks a protected read through the real tool lifecycle", async () => {
		const harness = await createHarness({ extensionFactories: [accessGuard] });
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, ".env"), "NEVER_EXPOSED=value");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: ".env" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Protected"),
		]);
		await harness.session.prompt("Read the config");
		const result = getToolResult(harness, "read");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("NEVER_EXPOSED");
	});
});
