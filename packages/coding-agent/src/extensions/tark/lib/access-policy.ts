// Best-effort file-tool policy; shell commands and other extensions are not sandboxed.
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ignore from "ignore";

function within(root: string, path: string): boolean {
	const local = relative(root, path);
	return local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			// realpath cannot resolve a dangling symlink, but a write would still follow it.
			if ((await lstat(path)).isSymbolicLink()) return canonicalPath(resolve(dirname(path), await readlink(path)));
		} catch (linkError) {
			if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
		}
		// New files still inherit the real location of their nearest existing parent.
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(await canonicalPath(parent), relative(parent, path));
	}
}

/** Reject protected paths, including new files under symlinks that escape the project. */
export async function deniedPath(
	cwd: string,
	requested: string,
	mode: "read" | "write" = "write",
): Promise<string | undefined> {
	const root = await realpath(cwd);
	const absolute = resolve(
		root,
		requested.replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? process.env.USERPROFILE ?? "~"),
	);
	if (mode === "write" && !within(root, absolute)) return "outside the project";
	const canonical = await canonicalPath(absolute);
	if (mode === "write" && !within(root, canonical)) return "symlink escapes the project";
	for (const path of [absolute, canonical]) {
		if (path.split(sep).some((part) => part === ".env" || part.startsWith(".env.")))
			return "environment files are protected";
	}
	// External documentation and installed resources remain readable; targets inside the project obey its policy.
	for (const target of new Set([absolute, canonical])) {
		if (!within(root, target) || target === root) continue;
		let directory = false;
		try {
			directory = (await lstat(target)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const name of [".gitignore", ".claudeignore"] as const) {
			let base = root;
			while (within(base, target) && base !== target) {
				let text: string;
				try {
					text = await readFile(resolve(base, name), "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					text = "";
				}
				const local = relative(base, target).split(sep).join("/") + (directory ? "/" : "");
				if (ignore().add(text).ignores(local)) return `matched ${name}`;
				const next = resolve(base, relative(base, target).split(sep)[0]);
				if (next === target) break;
				base = next;
			}
		}
	}
	return undefined;
}

/** Block obvious environment dumps without rejecting ordinary shell variables or `set -e`. */
export function blockedBashReason(command: string): string | undefined {
	return /\bprintenv\b|(?:^|[;&|]\s*)(?:env|set)\s*(?:$|[;&|])|\/(?:proc|sys)\/[^\s]*environ\b|\bprocess\.env\b|\bos\.environ\b/.test(
		command,
	)
		? "environment inspection is disabled"
		: undefined;
}
