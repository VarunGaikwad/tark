import { fuzzyFilter, Input, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { z } from "zod";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getTarkInvocation,
	KeybindingsManager,
} from "./host.ts";
import {
	type AgentConfig,
	type AgentName,
	agentNames,
	childResourceArgs,
	completeProjectAgentConfig,
	type Effort,
	isAgentName,
	loadAgentConfig,
	profiles,
	routeSubagent,
	saveProjectAgentModel,
	subagentTools,
} from "./lib/agents.ts";
import { limitOutput, runSubagent } from "./lib/subagent-runner.ts";
import { normalizeSubagentScope, type SchedulerStatus, SubagentScheduler } from "./lib/subagent-scheduler.ts";
import { installWorkflow } from "./workflow.ts";

const AgentSchema = Type.Union(agentNames.map((name) => Type.Literal(name)));
const parameters = Type.Object({
	agent: AgentSchema,
	purpose: Type.Optional(
		Type.Literal("explore", {
			description:
				"Use ask for read-only codebase exploration with small_model when configured, otherwise the current model.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("read"), Type.Literal("write")], {
			description:
				"Declared work mode. Defaults to write except plan/ask and exploration. Phase 1 rejects write delegation after validating approval and exact scope.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Explicit repository-relative paths; writes must exactly match the approved task allowed_paths. Phase 1 does not execute builders.",
		}),
	),
	task_id: Type.Optional(
		Type.String({ minLength: 1, description: "Exact approved plan task ID; required for requested writes." }),
	),
	task: Type.String({
		minLength: 1,
		maxLength: 50_000,
		description: "Self-contained task including needed context; conversation history is not inherited.",
	}),
});
const stateType = "tark-agent";
const profileChoices = [...agentNames, "auto"];

export default function agentsExtension(pi: ExtensionAPI) {
	let active: AgentName = "code";
	let pinned = false;
	let activationOrigin: "manual" | "automatic" | undefined;
	let switching = false;
	let configuring = false;
	let startupHandled = false;
	const depthText = process.env.TARK_SUBAGENT_DEPTH ?? "0";
	const depth = /^[0-2]$/.test(depthText) ? Number(depthText) : 2;
	const jobs = new Map<AbortController, Promise<unknown>>();
	let scheduler = new SubagentScheduler();
	const childStatuses = new Map<AbortController, { agent: AgentName; status: "queued" | "running" }>();

	function childStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const groups = (["running", "queued"] as const)
			.map((state) => {
				const names = [...childStatuses.values()].filter((job) => job.status === state).map((job) => job.agent);
				return names.length ? `${names.length} ${state}: ${names.join(", ")}` : "";
			})
			.filter(Boolean);
		ctx.ui.setStatus("tark-subagents", groups.length ? `subagents · ${groups.join(" · ")}` : undefined);
	}
	// Inherited scope crosses the child-process environment boundary.
	const inheritedScope = process.env.TARK_SUBAGENT_SCOPE
		? z
				.object({ mode: z.enum(["read", "write"]), paths: z.array(z.string()) })
				.parse(JSON.parse(process.env.TARK_SUBAGENT_SCOPE))
		: undefined;

	const workflow = installWorkflow(pi, {
		agent: () => active,
		restoreAgent: restore,
		canSwitch,
		canApprove: depth === 0 && inheritedScope?.mode !== "read",
		activateCode: (ctx) => activate("code", ctx, "manual"),
		status,
	});

	pi.registerFlag("agent", { description: `Agent profile: ${agentNames.join(", ")}`, type: "string" });

	function status(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("tark-agent", `${active} · ${workflow.permission()}`);
		ctx.ui.setStatus("tark-agent-mode", "");
	}

	function persist() {
		pi.appendEntry(stateType, { agent: active, origin: activationOrigin, pinned });
	}

	function canSwitch(ctx: ExtensionContext) {
		return !switching && !configuring && ctx.isIdle() && jobs.size === 0;
	}

	async function activate(
		name: AgentName,
		ctx: ExtensionContext,
		origin: "manual" | "automatic",
		config?: AgentConfig,
	): Promise<boolean> {
		if (!canSwitch(ctx)) {
			ctx.ui.notify("Wait for the current agent to finish before switching profiles.", "warning");
			return false;
		}
		switching = true;
		const previousModel = ctx.model;
		const previousEffort = (ctx.thinkingLevel ?? pi.getThinkingLevel()) as Effort;
		const previousState = { active, activationOrigin, pinned };
		let modelChanged = false;
		let effortChanged = false;
		try {
			config ??= await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
			const override = config.subagent_variant_overrides?.[name];
			const modelId = override?.model ?? config.model;
			if (modelId) {
				const slash = modelId.indexOf("/");
				const model = ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
				if (!model || !(await pi.setModel(model)))
					throw new Error(`Configured model unavailable: ${modelId}. Check /model and /login.`);
				modelChanged = true;
			}
			if (override?.effort !== undefined) {
				effortChanged = true;
				pi.setThinkingLevel(override.effort);
			}
			active = name;
			activationOrigin = origin;
			pinned = origin === "manual";
			persist();
			status(ctx);
			if (origin === "manual" || name !== previousState.active) {
				ctx.ui.notify(`Agent: ${active}${origin === "automatic" ? " (automatic)" : ""}`, "info");
			}
			return true;
		} catch (error) {
			// setModel can succeed before a later setting throws; keep a failed route atomic.
			active = previousState.active;
			activationOrigin = previousState.activationOrigin;
			pinned = previousState.pinned;
			try {
				if (modelChanged && previousModel && !(await pi.setModel(previousModel)))
					throw new Error("Previous model unavailable");
				if (modelChanged || effortChanged) pi.setThinkingLevel(previousEffort);
			} catch (rollbackError) {
				ctx.ui.notify(
					`Agents: could not restore previous settings: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					"warning",
				);
			}
			ctx.ui.notify(`Agents: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		} finally {
			switching = false;
		}
	}

	function restore(ctx: ExtensionContext) {
		active = "code";
		pinned = false;
		activationOrigin = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== stateType) continue;
			const data = entry.data as { agent?: unknown; origin?: unknown; pinned?: unknown } | undefined;
			if (!isAgentName(data?.agent)) continue;
			active = data.agent;
			activationOrigin = data.origin === "automatic" ? "automatic" : "manual";
			pinned = typeof data.pinned === "boolean" ? data.pinned : true;
		}
		status(ctx);
	}

	pi.on("session_start", async (event, ctx) => {
		if (jobs.size === 0) scheduler = new SubagentScheduler();
		restore(ctx);
		childStatus(ctx);
		if (!startupHandled && (!event.reason || event.reason === "startup")) {
			const flag = pi.getFlag("agent");
			if (isAgentName(flag)) {
				active = flag;
				activationOrigin = "manual";
				// Child processes receive --agent as their fixed role; only main branches persist a pin.
				if (depth === 0) {
					pinned = true;
					persist();
				}
			} else if (flag !== undefined && flag !== "")
				ctx.ui.notify(`Unknown agent: ${flag}. Choose ${agentNames.join(", ")}.`, "warning");
		}
		startupHandled = true;
		status(ctx);
		if (depth >= 2) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "subagent"));
		// Only initialize a new main session; explicit CLI choices and resumed models remain authoritative.
		if (
			depth !== 0 ||
			(event.reason && event.reason !== "startup" && event.reason !== "new") ||
			ctx.sessionManager.getBranch().some((entry) => entry.type === "message")
		)
			return;
		const args = process.argv
			.slice(2)
			.slice(0, process.argv.indexOf("--") < 0 ? undefined : process.argv.indexOf("--") - 2);
		const explicitModel = args.some((arg) => /^(?:--model|--models|--provider)(?:=|$)/.test(arg));
		try {
			const config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
			const override = isAgentName(pi.getFlag("agent")) ? config.subagent_variant_overrides?.[active] : undefined;
			const modelId = override?.model ?? config.model;
			if (modelId && !explicitModel) {
				const slash = modelId.indexOf("/");
				const model = ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
				if (!model || !(await pi.setModel(model))) throw new Error(`Configured model unavailable: ${modelId}`);
			}
			if (override?.effort && !args.some((arg) => /^--thinking(?:=|$)/.test(arg)))
				pi.setThinkingLevel(override.effort);
		} catch (error) {
			ctx.ui.notify(`Agents: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("input", (_event, ctx) => {
		if (configuring) {
			ctx.ui.notify("Finish agent setup before submitting a request.", "warning");
			return { action: "handled" as const };
		}
		return { action: "continue" as const };
	});

	pi.registerCommand("setup-agents", {
		description: "Choose per-profile models in project settings; use defaults to fill missing settings",
		getArgumentCompletions: (prefix) =>
			"defaults".startsWith(prefix)
				? [{ value: "defaults", label: "defaults — fill missing project settings" }]
				: null,
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action && action !== "defaults") {
				ctx.ui.notify(
					"Use /setup-agents for the model menu or /setup-agents defaults to fill missing settings.",
					"warning",
				);
				return;
			}
			if (!action && (ctx.mode !== "tui" || !ctx.hasUI || depth > 0)) {
				ctx.ui.notify(
					"The agent model menu requires an interactive terminal. Use /setup-agents defaults for defaults.",
					"warning",
				);
				return;
			}
			if (!canSwitch(ctx)) {
				ctx.ui.notify("Wait for the current agent and subagents to finish before configuring models.", "warning");
				return;
			}
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Agent configuration is available only in trusted projects.", "warning");
				return;
			}
			configuring = true;
			try {
				const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				if (!action) {
					const config = await loadAgentConfig(ctx.cwd, getAgentDir(), true);
					const choices = agentNames.map((name) => {
						const override = config.subagent_variant_overrides?.[name]?.model;
						return `${name} · ${override ?? `${config.model ?? currentModel ?? "current model"} (inherited)`}`;
					});
					const choice = await ctx.ui.select("Agent models — save to .tark/settings.json", choices);
					if (!choice) return;
					const name = agentNames[choices.indexOf(choice)];
					const available = ctx.modelRegistry.getAvailable();
					if (!available.length)
						throw new Error("No authenticated models available. Use /login and /model first.");
					const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
						const header = new Text(theme.fg("accent", `${name} model — .tark/settings.json`), 0, 0);
						const input = new Input();
						const hint = new Text(
							theme.fg(
								"dim",
								`Type to search · ${keys.getKeys("tui.select.confirm").join("/")} save · ${keys.getKeys("tui.select.cancel").join("/")} cancel`,
							),
							0,
							0,
						);
						const items = available.map((model) => ({
							value: `${model.provider}/${model.id}`,
							label: `${model.provider}/${model.id}`,
							description: model.name,
						}));
						const listTheme = {
							selectedPrefix: (text: string) => theme.fg("accent", text),
							selectedText: (text: string) => theme.fg("accent", text),
							description: (text: string) => theme.fg("muted", text),
							scrollInfo: (text: string) => theme.fg("dim", text),
							noMatch: () => theme.fg("warning", "No matching models"),
						};
						let list = new SelectList(items, 10, listTheme);
						list.setSelectedIndex(
							items.findIndex(
								(item) =>
									item.value ===
									(config.subagent_variant_overrides?.[name]?.model ?? config.model ?? currentModel),
							),
						);
						return {
							capturesViewportInput: true,
							get focused() {
								return input.focused;
							},
							set focused(value: boolean) {
								input.focused = value;
							},
							render: (width) => [
								...header.render(width),
								"",
								...input.render(width),
								"",
								...list.render(width),
								"",
								...hint.render(width),
							],
							invalidate() {
								header.invalidate();
								input.invalidate();
								list.invalidate();
								hint.invalidate();
							},
							handleInput(data) {
								if (keys.matches(data, "tui.select.cancel")) {
									done(undefined);
									return;
								}
								if (keys.matches(data, "tui.select.confirm")) {
									const item = list.getSelectedItem();
									if (item) done(item.value);
									return;
								}
								if (
									(
										["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const
									).some((key) => keys.matches(data, key))
								)
									list.handleInput(data);
								else {
									input.handleInput(data);
									list = new SelectList(
										fuzzyFilter(items, input.getValue(), (item) => `${item.value} ${item.description}`),
										10,
										listTheme,
									);
								}
								tui.requestRender();
							},
						};
					});
					if (!selected) return;
					if (!ctx.isProjectTrusted() || !ctx.isIdle() || jobs.size > 0 || switching)
						throw new Error("Project trust or agent activity changed; try setup again when idle.");
					const model = ctx.modelRegistry
						.getAvailable()
						.find((model) => `${model.provider}/${model.id}` === selected);
					if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
						throw new Error(`Model unavailable: ${selected}. Check /model and /login.`);
					await saveProjectAgentModel(ctx.cwd, getAgentDir(), name, selected);
					ctx.ui.notify(
						`Saved ${name}: ${selected} in .tark/settings.json. Use /profile ${name} to apply; future subagents use it automatically.`,
						"info",
					);
					return;
				}
				const result = await completeProjectAgentConfig(ctx.cwd, getAgentDir(), currentModel);
				const message =
					result === "created"
						? "Added default agent settings under tark in .tark/settings.json."
						: result === "updated"
							? "Added missing tark settings in .tark/settings.json; existing values were preserved."
							: "Your project agent configuration is already complete.";
				ctx.ui.notify(message, "info");
			} catch (error) {
				ctx.ui.notify(
					`Agent configuration was not updated: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			} finally {
				configuring = false;
			}
		},
	});

	pi.registerCommand("profile", {
		description: "User-only agent selection; selecting code/debug does not approve writes",
		getArgumentCompletions: (prefix) => {
			const matches = profileChoices.filter((choice) => choice.startsWith(prefix));
			return matches.length > 0 ? matches.map((choice) => ({ value: choice, label: choice })) : null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			let name: string | undefined = args.trim() || undefined;
			if (!name) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current agent: ${active}. Use /profile <${profileChoices.join("|")}>.`, "info");
					return;
				}
				name = await ctx.ui.select(`Agent profile (current: ${active})`, profileChoices);
				if (!name) return;
			}
			if (name === "auto") {
				ctx.ui.notify(
					"Automatic routing is disabled. Only the user can change Agent or approve write permission.",
					"info",
				);
				return;
			}
			if (!isAgentName(name)) {
				ctx.ui.notify(`Unknown agent: ${name}. Choose ${profileChoices.join(", ")}.`, "error");
				return;
			}
			await activate(name, ctx, "manual");
		},
	});

	for (const key of KeybindingsManager.create().getKeys("app.profile.cycle"))
		pi.registerShortcut(key, {
			description: "Cycle agent profile (plan → orchestrator → debug → ask → code)",
			handler: async (ctx) => {
				if (ctx.mode !== "tui") return;
				await activate(agentNames[(agentNames.indexOf(active) + 1) % agentNames.length], ctx, "manual");
			},
		});

	pi.on("before_agent_start", (event) => {
		// A named section preserves the cached repository/tool prefix across profile changes.
		event.systemPromptOptions.sections.tark_profile = `Tark agent profile: ${active}\n${profiles[active]}\nFor authorized edits: inspect and reuse repository patterns; keep files cohesive and separate unrelated responsibilities before they become unreadable. Use focused, clearly named functions and straightforward control flow without tiny-file fragmentation, unnecessary abstractions, or hard size caps. Reread changed code and run relevant checks before completing edits.\n${
			depth > 0
				? `You are a delegated subagent. Work only on the supplied task.${inheritedScope ? ` Declared ownership: ${inheritedScope.mode}; paths: ${JSON.stringify(inheritedScope.paths)}. Modify only these paths (an empty write list means broad ownership); keep nested delegation within this ownership.` : ""} If user input is needed, return the question to the parent; no terminal interaction is available. Report changed files, results, and unexecuted checks. If the subagent tool is available, use purpose: explore only for bounded read-only codebase exploration and return concise file paths, line numbers, and uncertainties.`
				: "All five profiles are callable through subagent. Delegate only when a separate context helps; supply a focused task and all relevant context. For bounded codebase exploration involving discovery, several files, or a summary, delegate to subagent with agent: ask and purpose: explore. It uses small_model when configured, otherwise the current model, and must return concise findings with file paths, line numbers, and uncertainties. Keep planning, judgment, edits, and final verification here; do not delegate a trivial single read."
		}\nPermission: ${workflow.permission()}. Selecting code/debug or --agent does not grant writes. Read the current saved plan and active task scope before editing; update progress with todo. Phase 1 blocks all shell commands, arbitrary extension/MCP tools, and builders pending command policy, sandboxed checks, and builder isolation. Only the user changes Agent or approves a plan.`;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a self-contained read-only task to an isolated Pi process. Use ask plus purpose: explore for read-only codebase exploration with small_model when configured, otherwise the current model; exploration ignores variant overrides. Model, effort, and routing reason are returned. Concurrency depends on the parent's profile, not the selected child agent: orchestrator can run up to two read children concurrently. Other parent profiles run children sequentially. Write requests require task_id and explicit paths exactly matching the user-approved task, then fail closed: builders are unavailable until sandboxed checks and builder isolation are implemented. Children cannot approve writes; questions return to the parent.",
		executionMode: "parallel",
		parameters,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (configuring) throw new Error("Finish agent setup before delegating.");
			const parentProfile = active;
			const controller = new AbortController();
			const abort = () => controller.abort(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			// Track preparation as well as queued/running work so shutdown and switching cannot race it.
			const job = executeJob();
			jobs.set(controller, job);
			try {
				return await job;
			} finally {
				jobs.delete(controller);
				childStatuses.delete(controller);
				childStatus(ctx);
				signal?.removeEventListener("abort", abort);
			}

			async function executeJob() {
				controller.signal.throwIfAborted();
				if (depth >= 2) throw new Error("Subagent delegation depth limit (2) reached");
				if (!isAgentName(params.agent) || !params.task.trim() || params.task.length > 50_000)
					throw new Error("A valid agent and non-empty task of at most 50000 characters are required");
				if (
					(parentProfile === "plan" || parentProfile === "ask") &&
					params.agent !== "plan" &&
					params.agent !== "ask"
				) {
					throw new Error(
						`${parentProfile} may delegate only to plan or ask; switch to code, debug, or orchestrator for changes`,
					);
				}
				const exploration = params.purpose === "explore";
				if (exploration && params.agent !== "ask") throw new Error("Exploration delegation requires agent: ask");
				const readOnly = exploration || params.agent === "plan" || params.agent === "ask";
				const parentScope = inheritedScope ? await normalizeSubagentScope(ctx.cwd, inheritedScope) : undefined;
				const scope = await normalizeSubagentScope(
					ctx.cwd,
					{
						mode: params.mode,
						paths:
							params.paths ??
							(parentScope?.mode === "write" && !readOnly && params.mode !== "read"
								? parentScope.paths
								: undefined),
					},
					readOnly,
				);
				if (scope.mode === "write") {
					if (depth > 0 || parentScope?.mode === "read")
						throw new Error("Read-only inherited scope cannot delegate writes");
					if (parentProfile === "plan" || parentProfile === "ask")
						throw new Error(`${parentProfile} cannot delegate writes`);
					if (!params.task_id || !params.paths?.length)
						throw new Error("Write delegation requires task_id and explicit approved paths");
					workflow.assertTask(params.task_id, params.paths);
					throw new Error(
						"Builder execution is unavailable until sandboxed checks and builder isolation are implemented.",
					);
				}
				if (!ctx.model) throw new Error("Select a main model before delegating");
				const config = await loadAgentConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted());
				const route = routeSubagent(
					config,
					params.agent,
					params.task,
					`${ctx.model.provider}/${ctx.model.id}`,
					(ctx.thinkingLevel ?? pi.getThinkingLevel()) as Effort,
					exploration,
				);
				const slash = route.model.indexOf("/");
				const selected = ctx.modelRegistry.find(route.model.slice(0, slash), route.model.slice(slash + 1));
				if (!selected || !ctx.modelRegistry.hasConfiguredAuth(selected))
					throw new Error(`Subagent model unavailable: ${route.model}. Check /model and /login.`);
				const tools = subagentTools(
					scope.mode === "read" ? "ask" : params.agent,
					pi.getActiveTools(),
					depth + 1,
					exploration,
				);
				let scheduling: SchedulerStatus = { status: "queued" };
				const details = () => ({
					agent: params.agent,
					...route,
					mode: scope.mode,
					paths: scope.paths,
					broad: scope.broad,
					...scheduling,
				});
				const update = (text: string) =>
					onUpdate?.({
						content: [
							{
								type: "text" as const,
								text: `${params.agent} · ${route.model} · ${route.effort} (${route.reason})\n${text}`,
							},
						],
						details: details(),
					});
				const args = [
					"--mode",
					"json",
					"--print",
					"--no-session",
					"--model",
					route.model,
					"--thinking",
					route.effort,
					"--agent",
					params.agent,
					ctx.isProjectTrusted() ? "--approve" : "--no-approve",
					...childResourceArgs(process.argv.slice(2)),
					"--tools",
					tools.join(","),
				];
				if (tools.length === 0) args.push("--no-tools");
				// Callable MCP tools must not escape a read-only child's explicit built-in loadout.
				if (scope.mode === "read") {
					args.push("--no-mcp");
					args.push("--exclude-tools", "mcp__*");
				}
				const reportStatus = (state: SchedulerStatus) => {
					scheduling = state;
					if (state.status === "queued" || state.status === "running") {
						childStatuses.set(controller, { agent: params.agent, status: state.status });
					} else childStatuses.delete(controller);
					childStatus(ctx);
					update(
						`${state.status}${state.reason ? ` (${state.reason})` : ""} · ${scope.mode}${scope.paths.length ? ` · ${scope.paths.join(", ")}` : ""}`,
					);
				};
				controller.signal.throwIfAborted();
				const result = await scheduler.schedule({
					scope,
					controller,
					serial: parentProfile !== "orchestrator",
					run: async () => {
						// A previous writer may have created a symlink while this request was queued.
						await normalizeSubagentScope(ctx.cwd, scope);
						return runSubagent({
							invocation: getTarkInvocation(),
							args,
							cwd: ctx.cwd,
							depth: depth + 1,
							task: params.task,
							scope,
							signal: controller.signal,
							onProgress: update,
						});
					},
					onStatus: (state) => {
						// Runner results can resolve with provider errors; classify before reporting completion.
						if (state.status !== "completed") reportStatus(state);
					},
				});
				const failed =
					result.exitCode !== 0 ||
					result.stopReason === "error" ||
					result.stopReason === "aborted" ||
					Boolean(result.error);
				reportStatus({ status: result.stopReason === "aborted" ? "aborted" : failed ? "failed" : "completed" });
				return {
					content: [
						{
							type: "text" as const,
							text: `${params.agent} · ${route.model} · ${route.effort} (${route.reason})\n${limitOutput(failed ? result.error || result.stderr || result.output || "Subagent failed" : result.output)}`,
						},
					],
					details: { ...details(), ...result },
					usage: result.usage,
					isError: failed,
				};
			}
		},
	});

	pi.on("session_shutdown", async () => {
		const closing = scheduler.shutdown("Session shutdown");
		for (const controller of jobs.keys()) controller.abort("Session shutdown");
		await closing;
		await Promise.allSettled(jobs.values());
	});
}
