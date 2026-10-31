import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "./host.ts";
import { AskQuestionParams, normalizeQuestions, outcome, type Result } from "./lib/question-model.ts";
import { askRpcQuestions } from "./lib/question-rpc.ts";
import { QuestionScreen } from "./lib/question-ui.ts";

/** Pi owns terminal input, rendering, raw mode and editor restoration. */
export default function askQuestion(pi: ExtensionAPI) {
	let active: AbortController | undefined;
	pi.on("session_shutdown", async () => {
		active?.abort();
	});

	pi.registerTool({
		name: "askquestions",
		label: "Ask Questions",
		description:
			"Ask the user related clarification questions in TUI or RPC mode and wait for validated answers. Options may have stable IDs. Supports single, multi, and multiline text questions, custom answers, defaultSelection (option IDs), defaultValue (editable text), selection limits, and required/optional answers. Legacy options/multiSelect/allowOther calls remain supported.",
		parameters: AskQuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = (details: Result) => ({
				content: [{ type: "text" as const, text: JSON.stringify(details) }],
				details,
			});
			if (signal?.aborted) return result(outcome("aborted"));
			if (
				!ctx.hasUI ||
				(ctx.mode !== "rpc" &&
					(ctx.mode !== "tui" ||
						!process.stdin.isTTY ||
						!process.stdout.isTTY ||
						process.stdin.destroyed ||
						process.stdin.readableEnded ||
						process.stdout.destroyed))
			) {
				return result(
					outcome(
						"requires_interaction",
						[],
						"askquestions requires RPC dialog support or an interactive TUI with terminal input/output.",
					),
				);
			}
			// sequential protects model batches; this guard also protects direct overlapping calls.
			if (active) return result(outcome("error", [], "Another askquestions interaction is already active."));
			const controller = new AbortController();
			active = controller;
			const interactionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			let screen: QuestionScreen | undefined;
			try {
				const questions = normalizeQuestions(params);
				if (ctx.mode === "rpc") return result(await askRpcQuestions(questions, ctx.ui, interactionSignal));
				const details = await ctx.ui.custom<Result>(
					(tui, theme, keybindings, done) => {
						screen = new QuestionScreen(questions, tui, theme, done, keybindings, interactionSignal);
						return screen;
					},
					{ blocked: { kind: "question", message: questions[0].question } },
				);
				return result(details);
			} catch (error) {
				return result(
					outcome(
						interactionSignal.aborted ? "aborted" : "error",
						[],
						error instanceof Error ? error.message : String(error),
					),
				);
			} finally {
				screen?.dispose();
				active = undefined;
			}
		},

		renderResult(result, _options, theme) {
			const details = result.details as Result | undefined;
			if (!details) {
				const text = result.content.find((entry) => entry.type === "text");
				return new Text(text?.type === "text" ? text.text : "askquestions", 0, 0);
			}
			// Resumed sessions may contain results from the original label-only tool.
			const status = details.status ?? (details.cancelled ? "cancelled" : "answered");
			if (status !== "answered") {
				const text = (details.error ?? `askquestions: ${status}`).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
				return new Text(theme.fg(status === "error" ? "error" : "warning", text), 0, 0);
			}
			const lines = details.answers.map((entry) => {
				const answer = Array.isArray(entry.answer) ? entry.answer.join(", ") : entry.answer;
				const text = `${entry.question}: ${answer}`.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
				return theme.fg("success", "✓ ") + text;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
