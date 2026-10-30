import { type Static, Type } from "typebox";

const Option = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1 })),
	label: Type.String({ minLength: 1 }),
	description: Type.Optional(Type.String()),
});

export const AskQuestionParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ minLength: 1 })),
			question: Type.String({ minLength: 1 }),
			type: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")])),
			options: Type.Optional(Type.Array(Option)),
			multiSelect: Type.Optional(Type.Boolean()),
			allowOther: Type.Optional(Type.Boolean()),
			required: Type.Optional(Type.Boolean()),
			defaultSelection: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
			defaultValue: Type.Optional(Type.String({ description: "Editable initial value for text questions only" })),
			minSelections: Type.Optional(Type.Integer({ minimum: 0 })),
			maxSelections: Type.Optional(Type.Integer({ minimum: 0 })),
			maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
		{ minItems: 1, description: "Related questions, answered together in the terminal" },
	),
});

export type Params = Static<typeof AskQuestionParams>;
export type Question = Omit<Params["questions"][number], "id" | "type" | "options" | "required"> & {
	id: string;
	type: "single" | "multi" | "text";
	options: { id: string; label: string; description?: string }[];
	required: boolean;
};
export type Draft = { indices: number[]; text: string; custom: boolean };
export type Answer = {
	id: string;
	question: string;
	answer: string | string[] | null;
	optionIds: string[];
	custom: boolean;
};
export type Outcome = "answered" | "cancelled" | "aborted" | "requires_interaction" | "error";
export type Result = { status: Outcome; answers: Answer[]; cancelled: boolean; error?: string };

export function normalizeQuestions(params: Params): Question[] {
	if (!params.questions.length) throw new Error("At least one question is required.");
	const questions = params.questions.map((item, index): Question => {
		const type = item.type ?? (item.options?.length ? (item.multiSelect ? "multi" : "single") : "text");
		const options = (item.options ?? []).map((option, i) => ({ ...option, id: option.id ?? `option-${i + 1}` }));
		if (!item.question.trim()) throw new Error("Question text cannot be blank.");
		if (new Set(options.map((option) => option.id)).size !== options.length)
			throw new Error("Option IDs must be unique within each question.");
		if (options.some((option) => !option.label.trim())) throw new Error("Option labels cannot be blank.");
		if (item.type && item.multiSelect && item.type !== "multi") throw new Error("type conflicts with multiSelect.");
		if (type === "text" && options.length) throw new Error("Text questions cannot have options.");
		if (!options.length && type !== "text") throw new Error("Selection questions require options.");
		// Legacy optionless questions still require explicit permission for text input.
		if (!item.type && !options.length && !item.allowOther)
			throw new Error("askquestions requires options or allowOther=true.");
		const required = item.required !== false;
		const min = Math.max(item.minSelections ?? 0, required ? 1 : 0);
		const max = item.maxSelections ?? options.length;
		if (type !== "multi" && (item.minSelections !== undefined || item.maxSelections !== undefined))
			throw new Error("Selection limits require a multi question.");
		if (type === "multi" && (min > max || max > options.length)) throw new Error("Invalid selection limits.");
		const q = { ...item, id: item.id ?? `question-${index + 1}`, type, options, required };
		const defaults =
			item.defaultSelection === undefined
				? []
				: typeof item.defaultSelection === "string"
					? [item.defaultSelection]
					: item.defaultSelection;
		if (type === "text" && item.defaultSelection !== undefined)
			throw new Error("Text questions do not support defaultSelection; use defaultValue.");
		if (type !== "text" && item.defaultValue !== undefined) throw new Error("defaultValue requires a text question.");
		if (item.maxLength !== undefined && type !== "text" && !item.allowOther)
			throw new Error("maxLength requires text or custom answers.");
		if (item.maxLength !== undefined && (!Number.isInteger(item.maxLength) || item.maxLength < 0))
			throw new Error("maxLength must be a nonnegative integer.");
		if (
			item.defaultValue !== undefined &&
			item.maxLength !== undefined &&
			Array.from(item.defaultValue).length > item.maxLength
		)
			throw new Error("defaultValue exceeds maxLength.");
		if (type === "single" && defaults.length > 1)
			throw new Error("Single questions accept only one default selection.");
		if (defaults.some((id) => !options.some((option) => option.id === id)))
			throw new Error("Unknown default option ID.");
		if (new Set(defaults).size !== defaults.length) throw new Error("Default option IDs must be unique.");
		if (type === "multi" && defaults.length > max) throw new Error("Defaults exceed maxSelections.");
		return q;
	});
	if (new Set(questions.map((q) => q.id)).size !== questions.length) throw new Error("Question IDs must be unique.");
	return questions;
}

export function initialDraft(q: Question): Draft {
	const defaults =
		q.defaultSelection === undefined
			? []
			: typeof q.defaultSelection === "string"
				? [q.defaultSelection]
				: q.defaultSelection;
	return {
		indices: q.options.flatMap((option, i) => (defaults.includes(option.id) ? [i] : [])),
		text: q.defaultValue ?? "",
		custom: q.type === "text",
	};
}

/** Shared by submission and final review; never filters away invalid selections. */
export function validateAnswer(q: Question, draft: Draft): Answer {
	if (draft.custom) {
		if (q.type !== "text" && !q.allowOther) throw new Error("Custom answers are not enabled.");
		if (q.required && !draft.text.trim()) throw new Error("An answer is required.");
		if (q.maxLength !== undefined && Array.from(draft.text).length > q.maxLength)
			throw new Error(`Use at most ${q.maxLength} characters.`);
		return { id: q.id, question: q.question, answer: draft.text, optionIds: [], custom: true };
	}
	if (q.type === "text") throw new Error("Enter a text answer.");
	if (draft.indices.some((i) => !Number.isInteger(i) || i < 0 || i >= q.options.length))
		throw new Error("Choose only listed options.");
	const indices = [...new Set(draft.indices)].sort((a, b) => a - b);
	const min = q.type === "multi" ? Math.max(q.minSelections ?? 0, q.required ? 1 : 0) : q.required ? 1 : 0;
	const max = q.type === "multi" ? (q.maxSelections ?? q.options.length) : 1;
	if (indices.length < min) throw new Error(`Choose at least ${min} option${min === 1 ? "" : "s"}.`);
	if (indices.length > max) throw new Error(`Choose at most ${max} option${max === 1 ? "" : "s"}.`);
	const options = indices.map((i) => q.options[i]!);
	return {
		id: q.id,
		question: q.question,
		answer: q.type === "multi" ? options.map((o) => o.label) : (options[0]?.label ?? ""),
		optionIds: options.map((o) => o.id),
		custom: false,
	};
}

export function outcome(status: Outcome, answers: Answer[] = [], error?: string): Result {
	return { status, answers, cancelled: status !== "answered", ...(error ? { error } : {}) };
}
