export const soundEvents = ["attention", "finished", "failure"] as const;
export type SoundEvent = (typeof soundEvents)[number];
export interface SoundPreferences {
	enabled: boolean;
	events: Record<SoundEvent, boolean>;
	minimumDurationMs: number;
}
export function defaultSoundPreferences(): SoundPreferences {
	return { enabled: false, events: { attention: true, finished: true, failure: true }, minimumDurationMs: 5000 };
}

export function validateSoundPreferences(value: unknown): SoundPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sound preferences");
	const source = value as Partial<SoundPreferences>;
	if (
		source.events !== undefined &&
		(!source.events || typeof source.events !== "object" || Array.isArray(source.events))
	)
		throw new Error("Invalid sound events");
	const defaults = defaultSoundPreferences();
	const item = { ...defaults, ...source, events: { ...defaults.events, ...source.events } };
	if (
		typeof item.enabled !== "boolean" ||
		!item.events ||
		soundEvents.some((event) => typeof item.events[event] !== "boolean") ||
		!Number.isFinite(item.minimumDurationMs) ||
		item.minimumDurationMs < 0 ||
		item.minimumDurationMs > 3_600_000
	) {
		throw new Error("Invalid sound preferences");
	}
	return {
		enabled: item.enabled,
		events: { attention: item.events.attention, finished: item.events.finished, failure: item.events.failure },
		minimumDurationMs: item.minimumDurationMs,
	};
}

export interface SoundSignal {
	type: string;
	message?: unknown;
	aborted?: unknown;
	outcome?: unknown;
}

/** Notifications follow the whole operation, never individual tools or retry attempts. */
export class SoundNotifications {
	private startedAt: number | undefined;
	private failed = false;
	private aborted = false;
	private waiting = false;
	private runtimeFailed = false;

	reset(): void {
		this.startedAt = undefined;
		this.failed = this.aborted = this.waiting = this.runtimeFailed = false;
	}

	accept(event: SoundSignal, minimumDurationMs = 5000, now = Date.now()): SoundEvent | undefined {
		if (event.type === "agent_start") {
			if (this.startedAt === undefined) this.startedAt = now;
			this.failed = this.aborted = this.runtimeFailed = false;
		}
		if (event.type === "runtime_error") {
			if (this.runtimeFailed) return;
			this.reset();
			this.runtimeFailed = true;
			return "failure";
		}
		if (this.startedAt === undefined) return;
		if (event.type === "message_end") {
			const message = event.message as { role?: string; stopReason?: string } | undefined;
			if (message?.role === "assistant") {
				this.failed = message.stopReason === "error";
				this.aborted = message.stopReason === "aborted";
			}
		}
		if (event.type === "agent_before_settle") {
			this.failed = event.outcome === "error";
			this.aborted = event.outcome === "aborted";
		}
		if (event.type === "ui_prompt_start") {
			if (this.waiting) return;
			this.waiting = true;
			return "attention";
		}
		if (event.type === "ui_prompt_end") this.waiting = false;
		if (event.type !== "agent_settled") return;
		const duration = now - this.startedAt;
		const result =
			event.aborted === true || this.aborted
				? undefined
				: this.failed
					? "failure"
					: duration >= minimumDurationMs
						? "finished"
						: undefined;
		this.reset();
		return result;
	}
}
