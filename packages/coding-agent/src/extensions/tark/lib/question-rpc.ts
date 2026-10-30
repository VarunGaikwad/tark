// Collect validated question drafts through the existing RPC dialog API.
import type { ExtensionContext } from "../host.ts";
import {
	type Answer,
	type Draft,
	initialDraft,
	outcome,
	type Question,
	type Result,
	validateAnswer,
} from "./question-model.ts";

/** RPC uses indexed display strings, never labels, to recover stable option IDs. */
export async function askRpcQuestions(
	questions: Question[],
	ui: Pick<ExtensionContext["ui"], "select" | "editor" | "confirm">,
	signal: AbortSignal,
): Promise<Result> {
	const drafts = questions.map(initialDraft);
	const answers = new Map<number, Answer>();
	const result = (status: Result["status"], error?: string) =>
		outcome(
			status,
			questions.flatMap((_, i) => (answers.has(i) ? [answers.get(i)!] : [])),
			error,
		);
	// editor() has no signal option. Stop waiting locally and ignore a late client response.
	const dialog = async <T>(open: () => Promise<T>): Promise<T> => {
		signal.throwIfAborted();
		let abort: () => void = () => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			const value = await Promise.race([open(), cancelled]);
			signal.throwIfAborted();
			return value;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
	const select = (title: string, choices: string[]) => dialog(() => ui.select(title, choices, { signal }));
	try {
		let current = 0;
		let error = "";
		while (true) {
			if (current === questions.length) {
				const summary = questions
					.map((q, i) => {
						const value = answers.get(i)!.answer;
						return `${i + 1}. ${q.question}: ${Array.isArray(value) ? value.join(", ") : value}`;
					})
					.join("\n");
				const actions = ["Submit answers", ...questions.map((q, i) => `Edit ${i + 1}. ${q.question}`)];
				const choice = await select(`Review answers\n${summary}`, actions);
				if (choice === undefined) return result("cancelled");
				const index = actions.indexOf(choice);
				if (index < 0) throw new Error("Choose a listed review action.");
				if (index === 0) {
					if (!(await dialog(() => ui.confirm("Submit answers?", summary, { signal }))))
						return result("cancelled");
					return outcome(
						"answered",
						questions.map((q, i) => validateAnswer(q, drafts[i]!)),
					);
				}
				current = index - 1;
				continue;
			}
			const q = questions[current]!;
			const draft: Draft = drafts[current]!;
			const title = `${current + 1}/${questions.length}. ${q.question}${error ? `\n${error}` : ""}`;
			if (draft.custom) {
				if (q.type !== "text") {
					const choice = await select(title, ["Edit custom answer", "Return to options"]);
					if (choice === undefined) return result("cancelled");
					if (choice === "Return to options") {
						draft.custom = false;
						answers.delete(current);
						continue;
					}
					if (choice !== "Edit custom answer") throw new Error("Choose a listed custom answer action.");
				}
				const text = await dialog(() => ui.editor(title, draft.text));
				if (text === undefined) return result("cancelled");
				draft.text = text;
			} else {
				const options = q.options.map(
					(option, i) =>
						`${i + 1}. ${draft.indices.includes(i) ? "[x] " : ""}${option.label}${option.description ? ` — ${option.description}` : ""}`,
				);
				const actions = [...options];
				// select() has no initial index; put the single-choice default under the native cursor.
				const selected = q.type === "single" ? draft.indices[0] : undefined;
				if (selected !== undefined) actions.unshift(...actions.splice(selected, 1));
				const custom = q.allowOther ? actions.push("Custom answer") - 1 : -1;
				const skip = !q.required ? actions.push("Skip (no answer)") - 1 : -1;
				const done = q.type === "multi" ? actions.push("Done selecting") - 1 : -1;
				const counts =
					q.type === "multi"
						? `\n${draft.indices.length} selected; choose ${Math.max(q.minSelections ?? 0, q.required ? 1 : 0)}–${q.maxSelections ?? q.options.length}. Select again to toggle.`
						: "";
				const choice = await select(title + counts, actions);
				if (choice === undefined) return result("cancelled");
				const index = actions.indexOf(choice);
				if (index < 0) throw new Error("Choose a listed option.");
				if (index === custom) {
					answers.delete(current);
					draft.custom = true;
					continue;
				}
				if (index === skip) draft.indices = [];
				else if (index !== done) {
					draft.indices =
						q.type === "single"
							? [options.indexOf(choice)]
							: draft.indices.includes(index)
								? draft.indices.filter((i) => i !== index)
								: [...draft.indices, index];
					if (q.type === "multi") {
						answers.delete(current);
						error = "";
						continue;
					}
				}
			}
			answers.delete(current);
			try {
				answers.set(current, validateAnswer(q, draft));
				error = "";
				current++;
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			}
		}
	} catch (cause) {
		return result(
			signal.aborted ? "aborted" : "error",
			signal.aborted ? undefined : cause instanceof Error ? cause.message : String(cause),
		);
	}
}
