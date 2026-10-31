// Offline provider fixture shared by parent and delegated CLI smoke processes.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export default function offlineTark(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "tark-offline-test",
		models: [{ id: "local", name: "Local fixture", reasoning: true }],
	});
	faux.setResponses(
		process.env.TARK_SUBAGENT_DEPTH
			? [fauxAssistantMessage("CHILD_VERIFIED")]
			: [
					fauxAssistantMessage(
						[fauxToolCall("subagent", { agent: "ask", mode: "read", task: "Return CHILD_VERIFIED" })],
						{ stopReason: "toolUse" },
					),
					(context) => {
						const result = context.messages.findLast(
							(message) => message.role === "toolResult" && message.toolName === "subagent",
						);
						return fauxAssistantMessage(
							result?.role === "toolResult" && !result.isError ? "PARENT_VERIFIED" : "PARENT_FAILED",
						);
					},
				],
	);
	pi.registerProvider(faux.provider);
}
