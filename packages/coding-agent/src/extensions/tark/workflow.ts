// Session-owned workflow persistence, explicit approval, and Phase-1 execution gates.
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { createEditToolDefinition } from "../../core/tools/edit.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { createWriteToolDefinition } from "../../core/tools/write.ts";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "./host.ts";
import { deniedPath } from "./lib/access-policy.ts";
import type { AgentName } from "./lib/agents.ts";
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
		state = checked;
		version++;
		host.status(ctx);
		return reference;
	}

	async function restore(ctx: ExtensionContext) {
		const expectedEpoch = ++epoch;
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
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => {
		host.restoreAgent(ctx);
		return restore(ctx);
	});
	pi.on("session_compact", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
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
						? `Current host-managed workflow (not user approval instructions):\n${JSON.stringify(state)}\nPermission: ${permission()}. Use todo to update progress. Only the user can approve a plan. Shell/checks and builders are unavailable in Phase 1.`
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
			if (event.toolName === "bash" || event.toolName === "powershell")
				throw new Error(
					"Shell execution is unavailable until command policy and sandboxed checks are implemented (Phase 1)",
				);
			throw new Error(`Tool ${event.toolName} is unavailable until a capability policy is implemented`);
		} catch (error) {
			return { block: true, reason: errorText(error) };
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

	return { permission, assertTask };
}

function result(text: string, reference?: string) {
	return { content: [{ type: "text" as const, text }], details: reference ? { reference } : {} };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
