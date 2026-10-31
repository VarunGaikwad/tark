import type { ExtensionAPI } from "./host.ts";
import { blockedBashReason, deniedPath } from "./lib/access-policy.ts";

const pathTools = new Set(["read", "edit", "write", "grep", "find", "ls"]);

/** Block protected project paths before built-in file tools execute. This is not OS isolation. */
export default function accessGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as { command?: unknown; path?: unknown };
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const reason = typeof input.command === "string" ? blockedBashReason(input.command) : undefined;
			return reason ? { block: true, reason } : undefined;
		}
		if (!pathTools.has(event.toolName)) return;
		const path = input.path;
		if (typeof path !== "string") return;
		const mode = event.toolName === "edit" || event.toolName === "write" ? "write" : "read";
		const reason = await deniedPath(ctx.cwd, path, mode);
		return reason ? { block: true, reason: `Access to ${path} denied: ${reason}.` } : undefined;
	});
}
