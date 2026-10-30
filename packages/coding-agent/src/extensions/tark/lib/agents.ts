import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "../host.ts";
import {
	type AgentConfig,
	type AgentName,
	agentNames,
	createInitialAgentConfig,
	type Effort,
	effortLevels,
} from "./agent-config.ts";
import { readSetupSettings } from "./recommended-tools.ts";

export { type AgentConfig, type AgentName, agentNames, type Effort, effortLevels } from "./agent-config.ts";

export const profiles: Record<AgentName, string> = {
	plan: "Explore the request and relevant code, clarify important unknowns, and return an actionable plan with acceptance checks. Do not implement or delegate implementation. Stop after the plan.",
	orchestrator:
		"Break work into focused tasks; use ask with purpose: explore for read-only codebase exploration, plan for planning, and debug with mode: read for diagnosis. Use orchestrator children only for a distinct coordination task, not ordinary fan-out. Include all necessary context; children do not inherit the conversation. Orchestrator is always read-only and never repairs source itself. Builder requests require task_id and explicit paths exactly matching the user-approved plan task; scope changes require new user approval. Phase 1 blocks builders until sandboxed checks and builder isolation exist, and blocks shell/check execution. Do not claim checks ran. At most two read-only jobs can run concurrently; no parallel builders. Inspect results and report verification blockers. Do not delegate the same orchestration task recursively.",
	debug: "Reproduce or establish evidence for the failure, trace its cause before editing, and make the smallest justified fix. Verify with a regression check. Separate confirmed facts from hypotheses and report any unexecuted checks.",
	ask: "Answer the user's question using relevant code or documentation as evidence. Do not change files or delegate changes. When context is missing, ask rather than invent facts. Stop when the question is answered.",
	code: "Implement the requested scope using existing repository patterns. Preserve unrelated changes, add focused coverage for behavior changes, run relevant checks, and report results. Stop when acceptance conditions are met.",
};

export function isAgentName(value: unknown): value is AgentName {
	return typeof value === "string" && agentNames.includes(value as AgentName);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function model(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[^\s/]+\/\S+$/.test(value)) {
		throw new Error(`${label} must be an exact provider/model ID`);
	}
	return value;
}

export function parseAgentConfig(value: unknown): AgentConfig {
	const source = object(value, "Agent configuration");
	const result: AgentConfig = {};
	// Read only supported settings so obsolete keys cannot disable core delegation.
	for (const key of ["recommendedTools", "agentSetup"]) {
		if (source[key] !== undefined && source[key] !== "enabled" && source[key] !== "disabled")
			throw new Error(`${key} must be enabled or disabled`);
	}
	for (const key of ["model", "small_model", "subagent_model"] as const) {
		if (source[key] !== undefined) result[key] = model(source[key], key);
	}
	if (source.auto_profile !== undefined) {
		if (typeof source.auto_profile !== "boolean") throw new Error("auto_profile must be a boolean");
		result.auto_profile = source.auto_profile;
	}
	if (source.subagent_variant_overrides !== undefined) {
		result.subagent_variant_overrides = {};
		for (const [name, value] of Object.entries(
			object(source.subagent_variant_overrides, "subagent_variant_overrides"),
		)) {
			if (!isAgentName(name)) throw new Error(`Unknown agent variant: ${name}`);
			const override = object(value, `Override ${name}`);
			for (const key of Object.keys(override)) {
				if (key !== "model" && key !== "effort") throw new Error(`Unknown override key: ${name}.${key}`);
			}
			const parsed: { model?: string; effort?: Effort } = {};
			if (override.model !== undefined) parsed.model = model(override.model, `${name}.model`);
			if (override.effort !== undefined) {
				if (!effortLevels.includes(override.effort as Effort)) throw new Error(`Invalid effort for ${name}`);
				parsed.effort = override.effort as Effort;
			}
			result.subagent_variant_overrides[name] = parsed;
		}
	}
	return result;
}

export async function loadAgentConfig(cwd: string, agentDir: string, trusted: boolean): Promise<AgentConfig> {
	async function load(directory: string): Promise<AgentConfig> {
		const path = join(directory, "settings.json");
		try {
			const settings = object(JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")), "Settings");
			return settings.tark === undefined ? {} : parseAgentConfig(settings.tark);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const global = await load(agentDir);
	const project = trusted ? await load(join(cwd, ".tark")) : {};
	const overrides = { ...global.subagent_variant_overrides };
	for (const name of agentNames) {
		if (project.subagent_variant_overrides?.[name]) {
			overrides[name] = { ...overrides[name], ...project.subagent_variant_overrides[name] };
		}
	}
	return {
		...global,
		...project,
		subagent_variant_overrides: overrides,
	};
}

export async function hasProjectAgentConfig(cwd: string): Promise<boolean> {
	try {
		const text = await readFile(join(cwd, ".tark", "settings.json"), "utf8");
		const settings = object(JSON.parse(text.replace(/^\uFEFF/, "")), "Settings");
		if (settings.tark === undefined) return false;
		const config = parseAgentConfig(settings.tark);
		return Object.keys(config).length > 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Fill project tark settings atomically without replacing configured values. */
export async function initializeAgentConfig(
	cwd: string,
	agentDir: string,
	defaultModel: string | undefined,
	signal?: AbortSignal,
): Promise<boolean> {
	return (await updateProjectAgentConfig(cwd, agentDir, defaultModel, "initialize", signal)) === "created";
}

export async function completeProjectAgentConfig(
	cwd: string,
	agentDir: string,
	defaultModel: string | undefined,
	signal?: AbortSignal,
): Promise<"created" | "updated" | "complete"> {
	return updateProjectAgentConfig(cwd, agentDir, defaultModel, "complete", signal);
}

/** Save only one profile's model, preserving effort and all other project settings. */
export async function saveProjectAgentModel(
	cwd: string,
	agentDir: string,
	name: AgentName,
	modelId: string,
): Promise<void> {
	await updateProjectAgentConfig(cwd, agentDir, undefined, { name, model: model(modelId, "Profile model") });
}

async function updateProjectAgentConfig(
	cwd: string,
	agentDir: string,
	defaultModel: string | undefined,
	mode: "initialize" | "complete" | { name: AgentName; model: string },
	signal?: AbortSignal,
): Promise<"created" | "updated" | "complete"> {
	// Refuse aliases of the user directory before creating a project lock or file.
	const initial = await readSetupSettings(cwd, agentDir);
	const path = initial.projectPath;
	return withFileMutationQueue(path, async () => {
		signal?.throwIfAborted();
		await mkdir(dirname(path), { recursive: true });
		const lock = `${path}.lock`;
		await mkdir(lock);
		const temporary = join(dirname(path), `.settings.json.tark-${randomUUID()}.tmp`);
		try {
			const { project } = await readSetupSettings(cwd, agentDir);
			const tark = project.settings.tark === undefined ? {} : object(project.settings.tark, "Tark settings");
			const source = parseAgentConfig(tark);
			const exists = Object.keys(source).length > 0;
			if (mode === "initialize" && exists) return "complete";
			let nextTark: Record<string, unknown>;
			if (typeof mode === "object") {
				if (source.subagent_variant_overrides?.[mode.name]?.model === mode.model) return "complete";
				nextTark = {
					...tark,
					subagent_variant_overrides: {
						...source.subagent_variant_overrides,
						[mode.name]: { ...source.subagent_variant_overrides?.[mode.name], model: mode.model },
					},
				};
			} else {
				const inherited = await loadAgentConfig(cwd, agentDir, false);
				const selected =
					source.model ?? inherited.model ?? (defaultModel ? model(defaultModel, "Default model") : undefined);
				if (!selected)
					throw new Error("No active model; select a model and configure tark in .tark/settings.json manually.");
				const defaults = createInitialAgentConfig(selected, inherited);
				const overrides: NonNullable<AgentConfig["subagent_variant_overrides"]> = {};
				let changed = Object.keys(defaults).some((key) => source[key as keyof AgentConfig] === undefined);
				for (const name of agentNames) {
					const expected = defaults.subagent_variant_overrides![name]!;
					const actual = source.subagent_variant_overrides?.[name];
					if (!actual?.model || actual.effort === undefined) changed = true;
					overrides[name] = { ...expected, ...actual };
				}
				if (!changed) return "complete";
				nextTark = { ...defaults, ...tark, subagent_variant_overrides: overrides };
			}
			const next = { ...project.settings, tark: nextTark };
			await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: project.mode });
			await chmod(temporary, project.mode);
			signal?.throwIfAborted();
			await rename(temporary, path);
			return exists ? "updated" : "created";
		} finally {
			try {
				await rm(temporary, { force: true });
			} finally {
				await rm(lock, { recursive: true, force: true });
			}
		}
	});
}

const profileIntentRules: [AgentName, RegExp][] = [
	[
		"plan",
		/^(?:let'?s\s+plan|(?:make|create)\s+(?:me\s+)?(?:a\s+)?plan|help\s+me\s+plan|plan|design|outline|analyze|think\s+through|approach)\b/i,
	],
	["debug", /^(?:help\s+me\s+)?(?:debug|investigate|fix|error|bug|broken|failing|crash|failure)\b/i],
	[
		"orchestrator",
		/^(?:orchestrate|coordinate|delegate|parallelize|split(?:\s+(?:this|it))?\s+into\s+tasks|use\s+subagents)\b/i,
	],
	["code", /^(?:create|make|add|implement|build|write|execute|generate|edit|modify|update|remove|delete|refactor)\b/i],
	["ask", /^(?:explain|answer(?:\s+(?:this\s+)?question)?|tell\s+me|clarify|what|how|why|where|when|who)\b/i],
];
const politePrefix = /^(?:(?:please|kindly|hey)[,\s]+|(?:could|would|can)\s+you\s+)+/i;

export function detectProfileIntent(text: string): AgentName | undefined {
	const input = text
		.trim()
		.replace(/\u2019/g, "'")
		.replace(politePrefix, "");
	if (!input || /^[/`>~"'\u201c\u2018]/.test(input)) return undefined;
	const match = profileIntentRules.find(([, expression]) => expression.test(input));
	if (!match) return undefined;
	const [profile, expression] = match;
	const rest = input.slice(input.match(expression)![0].length);
	if (profile !== "ask" && /^\s+(?:is|means|refers\s+to)\b/i.test(rest)) return undefined;
	// shortcut: bounded English outer-action rules; expand only with evaluated intent examples.
	const nested =
		/^(?:\s+(?:how|why|what|when|where)\b)|\bto\s+(?:debug|investigate|implement|build|write|execute)\b/i.test(rest);
	if (!nested) {
		const ownText = rest.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’/g, "");
		for (const clause of ownText.split(/\b(?:and(?:\s+then)?|then|but|also)\s+|[.!?]\s+|\n+/i).slice(1)) {
			const other = profileIntentRules.find(([, rule]) => rule.test(clause.trim().replace(politePrefix, "")));
			if (other && other[0] !== profile) return undefined;
		}
	}
	return profile;
}

export function isSmallTask(agent: AgentName, task: string): boolean {
	// shortcut: conservative text heuristic, replace with evaluated routing if real tasks outgrow it.
	if (task.length > 400 || task.split(/\s+/).length > 65) return false;
	if (
		/\b(architect\w*|design|implement|investigate|debug|refactor|migrat\w*|security|race|performance|across|multiple|entire|comprehensive)\b/i.test(
			task,
		)
	)
		return false;
	if (agent === "ask")
		return /^\s*(find|locate|list|what (is|does|file)|where (is|are)|explain|summari[sz]e)\b/i.test(task);
	if (agent === "code")
		return /^\s*(fix (a |the )?typo|correct (a |the )?typo|rename (a |the )?(variable|symbol)|update (a |the )?(comment|label))\b/i.test(
			task,
		);
	return false;
}

export function routeSubagent(
	config: AgentConfig,
	agent: AgentName,
	task: string,
	currentModel: string,
	currentEffort: Effort,
	exploration = false,
) {
	if (exploration) {
		return {
			model: config.small_model ?? currentModel,
			effort: "low" as Effort,
			reason: config.small_model ? "configured exploration small model" : "exploration current model",
		};
	}
	const override = config.subagent_variant_overrides?.[agent];
	const small = Boolean(config.small_model && isSmallTask(agent, task) && !override?.model);
	return {
		model: override?.model ?? (small ? config.small_model! : (config.subagent_model ?? currentModel)),
		effort: override?.effort ?? (small ? "low" : currentEffort),
		reason: override?.model ? "variant override" : small ? "automatic small task" : "default subagent",
	};
}

export function subagentTools(agent: AgentName, active: string[], depth: number, exploration = false): string[] {
	if (agent === "plan" || agent === "ask") {
		return active.filter(
			(name) => ["read", "grep", "find", "ls"].includes(name) || (!exploration && depth < 2 && name === "subagent"),
		);
	}
	return active.filter((name) => name !== "askquestions" && (name !== "subagent" || depth < 2));
}

export function childResourceArgs(argv: string[]): string[] {
	const result: string[] = [];
	const values = ["--extension", "-e", "--skill", "--prompt-template", "--system-prompt", "--append-system-prompt"];
	const flags = [
		"--no-extensions",
		"-ne",
		"--no-skills",
		"-ns",
		"--no-prompt-templates",
		"-np",
		"--no-context-files",
		"-nc",
		"--no-mcp",
		"--offline",
	];
	for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
		if (values.includes(argv[i]) && argv[i + 1] !== undefined) result.push(argv[i], argv[++i]);
		else if (flags.includes(argv[i])) result.push(argv[i]);
	}
	return result;
}
