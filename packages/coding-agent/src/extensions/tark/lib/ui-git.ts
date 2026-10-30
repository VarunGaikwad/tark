import { type ChildProcess, execFile } from "node:child_process";

export type FooterGitStats = {
	branch: string | undefined;
	dirty: boolean;
	added: number;
	removed: number;
};

type GitResult = { ok: true; output: string } | { ok: false };

const THROTTLE_MS = 1_000;
const COMMAND_TIMEOUT_MS = 3_000;
const MAX_OUTPUT = 64 * 1024;
// shortcut: unborn SHA-256 repos omit stats; derive their empty tree hash if support is needed.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function createFooterGitTracker(
	cwd: string,
	onChange: () => void,
): {
	getStats(): FooterGitStats | undefined;
	refresh(): void;
	dispose(): void;
} {
	let stats: FooterGitStats | undefined;
	let disposed = false;
	let running = false;
	let pending = false;
	let timer: NodeJS.Timeout | undefined;
	let lastStarted = 0;
	const children = new Set<ChildProcess>();

	function git(args: string[]): Promise<GitResult> {
		if (disposed) return Promise.resolve({ ok: false });
		return new Promise((resolve) => {
			let child: ChildProcess;
			try {
				child = execFile(
					"git",
					args,
					{
						cwd,
						encoding: "utf8",
						timeout: COMMAND_TIMEOUT_MS,
						maxBuffer: MAX_OUTPUT,
						windowsHide: true,
					},
					(error, stdout) => {
						children.delete(child);
						resolve(error || disposed ? { ok: false } : { ok: true, output: stdout });
					},
				);
				children.add(child);
			} catch {
				resolve({ ok: false });
			}
		});
	}

	async function collect(): Promise<FooterGitStats | undefined> {
		const status = await git(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]);
		if (!status.ok) return undefined;

		const symbolicBranch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
		let branch = symbolicBranch.ok ? symbolicBranch.output.trim() || undefined : undefined;
		const head = await git(["rev-parse", "--verify", "HEAD"]);
		if (!branch && head.ok) {
			const detached = await git(["rev-parse", "--short", "HEAD"]);
			if (!detached.ok) return undefined;
			branch = detached.output.trim() || undefined;
		}

		const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", head.ok ? "HEAD" : EMPTY_TREE]);
		if (!diff.ok) return undefined;
		let added = 0;
		let removed = 0;
		for (const line of diff.output.split("\n")) {
			const [add, remove] = line.split("\t", 3);
			if (add === "-" || remove === "-") continue;
			const addCount = Number(add);
			const removeCount = Number(remove);
			if (Number.isSafeInteger(addCount) && Number.isSafeInteger(removeCount)) {
				added += addCount;
				removed += removeCount;
			}
		}
		return { branch, dirty: status.output.length > 0, added, removed };
	}

	function same(a: FooterGitStats | undefined, b: FooterGitStats | undefined): boolean {
		return a?.branch === b?.branch && a?.dirty === b?.dirty && a?.added === b?.added && a?.removed === b?.removed;
	}

	function schedule() {
		if (disposed || running || timer || !pending) return;
		const delay = Math.max(0, THROTTLE_MS - (Date.now() - lastStarted));
		timer = setTimeout(() => {
			timer = undefined;
			if (pending) run();
		}, delay);
		timer.unref?.();
	}

	async function run() {
		if (disposed || running || !pending) return;
		pending = false;
		running = true;
		lastStarted = Date.now();
		try {
			const next = await collect();
			if (!disposed && !same(stats, next)) {
				stats = next;
				try {
					onChange();
				} catch {
					// A footer notification must not leave refreshes stuck.
				}
			}
		} catch {
			// Treat unexpected collection failures as unavailable Git state.
		} finally {
			running = false;
			schedule();
		}
	}

	return {
		getStats: () => stats,
		refresh() {
			if (disposed) return;
			pending = true;
			schedule();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			for (const child of children) child.kill();
			children.clear();
		},
	};
}
