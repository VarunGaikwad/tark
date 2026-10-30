import { type ExtensionAPI, getAgentDir } from "./host.ts";
import { hasProjectAgentConfig, initializeAgentConfig } from "./lib/agents.ts";
import {
	hasToolOverrides,
	readSetupSettings,
	saveSetupChoice,
	setupChoice,
	toolsToOffer,
} from "./lib/recommended-tools.ts";

/** Offer project-local setup automatically, never silently change tool policy. */
export default function recommendedTools(pi: ExtensionAPI) {
	const visited = new Set<string>();
	let pending: AbortController | undefined;
	pi.on("session_shutdown", async () => {
		pending?.abort();
	});

	pi.on("session_start", async (_event, ctx) => {
		if (
			ctx.mode !== "tui" ||
			!ctx.hasUI ||
			!process.stdin.isTTY ||
			!process.stdout.isTTY ||
			process.stdin.destroyed ||
			process.stdin.readableEnded ||
			process.stdout.destroyed ||
			!ctx.isProjectTrusted() ||
			hasToolOverrides(process.argv.slice(2)) ||
			visited.has(ctx.cwd) ||
			pending
		)
			return;
		visited.add(ctx.cwd);
		const controller = new AbortController();
		pending = controller;
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
		const availableTools = () =>
			pi
				.getAllTools()
				.filter((tool) => tool.sourceInfo.source === "builtin")
				.map((tool) => tool.name);
		try {
			const settings = await readSetupSettings(ctx.cwd);
			const tools = toolsToOffer(settings, availableTools(), pi.getActiveTools());
			const agentsAvailable = () => pi.getAllTools().some((tool) => tool.name === "subagent");
			const setupAgents =
				agentsAvailable() &&
				setupChoice(settings, "agentSetup") !== "disabled" &&
				!(await hasProjectAgentConfig(ctx.cwd));
			if ((!tools.length && !setupAgents) || signal.aborted) return;
			const choice = await ctx.ui.select(
				`Enable Tark setup for this project?\n${tools.length ? `${tools.join(" · ")}\nSaves .tark/settings.json and enables tools now.\n` : ""}${setupAgents ? "Adds default agent models under tark in .tark/settings.json." : ""}`,
				["Not now", "Enable", "Don't ask again"],
				{ signal },
			);
			if (signal.aborted || !ctx.isProjectTrusted() || choice === undefined || choice === "Not now") return;
			if (choice !== "Enable" && choice !== "Don't ask again") return;
			if (
				choice === "Enable" &&
				(tools.some((name) => !availableTools().includes(name)) || (setupAgents && !agentsAvailable()))
			) {
				ctx.ui.notify("Tool availability changed during setup; no settings were saved.", "warning");
				return;
			}
			const preference = choice === "Enable" ? "enabled" : "disabled";
			await saveSetupChoice(settings, preference, tools, undefined, signal, setupAgents ? preference : undefined);
			if (choice === "Enable" && !signal.aborted) {
				if (tools.length) {
					pi.setActiveTools([...new Set([...pi.getActiveTools(), ...tools])]);
					ctx.ui.notify(`Enabled ${tools.join(", ")} and saved this project's preference.`, "info");
				}
				if (!setupAgents) return;
				try {
					const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
					if (await initializeAgentConfig(ctx.cwd, getAgentDir(), currentModel, signal)) {
						ctx.ui.notify(
							"Added default agent models under tark in .tark/settings.json. Edit it to customize models and effort.",
							"info",
						);
					}
				} catch (error) {
					if (!signal.aborted)
						ctx.ui.notify(
							`Agent configuration was not created: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
				}
			}
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(
					`Tark tool setup skipped: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		} finally {
			pending = undefined;
		}
	});
}
