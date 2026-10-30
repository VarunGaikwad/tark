import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "./host.ts";
import { readSoundSettings, SoundPlayer, saveSoundSettings } from "./lib/sound.ts";
import {
	defaultSoundPreferences,
	type SoundEvent,
	SoundNotifications,
	type SoundSignal,
	soundEvents,
} from "./lib/sound-events.ts";

export default function sound(
	pi: ExtensionAPI,
	dependencies: {
		agentDir?: string;
		player?: Pick<SoundPlayer, "play" | "stop" | "status" | "lastError">;
		terminal?: () => boolean;
		now?: () => number;
	} = {},
) {
	const agentDir = dependencies.agentDir ?? getAgentDir();
	const player = dependencies.player ?? new SoundPlayer(agentDir);
	const notifications = new SoundNotifications();
	let preferences = defaultSoundPreferences();
	let prompted = false;
	let settingsOpen = false;
	let pending: AbortController | undefined;
	const terminal =
		dependencies.terminal ??
		(() =>
			Boolean(
				process.stdin.isTTY &&
					process.stdout.isTTY &&
					!process.stdin.destroyed &&
					!process.stdin.readableEnded &&
					!process.stdout.destroyed,
			));
	const interactive = (ctx: ExtensionContext) =>
		ctx.mode === "tui" && ctx.hasUI && terminal() && !Number(process.env.TARK_SUBAGENT_DEPTH);

	pi.on("session_start", async (_event, ctx) => {
		notifications.reset();
		player.stop();
		if (!interactive(ctx)) return;
		let startupSignal: AbortSignal | undefined;
		try {
			const previous = await readSoundSettings(agentDir);
			preferences = previous.preferences;
			if (previous.configured || prompted || pending) return;
			prompted = true;
			const controller = new AbortController();
			pending = controller;
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
			startupSignal = signal;
			try {
				// Session handlers are awaited in manifest order, after recommended-tool/agent setup.
				const choice = await ctx.ui.select(
					"Enable sound notifications?\nPlay sounds when the AI needs input, finishes, or encounters an unrecovered error.\nYou can always change this later with /sound.",
					["No", "Yes"],
					{ signal },
				);
				if (signal.aborted || (choice !== "Yes" && choice !== "No")) return;
				preferences = (
					await saveSoundSettings(agentDir, previous, { ...preferences, enabled: choice === "Yes" }, signal)
				).preferences;
			} finally {
				pending = undefined;
			}
		} catch (error) {
			preferences = defaultSoundPreferences();
			if (!startupSignal?.aborted)
				ctx.ui.notify(`Sound setup skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	const notify = (event: SoundSignal, ctx: ExtensionContext) => {
		if (!interactive(ctx)) return;
		if (event.type === "agent_settled" && ctx.hasPendingMessages()) return;
		const selected = notifications.accept(event, preferences.minimumDurationMs, dependencies.now?.());
		if (!settingsOpen && selected && preferences.enabled && preferences.events[selected]) void player.play(selected);
	};
	pi.on("agent_start", (event, ctx) => {
		notify(event, ctx);
	});
	pi.on("message_end", (event, ctx) => {
		notify(event, ctx);
	});
	pi.on("agent_settled", (event, ctx) => {
		notify(event, ctx);
	});
	pi.on("ui_prompt_start", (event, ctx) => {
		notify(event, ctx);
	});
	pi.on("ui_prompt_end", (event, ctx) => {
		notify(event, ctx);
	});

	pi.registerCommand("sound", {
		description: "Configure sound notifications: on, off, test [attention|finished|failure], status",
		handler: async (args, ctx) => {
			if (!interactive(ctx)) {
				ctx.ui.notify("/sound requires an interactive terminal.", "info");
				return;
			}
			if (pending || settingsOpen) return;
			settingsOpen = true;
			const controller = new AbortController();
			pending = controller;
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
			try {
				let previous = await readSoundSettings(agentDir);
				preferences = previous.preferences;
				const save = async () => {
					previous = await saveSoundSettings(agentDir, previous, preferences, signal);
					if (!preferences.enabled) player.stop();
				};
				const preview = async (event: SoundEvent) => {
					if (signal.aborted) return;
					if (!(await player.play(event, true)) && !signal.aborted)
						ctx.ui.notify(player.lastError ?? "Audio is busy. Try again after playback finishes.", "warning");
				};
				const [action, event, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === "on" || action === "off") {
					if (event) throw new Error("Use /sound on or /sound off");
					preferences = { ...preferences, enabled: action === "on" };
					await save();
					ctx.ui.notify(`Sound notifications ${preferences.enabled ? "enabled" : "disabled"}.`, "info");
				} else if (action === "status") {
					ctx.ui.notify(
						`Sounds: ${preferences.enabled ? "on" : "off"}; ${soundEvents.map((name) => `${name}: ${preferences.events[name] ? "on" : "off"}`).join(", ")}; completion minimum: ${preferences.minimumDurationMs / 1000}s.\n${await player.status()}`,
						"info",
					);
				} else if (action === "test") {
					if (extra.length || (event && !soundEvents.includes(event as SoundEvent)))
						throw new Error("Use /sound test [attention|finished|failure]");
					await preview((event as SoundEvent | undefined) ?? "attention");
				} else if (action) {
					throw new Error("Use /sound, /sound on, /sound off, /sound test [event], or /sound status");
				} else {
					while (!signal.aborted) {
						const choices = [
							`Sounds: ${preferences.enabled ? "on" : "off"}`,
							...soundEvents.map((name) => `${name}: ${preferences.events[name] ? "on" : "off"}`),
							`Completion minimum: ${preferences.minimumDurationMs / 1000}s`,
							"Preview attention",
							"Preview finished",
							"Preview failure",
							"Done",
						];
						const choice = await ctx.ui.select("Sound notifications", choices, { signal });
						if (!choice || choice === "Done" || signal.aborted) break;
						const index = choices.indexOf(choice);
						if (index === 0) {
							preferences = { ...preferences, enabled: !preferences.enabled };
							await save();
						} else if (index >= 1 && index <= 3) {
							const name = soundEvents[index - 1];
							preferences = {
								...preferences,
								events: { ...preferences.events, [name]: !preferences.events[name] },
							};
							await save();
						} else if (index === 4) {
							const duration = await ctx.ui.select(
								"Minimum run duration for completion sound",
								["0 seconds", "5 seconds", "15 seconds", "30 seconds"],
								{ signal },
							);
							if (duration && !signal.aborted) {
								preferences = { ...preferences, minimumDurationMs: Number.parseInt(duration, 10) * 1000 };
								await save();
							}
						} else if (index >= 5 && index <= 7) await preview(soundEvents[index - 5]);
					}
				}
			} catch (error) {
				if (!signal.aborted)
					ctx.ui.notify(`Sound settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
				// Failed writes must not enable notifications only in memory.
				try {
					preferences = (await readSoundSettings(agentDir)).preferences;
				} catch {
					preferences = defaultSoundPreferences();
				}
			} finally {
				settingsOpen = false;
				pending = undefined;
			}
		},
	});

	pi.on("session_shutdown", async () => {
		pending?.abort();
		notifications.reset();
		player.stop();
	});
}
