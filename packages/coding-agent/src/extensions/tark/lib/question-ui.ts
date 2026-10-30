import type { EventEmitter } from "node:events";
import { CURSOR_MARKER, Editor, ScrollView, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "../host.ts";
import {
	type Answer,
	type Draft,
	initialDraft,
	type Outcome,
	outcome,
	type Question,
	type Result,
	validateAnswer,
} from "./question-model.ts";

// Model-provided labels are plain text, not terminal escape sequences.
const plain = (text: string) => text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class QuestionScreen {
	private current = 0;
	private review = false;
	private error = "";
	private settled = false;
	private hasFocus = false;
	private readonly drafts: Draft[];
	private readonly inputs: Editor[];
	private lines: string[] = [];
	private readonly viewport = new ScrollView({ render: () => this.lines, invalidate() {} });
	private revealFocus = true;
	private readonly focus: number[];
	private readonly confirmed = new Set<number>();
	private readonly abort = () => this.finish("aborted");
	private readonly eof = () => this.finish("error", "Terminal input closed before submission.");
	private readonly inputError = (error: Error) => this.finish("error", `Terminal input failed: ${message(error)}`);

	private readonly questions: Question[];
	private readonly tui: Pick<TUI, "requestRender" | "terminal">;
	private readonly theme: Pick<Theme, "fg">;
	private readonly done: (result: Result) => void;
	private readonly keybindings: KeybindingsManager;
	private readonly signal?: AbortSignal;
	private readonly stream: Pick<EventEmitter, "on" | "off">;

	constructor(
		questions: Question[],
		tui: Pick<TUI, "requestRender" | "terminal">,
		theme: Pick<Theme, "fg">,
		done: (result: Result) => void,
		keybindings: KeybindingsManager,
		signal?: AbortSignal,
		stream: Pick<EventEmitter, "on" | "off"> = process.stdin,
	) {
		this.questions = questions;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.keybindings = keybindings;
		this.signal = signal;
		this.stream = stream;
		this.drafts = questions.map(initialDraft);
		this.focus = this.drafts.map((draft) => draft.indices[0] ?? 0);
		this.inputs = questions.map((_, i) => {
			const input = new Editor(tui as TUI, {
				borderColor: (text) => theme.fg("accent", text),
				selectList: {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			});
			input.setText(this.drafts[i]!.text);
			input.onChange = () => {
				this.drafts[i]!.text = input.getExpandedText();
				this.confirmed.delete(i);
				this.error = "";
			};
			input.onSubmit = (text) => {
				// Editor clears after submit; keep drafts editable on validation failure or review.
				input.setText(text);
				this.save();
			};
			return input;
		});
		signal?.addEventListener("abort", this.abort, { once: true });
		stream.on("end", this.eof);
		stream.on("close", this.eof);
		stream.on("error", this.inputError);
		if (signal?.aborted) this.abort();
	}

	get focused() {
		return this.hasFocus;
	}
	set focused(value: boolean) {
		this.hasFocus = value;
		this.inputs.forEach((input, i) => {
			input.focused = value && !this.review && i === this.current && this.drafts[i]!.custom;
		});
	}

	dispose() {
		this.signal?.removeEventListener("abort", this.abort);
		this.stream.off("end", this.eof);
		this.stream.off("close", this.eof);
		this.stream.off("error", this.inputError);
		this.inputs.forEach((input) => {
			input.focused = false;
		});
	}

	private answers(): Answer[] {
		return this.questions.flatMap((q, i) => (this.confirmed.has(i) ? [validateAnswer(q, this.drafts[i]!)] : []));
	}

	private finish(status: Outcome, error?: string) {
		if (this.settled) return;
		this.settled = true;
		this.dispose();
		this.done(outcome(status, this.answers(), error));
	}

	private refresh() {
		this.focused = this.hasFocus;
		this.tui.requestRender();
	}

	private save() {
		try {
			validateAnswer(this.questions[this.current]!, this.drafts[this.current]!);
			this.confirmed.add(this.current);
			this.error = "";
			if (this.questions.length === 1) this.finish("answered");
			else if (this.current + 1 < this.questions.length) this.current++;
			else this.review = true;
		} catch (error) {
			this.error = message(error);
		}
	}

	handleInput(data: string) {
		if (this.settled) return;
		try {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.finish("cancelled");
				return;
			}
			if (
				this.keybindings.matches(data, "tui.select.pageUp") ||
				this.keybindings.matches(data, "tui.select.pageDown")
			) {
				this.viewport.scrollBy(
					(this.keybindings.matches(data, "tui.select.pageDown") ? 1 : -1) *
						Math.max(1, this.viewport.viewportHeight - 1),
				);
				this.refresh();
				return;
			}
			this.revealFocus = true;
			if (
				this.questions.length > 1 &&
				(this.keybindings.matches(data, "app.question.next") ||
					this.keybindings.matches(data, "app.question.previous"))
			) {
				const position = this.review ? this.questions.length : this.current;
				const direction = this.keybindings.matches(data, "app.question.next") ? 1 : -1;
				const next = (position + direction + this.questions.length + 1) % (this.questions.length + 1);
				this.review = next === this.questions.length;
				if (!this.review) this.current = next;
				this.error = "";
			} else if (this.review) {
				if (this.keybindings.matches(data, "tui.select.confirm")) {
					const missing = this.questions.findIndex((_, i) => !this.confirmed.has(i));
					if (missing !== -1) {
						this.current = missing;
						this.review = false;
						this.error = "Confirm this question before submitting.";
					} else {
						this.questions.forEach((q, i) => {
							validateAnswer(q, this.drafts[i]!);
						});
						this.finish("answered");
					}
				}
			} else {
				const q = this.questions[this.current]!;
				const draft = this.drafts[this.current]!;
				const input = this.inputs[this.current]!;
				if (draft.custom) {
					if (
						q.type !== "text" &&
						input.getCursor().line === 0 &&
						this.keybindings.matches(data, "tui.select.up")
					) {
						draft.custom = false;
						this.confirmed.delete(this.current);
					} else {
						input.handleInput(data);
					}
				} else {
					// The synthetic action lives at a separate index, never a label or option ID.
					const count = q.options.length + (q.allowOther ? 1 : 0) + (!q.required && q.type === "single" ? 1 : 0);
					const focus = this.focus[this.current]!;
					if (this.keybindings.matches(data, "tui.select.up"))
						this.focus[this.current] = (focus - 1 + count) % count;
					else if (this.keybindings.matches(data, "tui.select.down"))
						this.focus[this.current] = (focus + 1) % count;
					else if (
						q.type === "multi" &&
						this.keybindings.matches(data, "app.question.toggle") &&
						focus < q.options.length
					) {
						draft.indices = draft.indices.includes(focus)
							? draft.indices.filter((i) => i !== focus)
							: [...draft.indices, focus];
						this.confirmed.delete(this.current);
						this.error = "";
					} else if (
						this.keybindings.matches(data, "tui.select.confirm") ||
						(q.type === "multi" && this.keybindings.matches(data, "app.question.toggle"))
					) {
						if (q.allowOther && focus === q.options.length) {
							draft.custom = true;
							this.confirmed.delete(this.current);
						} else {
							if (q.type === "single") draft.indices = focus < q.options.length ? [focus] : [];
							this.save();
						}
					}
				}
			}
			this.refresh();
		} catch (error) {
			this.finish("error", message(error));
		}
	}

	invalidate() {
		this.revealFocus = true;
		this.inputs.forEach((input) => {
			input.invalidate();
		});
	}

	render(width: number): string[] {
		if (this.settled) return [];
		try {
			width = Math.max(1, width);
			const lines: string[] = [];
			let focusLine = 0;
			const key = (binding: Parameters<KeybindingsManager["getKeys"]>[0]) =>
				this.keybindings.getKeys(binding).join("/") || "unbound";
			const add = (text: string, color: Parameters<Theme["fg"]>[0] = "text") =>
				lines.push(...wrapTextWithAnsi(plain(text), width).map((line) => this.theme.fg(color, line)));
			add(
				this.review
					? `Review answers · ${key("tui.select.confirm")} to submit`
					: `? Question ${this.current + 1}/${this.questions.length}`,
				"accent",
			);
			if (this.review) {
				this.questions.forEach((q, i) => {
					const value = this.confirmed.has(i) ? validateAnswer(q, this.drafts[i]!).answer : "(not confirmed)";
					add(`${q.question}: ${Array.isArray(value) ? value.join(", ") : value}`);
				});
			} else {
				const q = this.questions[this.current]!;
				const draft = this.drafts[this.current]!;
				add(q.question);
				if (draft.custom) {
					add(
						q.type === "text"
							? "Your answer:"
							: `Your answer · ${key("tui.select.up")} on first line returns to options`,
						"muted",
					);
					const editorLines = this.inputs[this.current]!.render(width);
					focusLine =
						lines.length +
						Math.max(
							0,
							editorLines.findIndex((line) => line.includes(CURSOR_MARKER)),
						);
					lines.push(...editorLines);
				} else {
					const choices = q.options.map((option, i) => ({
						label: option.label,
						description: option.description,
						selected: draft.indices.includes(i),
					}));
					if (q.allowOther)
						choices.push({ label: "Type something else", description: undefined, selected: false });
					if (!q.required && q.type === "single")
						choices.push({ label: "Skip (no answer)", description: undefined, selected: false });
					choices.forEach((choice, i) => {
						const focused = i === this.focus[this.current];
						if (focused) focusLine = lines.length;
						add(
							`${focused ? "❯" : " "} ${q.type === "multi" ? (choice.selected ? "[x] " : "[ ] ") : ""}${i + 1}. ${choice.label}`,
							focused ? "accent" : "text",
						);
						if (choice.description) add(`     ${choice.description}`, "muted");
					});
				}
			}
			if (this.error) {
				focusLine = lines.length;
				add(this.error, "error");
			}
			const multi =
				!this.review && this.questions[this.current]!.type === "multi" && !this.drafts[this.current]!.custom;
			const textMode = !this.review && this.drafts[this.current]!.custom;
			add(
				`${this.review || textMode ? "" : `${key("tui.select.up")}/${key("tui.select.down")} Navigate · ${multi ? `${key("app.question.toggle")} Toggle · ` : ""}`}${key(textMode ? "tui.input.submit" : "tui.select.confirm")} Confirm · ${textMode ? `${key("tui.input.newLine")} New line · ` : ""}${key("tui.select.cancel")} Cancel`,
				"dim",
			);
			if (this.questions.length > 1)
				add(`${key("app.question.next")}/${key("app.question.previous")} Questions · Answers preserved`, "dim");
			add(`${key("tui.select.pageUp")}/${key("tui.select.pageDown")} Scroll`, "dim");
			// Keep the focused action/cursor visible even when a wrapped prompt fills the screen.
			const height = Math.max(1, this.tui.terminal.rows - 2);
			this.lines = lines;
			this.viewport.updateLayout(lines.length, height, () => this.tui.requestRender());
			if (this.revealFocus) {
				if (focusLine < this.viewport.scrollTop) this.viewport.scrollTo(focusLine);
				else if (focusLine >= this.viewport.scrollTop + height) this.viewport.scrollTo(focusLine - height + 1);
				this.revealFocus = false;
			}
			// Inline custom screens also run in regular mode, where layout does not clip ScrollView.
			return this.viewport.render(width).slice(this.viewport.scrollTop, this.viewport.scrollTop + height);
		} catch (error) {
			this.finish("error", message(error));
			return [];
		}
	}
}
