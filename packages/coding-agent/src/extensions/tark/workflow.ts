// Session-owned workflow persistence, explicit approval, and capability-gated execution.
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Type } from "typebox";
import { createBashToolDefinition } from "../../core/tools/bash.ts";
import { createEditToolDefinition } from "../../core/tools/edit.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { createWriteToolDefinition } from "../../core/tools/write.ts";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "./host.ts";
import { deniedPath } from "./lib/access-policy.ts";
import type { AgentName } from "./lib/agents.ts";
import { CheckPolicy, type CheckResult, checkNames, isCheckConfig } from "./lib/check-policy.ts";
import { executeReadOnlySandbox, executeSafeGit } from "./lib/command-execution.ts";
import { classifyCommand, commandTimeout } from "./lib/command-policy.ts";
import { DebugWorkflow } from "./lib/debug-workflow.ts";
import {
	assertApprovedTask,
	assertWorkflowWritePath,
	changeTodo,
	createPlan,
	emptyWorkflowState,
	loadWorkflowSnapshot,
	saveWorkflowSnapshot,
	validateWorkflowState,
	WORKFLOW_LIMITS,
	type WorkflowState,
} from "./lib/workflow-state.ts";

const entryType = "tark-workflow";
const safeTools = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"get_workspace_changes",
	"get_file_outline",
	"askquestions",
	"todo",
	"save_plan",
	"subagent",
	"bash",
	"run_checks",
	"debug_workflow",
]);
const todoParameters = Type.Object(
	{
		action: Type.Union((["list", "add", "update", "remove", "clear"] as const).map((action) => Type.Literal(action))),
		id: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
		text: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.itemText })),
		state: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in-progress"), Type.Literal("done")])),
	},
	{ additionalProperties: false },
);
const planParameters = Type.Object(
	{
		action: Type.Union([Type.Literal("get"), Type.Literal("save")]),
		text: Type.Optional(Type.String({ maxLength: WORKFLOW_LIMITS.planBytes })),
		tasks: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.String({ minLength: 1, maxLength: WORKFLOW_LIMITS.itemText }),
						text: Type.String({ minLength: 1, maxLength: WORKFLOW_LIMITS.itemText }),
						allowed_paths: Type.Array(Type.String({ minLength: 1, maxLength: WORKFLOW_LIMITS.pathBytes }), {
							maxItems: WORKFLOW_LIMITS.pathsPerTask,
						}),
					},
					{ additionalProperties: false },
				),
				{ maxItems: WORKFLOW_LIMITS.tasks },
			),
		),
	},
	{ additionalProperties: false },
);

interface WorkflowHost {
	agent(): AgentName;
	restoreAgent(ctx: ExtensionContext): void;
	canSwitch(ctx: ExtensionContext): boolean;
	canCheck(): boolean;
	canApprove: boolean;
	activateCode(ctx: ExtensionContext): Promise<boolean>;
	status(ctx: ExtensionContext): void;
}

/** Install one workflow per agents extension; no approval is shared across runtimes or children. */
export function installWorkflow(pi: ExtensionAPI, host: WorkflowHost) {
	let state = emptyWorkflowState();
	let available = true;
	let stopped = false;
	let approving = false;
	let version = 0;
	let epoch = 0;
	let tail: Promise<unknown> = Promise.resolve();
	let execution = new AbortController();
	let checking = false;
	const checks = new CheckPolicy();
	const debug = new DebugWorkflow();

	function serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work);
		tail = result.catch(() => {});
		return result;
	}

	function assertCurrent(ctx: ExtensionContext, expectedEpoch: number) {
		if (stopped || expectedEpoch !== epoch) throw new Error("Workflow session changed; retry in the active session");
		if (!available) throw new Error("Workflow state unavailable; restore its snapshot before continuing");
		if (ctx.signal?.aborted) throw new Error("Operation aborted");
	}

	async function commit(next: WorkflowState, ctx: ExtensionContext, expectedEpoch: number) {
		assertCurrent(ctx, expectedEpoch);
		const checked = validateWorkflowState(next);
		const reference = await saveWorkflowSnapshot(ctx.cwd, getAgentDir(), checked);
		assertCurrent(ctx, expectedEpoch);
		// A reference is appended only after the immutable snapshot exists. Failed IO never commits memory.
		pi.appendEntry(entryType, { reference });
		if (state.plan?.revision !== checked.plan?.revision) debug.reset();
		state = checked;
		version++;
		host.status(ctx);
		return reference;
	}

	async function restore(ctx: ExtensionContext) {
		const expectedEpoch = ++epoch;
		execution.abort("Workflow restored");
		execution = new AbortController();
		debug.reset();
		state = emptyWorkflowState();
		available = false;
		stopped = false;
		version++;
		host.status(ctx);
		return serialize(async () => {
			try {
				const latest = ctx.sessionManager
					.getBranch()
					.findLast((entry) => entry.type === "custom" && entry.customType === entryType);
				let next = emptyWorkflowState();
				if (latest?.type === "custom") {
					const data: unknown = latest.data;
					if (
						!data ||
						typeof data !== "object" ||
						!("reference" in data) ||
						typeof data.reference !== "string" ||
						Object.keys(data).length !== 1
					)
						throw new Error("Invalid workflow snapshot entry");
					next = await loadWorkflowSnapshot(ctx.cwd, getAgentDir(), data.reference);
				}
				if (stopped || epoch !== expectedEpoch) return;
				state = next;
				available = true;
			} catch (error) {
				if (epoch !== expectedEpoch || stopped) return;
				ctx.ui.notify(`Workflow restoration failed; execution blocked: ${errorText(error)}`, "error");
			} finally {
				host.status(ctx);
			}
		});
	}

	function permission(): "read" | "write" {
		if (!available || stopped || approving || !host.canApprove || !["code", "debug"].includes(host.agent()))
			return "read";
		try {
			assertApprovedTask(state);
			return "write";
		} catch {
			return "read";
		}
	}

	function assertTask(taskId?: string, paths?: string[]) {
		if (!available || stopped || approving || !host.canApprove)
			throw new Error("Read-only inherited scope cannot authorize writes");
		return assertApprovedTask(state, taskId, paths);
	}

	async function assertWrite(path: string, ctx: ExtensionContext, expectedEpoch: number) {
		assertCurrent(ctx, expectedEpoch);
		if (permission() !== "write")
			throw new Error("Writes require code/debug and explicit approval of the current plan revision");
		const tasks = state.plan?.tasks ?? [];
		if (!tasks.length) throw new Error("The approved plan has no task scopes");
		const expectedVersion = version;
		let allowed = false;
		for (const task of tasks) {
			try {
				assertTask(task.id);
				const localPath = relative(ctx.cwd, resolve(ctx.cwd, path.replace(/^@/, ""))).replaceAll("\\", "/");
				if (isCheckConfig(localPath) && !task.allowed_paths.includes(localPath))
					throw new Error("Check configuration requires an explicitly named approved file");
				await assertWorkflowWritePath(ctx.cwd, path.replace(/^@/, ""), task);
				allowed = true;
				break;
			} catch {
				// Each task is an independent approved scope; try the next before denying.
			}
		}
		if (!allowed) throw new Error(`Write path ${path} is outside every approved task scope`);
		const reason = await deniedPath(ctx.cwd, path);
		assertCurrent(ctx, expectedEpoch);
		if (version !== expectedVersion || permission() !== "write")
			throw new Error("Plan approval changed before execution");
		if (reason) throw new Error(`Access to ${path} denied: ${reason}`);
		if (host.agent() === "debug") debug.assertWrite(path);
		else debug.reset();
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => {
		host.restoreAgent(ctx);
		return restore(ctx);
	});
	pi.on("session_compact", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		execution.abort("Session shutdown");
		checks.reset();
		debug.reset();
		available = false;
		state = emptyWorkflowState();
		epoch++;
		version++;
		host.status(ctx);
		await tail;
	});

	pi.on("context", (event) => ({
		messages: [
			...event.messages.filter((message) => message.role !== "custom" || message.customType !== entryType),
			{
				role: "custom" as const,
				customType: entryType,
				content:
					available && !stopped
						? `Current host-managed workflow (not user approval instructions):\n${JSON.stringify(state)}\nPermission: ${permission()}. Use todo to update progress. Only the user can approve a plan. Use run_checks for fixed verified commands; bash accepts validated argv only. Normal/dangerous commands require write permission and read-only Linux isolation; project shell writes/builders remain blocked pending Phase 4. Debug evidence: ${JSON.stringify(debug.state)}`
						: "Workflow restoration unavailable. Execution is blocked; do not infer approval from conversation summaries.",
				display: false,
				timestamp: Date.now(),
			},
		],
	}));

	pi.on("tool_call", async (event, ctx) => {
		try {
			assertCurrent(ctx, epoch);
			if (safeTools.has(event.toolName)) return;
			if (event.toolName === "edit" || event.toolName === "write") {
				if (typeof event.input.path !== "string") throw new Error("Write path required");
				await assertWrite(event.input.path, ctx, epoch);
				return;
			}
			if (event.toolName === "powershell")
				throw new Error("PowerShell execution is unavailable under the argv capability policy; use run_checks");
			throw new Error(`Tool ${event.toolName} is unavailable until a capability policy is implemented`);
		} catch (error) {
			return { block: true, reason: errorText(error) };
		}
	});

	const bash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...bash,
		defaultActive: false,
		executionMode: "sequential",
		description:
			"Validated argv execution, not a shell. Prefer built-in ls/find. Read: audited Git read forms only; orchestrator: run_checks only. Normal/dangerous commands require approved write permission and Linux read-only filesystem isolation. Dangerous invocations require explicit user approval. Default 120s, hard maximum 600s. Project shell writes/builders remain blocked until Phase 4.",
		promptGuidelines: ["Use run_checks for configured verification; bash never interprets shell syntax."],
		execute(id, params, signal, onUpdate, ctx) {
			const expectedEpoch = epoch;
			const combined = AbortSignal.any([execution.signal, ...(signal ? [signal] : [])]);
			return serialize(async () => {
				assertCurrent(ctx, expectedEpoch);
				const guarded = createBashToolDefinition(ctx.cwd, {
					exposeSessionEnvironment: false,
					operations: {
						async exec(command, cwd, options) {
							const timeout = commandTimeout(options.timeout);
							if (host.agent() === "orchestrator")
								throw new Error("Orchestrator has no general bash; use run_checks");
							const policy = await classifyCommand(command);
							const expectedVersion = version;
							if (policy.tier !== "safe") {
								if (permission() !== "write")
									throw new Error(
										"Normal/dangerous commands require approved write permission; read agents use run_checks",
									);
								if (
									policy.tier === "dangerous" &&
									(!ctx.hasUI ||
										!(await ctx.ui.confirm(
											"Approve this dangerous invocation only?",
											`Command: ${command}\nWorking directory: ${cwd}\nFilesystem remains read-only; approval grants no additional scope.`,
											{ signal: combined },
										)))
								)
									throw new Error("Dangerous invocation not approved");
							}
							assertCurrent(ctx, expectedEpoch);
							combined.throwIfAborted();
							if (version !== expectedVersion) throw new Error("Plan approval changed before execution");
							const run = policy.tier === "safe" ? executeSafeGit : executeReadOnlySandbox;
							const result = await run(policy.executable, policy.args, cwd, { timeout, signal: combined });
							options.onData(
								Buffer.from(
									`${result.output}${result.omittedBytes ? `\n[${result.omittedBytes} output bytes omitted]` : ""}`,
								),
							);
							if (result.termination === "timeout") throw new Error(`timeout:${timeout}`);
							if (result.termination === "cancelled") throw new Error("aborted");
							return { exitCode: result.exitCode };
						},
					},
				});
				return guarded.execute(id, params, combined, onUpdate, ctx);
			});
		},
	});

	pi.registerTool({
		name: "run_checks",
		label: "Run checks",
		executionMode: "sequential",
		description:
			"Run a fixed typecheck/lint/test from user-reviewed .tark/checks.json. No arbitrary command or arguments. Linux/WSL2 read-only source sandbox; native Windows needs session opt-in and reports unsandboxed. Counts may be unknown. Output bounded to 200 lines/8 KiB.",
		parameters: Type.Object(
			{ check: Type.Union(checkNames.map((name) => Type.Literal(name))) },
			{ additionalProperties: false },
		),
		execute(_id, params, signal, _onUpdate, ctx) {
			const expectedEpoch = epoch;
			const combined = AbortSignal.any([execution.signal, ...(signal ? [signal] : [])]);
			return serialize(async () => {
				assertCurrent(ctx, expectedEpoch);
				if (Object.keys(params).length !== 1 || !checkNames.includes(params.check))
					throw new Error("Only a fixed check name is accepted");
				if (!host.canCheck())
					throw new Error("Wait for subagents and agent setup to finish before checking a stable source tree");
				checking = true;
				let checked: CheckResult;
				try {
					checked = await checks.run(params.check, ctx, combined);
				} finally {
					checking = false;
				}
				assertCurrent(ctx, expectedEpoch);
				if (host.agent() === "debug") debug.observe(checked);
				return {
					content: [
						{
							type: "text" as const,
							text: `${checked.check}: ${checked.passed ? "pass" : "fail"}; exit ${checked.exitCode}; ${checked.isolation}; ${checked.termination}; test counts unknown\n${checked.output}${checked.omittedBytes ? `\n[${checked.omittedBytes} output bytes omitted]` : ""}`,
						},
					],
					details: checked,
					isError: !checked.passed,
				};
			});
		},
	});

	pi.registerTool({
		name: "debug_workflow",
		label: "Debug evidence",
		executionMode: "sequential",
		description:
			"Record reproduction evidence, a failing run_checks regression, or why regression testing is infeasible with alternative verification. status reports remaining requirements; evidence is agent-reported, not independently proven. Source fixes require this sequence; run_checks verifies afterwards.",
		parameters: Type.Object(
			{
				action: Type.Union(["status", "reproduce", "regression", "infeasible"].map((name) => Type.Literal(name))),
				evidence: Type.Optional(Type.String({ maxLength: 4096 })),
			},
			{ additionalProperties: false },
		),
		execute(_id, params, _signal, _onUpdate, ctx) {
			const expectedEpoch = epoch;
			return serialize(async () => {
				assertCurrent(ctx, expectedEpoch);
				if (host.agent() !== "debug") throw new Error("Debug evidence requires the debug Agent");
				if (
					Object.keys(params).some((key) => key !== "action" && key !== "evidence") ||
					!["status", "reproduce", "regression", "infeasible"].includes(params.action) ||
					(params.evidence !== undefined && typeof params.evidence !== "string")
				)
					throw new Error("Invalid debug evidence input");
				if (params.action !== "status") debug.report(params.action, params.evidence ?? "");
				return result(JSON.stringify(debug.state));
			});
		},
	});

	pi.on("agent_before_settle", (event) => {
		if (host.agent() !== "debug") return;
		try {
			debug.assertComplete();
		} catch (error) {
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: "tark-debug-incomplete",
						display: true,
						content: errorText(error),
					},
				],
			};
		}
	});

	// The normal definitions preserve rendering, legacy edit inputs, BOM handling, and the core mutation queue.
	const edit = createEditToolDefinition(process.cwd());
	pi.registerTool({
		...edit,
		defaultActive: false,
		executionMode: "sequential",
		execute(id, params, signal, onUpdate, ctx) {
			const expectedEpoch = epoch;
			return serialize(async () => {
				await assertWrite(params.path, ctx, expectedEpoch);
				const guarded = createEditToolDefinition(ctx.cwd, {
					operations: {
						access: (path) => access(path, constants.R_OK | constants.W_OK),
						readFile,
						async writeFile(path, content) {
							await assertWrite(path, ctx, expectedEpoch);
							await writeFile(path, content, "utf-8");
						},
					},
				});
				return guarded.execute(id, params, signal, onUpdate, ctx);
			});
		},
	});
	const write = createWriteToolDefinition(process.cwd());
	pi.registerTool({
		...write,
		defaultActive: false,
		executionMode: "sequential",
		execute(id, params, signal, onUpdate, ctx) {
			const expectedEpoch = epoch;
			return serialize(async () => {
				await assertWrite(params.path, ctx, expectedEpoch);
				const guarded = createWriteToolDefinition(ctx.cwd, {
					operations: {
						async mkdir(directory) {
							await assertWrite(resolveToCwd(params.path, ctx.cwd), ctx, expectedEpoch);
							await mkdir(directory, { recursive: true });
						},
						async writeFile(path, content) {
							await assertWrite(path, ctx, expectedEpoch);
							await writeFile(path, content, "utf-8");
						},
					},
				});
				return guarded.execute(id, params, signal, onUpdate, ctx);
			});
		},
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		executionMode: "sequential",
		description: `Manage bounded todos: list/add/update/remove/clear, stable IDs, pending/in-progress/done. At most ${WORKFLOW_LIMITS.todos} items, ${WORKFLOW_LIMITS.itemText} code points per text; host storage only.`,
		parameters: todoParameters,
		execute(_id, params, _signal, _onUpdate, ctx) {
			const expectedEpoch = epoch;
			return serialize(async () => {
				assertCurrent(ctx, expectedEpoch);
				if (host.agent() === "debug" && params.state === "done") debug.assertComplete();
				const next = changeTodo(state, params);
				if (params.action === "list") return result(JSON.stringify(next.todos));
				const reference = await commit(next, ctx, expectedEpoch);
				return result(
					`Todo ${params.action} saved; ${next.todos.length} item(s), next ID ${next.nextTodoId}.`,
					reference,
				);
			});
		},
	});

	pi.registerTool({
		name: "save_plan",
		label: "Saved plan",
		executionMode: "sequential",
		description: `Get or save the exact plan text and tasks {id,text,allowed_paths} in host-managed JSON outside the repository. Approval persists only when the plan revision hash is unchanged. Limits: ${WORKFLOW_LIMITS.planBytes} plan bytes, ${WORKFLOW_LIMITS.tasks} tasks, ${WORKFLOW_LIMITS.pathsPerTask} paths/task, ${WORKFLOW_LIMITS.stateBytes} total state bytes. No destination, format, execution, approval, or agent switching arguments.`,
		parameters: planParameters,
		execute(_id, params, _signal, _onUpdate, ctx) {
			const expectedEpoch = epoch;
			return serialize(async () => {
				assertCurrent(ctx, expectedEpoch);
				if (Object.keys(params).some((key) => !["action", "text", "tasks"].includes(key)))
					throw new Error("Unknown workflow field");
				if (params.action === "get")
					return result(JSON.stringify({ plan: state.plan ?? null, approval: state.approval ?? null }));
				if (params.action !== "save" || typeof params.text !== "string" || !Array.isArray(params.tasks))
					throw new Error("Saving requires text and tasks");
				const plan = createPlan(params.text, params.tasks);
				const approval = state.plan?.revision === plan.revision ? state.approval : undefined;
				const reference = await commit({ ...state, plan, approval }, ctx, expectedEpoch);
				return result(JSON.stringify({ revision: plan.revision, approval: Boolean(state.approval) }), reference);
			});
		},
	});

	pi.on("input", async (event, ctx) => {
		const match = /^\/approve-plan\s*$/.exec(event.text);
		if (!match) return { action: "continue" as const };
		if (event.source !== "interactive" && event.source !== "rpc") {
			ctx.ui.notify("Plan approval requires direct user input.", "warning");
			return { action: "handled" as const };
		}
		try {
			assertCurrent(ctx, epoch);
			if (!host.canApprove || !ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc"))
				throw new Error("Plan approval requires the main interactive TUI or RPC session");
			if (approving || !host.canSwitch(ctx))
				throw new Error("Wait for agent setup and all subagents to finish before approval");
			const plan = state.plan;
			if (!plan) throw new Error("Save a plan before requesting approval");
			if (plan.tasks.length === 0) throw new Error("The plan has no tasks to approve");
			const expectedEpoch = epoch;
			const expectedVersion = version;
			const sessionId = ctx.sessionManager.getSessionId();
			const agent = host.agent();
			const review = `Plan revision: ${plan.revision}\n\n${plan.text}\n\nAll tasks and their exact scopes (approved together):\n${JSON.stringify(plan.tasks, null, 2)}`;
			const revalidate = () => {
				assertCurrent(ctx, expectedEpoch);
				if (
					version !== expectedVersion ||
					state.plan !== plan ||
					sessionId !== ctx.sessionManager.getSessionId() ||
					host.agent() !== agent ||
					!host.canSwitch(ctx)
				)
					throw new Error("Plan, session, or activity changed during approval; review again");
			};
			approving = true;
			host.status(ctx);
			try {
				if ((await ctx.ui.editor("Review saved plan (changes cancel approval)", review)) !== review) {
					return { action: "handled" as const };
				}
				revalidate();
				if (
					(await ctx.ui.select(`Approve plan revision ${plan.revision}?`, ["Cancel", "Approve & start code"])) !==
					"Approve & start code"
				)
					return { action: "handled" as const };
				await serialize(async () => {
					revalidate();
					const revoked = validateWorkflowState({ ...state, approval: undefined });
					const revocationReference = await saveWorkflowSnapshot(ctx.cwd, getAgentDir(), revoked);
					await commit({ ...state, approval: { revision: plan.revision } }, ctx, expectedEpoch);
					try {
						if (!(await host.activateCode(ctx))) throw new Error("Code activation failed");
						assertCurrent(ctx, expectedEpoch);
					} catch (error) {
						if (!stopped && epoch === expectedEpoch) {
							state = revoked;
							try {
								pi.appendEntry(entryType, { reference: revocationReference });
								version++;
							} catch (appendError) {
								available = false;
								throw appendError;
							}
						}
						throw new Error(`${errorText(error)}; approval revoked`);
					}
				});
			} finally {
				approving = false;
				host.status(ctx);
			}
		} catch (error) {
			ctx.ui.notify(`Plan not approved: ${errorText(error)}`, "warning");
		}
		return { action: "handled" as const };
	});

	return { permission, assertTask, isChecking: () => checking };
}

function result(text: string, reference?: string) {
	return { content: [{ type: "text" as const, text }], details: reference ? { reference } : {} };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
