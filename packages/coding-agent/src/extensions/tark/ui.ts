import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { addUsageToTotals, createUsageTotals } from "../../core/usage-totals.ts";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getTarkResourcesDir,
	KeybindingsManager,
	type SessionEntry,
} from "./host.ts";
import { agentConfigCapabilities } from "./lib/agent-config.ts";
import { hasProjectAgentConfig, loadAgentConfig } from "./lib/agents.ts";
import { createFooterGitTracker } from "./lib/ui-git.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const WORDMARK = ["TARK", "Coding agent"];
const WORDMARK_WIDTH = Math.max(...WORDMARK.map((line) => visibleWidth(line)));

const fmt = (n: number) => {
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
};

type FooterTotals = {
	prompts: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	models: string[];
	startedAt?: number;
};

function sessionTotals(entries: readonly SessionEntry[], startedAt?: number): FooterTotals {
	const models = new Set<string>();
	let prompts = 0;
	const totals = createUsageTotals();
	let earliest = startedAt;
	for (const entry of entries) {
		const timestamp = Date.parse(entry.timestamp);
		if (earliest === undefined && Number.isFinite(timestamp)) earliest = timestamp;
		if (entry.type === "usage") {
			models.add(entry.model);
			addUsageToTotals(totals, entry.usage);
			continue;
		}
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(totals, entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") prompts++;
		if (entry.message.role === "assistant" && typeof entry.message.model === "string")
			models.add(entry.message.model);
		if (entry.message.role !== "assistant" && entry.message.role !== "toolResult") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		if (entry.message.role === "toolResult" && entry.message.toolName === "subagent") {
			const details = entry.message.details;
			if (details && typeof details === "object" && "model" in details && typeof details.model === "string") {
				const slash = details.model.indexOf("/");
				models.add(slash < 0 ? details.model : details.model.slice(slash + 1));
			}
		}
		addUsageToTotals(totals, usage);
	}
	return { prompts, ...totals, models: [...models], startedAt: earliest };
}

function elapsedSince(timestamp: number | undefined): string | undefined {
	if (timestamp === undefined) return undefined;
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	if (seconds >= 3_600) return `⏱ ${Math.floor(seconds / 3_600)}h${Math.floor(seconds / 60) % 60}m elapsed`;
	if (seconds >= 60) return `⏱ ${Math.floor(seconds / 60)}m${seconds % 60}s elapsed`;
	return `⏱ ${seconds}s elapsed`;
}

type FitField = { text: string; min: number; priority?: number };

// Every field gets its own budget; no long label can consume a core neighbour.
function fitFields(fields: FitField[], sep: string, width: number): string {
	const kept = [...fields];
	while (
		kept.length > 1 &&
		kept.reduce((n, field) => n + visibleWidth(field.text), 0) + visibleWidth(sep) * (kept.length - 1) > width
	) {
		let weakest = -1;
		kept.forEach((field, index) => {
			if (field.priority !== undefined && (weakest < 0 || field.priority < kept[weakest].priority!)) weakest = index;
		});
		if (weakest < 0) break;
		kept.splice(weakest, 1);
	}
	let remaining = Math.max(0, width - visibleWidth(sep) * Math.max(0, kept.length - 1));
	return truncateToWidth(
		kept
			.map((field, index) => {
				const laterMinimum = kept
					.slice(index + 1)
					.reduce((n, next) => n + Math.min(next.min, visibleWidth(next.text)), 0);
				const budget = Math.min(visibleWidth(field.text), Math.max(0, remaining - laterMinimum));
				remaining -= budget;
				return truncateToWidth(field.text, budget, "…");
			})
			.join(sep),
		width,
		"…",
	);
}

function capacityLabel(contextWindow: number | null | undefined): string {
	if (contextWindow == null || !Number.isFinite(contextWindow)) return "of —";
	return contextWindow < 1_000_000
		? `of ${Math.round(contextWindow / 1_000)}k`
		: `of ${(contextWindow / 1_000_000).toFixed(2)}M`;
}

export default function (pi: ExtensionAPI) {
	const cycleHint = KeybindingsManager.create().getKeys("app.profile.cycle").join("/");
	// Jiti can retain imported JSON across reloads; read it once per extension runtime.
	const tipList: { category: string; text: string }[] = JSON.parse(
		readFileSync(join(getTarkResourcesDir(), "ui-tips.json"), "utf8"),
	);
	if (
		!Array.isArray(tipList) ||
		tipList.some(
			(tip) =>
				typeof tip?.category !== "string" ||
				!tip.category.trim() ||
				typeof tip?.text !== "string" ||
				!tip.text.trim(),
		)
	) {
		throw new Error("Invalid ui-tips.json: expected tips with non-empty category and text strings.");
	}

	let state = "ready";
	let activeTool = "";
	let redraw = () => {};
	let remainingTips: typeof tipList = [];
	let agentSetupTips: string[] = [];
	let refreshFooterMetrics = () => {};
	let refreshGit = () => {};

	function update() {
		redraw();
	}

	function updateTitle(ctx: ExtensionContext) {
		if (ctx.mode === "tui") ctx.ui.setTitle(`Tark · ${pi.getSessionName() || "Untitled session"}`);
	}

	pi.on("session_info_changed", async (_event, ctx) => {
		updateTitle(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		state = "ready";
		activeTool = "";
		redraw = () => {};
		refreshFooterMetrics = () => {};
		refreshGit = () => {};
		if (ctx.mode !== "tui") return;

		agentSetupTips = [];
		try {
			if (ctx.isProjectTrusted() && (await hasProjectAgentConfig(ctx.cwd))) {
				const config = await loadAgentConfig(ctx.cwd, getAgentDir(), true);
				for (const key of Object.keys(agentConfigCapabilities) as (keyof typeof agentConfigCapabilities)[]) {
					if (config[key] === undefined)
						agentSetupTips.push(`Settings: add tark.${key} to ${agentConfigCapabilities[key]}.`);
				}
			}
		} catch {
			agentSetupTips = ["Settings: fix the tark object in settings.json so Tark can apply your agent settings."];
		}
		const selectedTips: typeof tipList = [];
		for (let i = 0; i < Math.min(3, tipList.length); i++) {
			if (remainingTips.length === 0) {
				remainingTips = tipList.filter((tip) => !selectedTips.includes(tip));
			}
			const differentCategories = remainingTips.filter(
				(tip) => !selectedTips.some((selected) => selected.category === tip.category),
			);
			const candidates = differentCategories.length > 0 ? differentCategories : remainingTips;
			const tip = candidates[Math.floor(Math.random() * candidates.length)];
			selectedTips.push(remainingTips.splice(remainingTips.indexOf(tip), 1)[0]);
		}

		updateTitle(ctx);

		// Headers are rendered once at the top of the startup view. A widget would
		// stay attached to the editor forever, making the onboarding copy noisy.
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number) {
				if (width <= 0) return [];

				const left =
					width < WORDMARK_WIDTH
						? [`${theme.fg("accent", "✦")} ${theme.bold("Tark")}`]
						: WORDMARK.map((line) => theme.fg("accent", line));

				const tips = [
					theme.fg("accent", theme.bold("Get started with Tark")),
					theme.fg("muted", "Questions, skills, prompts & stats."),
					...agentSetupTips.map((tip) => theme.fg("warning", tip)),
					...selectedTips.map(
						(tip) => `${theme.fg("accent", `[${tip.category}]`)} ${theme.fg("muted", tip.text)}`,
					),
					theme.fg("dim", "/help · /sound · /summary · /commit"),
				];
				const tipWidth = width - WORDMARK_WIDTH - 3;
				if (tipWidth >= 32) {
					const right = tips.flatMap((line) => wrapTextWithAnsi(line, tipWidth));
					return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
						const line = truncateToWidth(left[index] ?? "", WORDMARK_WIDTH, "");
						const padding = " ".repeat(WORDMARK_WIDTH - visibleWidth(line) + 3);
						return line + padding + (right[index] ?? "");
					});
				}

				return [
					...left.map((line) => truncateToWidth(line, width, "")),
					"",
					...tips.flatMap((line) => wrapTextWithAnsi(line, width)),
				];
			},
			invalidate() {},
		}));

		ctx.ui.setFooter((tui, theme, footerData) => {
			redraw = () => tui.requestRender();
			const getSessionStart = () => {
				const timestamp = ctx.sessionManager.getHeader?.()?.timestamp;
				const parsed = timestamp ? Date.parse(timestamp) : NaN;
				return Number.isFinite(parsed) ? parsed : undefined;
			};
			let totals = sessionTotals(ctx.sessionManager.getEntries(), getSessionStart());
			refreshFooterMetrics = () => {
				totals = sessionTotals(ctx.sessionManager.getEntries(), getSessionStart());
			};
			const git = createFooterGitTracker(ctx.cwd, () => tui.requestRender());
			git.refresh();
			const unsubscribe = footerData.onBranchChange(() => {
				git.refresh();
				tui.requestRender();
			});
			refreshGit = () => git.refresh();

			let titleTicks = 0;
			const timer = setInterval(() => {
				if (state !== "ready") tui.requestRender();
				// Pi can reset the title after session_start and delayed Windows startup checks.
				if (++titleTicks >= 10) {
					titleTicks = 0;
					updateTitle(ctx);
				}
			}, 100);
			timer.unref?.();

			return {
				invalidate() {},

				render(width: number) {
					if (width <= 0) return [];
					const dim = (s: string) => theme.fg("dim", s);
					const muted = (s: string) => theme.fg("muted", s);
					const sep = dim(" · ");
					const frame = SPINNER[Math.floor(Date.now() / 100) % SPINNER.length];
					const activity =
						state === "tool" ? `${frame} ${activeTool}` : state === "thinking" ? `${frame} thinking` : "● ready";
					const agent = footerData.getExtensionStatuses?.().get("tark-agent");
					const agentMode = footerData.getExtensionStatuses?.().get("tark-agent-mode");
					const modelName = ctx.model?.name ?? ctx.model?.id ?? "—";
					const usage = ctx.getContextUsage();
					const reportedPercent = usage?.percent;
					const pct = reportedPercent != null && Number.isFinite(reportedPercent) ? reportedPercent : null;
					const tone = pct == null ? "dim" : pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
					const pctText = pct == null ? "—" : `${Math.round(pct)}%`;
					// The bar is bounded even if a provider reports an impossible percentage.
					const cells = Math.max(0, Math.min(8, Math.floor((width - 18) / 2)));
					const filled = pct == null ? 0 : Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells);
					const context = `${muted("ctx")} ${theme.fg(tone, "▰".repeat(filled))}${dim("▱".repeat(cells - filled))} ${theme.fg(tone, pctText)} ${dim(capacityLabel(usage?.contextWindow))}`;
					const stats = git.getStats();
					const branch = stats?.branch ?? footerData.getGitBranch?.();
					const project = `${basename(ctx.cwd)}${branch ? ` ⎇ ${branch}${stats?.dirty ? " ●" : ""}` : ""}`;
					const projectReserve = width >= 56 ? 16 : 0;
					const modelBudget = Math.max(4, width - visibleWidth(context) - visibleWidth(sep) - projectReserve);
					const row1 = fitFields(
						[
							{ text: truncateToWidth(modelName, modelBudget, "…"), min: 4 },
							{ text: muted(`think ${pi.getThinkingLevel()}`), min: 0, priority: 2 },
							{ text: context, min: visibleWidth(context) },
							{ text: dim(`💬 ${totals.prompts}`), min: 0, priority: 1 },
							...(projectReserve ? [{ text: dim(project), min: 0 }] : []),
						],
						sep,
						width,
					);

					const inclusiveInput = totals.input + totals.cacheRead + totals.cacheWrite;
					const hitBase = totals.input + totals.cacheRead + totals.cacheWrite;
					const hit = hitBase > 0 ? Math.round((totals.cacheRead / hitBase) * 100) : 0;
					const costText = `$${totals.cost.toFixed(3)}`;
					const elapsed = elapsedSince(totals.startedAt);
					const history = totals.models.length > 1 ? totals.models : [];
					const row2 = fitFields(
						[
							...(agent
								? [
										{
											text: theme.fg("accent", agentMode && width >= 64 ? `${agent} (${agentMode})` : agent),
											min: Math.min(visibleWidth(agent), 18),
										},
									]
								: []),
							{ text: theme.fg(state === "ready" ? "success" : "accent", activity), min: 8 },
							{ text: muted(`↓ ${fmt(inclusiveInput)} in ↑ ${fmt(totals.output)} out`), min: 0, priority: 5 },
							{
								text: dim(`cache R ${fmt(totals.cacheRead)} W ${fmt(totals.cacheWrite)} (${hit}% hit)`),
								min: 0,
								priority: 4,
							},
							...(elapsed ? [{ text: dim(elapsed), min: 0, priority: 3 }] : []),
							...(stats && (stats.added || stats.removed)
								? [{ text: dim(`+${stats.added} −${stats.removed}`), min: 0, priority: 2 }]
								: []),
							...(history.length > 0
								? [{ text: dim(`models ${history.join(", ")}`), min: 0, priority: 1 }]
								: []),
							...(agent && cycleHint ? [{ text: dim(`[${cycleHint}]`), min: 0, priority: 0 }] : []),
							{ text: muted(costText), min: visibleWidth(costText) },
						],
						sep,
						width,
					);

					const children = footerData.getExtensionStatuses?.().get("tark-subagents");
					return children ? [row1, row2, theme.fg("accent", truncateToWidth(children, width, "…"))] : [row1, row2];
				},

				dispose() {
					clearInterval(timer);
					unsubscribe();
					git.dispose();
					redraw = () => {};
					refreshFooterMetrics = () => {};
					refreshGit = () => {};
				},
			};
		});

		update();
	});

	pi.on("agent_start", async () => {
		state = "thinking";
		activeTool = "";
		refreshFooterMetrics();
		update();
	});

	pi.on("turn_start", async () => {
		state = "thinking";
		activeTool = "";
		update();
	});

	pi.on("message_end", async () => {
		refreshFooterMetrics();
		refreshGit();
		update();
	});

	pi.on("session_compact", async () => {
		refreshFooterMetrics();
		refreshGit();
		update();
	});

	pi.on("session_tree", async () => {
		refreshFooterMetrics();
		update();
	});

	pi.on("tool_execution_end", async () => {
		refreshFooterMetrics();
		refreshGit();
		update();
	});

	pi.on("tool_call", async (event) => {
		state = "tool";
		activeTool = event.toolName;
		update();
	});

	pi.on("agent_settled", async () => {
		state = "ready";
		activeTool = "";
		refreshFooterMetrics();
		refreshGit();
		update();
	});

	pi.on("model_select", async () => {
		refreshFooterMetrics();
		update();
	});

	pi.on("thinking_level_select", async () => {
		update();
	});
}
