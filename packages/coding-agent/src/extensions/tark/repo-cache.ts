import path from "node:path";
import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "./host.ts";
import { RepoCache } from "./lib/repo-cache.ts";

/** Adds cached outlines and change discovery without replacing or blocking native tools. */
export default function repoCache(pi: ExtensionAPI, dependencies: { cacheDir?: string } = {}) {
	pi.registerFlag("repo-cache-exclude", {
		description: "Comma-separated repository-relative path prefixes excluded from the local index",
		type: "string",
		default: "",
	});
	const caches = new Map<string, Promise<RepoCache>>();
	const get = (ctx: ExtensionContext) => {
		if (!ctx.isProjectTrusted()) throw new Error("Repository caching requires a trusted project.");
		const cwd = ctx.cwd;
		let cache = caches.get(cwd);
		if (!cache) {
			cache = RepoCache.open(cwd, {
				cacheDir: dependencies.cacheDir ?? path.join(getAgentDir(), "cache", "repo-index"),
				exclude: String(pi.getFlag("repo-cache-exclude") ?? "")
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean),
			});
			caches.set(cwd, cache);
			void cache.catch(() => {
				caches.delete(cwd);
			});
		}
		return cache;
	};
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		try {
			await get(ctx);
		} catch (error) {
			ctx.ui.notify(`Repository cache unavailable: ${String(error)}`, "warning");
		}
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!ctx.isProjectTrusted()) return;
		// Only changed candidates and bounded pending work; no whole-tree metadata audit per turn.
		try {
			await (await get(ctx)).sync({ budget: 100, signal: ctx.signal });
		} catch (error) {
			ctx.ui.notify(`Repository cache update failed: ${String(error)}`, "warning");
		}
	});
	pi.on("session_shutdown", async () => {
		await Promise.all(
			[...caches.values()]
				.map(async (cache) => {
					await (await cache).close();
				})
				.map((job) => job.catch(() => {})),
		);
		caches.clear();
	});
	pi.registerTool({
		name: "get_workspace_changes",
		label: "Repository changes",
		promptGuidelines: [
			"Before broad repository exploration, call get_workspace_changes and focus on changed or task-relevant files instead of repeating an unchanged repository scan. If the cache is unavailable or results are truncated, use native discovery tools.",
		],
		description:
			"List added, modified and deleted indexed files since the last call, plus Git staged/unstaged/untracked status—not a full workspace diff. Validates metadata to catch missed filesystem events. Uses current working-tree contents, not Git blobs. Each list is capped at 200 entries and truncation is reported; use native grep/find for general discovery.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const result = await (await get(ctx)).changedFiles(signal);
			const bounded = {
				...result,
				changes: result.changes.slice(0, 200),
				workingTree: result.workingTree.slice(0, 200),
				truncated: result.changes.length > 200 || result.workingTree.length > 200,
			};
			return { content: [{ type: "text", text: JSON.stringify(bounded) }], details: bounded };
		},
	});
	pi.registerTool({
		name: "get_file_outline",
		label: "Cached file outline",
		promptGuidelines: [
			"Before rereading a previously explored file, call get_file_outline. If its hash matches the version already read, reuse that content from context; otherwise read the needed current code. Read directly when exact code is needed for an edit, the outline is insufficient, prior content is unavailable, or the cache excludes the file.",
		],
		description:
			"Return a fresh, SHA-256-versioned deterministic declaration/heading outline for a repository-relative file (not a semantic summary). Reuses unchanged 64-line chunks. Use native grep to search and read for full contents. Excludes ignored, sensitive, binary and oversized files.",
		parameters: Type.Object({
			path: Type.String({ description: "File path relative to the Git root (or session directory without Git)" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await (await get(ctx)).summary(params.path, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerCommand("repo-cache-status", {
		description: "Show local repository index counts, hits/misses, duration and disk size",
		handler: async (_args, ctx) => {
			const cache = await get(ctx);
			const status = cache.status();
			ctx.ui.notify(
				`Repo cache: ${status.filesIndexed} files indexed, ${status.filesChanged} changed in last update, ${status.pending} pending; ${status.cacheHits} file/chunk hits / ${status.cacheMisses} chunk misses; ${status.hashes} files hashed; ${status.updateMs.toFixed(1)} ms last update; ${status.cacheBytes} bytes on disk.${status.lastError ? ` Warning: ${status.lastError}` : ""}`,
				"info",
			);
		},
	});
}
