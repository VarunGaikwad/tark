import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, SettingsManager, withFileMutationQueue } from "../host.ts";

export const recommendedTools = ["grep", "find", "ls"];
const defaultTools = ["read", "bash", "edit", "write"];
// Older Pi releases treat +name as a literal tool name.
export const supportsAdditiveTools =
	SettingsManager.inMemory({ defaultTools: ["+find"] })
		.getDefaultTools()
		?.includes("find") === true;
type Settings = Record<string, unknown>;
type Snapshot = { text: string | undefined; settings: Settings; mode: number };
export type SetupSettings = { projectPath: string; globalPath: string; project: Snapshot; global: Snapshot };

function object(value: unknown): value is Settings {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function snapshot(path: string): Promise<Snapshot> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile()) throw new Error(`Not a regular settings file: ${path}`);
		const text = await readFile(path, "utf8");
		const settings: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		if (!object(settings)) throw new Error(`Settings must be a JSON object: ${path}`);
		if (
			settings.defaultTools !== undefined &&
			(!Array.isArray(settings.defaultTools) ||
				settings.defaultTools.some((entry) => typeof entry !== "string" || !entry))
		) {
			throw new Error(`Invalid defaultTools in ${path}`);
		}
		if (settings.tark !== undefined && !object(settings.tark)) throw new Error(`Invalid tark settings in ${path}`);
		return { text, settings, mode: stat.mode & 0o777 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: undefined, settings: {}, mode: 0o600 };
		throw error;
	}
}

export async function readSetupSettings(cwd: string, agentDir = getAgentDir()): Promise<SetupSettings> {
	const projectPath = join(cwd, ".tark", "settings.json");
	const globalPath = join(agentDir, "settings.json");
	const directories = await Promise.all(
		[dirname(projectPath), dirname(globalPath)].map(async (path) => {
			try {
				return await realpath(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve(path);
				throw error;
			}
		}),
	);
	if (directories[0] === directories[1])
		throw new Error("Project and user settings share a path; project-only setup is unavailable.");
	const [project, global] = await Promise.all([snapshot(projectPath), snapshot(globalPath)]);
	return { projectPath, globalPath, project, global };
}

export function setupChoice(
	settings: SetupSettings,
	feature: "recommendedTools" | "agentSetup" = "recommendedTools",
): unknown {
	const tark = settings.project.settings.tark;
	return object(tark) ? tark[feature] : undefined;
}

export function toolsToOffer(
	settings: SetupSettings,
	available: string[],
	active: string[],
	additive = supportsAdditiveTools,
): string[] {
	if (setupChoice(settings) === "enabled" || setupChoice(settings) === "disabled") return [];
	const layers = [settings.global.settings.defaultTools, settings.project.settings.defaultTools] as (
		| string[]
		| undefined
	)[];
	// A plain-name list (including []) is an intentional allowlist, not an invitation to expand it.
	if (layers.some((list) => list !== undefined && (!list.length || list.some((name) => !/^[+-].+/.test(name)))))
		return [];
	// Do not reinterpret additive configurations on a Pi release that does not support them.
	if (!additive && layers.some((list) => list !== undefined)) return [];
	const excluded = new Set<string>();
	for (const list of layers) {
		for (const entry of list ?? []) {
			if (entry.startsWith("-")) excluded.add(entry.slice(1));
			else excluded.delete(entry.slice(1));
		}
	}
	return recommendedTools.filter((name) => available.includes(name) && !active.includes(name) && !excluded.has(name));
}

/** Skip CLI selection overrides instead of trying to infer or undo the user's policy. */
export function hasToolOverrides(argv: string[]): boolean {
	for (const arg of argv) {
		if (arg === "--") break;
		if (/^(?:--(?:tools|exclude-tools|no-tools|no-builtin-tools)|-t|-xt|-nt|-nbt)(?:=|$)/.test(arg)) return true;
	}
	return false;
}

export async function saveSetupChoice(
	settings: SetupSettings,
	choice: "enabled" | "disabled",
	tools: string[],
	additive = supportsAdditiveTools,
	signal?: AbortSignal,
	agentSetup?: "enabled" | "disabled",
): Promise<void> {
	await withFileMutationQueue(settings.projectPath, async () => {
		signal?.throwIfAborted();
		await mkdir(dirname(settings.projectPath), { recursive: true });
		// Use Pi's settings lock-directory convention. Never remove another writer's lock.
		const lock = `${settings.projectPath}.lock`;
		await mkdir(lock);
		const temporary = join(dirname(settings.projectPath), `.settings.json.tark-${randomUUID()}.tmp`);
		try {
			const { project, global } = await readSetupSettings(
				dirname(dirname(settings.projectPath)),
				dirname(settings.globalPath),
			);
			if (project.text !== settings.project.text || global.text !== settings.global.text) {
				throw new Error(
					"Settings changed while the setup prompt was open. Nothing was overwritten; try again next startup.",
				);
			}
			signal?.throwIfAborted();
			const next = { ...project.settings };
			if (choice === "enabled" && next.quietStartup === undefined) next.quietStartup = true;
			const tark = object(next.tark) ? next.tark : {};
			next.tark = {
				...tark,
				...(tools.length ? { recommendedTools: choice } : {}),
				...(agentSetup ? { agentSetup } : {}),
			};
			if (choice === "enabled" && tools.length) {
				next.defaultTools = additive
					? [
							...((project.settings.defaultTools as string[] | undefined) ?? []),
							...tools.map((name) => `+${name}`),
						]
					: [...defaultTools, ...tools];
			}
			await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: project.mode });
			await chmod(temporary, project.mode);
			signal?.throwIfAborted();
			await rename(temporary, settings.projectPath);
		} finally {
			try {
				await rm(temporary, { force: true });
			} finally {
				await rm(lock, { recursive: true, force: true });
			}
		}
	});
}
