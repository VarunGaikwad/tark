// Bounded workflow data, approved task scopes, and host-owned immutable snapshots.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "../host.ts";

export interface TodoItem {
	id: number;
	text: string;
	state: "pending" | "in-progress" | "done";
}

export interface PlanTask {
	id: string;
	text: string;
	allowed_paths: string[];
}

export interface SavedPlan {
	revision: string;
	text: string;
	tasks: PlanTask[];
}

export interface PlanApproval {
	revision: string;
}

export interface WorkflowState {
	todos: TodoItem[];
	nextTodoId: number;
	plan?: SavedPlan;
	approval?: PlanApproval;
}

/** Limits apply on every state input, snapshot save, and snapshot load. Text counts Unicode code points; sizes count UTF-8 bytes. */
export const WORKFLOW_LIMITS = {
	todos: 100,
	itemText: 1000,
	planBytes: 64 * 1024,
	tasks: 100,
	pathsPerTask: 100,
	pathBytes: 1024,
	stateBytes: 256 * 1024,
} as const;

const HASH = /^[a-f0-9]{64}$/;

/** Return an empty state without resetting IDs in an existing workflow. */
export function emptyWorkflowState(): WorkflowState {
	return { todos: [], nextTodoId: 1 };
}

/** Validate untrusted state and return only its supported, bounded data fields. */
export function validateWorkflowState(value: unknown): WorkflowState {
	const input = record(value, ["todos", "nextTodoId", "plan", "approval"]);
	const todos = array(input.todos, WORKFLOW_LIMITS.todos, "todos").map((value): TodoItem => {
		const item = record(value, ["id", "text", "state"]);
		return { id: positiveId(item.id), text: itemText(item.text), state: todoState(item.state) };
	});
	const nextTodoId = positiveId(input.nextTodoId);
	if (new Set(todos.map((item) => item.id)).size !== todos.length || todos.some((item) => item.id >= nextTodoId)) {
		throw new Error("Todo IDs must be unique and less than nextTodoId");
	}
	const state: WorkflowState = { todos, nextTodoId };
	if (input.plan !== undefined) {
		const plan = record(input.plan, ["revision", "text", "tasks"]);
		state.plan = validatedPlan(plan.text, plan.tasks);
		if (plan.revision !== state.plan.revision) throw new Error("Plan revision does not match its content");
	}
	if (input.approval !== undefined) {
		const approval = record(input.approval, ["revision"]);
		if (!state.plan || approval.revision !== state.plan.revision) {
			throw new Error("Approval must match the current plan revision");
		}
		state.approval = { revision: state.plan.revision };
	}
	if (Buffer.byteLength(JSON.stringify(state), "utf8") > WORKFLOW_LIMITS.stateBytes) {
		throw new Error("Workflow state exceeds the serialized size limit");
	}
	return state;
}

/** Hash exact plan text and ordered tasks into the revision that approval is bound to. */
export function createPlan(text: string, tasks: PlanTask[]): SavedPlan {
	return validatedPlan(text, tasks);
}

/** Apply a todo action without mutating the input or recycling removed/cleared IDs. */
export function changeTodo(
	state: WorkflowState,
	input: {
		action: "list" | "add" | "update" | "remove" | "clear";
		id?: number;
		text?: string;
		state?: TodoItem["state"];
	},
): WorkflowState {
	const next = validateWorkflowState(state);
	record(input, ["action", "id", "text", "state"]);
	switch (input.action) {
		case "list":
			return next;
		case "add":
			if (next.nextTodoId === Number.MAX_SAFE_INTEGER) throw new Error("Todo IDs exhausted");
			next.todos.push({
				id: next.nextTodoId++,
				text: itemText(input.text),
				state: input.state === undefined ? "pending" : todoState(input.state),
			});
			break;
		case "update":
		case "remove": {
			const id = positiveId(input.id);
			const index = next.todos.findIndex((item) => item.id === id);
			if (index < 0) throw new Error(`Todo #${id} not found`);
			if (input.action === "remove") next.todos.splice(index, 1);
			else {
				if (input.text === undefined && input.state === undefined)
					throw new Error("Todo update requires text or state");
				if (input.text !== undefined) next.todos[index].text = itemText(input.text);
				if (input.state !== undefined) next.todos[index].state = todoState(input.state);
			}
			break;
		}
		case "clear":
			next.todos = [];
			break;
		default:
			throw new Error("Unknown todo action");
	}
	return validateWorkflowState(next);
}

/** Require current user approval and, when supplied, the exact approved path set (order is immaterial). */
export function assertApprovedTask(state: WorkflowState, taskId?: string, paths?: string[]): PlanTask {
	const checked = validateWorkflowState(state);
	const { plan, approval } = checked;
	if (!plan || !approval || approval.revision !== plan.revision) {
		throw new Error("Task requires approval of the current plan revision");
	}
	const task = taskId === undefined ? plan.tasks[0] : plan.tasks.find((task) => task.id === taskId);
	if (!task) throw new Error("Task is not included in the approved plan revision");
	if (paths !== undefined) {
		const requested = validatePaths(paths);
		if (
			requested.length !== task.allowed_paths.length ||
			requested.some((path) => !task.allowed_paths.includes(path))
		) {
			throw new Error("Requested paths must exactly match the approved task scope");
		}
	}
	return task;
}

/** Check relative or cwd-local absolute writes against a task; callers must also apply their existing deniedPath policy. */
export async function assertWorkflowWritePath(cwd: string, requested: string, task: PlanTask): Promise<void> {
	const checked = validateTask(task);
	const root = await realpath(cwd);
	if (typeof requested !== "string" || requested.split("/").some((part) => part === "." || part === "..")) {
		throw new Error("Write path must not contain dot segments");
	}
	const local = isAbsolute(requested) ? relative(resolve(cwd), requested).split(sep).join("/") : requested;
	validatePath(local);
	const target = resolve(root, local);
	const scope = checked.allowed_paths.find((path) => within(resolve(root, path), target));
	if (!scope) throw new Error("Write path is outside the approved task scope");
	await rejectSymlinks(target, root);
	try {
		const metadata = await lstat(target);
		if (!metadata.isFile() || metadata.nlink !== 1)
			throw new Error("Workflow writes require a regular file without hard links");
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
	const canonical = await canonicalNewPath(target);
	const canonicalScope = await canonicalNewPath(resolve(root, scope));
	if (!within(root, canonical) || !within(canonicalScope, canonical)) {
		throw new Error("Canonical write path is outside the approved task scope");
	}
}

/** Save a private, immutable JSON snapshot outside repositories and return its SHA-256 reference. */
export async function saveWorkflowSnapshot(cwd: string, agentDir: string, state: WorkflowState): Promise<string> {
	const content = JSON.stringify({ project: await realpath(cwd), state: validateWorkflowState(state) });
	if (Buffer.byteLength(content, "utf8") > WORKFLOW_LIMITS.stateBytes)
		throw new Error("Workflow snapshot exceeds the serialized size limit");
	const reference = digest(content);
	return withFileMutationQueue(resolve(agentDir, "workflows", `${reference}.json`), async () => {
		let directory = await storageDirectory(cwd, agentDir);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		directory = await storageDirectory(cwd, agentDir);
		const path = resolve(directory, `${reference}.json`);
		let file: FileHandle;
		try {
			file = await open(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			// Never replace an existing snapshot, including a corrupt or hostile one.
			await readSnapshot(cwd, agentDir, reference);
			return reference;
		}
		try {
			await file.writeFile(content, "utf8");
		} catch (error) {
			await unlink(path);
			throw error;
		} finally {
			await file.close();
		}
		return reference;
	});
}

/** Load a bounded regular JSON snapshot only when its bytes match the content-addressed reference. */
export async function loadWorkflowSnapshot(cwd: string, agentDir: string, reference: string): Promise<WorkflowState> {
	if (typeof reference !== "string" || !HASH.test(reference)) throw new Error("Invalid workflow snapshot reference");
	return withFileMutationQueue(resolve(agentDir, "workflows", `${reference}.json`), () =>
		readSnapshot(cwd, agentDir, reference),
	);
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected a workflow object");
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown workflow field");
	return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number, name: string): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) throw new Error(`Invalid or oversized ${name}`);
	// Materialize holes so element validation cannot silently skip malformed sparse arrays.
	return Array.from(value);
}

function positiveId(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid todo ID");
	return value;
}

function itemText(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > WORKFLOW_LIMITS.itemText * 2 ||
		[...value].length > WORKFLOW_LIMITS.itemText
	) {
		throw new Error("Item text must be nonempty and within the code point limit");
	}
	return value;
}

function todoState(value: unknown): TodoItem["state"] {
	if (value !== "pending" && value !== "in-progress" && value !== "done") throw new Error("Invalid todo state");
	return value;
}

function validatedPlan(text: unknown, tasks: unknown): SavedPlan {
	if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > WORKFLOW_LIMITS.planBytes) {
		throw new Error("Plan text must be nonempty and within the plan byte limit");
	}
	const checked = array(tasks, WORKFLOW_LIMITS.tasks, "tasks").map(validateTask);
	if (new Set(checked.map((task) => task.id)).size !== checked.length) throw new Error("Task IDs must be unique");
	const content = JSON.stringify({ text, tasks: checked });
	if (Buffer.byteLength(content, "utf8") > WORKFLOW_LIMITS.stateBytes) {
		throw new Error("Plan exceeds the serialized size limit");
	}
	return { revision: digest(content), text, tasks: checked };
}

function validateTask(value: unknown): PlanTask {
	const task = record(value, ["id", "text", "allowed_paths"]);
	return { id: itemText(task.id), text: itemText(task.text), allowed_paths: validatePaths(task.allowed_paths) };
}

function validatePaths(value: unknown): string[] {
	const paths = array(value, WORKFLOW_LIMITS.pathsPerTask, "allowed_paths").map(validatePath);
	if (new Set(paths).size !== paths.length) throw new Error("Duplicate allowed paths");
	return paths;
}

function validatePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		Buffer.byteLength(value, "utf8") > WORKFLOW_LIMITS.pathBytes ||
		/[\\:*?[\]{}()\u0000-\u001f\u007f-\u009f]/.test(value) ||
		value
			.split("/")
			.some(
				(part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:\.git|\.tark)$/i.test(part),
			)
	) {
		throw new Error(
			"Paths must be strict relative paths without root, dot segments, metadata, globs, or control characters",
		);
	}
	return value;
}

function digest(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function within(root: string, path: string): boolean {
	const local = relative(root, path);
	return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function canonicalNewPath(path: string): Promise<string> {
	try {
		// lstat distinguishes missing paths from dangling symlinks, which realpath alone cannot do.
		await lstat(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
		return resolve(await canonicalNewPath(dirname(path)), relative(dirname(path), path));
	}
	return realpath(path);
}

async function rejectSymlinks(path: string, root = parse(path).root): Promise<void> {
	let current = root;
	for (const part of relative(root, path).split(sep)) {
		current = resolve(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error("Workflow paths must not contain symlinks");
		} catch (error) {
			if (hasCode(error, "ENOENT")) return;
			throw error;
		}
	}
}

async function containingGitRoot(path: string): Promise<string | undefined> {
	let current = path;
	while (true) {
		try {
			const marker = await lstat(resolve(current, ".git"));
			if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) return current;
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

async function storageDirectory(cwd: string, agentDir: string): Promise<string> {
	const root = await realpath(cwd);
	const repository = (await containingGitRoot(root)) ?? root;
	const requested = resolve(agentDir, "workflows");
	const canonical = await canonicalNewPath(requested);
	// Validate before mkdir: a new directory under an ancestor repository is still repository-local storage.
	if (within(repository, canonical) || (await containingGitRoot(canonical))) {
		throw new Error("Workflow storage must be outside the repository");
	}
	await rejectSymlinks(requested);
	try {
		const metadata = await lstat(canonical);
		if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
			throw new Error("Workflow storage directory must be private (0700)");
		}
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
	return canonical;
}

async function readSnapshot(cwd: string, agentDir: string, reference: string): Promise<WorkflowState> {
	const directory = await storageDirectory(cwd, agentDir);
	const path = resolve(directory, `${reference}.json`);
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) !== 0 || metadata.nlink !== 1) {
		throw new Error("Workflow snapshot must be a non-executable regular file without links");
	}
	if (metadata.size > WORKFLOW_LIMITS.stateBytes)
		throw new Error("Workflow snapshot exceeds the serialized size limit");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await file.stat();
		if (
			!opened.isFile() ||
			(opened.mode & 0o111) !== 0 ||
			opened.nlink !== 1 ||
			opened.size > WORKFLOW_LIMITS.stateBytes
		) {
			throw new Error("Invalid workflow snapshot file");
		}
		// A fixed buffer also bounds reads if another process grows the file after stat.
		const buffer = Buffer.alloc(WORKFLOW_LIMITS.stateBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > WORKFLOW_LIMITS.stateBytes) throw new Error("Workflow snapshot exceeds the serialized size limit");
		const bytes = buffer.subarray(0, length);
		if (createHash("sha256").update(bytes).digest("hex") !== reference)
			throw new Error("Workflow snapshot integrity mismatch");
		const snapshot = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), [
			"project",
			"state",
		]);
		if (snapshot.project !== (await realpath(cwd))) throw new Error("Workflow snapshot belongs to another project");
		return validateWorkflowState(snapshot.state);
	} finally {
		await file.close();
	}
}
