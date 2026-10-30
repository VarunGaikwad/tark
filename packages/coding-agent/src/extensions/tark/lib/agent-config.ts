export const agentNames = ["plan", "orchestrator", "debug", "ask", "code"] as const;
export type AgentName = (typeof agentNames)[number];
export const effortLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof effortLevels)[number];

export interface AgentConfig {
	model?: string;
	small_model?: string;
	subagent_model?: string;
	auto_profile?: boolean;
	subagent_variant_overrides?: Partial<Record<AgentName, { model?: string; effort?: Effort }>>;
}

/**
 * Static values written under tark in project settings.json.
 * Add new static AgentConfig properties here so project setup includes them.
 */
export const initialAgentConfigDefaults = {
	auto_profile: false,
} satisfies Pick<AgentConfig, "auto_profile">;

/** Header copy for incomplete project agent configuration. */
export type AgentConfigSetting = keyof AgentConfig;

export const agentConfigCapabilities = {
	model: "choose the default main model",
	small_model: "use a cheaper model for eligible small tasks",
	subagent_model: "choose the normal model for delegated work",
	auto_profile: "automatically select a profile for clear requests",
	subagent_variant_overrides: "customize model and effort for each agent profile",
} satisfies Record<AgentConfigSetting, string>;

export function createInitialAgentConfig(selected: string, inherited: AgentConfig): AgentConfig {
	const efforts: Record<AgentName, Effort> = {
		plan: "high",
		orchestrator: "high",
		debug: "high",
		ask: "low",
		code: "medium",
	};
	const overrides: NonNullable<AgentConfig["subagent_variant_overrides"]> = {};
	for (const name of agentNames) {
		overrides[name] = {
			model: inherited.subagent_model ?? selected,
			effort: efforts[name],
			...inherited.subagent_variant_overrides?.[name],
		};
	}
	return {
		model: selected,
		small_model: inherited.small_model ?? selected,
		subagent_model: inherited.subagent_model ?? selected,
		auto_profile: inherited.auto_profile ?? initialAgentConfigDefaults.auto_profile,
		subagent_variant_overrides: overrides,
	};
}
