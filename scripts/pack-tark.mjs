#!/usr/bin/env node
// Package the fork under its own npm identity without renaming Pi's workspace SDK.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "../packages/coding-agent/src/utils/child-process.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
	console.log("Usage: node scripts/pack-tark.mjs [--name @scope/package] [--out directory]\nBuild first with npm run build. This creates a tarball; it never publishes.");
	process.exit(0);
}
let name = "@tark-ai/coding-agent";
let out = join(root, ".artifacts", "tark");
for (let index = 0; index < args.length; index++) {
	const flag = args[index];
	const value = args[++index];
	if (!value || (flag !== "--name" && flag !== "--out")) throw new Error("Expected --name or --out with a value");
	if (flag === "--name") name = value;
	else out = resolve(value);
}
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.startsWith("@earendil-works/")) {
	throw new Error("Choose Tark's own valid npm package name, not the upstream scope");
}
const source = join(root, "packages", "coding-agent");
const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
// Fail before staging if the build is absent; npm pack must never silently produce a source-only CLI.
await readFile(join(source, "dist", "bundle", "cli.js"));
const staging = await mkdtemp(join(tmpdir(), "tark-package-"));
try {
	for (const path of ["dist", "tark", "docs", "examples", "schemas", "README.md", "CHANGELOG.md", "LICENSE"]) {
		await cp(join(source, path), join(staging, path), { recursive: true });
	}
	manifest.name = name;
	manifest.scripts = {};
	manifest.files = ["dist", "tark", "docs", "examples", "schemas", "README.md", "CHANGELOG.md", "LICENSE"];
	await writeFile(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	await mkdir(out, { recursive: true });
	const packed = spawnProcessSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: staging, encoding: "utf8", shell: false });
	if (packed.status !== 0) throw new Error(packed.stderr || packed.error?.message || "npm pack failed");
	for (const artifact of JSON.parse(packed.stdout)) {
		console.log(`${join(out, artifact.filename)} (${artifact.entryCount} files, ${artifact.size} bytes)`);
	}
} finally {
	await rm(staging, { recursive: true, force: true });
}
