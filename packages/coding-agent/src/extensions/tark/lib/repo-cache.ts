import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type FSWatcher, type Stats, watch } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { deniedPath } from "./access-policy.ts";

const exec = promisify(execFile);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const chunkSchema = z.object({
	hash: hashSchema,
	lines: z.number().int().nonnegative(),
	outline: z.array(z.object({ line: z.number().int().positive(), text: z.string().max(240) })),
});
const metadataSchema = z.object({
	size: z.number(),
	mtimeMs: z.number(),
	ctimeMs: z.number(),
	ino: z.number(),
	mode: z.number(),
});
const fileSchema = z.object({
	path: z.string(),
	hash: hashSchema,
	metadata: metadataSchema,
	indexedVersion: hashSchema,
	indexedAt: z.string(),
	binary: z.boolean(),
	chunks: z.array(chunkSchema),
});
const diskSchema = z.object({ schema: z.literal(1), root: z.string(), head: z.string(), files: z.array(fileSchema) });
type FileEntry = z.infer<typeof fileSchema>;
type Chunk = z.infer<typeof chunkSchema>;
type Change = { path: string; kind: "added" | "modified" | "deleted" };
export type RepoCacheOptions = {
	cacheDir: string;
	exclude?: string[];
	maxFiles?: number;
	maxFileBytes?: number;
	watch?: boolean;
};
const excludedParts = new Set([
	".git",
	".ssh",
	".aws",
	".azure",
	".gnupg",
	".kube",
	"secrets",
	"credentials",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".nuxt",
	".cache",
	".tark",
	"target",
	"vendor",
]);
const metadata = (s: Stats) => ({ size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, mode: s.mode });
const sameMetadata = (a: FileEntry["metadata"], b: FileEntry["metadata"]) =>
	Object.keys(a).every((key) => a[key as keyof typeof a] === b[key as keyof typeof b]);
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Local, reconstructible cache. Git owns discovery; metadata validates missed watch events. */
export class RepoCache {
	readonly files = new Map<string, FileEntry>();
	readonly metrics = {
		hashes: 0,
		fileHits: 0,
		chunkHits: 0,
		chunkMisses: 0,
		metadataChecks: 0,
		updateMs: 0,
		cacheBytes: 0,
	};
	root = "";
	git = false;
	head = "";
	lastChanges: Change[] = [];
	workingTree: { path: string; status: string }[] = [];
	lastError: string | undefined;
	private cacheFile = "";
	private chunks = new Map<string, Chunk>();
	private dirty = new Set<string>();
	private journal = new Map<string, Change>();
	private pending = new Set<string>();
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	private saveNeeded = false;
	private lastAudit = 0;
	private discovered: string[] | undefined;
	private inventoryDirty = false;

	private readonly options: RepoCacheOptions;

	private constructor(options: RepoCacheOptions) {
		this.options = options;
	}

	static async open(cwd: string, options: RepoCacheOptions): Promise<RepoCache> {
		const cache = new RepoCache(options);
		cache.root = await realpath(cwd);
		try {
			cache.root = (await cache.command(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
			cache.root = await realpath(cache.root);
			cache.git = true;
		} catch {
			/* Non-Git directories use the bounded filesystem walker. */
		}
		await mkdir(options.cacheDir, { recursive: true, mode: 0o700 });
		cache.cacheFile = path.join(options.cacheDir, `${sha256(cache.root)}.json`);
		try {
			if ((await lstat(cache.cacheFile)).size > 64 * 1024 * 1024) throw new Error("Index exceeds 64 MiB limit.");
			const text = await readFile(cache.cacheFile, "utf8");
			const stored = diskSchema.parse(JSON.parse(text));
			if (stored.root === cache.root) {
				cache.head = stored.head;
				for (const file of stored.files) {
					if (!cache.excluded(file.path)) {
						cache.files.set(file.path, file);
						for (const chunk of file.chunks) cache.chunks.set(chunk.hash, chunk);
					}
				}
				cache.metrics.cacheBytes = Buffer.byteLength(text);
			}
		} catch (error) {
			if (!missing(error)) cache.lastError = "Persistent index unreadable or incompatible; rebuilding.";
		}
		// Startup hashes at most 100 files. Remaining work is completed in idle batches or on demand.
		await cache.sync({ audit: true, budget: 100 });
		if (options.watch !== false) cache.start();
		return cache;
	}

	private async command(args: string[]): Promise<string> {
		return (
			await exec("git", ["--no-optional-locks", "-C", this.root, ...args], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
				timeout: 10000,
			})
		).stdout;
	}

	private excluded(relative: string): boolean {
		const absolute = path.resolve(this.root, relative);
		const cacheRoot = path.resolve(this.options.cacheDir);
		if (absolute === cacheRoot || absolute.startsWith(`${cacheRoot}${path.sep}`)) return true;
		if (
			!relative ||
			path.isAbsolute(relative) ||
			relative.includes("\\") ||
			relative
				.split("/")
				.some((part) => part === ".." || excludedParts.has(part) || part === ".env" || part.startsWith(".env."))
		)
			return true;
		if (
			/(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.envrc|id_rsa|id_ed25519|credentials[^/]*|secrets?\.[^/]*)$|\.(?:pem|key|p12|pfx|png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp[34]|wav|exe|dll|so)$/i.test(
				relative,
			)
		)
			return true;
		return (this.options.exclude ?? []).some(
			(prefix) => relative === prefix || relative.startsWith(`${prefix.replace(/\/$/, "")}/`),
		);
	}

	private async inventory(audit: boolean): Promise<string[]> {
		if (!this.git && this.discovered && !audit && !this.inventoryDirty) return this.discovered;
		let names: string[];
		if (this.git) {
			names = [
				...new Set(
					(await this.command(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
						.split("\0")
						.filter(Boolean),
				),
			];
		} else {
			names = [];
			let visited = 0;
			const walk = async (directory: string): Promise<void> => {
				for await (const entry of await opendir(path.join(this.root, directory))) {
					if (++visited > (this.options.maxFiles ?? 20000) * 4)
						throw new Error("Repository cache traversal limit exceeded; exclude more paths or use native tools.");
					const relative = directory ? `${directory}/${entry.name}` : entry.name;
					if (this.excluded(relative) || (await deniedPath(this.root, relative))) continue;
					if (entry.isDirectory()) await walk(relative);
					else if (entry.isFile()) names.push(relative);
					if (names.length > (this.options.maxFiles ?? 20000))
						throw new Error("Repository cache file limit exceeded; use native grep/read or exclude more paths.");
				}
			};
			await walk("");
		}
		names = names.filter((name) => !this.excluded(name));
		if (names.length > (this.options.maxFiles ?? 20000))
			throw new Error("Repository cache file limit exceeded; use native grep/read or exclude more paths.");
		this.discovered = names.sort();
		this.inventoryDirty = false;
		return this.discovered;
	}

	private async gitChanges(): Promise<Set<string>> {
		const changed = new Set<string>();
		if (!this.git) return changed;
		const head = (await this.command(["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
		if (this.head && head && head !== this.head) {
			const diff = await this.command(["diff", "--name-only", "-z", this.head, head, "--"]).catch(() =>
				[...this.files.keys()].join("\0"),
			);
			for (const name of diff.split("\0")) if (name) changed.add(name);
		}
		if (this.head !== head) this.saveNeeded = true;
		this.head = head;
		const records = (
			await this.command(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"])
		).split("\0");
		this.workingTree = [];
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (!record) continue;
			const status = record.slice(0, 2);
			const name = record.slice(3);
			if (!this.excluded(name)) this.workingTree.push({ path: name, status });
			changed.add(name);
			if (/[RC]/.test(status)) {
				const old = records[++i];
				if (old) changed.add(old);
			}
		}
		return changed;
	}

	private start(): void {
		try {
			this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
				if (filename) {
					const name = filename.toString().split(path.sep).join("/");
					if (!this.excluded(name)) {
						this.dirty.add(name);
						this.inventoryDirty = true;
					}
				} else {
					this.lastAudit = 0;
					this.inventoryDirty = true;
				}
			});
			this.watcher.on("error", () => {
				this.lastAudit = 0;
				this.watcher?.close();
			});
		} catch {
			/* Periodic audits and query validation also work without notifications. */
		}
		this.timer = setInterval(() => {
			void this.sync({ audit: Date.now() - this.lastAudit > 30000, budget: 100 }).catch((error) => {
				this.lastError = String(error);
			});
		}, 2000);
		this.timer.unref();
		this.watcher?.unref();
	}

	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		const next = this.queue.then(work);
		this.queue = next.catch(() => {});
		return next;
	}

	sync(options: { audit?: boolean; budget?: number; signal?: AbortSignal } = {}): Promise<Change[]> {
		return this.exclusive(async () => {
			if (this.closed) throw new Error("Repository cache is closed.");
			options.signal?.throwIfAborted();
			const started = performance.now();
			const names = await this.inventory(Boolean(options.audit));
			const live = new Set(names);
			const candidates = await this.gitChanges();
			for (const name of this.dirty) candidates.add(name);
			this.dirty.clear();
			const changes: Change[] = [];
			const record = (name: string, kind: Change["kind"]) => {
				const change = { path: name, kind };
				changes.push(change);
				this.journal.set(name, change);
			};
			for (const name of this.files.keys()) {
				if (!live.has(name)) {
					this.files.delete(name);
					record(name, "deleted");
					this.saveNeeded = true;
				}
			}
			for (const name of names) {
				if (options.audit || !this.files.has(name) || candidates.has(name)) this.pending.add(name);
			}
			let processed = 0;
			for (const name of this.pending) {
				options.signal?.throwIfAborted();
				if (processed++ >= (options.budget ?? Infinity)) break;
				if (live.has(name)) {
					const kind = await this.indexFile(name);
					if (kind) record(name, kind);
				}
				this.pending.delete(name);
			}
			if (options.audit) this.lastAudit = Date.now();
			await this.save();
			this.lastChanges = changes;
			this.metrics.updateMs = performance.now() - started;
			this.lastError = undefined;
			return changes;
		});
	}

	private async indexFile(name: string): Promise<Change["kind"] | undefined> {
		const absolute = path.join(this.root, name);
		const previous = this.files.get(name);
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const before = await lstat(absolute);
				this.metrics.metadataChecks++;
				const canonical = await realpath(absolute);
				const relative = path.relative(this.root, canonical);
				if (
					!before.isFile() ||
					before.size > (this.options.maxFileBytes ?? 1024 * 1024) ||
					relative.startsWith(`..${path.sep}`) ||
					path.isAbsolute(relative) ||
					(await deniedPath(this.root, name))
				) {
					if (previous) {
						this.files.delete(name);
						this.saveNeeded = true;
						return "deleted";
					}
					return;
				}
				const currentMetadata = metadata(before);
				if (previous && sameMetadata(previous.metadata, currentMetadata)) {
					this.metrics.fileHits++;
					return;
				}
				const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				let data: Buffer;
				try {
					if (!sameMetadata(currentMetadata, metadata(await handle.stat()))) continue;
					data = await handle.readFile();
					if (!sameMetadata(currentMetadata, metadata(await handle.stat()))) continue;
				} finally {
					await handle.close();
				}
				if (!sameMetadata(currentMetadata, metadata(await lstat(absolute)))) continue;
				const hash = sha256(data);
				this.metrics.hashes++;
				// NUL and invalid UTF-8 files never produce outlines.
				let text = "";
				let isBinary = data.includes(0);
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(data);
				} catch {
					isBinary = true;
				}
				const chunks: Chunk[] = [];
				if (!isBinary) {
					const lines = text.split(/\r?\n/);
					for (let offset = 0; offset < lines.length; offset += 64) {
						const part = lines.slice(offset, offset + 64);
						const chunkHash = sha256(part.join("\n"));
						let chunk = this.chunks.get(chunkHash);
						if (chunk) this.metrics.chunkHits++;
						else {
							this.metrics.chunkMisses++;
							chunk = {
								hash: chunkHash,
								lines: part.length,
								outline: part
									.flatMap((line, index) =>
										/^\s*(?:(?:export|public|private|static|async|default|abstract|declare)\s+)*(?:function|class|interface|type|enum|def|struct|trait|fn|const|let|var)\b|^#{1,6}\s/.test(
											line,
										)
											? [{ line: index + 1, text: line.trim().slice(0, 240) }]
											: [],
									)
									.slice(0, 32),
							};
							this.chunks.set(chunkHash, chunk);
						}
						chunks.push(chunk);
					}
				}
				this.files.set(name, {
					path: name,
					hash,
					metadata: currentMetadata,
					indexedVersion: hash,
					indexedAt: new Date().toISOString(),
					binary: isBinary,
					chunks,
				});
				this.saveNeeded = true;
				return previous?.hash === hash ? undefined : previous ? "modified" : "added";
			} catch (error) {
				if (!missing(error)) throw error;
				if (previous) {
					this.files.delete(name);
					this.saveNeeded = true;
					return "deleted";
				}
				return;
			}
		}
		throw new Error(`File changed while indexing: ${name}. Retry for fresh results.`);
	}

	private async save(): Promise<void> {
		if (!this.saveNeeded) return;
		const text = JSON.stringify({ schema: 1, root: this.root, head: this.head, files: [...this.files.values()] });
		if (Buffer.byteLength(text) > 64 * 1024 * 1024)
			throw new Error("Repository cache exceeds 64 MiB; exclude more paths or use native grep/read.");
		const temporary = `${this.cacheFile}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
			await rename(temporary, this.cacheFile);
		} finally {
			await rm(temporary, { force: true });
		}
		this.metrics.cacheBytes = Buffer.byteLength(text);
		this.saveNeeded = false;
		this.chunks = new Map(
			[...this.files.values()].flatMap((file) => file.chunks.map((chunk) => [chunk.hash, chunk] as const)),
		);
	}

	async summary(name: string, signal?: AbortSignal) {
		const relative = path.relative(this.root, path.resolve(this.root, name)).split(path.sep).join("/");
		if (this.excluded(relative)) throw new Error("Path is outside the repository or excluded.");
		const denial = await deniedPath(this.root, relative);
		if (denial) throw new Error(`Path excluded: ${denial}`);
		if (!this.git && !this.discovered?.includes(relative)) this.inventoryDirty = true;
		await this.sync({ signal });
		return this.exclusive(async () => {
			signal?.throwIfAborted();
			// Validate the requested file even if its notification was lost or Git reports it clean.
			const kind = await this.indexFile(relative);
			if (kind) this.journal.set(relative, { path: relative, kind });
			await this.save();
			const file = this.files.get(relative);
			if (!file || file.binary) throw new Error("File is missing, binary, oversized, or excluded.");
			let offset = 0;
			return {
				path: relative,
				hash: file.hash,
				indexedVersion: file.indexedVersion,
				indexedAt: file.indexedAt,
				bytes: file.metadata.size,
				outlineLimit: "32 declarations per 64-line chunk; 100 total",
				outline: file.chunks
					.flatMap((chunk) => {
						const items = chunk.outline.map((item) => ({ line: offset + item.line, text: item.text }));
						offset += chunk.lines;
						return items;
					})
					.slice(0, 100),
			};
		});
	}

	async changedFiles(signal?: AbortSignal) {
		await this.sync({ audit: true, signal });
		const changes = [...this.journal.values()];
		this.journal.clear();
		return { head: this.head, changes, workingTree: this.workingTree };
	}

	status() {
		return {
			root: this.root,
			git: this.git,
			filesIndexed: [...this.files.values()].filter((file) => !file.binary).length,
			filesChanged: this.lastChanges.length,
			pending: this.pending.size,
			cacheHits: this.metrics.fileHits + this.metrics.chunkHits,
			cacheMisses: this.metrics.chunkMisses,
			...this.metrics,
			lastError: this.lastError,
		};
	}

	async close(): Promise<void> {
		clearInterval(this.timer);
		this.watcher?.close();
		await this.exclusive(async () => {
			this.closed = true;
			await this.save();
		});
	}
}
