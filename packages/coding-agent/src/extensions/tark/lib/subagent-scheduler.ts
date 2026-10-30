import { lstat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export type SubagentScope = { mode: "read" | "write"; paths: string[]; broad: boolean };

const sharedRootFiles = new Set([
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	".npmrc",
	"biome.json",
	"turbo.json",
	"nx.json",
]);
const sharedRootPatterns = [
	/^tsconfig(?:\.[^/]+)?\.json$/,
	/^(?:vite|webpack|rollup|esbuild|eslint|prettier)\.config\.[^/]+$/,
	/^\.eslintrc(?:\.[^/]+)?$/,
	/^\.prettierrc(?:\.[^/]+)?$/,
];

function isSharedPath(path: string): boolean {
	path = path.toLowerCase();
	const first = path.split("/")[0];
	if ([".tark", ".git", ".github"].includes(first)) return true;
	const name = basename(path);
	if (sharedRootFiles.has(name) || /^tsconfig(?:\.[^/]+)?\.json$/.test(name)) return true;
	return !path.includes("/") && sharedRootPatterns.some((pattern) => pattern.test(path));
}

async function rejectSymlinkComponents(cwd: string, path: string): Promise<void> {
	let current = cwd;
	for (const segment of path.split("/")) {
		current = resolve(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Write path contains a symbolic-link component: ${path}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}
}

/** Validates a declared scope without resolving symlinks outside the workspace. */
export async function normalizeSubagentScope(
	cwd: string,
	input: { mode?: "read" | "write"; paths?: string[] },
	readOnly = false,
): Promise<SubagentScope> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new TypeError("Subagent scope must be an object");
	const mode = input.mode === undefined ? (readOnly ? "read" : "write") : input.mode;
	if (mode !== "read" && mode !== "write") throw new TypeError("Subagent scope mode must be read or write");
	if (readOnly && input.mode === "write") throw new Error("A read-only subagent cannot declare write scope");
	if (input.paths !== undefined && !Array.isArray(input.paths))
		throw new TypeError("Subagent scope paths must be an array");

	const root = resolve(cwd);
	const paths: string[] = [];
	for (const value of input.paths ?? []) {
		if (typeof value !== "string") throw new TypeError("Subagent scope paths must contain strings");
		if (!value || value.includes("\0") || value.includes("\\") || /^(?:[A-Za-z]:|\/)/.test(value)) {
			throw new Error(`Invalid repository-relative path: ${JSON.stringify(value)}`);
		}
		const absolute = resolve(root, value);
		const fromRoot = relative(root, absolute);
		if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error(`Path escapes workspace: ${value}`);
		paths.push(fromRoot ? fromRoot.split(sep).join("/") : ".");
	}
	const normalized = [...new Set(paths)];
	if (mode === "write")
		await Promise.all(normalized.filter((path) => path !== ".").map((path) => rejectSymlinkComponents(root, path)));
	const broad =
		mode === "write" && (normalized.length === 0 || normalized.includes(".") || normalized.some(isSharedPath));
	return { mode, paths: normalized, broad };
}

function overlaps(a: string, b: string): boolean {
	// Case-fold conservatively on platforms whose default filesystems are case-insensitive.
	if (process.platform === "win32" || process.platform === "darwin") {
		a = a.toLowerCase();
		b = b.toLowerCase();
	}
	return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function scopesConflict(a: SubagentScope, b: SubagentScope): boolean {
	if (a.mode === "read" || b.mode === "read") return false;
	if (a.broad || b.broad) return true;
	return a.paths.some((left) => b.paths.some((right) => overlaps(left, right)));
}

export type SchedulerStatus = { status: "queued" | "running" | "completed" | "failed" | "aborted"; reason?: string };

type Job<T> = {
	scope: SubagentScope;
	controller: AbortController;
	serial: boolean;
	run: () => Promise<T>;
	onStatus?: (status: SchedulerStatus) => void;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	abort: () => void;
	state: "queued" | "active" | "settled";
	lastStatus?: string;
	done: Promise<void>;
	finish: () => void;
};

export class SubagentScheduler {
	#queued: Job<unknown>[] = [];
	#active = new Set<Job<unknown>>();
	#draining = false;
	#stopping = false;
	#shutdown?: Promise<void>;
	readonly #limit: number;

	constructor(limit = 2) {
		if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Subagent scheduler limit must be at least one");
		this.#limit = limit;
	}

	get size(): number {
		return this.#queued.length + this.#active.size;
	}

	schedule<T>(options: {
		scope: SubagentScope;
		controller: AbortController;
		serial?: boolean;
		run: () => Promise<T>;
		onStatus?: (status: SchedulerStatus) => void;
	}): Promise<T> {
		if (this.#stopping) return Promise.reject(this.#abortError("Subagent scheduler is shut down"));
		options.controller.signal.throwIfAborted();
		return new Promise<T>((resolve, reject) => {
			let finish!: () => void;
			const done = new Promise<void>((doneResolve) => {
				finish = doneResolve;
			});
			const job: Job<T> = {
				...options,
				serial: options.serial === true,
				resolve,
				reject,
				state: "queued",
				done,
				finish,
				abort: () => this.#cancelQueued(job as unknown as Job<unknown>),
			};
			options.controller.signal.addEventListener("abort", job.abort, { once: true });
			this.#queued.push(job as Job<unknown>);
			this.#drain();
		});
	}

	async shutdown(reason?: unknown): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		this.#stopping = true;
		this.#shutdown = (async () => {
			for (const job of [...this.#queued]) {
				job.controller.abort(reason);
				this.#cancelQueued(job);
			}
			for (const job of this.#active) job.controller.abort(reason);
			await Promise.all([...this.#active].map((job) => job.done));
		})();
		return this.#shutdown;
	}

	#drain(): void {
		if (this.#draining || this.#stopping) return;
		this.#draining = true;
		try {
			let started: boolean;
			do {
				started = false;
				for (const job of [...this.#queued]) {
					if (this.#stopping) break;
					if (job.state !== "queued") continue;
					const reason = this.#blockingReason(job);
					if (reason) {
						this.#status(job, { status: "queued", reason });
						continue;
					}
					this.#queued.splice(this.#queued.indexOf(job), 1);
					job.controller.signal.removeEventListener("abort", job.abort);
					this.#start(job);
					started = true;
				}
			} while (started && !this.#shutdown);
		} finally {
			this.#draining = false;
		}
	}

	#blockingReason(job: Job<unknown>): string | undefined {
		if (
			this.#active.size >= this.#limit ||
			(job.serial && this.#active.size > 0) ||
			[...this.#active].some((active) => active.serial)
		)
			return "capacity";
		const conflict = [...this.#active].find((active) => scopesConflict(job.scope, active.scope));
		if (!conflict) return undefined;
		if (job.scope.broad || conflict.scope.broad) return "conflicting broad write";
		const left = job.scope.paths.find((path) => conflict.scope.paths.some((other) => overlaps(path, other)))!;
		return `conflicting path: ${left}`;
	}

	#start(job: Job<unknown>): void {
		job.state = "active";
		this.#active.add(job);
		this.#status(job, { status: "running" });
		let promise: Promise<unknown>;
		try {
			job.controller.signal.throwIfAborted();
			promise = Promise.resolve(job.run());
		} catch (error) {
			promise = Promise.reject(error);
		}
		promise.then(
			(value) => this.#settle(job, "completed", value),
			(error) => this.#settle(job, job.controller.signal.aborted ? "aborted" : "failed", error),
		);
	}

	#settle(job: Job<unknown>, status: SchedulerStatus["status"], value: unknown): void {
		if (job.state === "settled") return;
		if (status === "completed" && job.controller.signal.aborted) {
			status = "aborted";
			value = job.controller.signal.reason;
		}
		job.state = "settled";
		this.#active.delete(job);
		job.finish();
		this.#status(job, { status });
		if (status === "completed") job.resolve(value);
		else job.reject(value);
		this.#drain();
	}

	#cancelQueued(job: Job<unknown>): void {
		if (job.state !== "queued") return;
		job.state = "settled";
		const index = this.#queued.indexOf(job);
		if (index >= 0) this.#queued.splice(index, 1);
		job.finish();
		job.controller.signal.removeEventListener("abort", job.abort);
		this.#status(job, { status: "aborted" });
		try {
			job.controller.signal.throwIfAborted();
		} catch (error) {
			job.reject(error);
		}
		this.#drain();
	}

	#status(job: Job<unknown>, status: SchedulerStatus): void {
		const key = `${status.status}\0${status.reason ?? ""}`;
		if (job.lastStatus === key) return;
		job.lastStatus = key;
		try {
			job.onStatus?.(status);
		} catch {
			/* Status observers cannot retain scheduler reservations. */
		}
	}

	#abortError(message: string): Error {
		const error = new Error(message);
		error.name = "AbortError";
		return error;
	}
}
