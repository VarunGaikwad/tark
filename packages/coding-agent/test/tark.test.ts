// Offline coverage for Tark configuration, policies, delegation, resources, and questions.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir, getTarkInvocation, getTarkResourcesDir } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import { blockedBashReason, deniedPath } from "../src/extensions/tark/lib/access-policy.ts";
import {
	completeProjectAgentConfig,
	detectProfileIntent,
	hasProjectAgentConfig,
	initializeAgentConfig,
	loadAgentConfig,
	parseAgentConfig,
	routeSubagent,
	saveProjectAgentModel,
	subagentTools,
} from "../src/extensions/tark/lib/agents.ts";
import type { Result } from "../src/extensions/tark/lib/question-model.ts";
import { normalizeQuestions, validateAnswer } from "../src/extensions/tark/lib/question-model.ts";
import { QuestionScreen } from "../src/extensions/tark/lib/question-ui.ts";
import { readSetupSettings, saveSetupChoice, toolsToOffer } from "../src/extensions/tark/lib/recommended-tools.ts";
import { RepoCache } from "../src/extensions/tark/lib/repo-cache.ts";
import { readSoundSettings, saveSoundSettings } from "../src/extensions/tark/lib/sound.ts";
import { defaultSoundPreferences, SoundNotifications } from "../src/extensions/tark/lib/sound-events.ts";
import { runSubagent, subagentEnvironment } from "../src/extensions/tark/lib/subagent-runner.ts";
import {
	normalizeSubagentScope,
	SubagentScheduler,
	scopesConflict,
} from "../src/extensions/tark/lib/subagent-scheduler.ts";
import resources from "../src/extensions/tark/resources.ts";
import sound from "../src/extensions/tark/sound.ts";

let root: string;
let cwd: string;
let agentDir: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "tark-test-"));
	cwd = join(root, "project");
	agentDir = join(root, "user");
	await mkdir(join(cwd, ".tark"), { recursive: true });
	await mkdir(agentDir);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("Tark distribution", () => {
	it("uses independent config and delegates through the current installation", () => {
		expect(APP_NAME).toBe("tark");
		expect(CONFIG_DIR_NAME).toBe(".tark");
		expect(getAgentDir()).not.toContain(".pi/");
		const invocation = getTarkInvocation();
		expect(invocation.command).toBe(process.execPath);
		expect(invocation.args.at(-1)).toMatch(/cli\.(ts|js)$/);
	});
	it("ships built-in features without installing PieXis", async () => {
		const runtime = createExtensionRuntime();
		const registrations = new Set<string>();
		const commands = new Set<string>();
		for (const input of builtInExtensions) {
			if (typeof input === "function") continue;
			const extension = await loadExtensionFromFactory(
				input.factory,
				cwd,
				createEventBus(),
				runtime,
				`builtin:${input.name}`,
			);
			for (const name of extension.tools.keys()) registrations.add(name);
			for (const name of extension.commands.keys()) commands.add(name);
		}
		expect([...registrations]).toEqual(
			expect.arrayContaining(["askquestions", "subagent", "get_workspace_changes", "get_file_outline"]),
		);
		expect(registrations.has("AskQuestion")).toBe(false);
		expect(commands.has("setup-agents")).toBe(true);
		expect(commands.has("health")).toBe(false);
		expect(builtInExtensions).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "tark-health" })]));
	});
	it("respects resource disable flags without interpreting prompt text as flags", async () => {
		const extension = await loadExtensionFromFactory(resources, cwd, createEventBus(), createExtensionRuntime());
		const discover = extension.handlers.get("resources_discover")![0];
		const previous = process.argv;
		try {
			process.argv = [previous[0], "fixture", "--no-skills", "--no-prompt-templates", "--no-themes"];
			expect(await discover({ type: "resources_discover", cwd, reason: "startup" }, {} as ExtensionContext)).toEqual(
				{ skillPaths: [], promptPaths: [], themePaths: [] },
			);
			process.argv = [previous[0], "fixture", "--", "--no-skills"];
			expect(
				await discover({ type: "resources_discover", cwd, reason: "startup" }, {} as ExtensionContext),
			).toMatchObject({ skillPaths: [join(getTarkResourcesDir(), "skills")] });
		} finally {
			process.argv = previous;
		}
	});
	it("excludes proprietary document skills and audio", async () => {
		const resources = getTarkResourcesDir();
		for (const name of ["docx", "xlsx", "pptx", "pdf"])
			expect(existsSync(join(resources, "skills", name))).toBe(false);
		for (const name of ["agent-browser", "ponytail", "ui-ux-pro-max"])
			expect(existsSync(join(resources, "skills", name, "LICENSE"))).toBe(true);
		expect(await readFile(join(resources, "NOTICE.md"), "utf8")).toContain("eee741fa");
		expect(existsSync(join(resources, "audio"))).toBe(false);
	});
});

describe("agent configuration and routing", () => {
	it("requires trust even for a Tark-only settings project", async () => {
		await writeFile(join(cwd, ".tark", "settings.json"), '{"tark":{"auto_profile":true}}');
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		expect((await loadAgentConfig(cwd, agentDir, false)).auto_profile).toBeUndefined();
		expect((await loadAgentConfig(cwd, agentDir, true)).auto_profile).toBe(true);
	});
	it("merges profile overrides by field without changing global settings", async () => {
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "test",
				tark: {
					model: "test/main",
					subagent_variant_overrides: { code: { model: "test/code", effort: "high" } },
				},
			}),
		);
		await writeFile(
			join(cwd, ".tark", "settings.json"),
			JSON.stringify({
				tark: {
					subagent_variant_overrides: { code: { effort: "low" } },
				},
			}),
		);
		const config = await loadAgentConfig(cwd, agentDir, true);
		expect(config.subagent_variant_overrides?.code).toEqual({ model: "test/code", effort: "low" });
		expect((await loadAgentConfig(cwd, agentDir, false)).subagent_variant_overrides?.code).toEqual({
			model: "test/code",
			effort: "high",
		});
	});
	it.each([{ enabled: true, enableAiReview: true, enableRuff: true }, null, "obsolete", { mode: "invalid" }])(
		"ignores obsolete codeHealth settings without rewriting user files: %j",
		async (codeHealth) => {
			const globalPath = join(agentDir, "settings.json");
			const projectPath = join(cwd, ".tark", "settings.json");
			const globalText = JSON.stringify({ tark: { model: "test/main", codeHealth } });
			const projectText = JSON.stringify({ tark: { codeHealth } });
			await writeFile(globalPath, globalText);
			await writeFile(projectPath, projectText);
			expect(await hasProjectAgentConfig(cwd)).toBe(false);
			expect(await loadAgentConfig(cwd, agentDir, true)).toEqual({
				model: "test/main",
				subagent_variant_overrides: {},
			});
			expect(await readFile(globalPath, "utf8")).toBe(globalText);
			expect(await readFile(projectPath, "utf8")).toBe(projectText);
		},
	);
	it("creates a scaffold once and completes only missing settings", async () => {
		expect(await initializeAgentConfig(cwd, agentDir, "test/main")).toBe(true);
		expect(await initializeAgentConfig(cwd, agentDir, "test/other")).toBe(false);
		expect(await completeProjectAgentConfig(cwd, agentDir, "test/other")).toBe("complete");
		const config = await loadAgentConfig(cwd, agentDir, true);
		expect(config.model).toBe("test/main");
		expect(config.auto_profile).toBe(false);
		expect(config).not.toHaveProperty("codeHealth");
		expect(JSON.parse(await readFile(join(cwd, ".tark", "settings.json"), "utf8")).tark).not.toHaveProperty(
			"codeHealth",
		);
		expect(config).not.toHaveProperty("delegate_exploration");
		expect(JSON.parse(await readFile(join(cwd, ".tark", "settings.json"), "utf8")).tark).not.toHaveProperty(
			"delegate_exploration",
		);
	});
	it("preserves settings and setup preferences when initializing and completing", async () => {
		const path = join(cwd, ".tark", "settings.json");
		await writeFile(
			path,
			`\uFEFF${JSON.stringify({
				$schema: "custom-settings-schema",
				theme: "orange",
				defaultTools: ["+grep"],
				tark: { recommendedTools: "enabled", agentSetup: "enabled", sound: { enabled: false } },
			})}`,
		);
		expect(await hasProjectAgentConfig(cwd)).toBe(false);
		expect(await initializeAgentConfig(cwd, agentDir, "test/main")).toBe(true);
		const initialized = JSON.parse(await readFile(path, "utf8"));
		expect(initialized).toMatchObject({
			$schema: "custom-settings-schema",
			theme: "orange",
			defaultTools: ["+grep"],
			tark: { model: "test/main", recommendedTools: "enabled", agentSetup: "enabled", sound: { enabled: false } },
		});
		expect(initialized.tark.$schema).toBeUndefined();
		expect(existsSync(join(cwd, ".tark", "agent.json"))).toBe(false);
		expect(await hasProjectAgentConfig(cwd)).toBe(true);
		await writeFile(
			path,
			JSON.stringify({
				...initialized,
				tark: {
					recommendedTools: "disabled",
					auto_profile: true,
					subagent_variant_overrides: { code: { effort: "max" } },
				},
			}),
		);
		expect(await initializeAgentConfig(cwd, agentDir, "test/other")).toBe(false);
		expect(await completeProjectAgentConfig(cwd, agentDir, "test/other")).toBe("updated");
		const completed = JSON.parse(await readFile(path, "utf8"));
		expect(completed).toMatchObject({
			theme: "orange",
			tark: {
				recommendedTools: "disabled",
				auto_profile: true,
				subagent_variant_overrides: { code: { model: "test/other", effort: "max" } },
			},
		});
		expect(await completeProjectAgentConfig(cwd, agentDir, "test/main")).toBe("complete");
	});
	it("saves only the selected profile model and preserves permissions and inherited effort", async () => {
		const path = join(cwd, ".tark", "settings.json");
		const original = {
			theme: "orange",
			tark: {
				agentSetup: "disabled",
				model: "test/main",
				sound: { enabled: false },
				subagent_variant_overrides: { code: { effort: "max" }, plan: { model: "test/plan" } },
			},
		};
		await writeFile(path, `\uFEFF${JSON.stringify(original)}`);
		await chmod(path, 0o640);
		await writeFile(
			join(agentDir, "settings.json"),
			'{"tark":{"subagent_variant_overrides":{"ask":{"effort":"low"}}}}',
		);
		await saveProjectAgentModel(cwd, agentDir, "code", "test/new/model");
		await saveProjectAgentModel(cwd, agentDir, "ask", "test/ask");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			...original,
			tark: {
				...original.tark,
				subagent_variant_overrides: {
					code: { model: "test/new/model", effort: "max" },
					plan: { model: "test/plan" },
					ask: { model: "test/ask" },
				},
			},
		});
		expect((await stat(path)).mode & 0o777).toBe(0o640);
		expect((await loadAgentConfig(cwd, agentDir, true)).subagent_variant_overrides?.ask).toEqual({
			model: "test/ask",
			effort: "low",
		});
		expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe(
			'{"tark":{"subagent_variant_overrides":{"ask":{"effort":"low"}}}}',
		);
		const saved = await readFile(path, "utf8");
		await expect(saveProjectAgentModel(cwd, agentDir, "code", "invalid")).rejects.toThrow("provider/model");
		expect(await readFile(path, "utf8")).toBe(saved);
	});
	it("ignores separate agent files and top-level agent keys", async () => {
		await writeFile(join(agentDir, "agent.json"), '{"model":"test/old"}');
		await writeFile(join(cwd, ".tark", "agents.json"), '{"auto_profile":true}');
		await writeFile(join(agentDir, "settings.json"), '{"model":"test/not-tark","theme":"orange"}');
		expect(await hasProjectAgentConfig(cwd)).toBe(false);
		expect(await loadAgentConfig(cwd, agentDir, true)).toEqual({ subagent_variant_overrides: {} });
	});
	it("does not read untrusted malformed settings or overwrite invalid project settings", async () => {
		const path = join(cwd, ".tark", "settings.json");
		await writeFile(path, '{"tark":{"auto_profile":"yes"}}');
		expect(await loadAgentConfig(cwd, agentDir, false)).toEqual({ subagent_variant_overrides: {} });
		await expect(loadAgentConfig(cwd, agentDir, true)).rejects.toThrow("settings.json");
		await expect(completeProjectAgentConfig(cwd, agentDir, "test/main")).rejects.toThrow("boolean");
		await expect(saveProjectAgentModel(cwd, agentDir, "code", "test/main")).rejects.toThrow("boolean");
		expect(await readFile(path, "utf8")).toBe('{"tark":{"auto_profile":"yes"}}');
		await writeFile(path, "not json");
		await expect(initializeAgentConfig(cwd, agentDir, "test/main")).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("not json");
	});
	it("honors settings locks and refuses symlinks and aliases of global settings", async () => {
		const path = join(cwd, ".tark", "settings.json");
		await mkdir(`${path}.lock`);
		await expect(initializeAgentConfig(cwd, agentDir, "test/main")).rejects.toThrow();
		await expect(saveProjectAgentModel(cwd, agentDir, "code", "test/main")).rejects.toThrow();
		expect(existsSync(`${path}.lock`)).toBe(true);
		await rm(`${path}.lock`, { recursive: true });
		await writeFile(join(agentDir, "settings.json"), '{"theme":"orange"}');
		await symlink(join(agentDir, "settings.json"), path);
		await expect(completeProjectAgentConfig(cwd, agentDir, "test/main")).rejects.toThrow("regular settings");
		await expect(saveProjectAgentModel(cwd, agentDir, "code", "test/main")).rejects.toThrow("regular settings");
		await rm(join(cwd, ".tark"), { recursive: true });
		await symlink(agentDir, join(cwd, ".tark"), "dir");
		await expect(initializeAgentConfig(cwd, agentDir, "test/main")).rejects.toThrow("share a path");
		await expect(saveProjectAgentModel(cwd, agentDir, "code", "test/main")).rejects.toThrow("share a path");
		expect(await readFile(join(agentDir, "settings.json"), "utf8")).toBe('{"theme":"orange"}');
	});
	it("rejects malformed configuration rather than silently changing providers", () => {
		for (const input of [
			{ model: "bare" },
			{ auto_profile: "yes" },
			{ subagent_variant_overrides: { code: { effort: "huge" } } },
		])
			expect(() => parseAgentConfig(input)).toThrow();
	});
	it.each([
		["Plan the migration", "plan"],
		["Explain how to implement login", "ask"],
		["Execute", "code"],
		["Debug this crash", "debug"],
		["Delegate these tasks", "orchestrator"],
		["Do not implement this", undefined],
		["`build` is a command", undefined],
		["Plan and then implement", undefined],
	])("routes outer request %s", (text, expected) => {
		expect(detectProfileIntent(text)).toBe(expected);
	});
	it("uses the small model only for eligible tasks and makes explore read-only", () => {
		const config = { small_model: "test/small" };
		expect(routeSubagent(config, "ask", "Locate the loader", "test/main", "high").model).toBe("test/small");
		expect(routeSubagent(config, "debug", "Investigate security", "test/main", "high").model).toBe("test/main");
		expect(subagentTools("ask", ["read", "bash", "edit", "subagent"], 1, true)).toEqual(["read", "bash"]);
	});
	it("routes exploration without setup and ignores obsolete top-level settings", async () => {
		expect(routeSubagent({}, "ask", "Explore multiple files", "test/main", "high", true)).toEqual({
			model: "test/main",
			effort: "low",
			reason: "exploration current model",
		});
		await writeFile(join(agentDir, "settings.json"), '{"tark":{"delegate_exploration":false,"obsolete":true}}');
		const config = await loadAgentConfig(cwd, agentDir, true);
		expect(config).toEqual({ subagent_variant_overrides: {} });
		expect(routeSubagent(config, "ask", "Explore", "test/main", "high", true).model).toBe("test/main");
	});
	it("keeps exploration routing separate from normal variant overrides", () => {
		const config = parseAgentConfig({
			small_model: "test/small",
			subagent_model: "test/delegated",
			subagent_variant_overrides: { ask: { model: "test/ask", effort: "high" } },
		});
		expect(routeSubagent(config, "ask", "Explore", "test/main", "medium", true)).toEqual({
			model: "test/small",
			effort: "low",
			reason: "configured exploration small model",
		});
		expect(routeSubagent(config, "ask", "Locate the loader", "test/main", "medium")).toEqual({
			model: "test/ask",
			effort: "high",
			reason: "variant override",
		});
		delete config.small_model;
		expect(routeSubagent(config, "ask", "Explore", "test/main", "medium", true).model).toBe("test/main");
	});
	it.each(["code", "debug", "orchestrator"] as const)("excludes interactive questions from %s children", (agent) => {
		expect(subagentTools(agent, ["read", "askquestions", "subagent"], 1)).toEqual(["read", "subagent"]);
		expect(subagentTools(agent, ["read", "askquestions", "subagent"], 2)).toEqual(["read"]);
	});
	it.each(["ask", "plan"] as const)("allows nested read-only exploration for %s within the depth cap", (agent) => {
		const active = [
			"read",
			"grep",
			"find",
			"ls",
			"bash",
			"run_checks",
			"edit",
			"write",
			"askquestions",
			"mcp__write",
			"subagent",
		];
		expect(subagentTools(agent, active, 1)).toEqual(["read", "grep", "find", "ls", "bash", "run_checks", "subagent"]);
		expect(subagentTools(agent, active, 2)).toEqual(["read", "grep", "find", "ls", "bash", "run_checks"]);
		expect(subagentTools(agent, active, 1, true)).toEqual(["read", "grep", "find", "ls", "bash", "run_checks"]);
		expect(subagentTools(agent, ["read"], 1)).toEqual(["read"]);
	});
});

describe("file access policy", () => {
	it("allows external documentation but denies external writes and environment files", async () => {
		await writeFile(join(root, "readme.md"), "docs");
		expect(await deniedPath(cwd, "../readme.md", "read")).toBeUndefined();
		expect(await deniedPath(cwd, "../readme.md", "write")).toContain("outside");
		expect(await deniedPath(cwd, ".env.local", "read")).toContain("protected");
	});
	it("protects existing and nonexistent symlink targets", async () => {
		await mkdir(join(root, "outside"));
		await symlink(join(root, "outside"), join(cwd, "link"), "dir");
		expect(await deniedPath(cwd, "link/new/deep.txt", "write")).toContain("symlink");
		await symlink(join(root, "missing.txt"), join(cwd, "dangling.txt"));
		expect(await deniedPath(cwd, "dangling.txt", "write")).toContain("symlink");
		await symlink(join(root, "missing-directory"), join(cwd, "dangling-dir"), "dir");
		expect(await deniedPath(cwd, "dangling-dir/new.txt", "write")).toContain("symlink");
		await writeFile(join(cwd, ".env"), "secret");
		await symlink(join(cwd, ".env"), join(cwd, "public.txt"));
		expect(await deniedPath(cwd, "public.txt", "read")).toContain("protected");
	});
	it("honors ignore directory patterns, character classes, and negation", async () => {
		await writeFile(join(cwd, ".gitignore"), "ignored/\nfile[0-9].txt\n*.log\n!important.log\n");
		await mkdir(join(cwd, "ignored"));
		expect(await deniedPath(cwd, "ignored/new.txt", "read")).toContain("gitignore");
		expect(await deniedPath(cwd, "file1.txt", "write")).toContain("gitignore");
		expect(await deniedPath(cwd, "important.log", "read")).toBeUndefined();
	});
	it("does not reject ordinary shell variables or strict mode", () => {
		expect(blockedBashReason('set -e; file=README.md; printf "%s" "$file"')).toBeUndefined();
		expect(blockedBashReason("printenv")).toBeDefined();
		expect(blockedBashReason("env")).toBeDefined();
	});
});

describe("subagent scopes and scheduling", () => {
	it("rejects escaping paths and serializes broad or overlapping writes", async () => {
		await expect(normalizeSubagentScope(cwd, { paths: ["../escape"] })).rejects.toThrow();
		const a = await normalizeSubagentScope(cwd, { paths: ["src"] });
		const b = await normalizeSubagentScope(cwd, { paths: ["src/a.ts"] });
		const broad = await normalizeSubagentScope(cwd, { paths: [".tark/settings.json"] });
		expect(scopesConflict(a, b)).toBe(true);
		expect(broad.broad).toBe(true);
		expect(scopesConflict(a, await normalizeSubagentScope(cwd, { mode: "read" }))).toBe(false);
	});
	it("runs two independent jobs but aborts queued work without running it", async () => {
		const scheduler = new SubagentScheduler();
		const scope = await normalizeSubagentScope(cwd, { mode: "read" });
		const releases: Array<() => void> = [];
		const run = () =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			});
		const a = scheduler.schedule({ scope, controller: new AbortController(), run });
		const b = scheduler.schedule({ scope, controller: new AbortController(), run });
		const controller = new AbortController();
		let ran = false;
		const queued = scheduler.schedule({
			scope,
			controller,
			run: async () => {
				ran = true;
			},
		});
		const rejected = expect(queued).rejects.toBeDefined();
		controller.abort();
		await rejected;
		expect(releases).toHaveLength(2);
		expect(ran).toBe(false);
		releases.forEach((release) => {
			release();
		});
		await Promise.all([a, b]);
		await scheduler.shutdown();
		expect(scheduler.size).toBe(0);
	});
	it("parses child JSON and aggregates usage without a real provider", async () => {
		const script = join(root, "child.mjs");
		await writeFile(
			script,
			`for await (const chunk of process.stdin) {}\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'verified'}],stopReason:'stop',usage:{input:3,output:2,cost:{total:0.01}}}}));`,
		);
		const result = await runSubagent({
			invocation: { command: process.execPath, args: [script] },
			args: [],
			cwd,
			depth: 1,
			task: "offline fixture",
			signal: new AbortController().signal,
		});
		expect(result.output).toBe("verified");
		expect(result.usage.input).toBe(3);
		expect(result.usage.cost.total).toBe(0.01);
		expect(subagentEnvironment(1).HOME).toBe(process.env.HOME);
	});
	it("cancels an active child", async () => {
		const script = join(root, "waiting.mjs");
		await writeFile(script, "setInterval(() => {}, 1000);");
		const controller = new AbortController();
		const job = runSubagent({
			invocation: { command: process.execPath, args: [script] },
			args: [],
			cwd,
			depth: 1,
			task: "wait",
			signal: controller.signal,
		});
		const rejected = expect(job).rejects.toThrow("aborted");
		controller.abort();
		await rejected;
	});
});

describe("questions", () => {
	it("validates multi-select counts and Unicode text length", () => {
		const [question] = normalizeQuestions({
			questions: [{ question: "Pick", type: "multi", options: [{ label: "a" }, { label: "b" }], minSelections: 2 }],
		});
		expect(() => validateAnswer(question, { indices: [0], custom: false, text: "" })).toThrow();
		expect(validateAnswer(question, { indices: [0, 1], custom: false, text: "" }).optionIds).toHaveLength(2);
		const [text] = normalizeQuestions({ questions: [{ question: "Text", type: "text", maxLength: 1 }] });
		expect(validateAnswer(text, { indices: [], custom: true, text: "😀" }).answer).toBe("😀");
	});
	it("uses remapped keys and cleans up listeners on cancellation", () => {
		const stream = new EventEmitter();
		const keys = new KeybindingsManager({ "tui.select.cancel": "ctrl+x" });
		let result: Result | undefined;
		const screen = new QuestionScreen(
			normalizeQuestions({ questions: [{ question: "Pick", options: [{ label: "a" }] }] }),
			{ requestRender() {}, terminal: { rows: 24 } } as ConstructorParameters<typeof QuestionScreen>[1],
			{ fg: (_color, text) => text },
			(value) => {
				result = value;
			},
			keys,
			undefined,
			stream,
		);
		screen.handleInput("\x03");
		expect(result).toBeUndefined();
		screen.handleInput("\x18");
		expect(result?.status).toBe("cancelled");
		expect(stream.listenerCount("end")).toBe(0);
	});
});

describe("sound settings", () => {
	beforeEach(() => vi.stubEnv("TARK_SUBAGENT_DEPTH", "0"));
	afterEach(() => vi.unstubAllEnvs());
	it("stores preferences under tark.sound without replacing other settings", async () => {
		const path = join(agentDir, "settings.json");
		const original = { $schema: "custom", theme: "orange", tark: { model: "test/main", agentSetup: "disabled" } };
		await writeFile(path, `\uFEFF${JSON.stringify(original)}`);
		await chmod(path, 0o640);
		const previous = await readSoundSettings(agentDir);
		expect(previous.configured).toBe(false);
		const preferences = { ...defaultSoundPreferences(), enabled: true };
		const saved = await saveSoundSettings(agentDir, previous, preferences);
		expect(saved.configured).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			...original,
			tark: { ...original.tark, sound: preferences },
		});
		expect((await stat(path)).mode & 0o777).toBe(0o640);
		expect((await readSoundSettings(agentDir)).preferences).toEqual(preferences);
		expect(existsSync(join(agentDir, "tark-sound.json"))).toBe(false);
		expect((await loadAgentConfig(cwd, agentDir, true)).model).toBe("test/main");
	});
	it("ignores old files and project sound settings, and resolves partial user settings", async () => {
		await writeFile(
			join(agentDir, "tark-sound.json"),
			JSON.stringify({ ...defaultSoundPreferences(), enabled: true }),
		);
		await writeFile(join(cwd, ".tark", "settings.json"), '{"tark":{"sound":{"enabled":true}}}');
		expect((await readSoundSettings(agentDir)).preferences.enabled).toBe(false);
		expect(await hasProjectAgentConfig(cwd)).toBe(false);
		await writeFile(
			join(agentDir, "settings.json"),
			'{"tark":{"sound":{"enabled":true,"events":{"failure":false}}}}',
		);
		expect((await readSoundSettings(agentDir)).preferences).toEqual({
			enabled: true,
			events: { attention: true, finished: true, failure: false },
			minimumDurationMs: 5000,
		});
	});
	it("rejects stale writes, cancellation, existing locks, malformed settings, and symlinks", async () => {
		const path = join(agentDir, "settings.json");
		const preferences = defaultSoundPreferences();
		const previous = await readSoundSettings(agentDir);
		await writeFile(path, '{"theme":"orange"}');
		await expect(saveSoundSettings(agentDir, previous, preferences)).rejects.toThrow("changed");
		expect(await readFile(path, "utf8")).toBe('{"theme":"orange"}');
		const current = await readSoundSettings(agentDir);
		await expect(saveSoundSettings(agentDir, current, preferences, AbortSignal.abort())).rejects.toThrow();
		await mkdir(`${path}.lock`);
		await expect(saveSoundSettings(agentDir, current, preferences)).rejects.toThrow();
		expect(existsSync(`${path}.lock`)).toBe(true);
		await rm(`${path}.lock`, { recursive: true });
		for (const text of [
			"not json",
			"[]",
			'{"tark":null}',
			'{"tark":{"sound":{"enabled":"yes"}}}',
			'{"tark":{"sound":{"events":null}}}',
		]) {
			await writeFile(path, text);
			await expect(readSoundSettings(agentDir)).rejects.toThrow();
			await expect(saveSoundSettings(agentDir, current, preferences)).rejects.toThrow();
			expect(await readFile(path, "utf8")).toBe(text);
		}
		await rm(path);
		const target = join(root, "settings.json");
		await writeFile(target, "{}");
		await symlink(target, path);
		await expect(readSoundSettings(agentDir)).rejects.toThrow("regular file");
		await expect(saveSoundSettings(agentDir, current, preferences)).rejects.toThrow("regular file");
		expect(await readFile(target, "utf8")).toBe("{}");
	});
	it("offers sound setup with existing settings, persists opt-out, and keeps commands working", async () => {
		await writeFile(join(agentDir, "settings.json"), '{"theme":"orange"}');
		const player = {
			play: vi.fn(async () => true),
			stop: vi.fn(),
			status: vi.fn(async () => "test player"),
			lastError: undefined,
		};
		const extension = await loadExtensionFromFactory(
			(pi) => sound(pi, { agentDir, player, terminal: () => true }),
			cwd,
			createEventBus(),
			createExtensionRuntime(),
		);
		const select = vi.fn(async () => "No");
		const notify = vi.fn();
		const ctx = {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: { select, notify },
			hasPendingMessages: () => false,
		} as unknown as ExtensionCommandContext;
		const start = extension.handlers.get("session_start")![0];
		await start({ type: "session_start", reason: "startup" }, ctx);
		expect(select).toHaveBeenCalledTimes(1);
		expect((await readSoundSettings(agentDir)).configured).toBe(true);
		expect((await readSoundSettings(agentDir)).preferences.enabled).toBe(false);
		await start({ type: "session_start", reason: "reload" }, ctx);
		expect(select).toHaveBeenCalledTimes(1);
		const command = extension.commands.get("sound")!;
		await command.handler("on", ctx);
		expect((await readSoundSettings(agentDir)).preferences.enabled).toBe(true);
		await command.handler("test failure", ctx);
		expect(player.play).toHaveBeenCalledWith("failure", true);
		await command.handler("off", ctx);
		expect((await readSoundSettings(agentDir)).preferences.enabled).toBe(false);
		expect(player.stop).toHaveBeenCalled();
		expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).theme).toBe("orange");
	});
	it("does not prompt when sound is configured or when running noninteractively", async () => {
		await writeFile(join(agentDir, "settings.json"), '{"tark":{"sound":{"enabled":false}}}');
		const extension = await loadExtensionFromFactory(
			(pi) => sound(pi, { agentDir, terminal: () => true }),
			cwd,
			createEventBus(),
			createExtensionRuntime(),
		);
		const select = vi.fn();
		const ctx = { cwd, mode: "tui", hasUI: true, ui: { select, notify: vi.fn() } } as unknown as ExtensionContext;
		const start = extension.handlers.get("session_start")![0];
		await start({ type: "session_start", reason: "startup" }, ctx);
		expect(select).not.toHaveBeenCalled();
		await rm(join(agentDir, "settings.json"));
		for (const mode of ["rpc", "json", "print"] as const) {
			await start({ type: "session_start", reason: "startup" }, { ...ctx, mode });
		}
		expect(select).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});
});

describe("setup, caching, and sound", () => {
	it("saves project-only additive tool preferences and detects prompt-time changes", async () => {
		let snapshot = await readSetupSettings(cwd, agentDir);
		await saveSetupChoice(snapshot, "enabled", ["grep"], true);
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		snapshot = await readSetupSettings(cwd, agentDir);
		expect(snapshot.project.settings.defaultTools).toEqual(["+grep"]);
		await writeFile(snapshot.projectPath, '{"userChange":true}');
		await expect(saveSetupChoice(snapshot, "enabled", ["find"], true)).rejects.toThrow("changed");
	});
	it("does not expand an explicit empty tool allowlist", async () => {
		await writeFile(join(cwd, ".tark", "settings.json"), '{"defaultTools":[]}');
		expect(toolsToOffer(await readSetupSettings(cwd, agentDir), ["grep"], [], true)).toEqual([]);
	});
	it("reuses unchanged outlines and refreshes edited files, excluding secrets", async () => {
		execFileSync("git", ["init", "--quiet", cwd]);
		await writeFile(join(cwd, "file.ts"), "export const answer = 1;\n");
		await writeFile(join(cwd, ".env"), "SECRET=never-index");
		await writeFile(join(cwd, ".npmrc"), "token=never-index");
		const cache = await RepoCache.open(cwd, { cacheDir: join(root, "cache"), watch: false });
		try {
			const first = await cache.summary("file.ts");
			const hashes = cache.metrics.hashes;
			expect((await cache.summary("file.ts")).hash).toBe(first.hash);
			expect(cache.metrics.hashes).toBe(hashes);
			await writeFile(join(cwd, "file.ts"), "export const answer = 200;\n");
			expect((await cache.summary("file.ts")).hash).not.toBe(first.hash);
			expect(cache.files.has(".env")).toBe(false);
			expect(cache.files.has(".npmrc")).toBe(false);
		} finally {
			await cache.close();
		}
	});
	it("defaults to silent sound and waits for final settlement", () => {
		expect(defaultSoundPreferences().enabled).toBe(false);
		const notifications = new SoundNotifications();
		notifications.accept({ type: "agent_start" }, 5000, 0);
		expect(notifications.accept({ type: "agent_end" }, 5000, 7000)).toBeUndefined();
		expect(notifications.accept({ type: "agent_settled" }, 5000, 7000)).toBe("finished");
		expect(notifications.accept({ type: "agent_settled" }, 5000, 8000)).toBeUndefined();
	});
});
