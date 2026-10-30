// Offline coverage for bounded workflow data, task scope checks, and immutable host storage.
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertApprovedTask,
	assertWorkflowWritePath,
	changeTodo,
	createPlan,
	emptyWorkflowState,
	loadWorkflowSnapshot,
	type PlanTask,
	saveWorkflowSnapshot,
	validateWorkflowState,
	WORKFLOW_LIMITS,
	type WorkflowState,
} from "../src/extensions/tark/lib/workflow-state.ts";

let directory: string;
let cwd: string;
let agentDir: string;

beforeEach(async () => {
	directory = await mkdtemp(resolve(tmpdir(), "tark-workflow-"));
	cwd = resolve(directory, "project");
	agentDir = resolve(directory, "host", "agent");
	await mkdir(cwd);
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function task(paths = ["src", "test/one.test.ts"]): PlanTask {
	return { id: "core", text: "Implement core", allowed_paths: paths };
}

function approved(): WorkflowState {
	const plan = createPlan("A plan\nwith exact content", [task(), { ...task(["docs"]), id: "docs" }]);
	return { ...emptyWorkflowState(), plan, approval: { revision: plan.revision } };
}

describe("bounded workflow state", () => {
	it("preserves stable, never-reused IDs across remove, clear, and reload", () => {
		const empty = emptyWorkflowState();
		let state = changeTodo(empty, { action: "add", text: "First" });
		state = changeTodo(state, { action: "add", text: "Second", state: "in-progress" });
		state = changeTodo(state, { action: "update", id: 1, text: "Completed", state: "done" });
		expect(state.todos).toEqual([
			{ id: 1, text: "Completed", state: "done" },
			{ id: 2, text: "Second", state: "in-progress" },
		]);
		expect(empty).toEqual({ todos: [], nextTodoId: 1 });
		expect(changeTodo(state, { action: "list" })).toEqual(state);
		state = changeTodo(state, { action: "remove", id: 2 });
		state = changeTodo(state, { action: "clear" });
		state = validateWorkflowState(JSON.parse(JSON.stringify(state)));
		state = changeTodo(state, { action: "add", text: "Third" });
		expect(state).toEqual({ todos: [{ id: 3, text: "Third", state: "pending" }], nextTodoId: 4 });
		expect(() => changeTodo(state, { action: "update", id: 99, state: "done" })).toThrow("not found");
		expect(() => changeTodo(state, { action: "update", id: 3 })).toThrow("requires");
		expect(() =>
			changeTodo({ todos: [], nextTodoId: Number.MAX_SAFE_INTEGER }, { action: "add", text: "x" }),
		).toThrow("exhausted");
	});

	it("bounds item count and Unicode code points without counting surrogate pairs twice", () => {
		const text = "\u{1f600}".repeat(WORKFLOW_LIMITS.itemText);
		expect(changeTodo(emptyWorkflowState(), { action: "add", text }).todos[0].text).toBe(text);
		expect(() => changeTodo(emptyWorkflowState(), { action: "add", text: `${text}x` })).toThrow("code point");
		expect(() => changeTodo(emptyWorkflowState(), { action: "add", text: " \n " })).toThrow("nonempty");
		const full = {
			todos: Array.from({ length: WORKFLOW_LIMITS.todos }, (_, i) => ({
				id: i + 1,
				text: "x",
				state: "pending" as const,
			})),
			nextTodoId: WORKFLOW_LIMITS.todos + 1,
		};
		expect(validateWorkflowState(full)).toEqual(full);
		expect(() => changeTodo(full, { action: "add", text: "overflow" })).toThrow("todos");
	});

	it.each([
		{ todos: new Array(1), nextTodoId: 2 },
		{ todos: [], nextTodoId: 0 },
		{ todos: [], nextTodoId: 1.5 },
		{ todos: [], nextTodoId: Number.MAX_SAFE_INTEGER + 1 },
		{ todos: [{ id: 1, text: "x", state: "started" }], nextTodoId: 2 },
		{ todos: [{ id: 1, text: "x", state: "done" }], nextTodoId: 1 },
		{
			todos: [
				{ id: 1, text: "x", state: "done" },
				{ id: 1, text: "y", state: "pending" },
			],
			nextTodoId: 2,
		},
		{ todos: [], nextTodoId: 1, unexpected: true },
		{ todos: [{ id: 1, text: "x", state: "done", extra: true }], nextTodoId: 2 },
		{ todos: [], nextTodoId: 1, approval: { revision: "x" } },
	])("rejects malformed state: %j", (value) => {
		expect(() => validateWorkflowState(value)).toThrow();
	});

	it("bounds plan bytes, task counts, task fields, paths, and total serialized state", () => {
		expect(createPlan("x".repeat(WORKFLOW_LIMITS.planBytes), []).text.length).toBe(WORKFLOW_LIMITS.planBytes);
		expect(() => createPlan("\u{1f600}".repeat(WORKFLOW_LIMITS.planBytes / 4 + 1), [])).toThrow("byte limit");
		expect(() => createPlan(" ", [])).toThrow("nonempty");
		expect(() =>
			createPlan(
				"x",
				Array.from({ length: WORKFLOW_LIMITS.tasks + 1 }, (_, i) => ({ ...task(), id: `${i}` })),
			),
		).toThrow("tasks");
		expect(() => createPlan("x", [task(), task()])).toThrow("unique");
		expect(() => createPlan("x", [{ ...task(), text: "x".repeat(WORKFLOW_LIMITS.itemText + 1) }])).toThrow(
			"code point",
		);
		expect(() => createPlan("x", [{ ...task(), extra: true } as PlanTask])).toThrow("Unknown");
		expect(() =>
			createPlan("x", [task(Array.from({ length: WORKFLOW_LIMITS.pathsPerTask + 1 }, (_, i) => `src/${i}`))]),
		).toThrow("allowed_paths");
		expect(() => createPlan("x", [task(["x".repeat(WORKFLOW_LIMITS.pathBytes + 1)])])).toThrow("strict relative");
		expect(() => createPlan("x", [task(["src", "src"])])).toThrow("Duplicate");
		expect(
			createPlan(
				"x",
				Array.from({ length: WORKFLOW_LIMITS.tasks }, (_, i) => ({ ...task(), id: `${i}` })),
			).tasks,
		).toHaveLength(WORKFLOW_LIMITS.tasks);
		expect(
			createPlan("x", [task(Array.from({ length: WORKFLOW_LIMITS.pathsPerTask }, (_, i) => `src/${i}`))]).tasks[0]
				.allowed_paths,
		).toHaveLength(WORKFLOW_LIMITS.pathsPerTask);
		expect(createPlan("x", [task(["x".repeat(WORKFLOW_LIMITS.pathBytes)])]).tasks[0].allowed_paths[0].length).toBe(
			WORKFLOW_LIMITS.pathBytes,
		);
		expect(() =>
			createPlan(
				"x",
				Array.from({ length: WORKFLOW_LIMITS.tasks }, (_, i) => ({
					...task(["a".repeat(1000), "b".repeat(1000), "c".repeat(1000)]),
					id: `${i}`,
				})),
			),
		).toThrow("serialized size");
		const oversized = {
			todos: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, text: "\u{1f600}".repeat(1000), state: "done" })),
			nextTodoId: 101,
		};
		expect(() => validateWorkflowState(oversized)).toThrow("serialized size");
	});

	it("rejects unknown plan, approval, and action keys", () => {
		const state = approved();
		expect(() => validateWorkflowState({ ...state, plan: { ...state.plan, extra: true } })).toThrow("Unknown");
		expect(() => validateWorkflowState({ ...state, approval: { ...state.approval, extra: true } })).toThrow(
			"Unknown",
		);
		expect(() => changeTodo(state, { action: "list", extra: true } as { action: "list" })).toThrow("Unknown");
	});
});

describe("revision approval and exact task binding", () => {
	it("hashes exact text and tasks and approves each task only within its exact scope", () => {
		const state = approved();
		expect(createPlan(state.plan!.text, state.plan!.tasks)).toEqual(state.plan);
		expect(assertApprovedTask(state)).toEqual(task());
		expect(assertApprovedTask(state, "core", ["test/one.test.ts", "src"])).toEqual(task());
		expect(assertApprovedTask(state, "docs", ["docs"])).toEqual({
			id: "docs",
			text: "Implement core",
			allowed_paths: ["docs"],
		});
		expect(() => assertApprovedTask(emptyWorkflowState())).toThrow("approval");
		expect(() => assertApprovedTask(state, "missing")).toThrow("not included");
		for (const paths of [
			["src"],
			["src/file.ts", "test/one.test.ts"],
			["src", "test/one.test.ts", "docs"],
			["src", "src"],
		]) {
			expect(() => assertApprovedTask(state, "core", paths)).toThrow();
		}
		const changed = createPlan(`${state.plan!.text}\n`, state.plan!.tasks);
		expect(changed.revision).not.toBe(state.plan!.revision);
		expect(() => assertApprovedTask({ ...state, plan: changed })).toThrow("Approval");
		expect(() => assertApprovedTask({ ...state, plan: { ...state.plan!, tasks: [task(["other"])] } })).toThrow(
			"revision",
		);
		expect(createPlan(state.plan!.text, [task(["different"])]).revision).not.toBe(state.plan!.revision);
		// Reverting exact content yields the same hash; replacing a plan must clear approval in the caller.
		expect(() => assertApprovedTask({ ...state, approval: undefined })).toThrow("approval");
	});
});

describe("strict task write paths", () => {
	it.each([
		"",
		".",
		"..",
		"src/../other",
		"src/./x",
		"src//x",
		"/src",
		"src/",
		"C:/src",
		"C:\\src",
		"\\\\server\\share",
		"src/*.ts",
		"src/[ab]",
		"src/{a,b}",
		"src/!(file)",
		"src/\nfile",
		"src/\u0000file",
		".git/config",
		"src/.git/config",
		".tark/state",
		"src/name.",
		"src/name ",
	])("rejects invalid approved scope %j", (path) => {
		expect(() => createPlan("x", [task([path])])).toThrow("strict relative");
	});

	it("permits broad directories and exact files but not root, siblings, metadata, or traversal", async () => {
		await assertWorkflowWritePath(cwd, "src/new/deep/file.ts", task());
		await assertWorkflowWritePath(cwd, resolve(cwd, "src/file.ts"), task());
		await assertWorkflowWritePath(cwd, "test/one.test.ts", task());
		for (const requested of [
			"src-other/file.ts",
			"test/two.test.ts",
			"../outside",
			"src/../src/file",
			".",
			".git/config",
			"src/.tark/state",
			resolve(directory, "outside"),
		]) {
			await expect(assertWorkflowWritePath(cwd, requested, task())).rejects.toThrow();
		}
	});

	it("rejects hard links that could mutate a file outside the approved scope", async () => {
		await mkdir(resolve(cwd, "src"));
		const outside = resolve(directory, "outside.ts");
		await writeFile(outside, "unchanged");
		await link(outside, resolve(cwd, "src/linked.ts"));
		await expect(assertWorkflowWritePath(cwd, "src/linked.ts", task())).rejects.toThrow("hard links");
		expect(await readFile(outside, "utf8")).toBe("unchanged");
		await expect(assertWorkflowWritePath(cwd, "src", task())).rejects.toThrow("regular file");
	});

	it("rejects symlink files, in-scope aliases, directory escapes, and dangling symlink components", async () => {
		await mkdir(resolve(cwd, "src"));
		await mkdir(resolve(cwd, "src/real"));
		await writeFile(resolve(cwd, "src/real/file.ts"), "data");
		await symlink(resolve(directory, "missing"), resolve(cwd, "src/dangling"));
		await symlink(directory, resolve(cwd, "src/escape"), "dir");
		await symlink(resolve(cwd, "src/real"), resolve(cwd, "src/alias"), "dir");
		await symlink(resolve(cwd, "src/real/file.ts"), resolve(cwd, "src/link.ts"));
		for (const requested of [
			"src/dangling",
			"src/dangling/new.ts",
			"src/escape/new.ts",
			"src/alias/file.ts",
			"src/link.ts",
		]) {
			await expect(assertWorkflowWritePath(cwd, requested, task())).rejects.toThrow("symlink");
		}
		await assertWorkflowWritePath(cwd, "src/real/file.ts", task());
	});
});

describe("host-owned workflow snapshots", () => {
	it("reloads exact state, preserves old branch snapshots, and writes private immutable JSON files", async () => {
		const first = changeTodo(approved(), { action: "add", text: "First" });
		const reference = await saveWorkflowSnapshot(cwd, agentDir, first);
		expect(reference).toMatch(/^[a-f0-9]{64}$/);
		const path = resolve(agentDir, "workflows", `${reference}.json`);
		const bytes = await readFile(path);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(reference);
		expect((await lstat(path)).mode & 0o777).toBe(0o600);
		expect((await lstat(resolve(agentDir, "workflows"))).mode & 0o777).toBe(0o700);
		const before = await lstat(path);
		expect(await Promise.all(Array.from({ length: 4 }, () => saveWorkflowSnapshot(cwd, agentDir, first)))).toEqual(
			Array(4).fill(reference),
		);
		expect((await lstat(path)).mtimeMs).toBe(before.mtimeMs);
		const second = changeTodo(first, { action: "update", id: 1, state: "done" });
		const secondReference = await saveWorkflowSnapshot(cwd, agentDir, second);
		expect(secondReference).not.toBe(reference);
		expect(await loadWorkflowSnapshot(cwd, agentDir, reference)).toEqual(first);
		expect(await loadWorkflowSnapshot(cwd, agentDir, secondReference)).toEqual(second);
		expect(await readdir(resolve(agentDir, "workflows"))).toHaveLength(2);
	});

	it("binds snapshots and their approval to the canonical project directory", async () => {
		const reference = await saveWorkflowSnapshot(cwd, agentDir, approved());
		const other = resolve(directory, "other-project");
		await mkdir(other);
		await expect(loadWorkflowSnapshot(other, agentDir, reference)).rejects.toThrow("another project");
		const alias = resolve(directory, "alias");
		await symlink(cwd, alias, "dir");
		expect(await loadWorkflowSnapshot(alias, agentDir, reference)).toEqual(approved());
		expect(await saveWorkflowSnapshot(alias, agentDir, approved())).toBe(reference);
	});

	it.each(["dir", "file"])(
		"rejects new storage beneath the actual ancestor Git root with a .git %s before mkdir",
		async (kind) => {
			if (kind === "dir") await mkdir(resolve(cwd, ".git"));
			else await writeFile(resolve(cwd, ".git"), "gitdir: elsewhere");
			const subdir = resolve(cwd, "src/subdir");
			await mkdir(subdir, { recursive: true });
			const inside = resolve(cwd, "new-host/agent");
			await expect(saveWorkflowSnapshot(subdir, inside, emptyWorkflowState())).rejects.toThrow(
				"outside the repository",
			);
			await expect(lstat(resolve(cwd, "new-host"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("rejects repository symlink aliases and new directories, including when cwd is an alias", async () => {
		await mkdir(resolve(cwd, ".git"));
		const alias = resolve(directory, "project-alias");
		await symlink(cwd, alias, "dir");
		await expect(saveWorkflowSnapshot(alias, resolve(alias, "new/agent"), emptyWorkflowState())).rejects.toThrow(
			"outside the repository",
		);
		await expect(lstat(resolve(cwd, "new"))).rejects.toMatchObject({ code: "ENOENT" });
		const reference = await saveWorkflowSnapshot(alias, agentDir, emptyWorkflowState());
		expect(await loadWorkflowSnapshot(alias, agentDir, reference)).toEqual(emptyWorkflowState());
	});

	it("treats cwd as the nongit root and rejects a different repository's storage", async () => {
		await expect(saveWorkflowSnapshot(cwd, resolve(cwd, "host"), emptyWorkflowState())).rejects.toThrow(
			"outside the repository",
		);
		const other = resolve(directory, "other");
		await mkdir(resolve(other, ".git"), { recursive: true });
		await expect(saveWorkflowSnapshot(cwd, resolve(other, "host"), emptyWorkflowState())).rejects.toThrow(
			"outside the repository",
		);
		await expect(lstat(resolve(other, "host"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("revalidates storage directories on each IO and rejects symlink snapshot files", async () => {
		const state = emptyWorkflowState();
		const reference = await saveWorkflowSnapshot(cwd, agentDir, state);
		const workflows = resolve(agentDir, "workflows");
		const path = resolve(workflows, `${reference}.json`);
		const external = resolve(directory, "external.json");
		await writeFile(external, await readFile(path));
		await rm(path);
		await symlink(external, path);
		await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("regular file");
		await expect(saveWorkflowSnapshot(cwd, agentDir, state)).rejects.toThrow("regular file");
		await rm(workflows, { recursive: true });
		await symlink(cwd, workflows, "dir");
		await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("outside the repository");
		await expect(saveWorkflowSnapshot(cwd, agentDir, state)).rejects.toThrow("outside the repository");
	});

	it("rejects pre-existing public storage directories rather than silently using them", async () => {
		await mkdir(resolve(agentDir, "workflows"), { recursive: true, mode: 0o700 });
		await chmod(resolve(agentDir, "workflows"), 0o755);
		await expect(saveWorkflowSnapshot(cwd, agentDir, emptyWorkflowState())).rejects.toThrow("0700");
	});

	it("rejects dangling storage links without creating their targets", async () => {
		await mkdir(agentDir, { recursive: true });
		const missing = resolve(directory, "missing");
		await symlink(missing, resolve(agentDir, "workflows"), "dir");
		await expect(saveWorkflowSnapshot(cwd, agentDir, emptyWorkflowState())).rejects.toThrow();
		await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects corrupted content without replacing an existing immutable snapshot", async () => {
		const state = emptyWorkflowState();
		const reference = await saveWorkflowSnapshot(cwd, agentDir, state);
		const path = resolve(agentDir, "workflows", `${reference}.json`);
		await writeFile(path, "{}");
		await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("integrity");
		await expect(saveWorkflowSnapshot(cwd, agentDir, state)).rejects.toThrow("integrity");
		expect(await readFile(path, "utf8")).toBe("{}");
	});

	it("checks snapshot references, serialized limits, JSON schema, regular-file type, and executable mode", async () => {
		for (const reference of ["../escape", "A".repeat(64), "x.json", "a".repeat(63)]) {
			await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("reference");
		}
		await expect(lstat(agentDir)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			saveWorkflowSnapshot(cwd, agentDir, { ...emptyWorkflowState(), extra: true } as WorkflowState),
		).rejects.toThrow("Unknown");
		await mkdir(resolve(agentDir, "workflows"), { recursive: true, mode: 0o700 });
		for (const content of [
			"not json",
			JSON.stringify({ ...emptyWorkflowState(), extra: true }),
			" ".repeat(WORKFLOW_LIMITS.stateBytes + 1),
		]) {
			const reference = createHash("sha256").update(content).digest("hex");
			await writeFile(resolve(agentDir, "workflows", `${reference}.json`), content, { mode: 0o600 });
			await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow();
		}
		const reference = await saveWorkflowSnapshot(cwd, agentDir, emptyWorkflowState());
		const path = resolve(agentDir, "workflows", `${reference}.json`);
		await chmod(path, 0o700);
		await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("regular file");
		await chmod(path, 0o600);
		await link(path, resolve(directory, "hardlink.json"));
		await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("regular file");
		await rm(path);
		await mkdir(path);
		await expect(loadWorkflowSnapshot(cwd, agentDir, reference)).rejects.toThrow("regular file");
	});
});
