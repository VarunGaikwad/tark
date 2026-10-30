// Offline regression coverage for question normalization, terminal screens, and RPC dialogs.
import { EventEmitter } from "node:events";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import askQuestion from "../src/extensions/tark/ask-question.ts";
import {
	initialDraft,
	normalizeQuestions,
	type Params,
	type Result,
	validateAnswer,
} from "../src/extensions/tark/lib/question-model.ts";
import { askRpcQuestions } from "../src/extensions/tark/lib/question-rpc.ts";
import { QuestionScreen } from "../src/extensions/tark/lib/question-ui.ts";
import { createTestUiContext } from "./suite/harness.ts";

const originalKeys = getKeybindings();
afterEach(() => setKeybindings(originalKeys));

function screenFor(params: Params, rows = 80, keys = new KeybindingsManager()) {
	setKeybindings(keys);
	const stream = new EventEmitter();
	const controller = new AbortController();
	const done = vi.fn<(result: Result) => void>();
	const terminal = { rows };
	const screen = new QuestionScreen(
		normalizeQuestions(params),
		{ requestRender() {}, terminal } as ConstructorParameters<typeof QuestionScreen>[1],
		{ fg: (_color, text) => text },
		done,
		keys,
		controller.signal,
		stream,
	);
	screen.focused = true;
	return { screen, done, stream, controller, terminal };
}

function rpcUi(
	selectSteps: Array<string | number | undefined>,
	texts: Array<string | undefined> = [],
	confirmed = true,
) {
	return {
		select: vi.fn(async (_title: string, options: string[]) => {
			const step = selectSteps.shift();
			return typeof step === "number" ? options[step] : step;
		}),
		editor: vi.fn(async (_title: string, _prefill?: string) => texts.shift()),
		confirm: vi.fn(async () => confirmed),
	};
}

const choices = [
	{ id: "a", label: "Same" },
	{ id: "b", label: "Same", description: "Second" },
];

describe("question model", () => {
	it("initializes editable multiline Unicode defaults without overloading option defaults", () => {
		const [q] = normalizeQuestions({
			questions: [{ question: "Text", type: "text", defaultValue: "😀\nline", maxLength: 6 }],
		});
		expect(initialDraft(q).text).toBe("😀\nline");
		expect(validateAnswer(q, initialDraft(q)).answer).toBe("😀\nline");
		expect(() => validateAnswer(q, { ...initialDraft(q), text: "😀\nlonger" })).toThrow("at most 6");
	});

	it.each([
		{ type: "single", options: choices, defaultValue: "x" },
		{ type: "text", defaultSelection: [] },
		{ type: "text", defaultSelection: "a" },
		{ type: "text", defaultValue: "😀😀", maxLength: 1 },
		{ type: "text", maxLength: -1 },
		{ type: "single", options: choices, maxLength: 3 },
		{ type: "multi", options: choices, maxSelections: 1, defaultSelection: ["a", "b"] },
		{ type: "multi", options: choices, defaultSelection: ["a", "a"] },
		{ type: "multi", options: choices, minSelections: 2, maxSelections: 1 },
		{ type: "single", options: choices, defaultSelection: "missing" },
	] satisfies Array<Omit<Params["questions"][number], "question">>)(
		"rejects incompatible parameters: %j",
		(invalid) => {
			expect(() => normalizeQuestions({ questions: [{ question: "Q", ...invalid }] })).toThrow();
		},
	);

	it("retains selection IDs, counts, optional empty answers, and explicit legacy normalization", () => {
		const [q] = normalizeQuestions({
			questions: [
				{ question: "Pick", options: choices, multiSelect: true, defaultSelection: ["b"], minSelections: 2 },
			],
		});
		expect(q.type).toBe("multi");
		expect(() => validateAnswer(q, initialDraft(q))).toThrow("at least 2");
		expect(validateAnswer(q, { indices: [1, 0], text: "", custom: false }).optionIds).toEqual(["a", "b"]);
		expect(() => validateAnswer(q, { indices: [2], text: "", custom: false })).toThrow("listed");
		const [optional] = normalizeQuestions({ questions: [{ question: "Text", type: "text", required: false }] });
		expect(validateAnswer(optional, initialDraft(optional)).answer).toBe("");
	});
});

describe("question terminal screen", () => {
	it("wraps prompts, option labels/descriptions, and review answers without losing their ends", () => {
		const prompt = `${"Long prompt ".repeat(4)}PROMPT-END`;
		const label = `${"Wide 界 option ".repeat(4)}LABEL-END`;
		const description = `${"Detailed description ".repeat(4)}DESCRIPTION-END`;
		const { screen, done } = screenFor(
			{
				questions: [
					{ question: prompt, options: [{ label, description }] },
					{ question: "Text", type: "text", defaultValue: `${"Review answer ".repeat(4)}ANSWER-END` },
				],
			},
			200,
		);
		const lines = screen.render(18);
		expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
		const joined = lines.join("").replaceAll(" ", "");
		expect(joined).toContain("PROMPT-END");
		expect(joined).toContain("LABEL-END");
		expect(joined).toContain("DESCRIPTION-END");
		screen.handleInput("\r");
		screen.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		expect(screen.render(18).join("").replaceAll(" ", "")).toContain("ANSWER-END");
		screen.handleInput("\r");
		expect(done.mock.calls[0][0].status).toBe("answered");
	});

	it("keeps focused choices reachable and allows paging all wrapped content in short narrow terminals", () => {
		const { screen, terminal } = screenFor(
			{
				questions: [
					{
						question: "Long prompt ".repeat(15),
						options: [
							{ label: "FIRST", description: `${"description ".repeat(20)}DETAIL-END` },
							{ label: "LAST" },
						],
					},
				],
			},
			7,
		);
		const seen: string[] = [];
		for (let i = 0; i < 30; i++) {
			const lines = screen.render(14);
			expect(lines.length).toBeLessThanOrEqual(5);
			expect(lines.every((line) => visibleWidth(line) <= 14)).toBe(true);
			seen.push(...lines);
			screen.handleInput("\x1b[6~");
		}
		expect(seen.join("").replaceAll(" ", "")).toContain("DETAIL-END");
		screen.handleInput("\x1b[B");
		expect(screen.render(14).join("\n")).toContain("LAST");
		terminal.rows = 4;
		screen.invalidate();
		expect(screen.render(10).join("\n")).toContain("LAST");
		screen.handleInput("\x1b");
	});

	it("edits defaults with native multiline keys and preserves drafts across grouped navigation/review", () => {
		const keys = new KeybindingsManager({ "tui.input.submit": "ctrl+s", "tui.input.newLine": "ctrl+n" });
		const { screen, done } = screenFor(
			{
				questions: [
					{ question: "Text", type: "text", defaultValue: "first" },
					{ question: "Pick", options: choices, defaultSelection: "b" },
				],
			},
			80,
			keys,
		);
		screen.handleInput("\x0e");
		for (const char of "second") screen.handleInput(char);
		screen.handleInput("\x13");
		screen.handleInput("\r");
		screen.handleInput("\x1b[Z");
		screen.handleInput("\x1b[Z");
		expect(screen.render(80).join("\n")).toContain("second");
		screen.handleInput("\x13");
		screen.handleInput("\r");
		screen.handleInput("\r");
		expect(done.mock.calls[0][0]).toMatchObject({
			status: "answered",
			answers: [{ answer: "first\nsecond" }, { optionIds: ["b"] }],
		});
	});

	it("uses native backslash-Enter and multiline paste behavior", () => {
		const { screen, done } = screenFor({ questions: [{ question: "Text", type: "text" }] });
		screen.handleInput("a");
		screen.handleInput("\\");
		screen.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		screen.handleInput("\x1b[200~b\nc\x1b[201~");
		screen.handleInput("\r");
		expect(done.mock.calls[0][0].answers[0].answer).toBe("a\nb\nc");
	});

	it("allows paging through every long review answer", () => {
		const { screen, terminal } = screenFor({
			questions: [
				{ question: "One", type: "text", defaultValue: `${"answer ".repeat(20)}FIRST-END` },
				{ question: "Two", type: "text", defaultValue: `${"answer ".repeat(20)}LAST-END` },
			],
		});
		screen.handleInput("\r");
		screen.handleInput("\r");
		terminal.rows = 6;
		screen.invalidate();
		const seen: string[] = [];
		for (let i = 0; i < 30; i++) {
			seen.push(...screen.render(13));
			screen.handleInput("\x1b[6~");
		}
		const text = seen.join("").replaceAll(" ", "");
		expect(text).toContain("FIRST-END");
		expect(text).toContain("LAST-END");
		screen.handleInput("\x1b");
	});

	it("validates text without discarding it and requires confirmation before grouped submission", () => {
		const { screen, done } = screenFor({
			questions: [
				{ question: "Text", type: "text", defaultValue: "ok", maxLength: 2 },
				{ question: "Pick", options: choices },
			],
		});
		screen.handleInput("x");
		screen.handleInput("\r");
		expect(screen.render(80).join("\n")).toContain("at most 2");
		expect(screen.render(80).join("\n")).toContain("okx");
		screen.handleInput("\x1b[Z");
		screen.handleInput("\r");
		expect(done).not.toHaveBeenCalled();
		expect(screen.render(80).join("\n")).toContain("Confirm this question");
		screen.handleInput("\x1b");
	});

	it("preserves multi defaults, custom editing, optional skips, and choice navigation", () => {
		const { screen, done } = screenFor({
			questions: [
				{
					question: "Many",
					type: "multi",
					options: choices,
					defaultSelection: ["b"],
					minSelections: 2,
					allowOther: true,
				},
				{ question: "Optional", options: [{ label: "A" }], required: false },
			],
		});
		screen.handleInput("\r");
		expect(screen.render(80).join("\n")).toContain("at least 2");
		screen.handleInput("\x1b[A");
		screen.handleInput(" ");
		screen.handleInput("\r");
		screen.handleInput("\x1b[B");
		screen.handleInput("\r");
		screen.handleInput("\r");
		expect(done.mock.calls[0][0]).toMatchObject({
			status: "answered",
			answers: [{ optionIds: ["a", "b"] }, { answer: "", optionIds: [] }],
		});
		const custom = screenFor({ questions: [{ question: "Other", options: choices, allowOther: true }] });
		custom.screen.handleInput("\x1b[B");
		custom.screen.handleInput("\x1b[B");
		custom.screen.handleInput("\r");
		custom.screen.handleInput("x");
		custom.screen.handleInput("\x0a");
		custom.screen.handleInput("y");
		custom.screen.handleInput("\r");
		expect(custom.done.mock.calls[0][0].answers[0]).toMatchObject({ answer: "x\ny", custom: true });
	});

	it.each(["cancel", "abort", "end", "close", "error"])("settles once and removes listeners on %s", (kind) => {
		const keys = new KeybindingsManager({ "tui.select.cancel": "ctrl+x" });
		const { screen, done, stream, controller } = screenFor(
			{
				questions: [
					{ question: "Pick", options: choices },
					{ question: "Text", type: "text" },
				],
			},
			80,
			keys,
		);
		screen.handleInput("\r");
		if (kind === "cancel") screen.handleInput("\x18");
		else if (kind === "abort") controller.abort();
		else stream.emit(kind, new Error("closed"));
		controller.abort();
		screen.handleInput("\r");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0]).toMatchObject({
			status: kind === "cancel" ? "cancelled" : kind === "abort" ? "aborted" : "error",
			answers: [{ optionIds: ["a"] }],
		});
		for (const event of ["end", "close", "error"]) expect(stream.listenerCount(event)).toBe(0);
		expect(screen.render(80)).toEqual([]);
	});
});

describe("askquestions mode and interaction guard", () => {
	it("guards concurrent RPC calls, releases on abort, and does not open TUI without a terminal", async () => {
		const extension = await loadExtensionFromFactory(
			askQuestion,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);
		const tool = extension.tools.get("askquestions")!.definition;
		const pending = Promise.withResolvers<string | undefined>();
		const opened = Promise.withResolvers<void>();
		const controller = new AbortController();
		const editor = vi.fn(async () => {
			opened.resolve();
			return pending.promise;
		});
		const custom = vi.fn();
		const ctx = { mode: "rpc", hasUI: true, ui: createTestUiContext({ editor, custom }) } as ExtensionToolContext;
		const params: Params = { questions: [{ question: "Q", type: "text" }] };
		const first = tool.execute("one", params, controller.signal, undefined, ctx);
		await opened.promise;
		expect((await tool.execute("two", params, undefined, undefined, ctx)).details).toMatchObject({
			status: "error",
			error: expect.stringContaining("already active"),
		});
		controller.abort();
		expect((await first).details).toMatchObject({ status: "aborted" });
		pending.resolve(undefined);
		expect((await tool.execute("three", params, undefined, undefined, ctx)).details).toMatchObject({
			status: "cancelled",
		});
		expect(editor).toHaveBeenCalledTimes(2);
		expect((await tool.execute("four", params, AbortSignal.abort(), undefined, ctx)).details).toMatchObject({
			status: "aborted",
		});
		const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		try {
			Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
			expect(
				(await tool.execute("five", params, undefined, undefined, { ...ctx, mode: "tui" })).details,
			).toMatchObject({ status: "requires_interaction" });
			expect(custom).not.toHaveBeenCalled();
		} finally {
			if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
			else Reflect.deleteProperty(process.stdin, "isTTY");
		}
	});
});

describe("question RPC dialogs", () => {
	it.each([
		[0, "b"],
		[1, "a"],
	] as const)("maps duplicate labels after displaying defaults first: %s", async (index, id) => {
		const ui = rpcUi([index, "Submit answers"]);
		const result = await askRpcQuestions(
			normalizeQuestions({ questions: [{ question: "Pick", options: choices, defaultSelection: "b" }] }),
			ui,
			new AbortController().signal,
		);
		expect(ui.select.mock.calls[0][1]).toEqual(["2. [x] Same — Second", "1. Same"]);
		expect(result).toMatchObject({ status: "answered", answers: [{ answer: "Same", optionIds: [id] }] });
		expect(ui.confirm).toHaveBeenCalledOnce();
	});

	it("validates multi counts and toggles defaults before explicit submission", async () => {
		const ui = rpcUi(["Done selecting", 0, "Done selecting", "Submit answers"]);
		const result = await askRpcQuestions(
			normalizeQuestions({
				questions: [
					{ question: "Many", type: "multi", options: choices, defaultSelection: ["b"], minSelections: 2 },
				],
			}),
			ui,
			new AbortController().signal,
		);
		expect(ui.select.mock.calls[1][0]).toContain("Choose at least 2");
		expect(ui.select.mock.calls[0][0]).toContain("1 selected; choose 2–2");
		expect(result.answers[0].optionIds).toEqual(["a", "b"]);
	});

	it("prefills multiline text, retries validation, and supports grouped review/edit", async () => {
		const ui = rpcUi([0, 1, 0, "Submit answers"], ["toolong", "ok\nx", "new"]);
		const result = await askRpcQuestions(
			normalizeQuestions({
				questions: [
					{ question: "Text", type: "text", defaultValue: "a\nb", maxLength: 4 },
					{ question: "Pick", options: choices },
				],
			}),
			ui,
			new AbortController().signal,
		);
		expect(ui.editor.mock.calls[0][1]).toBe("a\nb");
		expect(ui.editor.mock.calls[1][0]).toContain("at most 4");
		expect(ui.editor.mock.calls[2][1]).toBe("ok\nx");
		expect(result).toMatchObject({ status: "answered", answers: [{ answer: "new" }, { optionIds: ["a"] }] });
	});

	it("supports custom, optional choice, and optional empty text answers", async () => {
		const ui = rpcUi(
			["Custom answer", "Edit custom answer", "Skip (no answer)", "Submit answers"],
			["custom\nanswer", ""],
		);
		const result = await askRpcQuestions(
			normalizeQuestions({
				questions: [
					{ question: "Custom", options: choices, allowOther: true },
					{ question: "Optional", options: choices, required: false },
					{ question: "Optional text", type: "text", required: false },
				],
			}),
			ui,
			new AbortController().signal,
		);
		expect(result).toMatchObject({
			status: "answered",
			answers: [
				{ answer: "custom\nanswer", custom: true, optionIds: [] },
				{ answer: "", optionIds: [] },
				{ answer: "", custom: true },
			],
		});
	});

	it.each(["select", "editor", "review", "confirm"])("cancels at %s without any later dialog", async (stage) => {
		const ui = rpcUi(
			stage === "select" ? [undefined] : stage === "review" ? [0, undefined] : [0, "Submit answers"],
			[undefined],
			false,
		);
		const result = await askRpcQuestions(
			normalizeQuestions({
				questions: [{ question: "Q", ...(stage === "editor" ? { type: "text" as const } : { options: choices }) }],
			}),
			ui,
			new AbortController().signal,
		);
		expect(result.status).toBe("cancelled");
		expect(ui.select).toHaveBeenCalledTimes(stage === "editor" ? 0 : stage === "select" ? 1 : 2);
		expect(ui.confirm).toHaveBeenCalledTimes(stage === "confirm" ? 1 : 0);
	});

	it.each(["select", "editor", "confirm"])(
		"aborts a pending %s, removes its listener, and ignores late responses",
		async (stage) => {
			const controller = new AbortController();
			const pending = Promise.withResolvers<string | undefined>();
			const ready = Promise.withResolvers<void>();
			const ui = rpcUi([0, "Submit answers"]);
			const open = () => {
				ready.resolve();
				return pending.promise;
			};
			if (stage === "editor") ui.editor.mockImplementation(open);
			else if (stage === "select") ui.select.mockImplementation(open);
			else
				ui.confirm.mockImplementation(async () => {
					ready.resolve();
					await pending.promise;
					return true;
				});
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const task = askRpcQuestions(
				normalizeQuestions({
					questions: [
						{ question: "Q", ...(stage === "editor" ? { type: "text" as const } : { options: choices }) },
					],
				}),
				ui,
				controller.signal,
			);
			await ready.promise;
			controller.abort();
			expect((await task).status).toBe("aborted");
			const calls = ui.select.mock.calls.length + ui.editor.mock.calls.length + ui.confirm.mock.calls.length;
			pending.resolve("late");
			await Promise.resolve();
			expect(ui.select.mock.calls.length + ui.editor.mock.calls.length + ui.confirm.mock.calls.length).toBe(calls);
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		},
	);

	it("opens nothing for a pre-aborted signal and rejects unlisted RPC responses", async () => {
		const q = normalizeQuestions({ questions: [{ question: "Q", options: choices }] });
		const ui = rpcUi(["Same"]);
		expect((await askRpcQuestions(q, ui, AbortSignal.abort())).status).toBe("aborted");
		expect(ui.select).not.toHaveBeenCalled();
		expect((await askRpcQuestions(q, ui, new AbortController().signal)).status).toBe("error");
	});
});
