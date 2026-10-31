import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./pack-tark.mjs", import.meta.url));
test("Tark packaging describes a local-only operation", () => {
	const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /never publishes/);
});
test("Tark packaging rejects upstream identities and malformed names", () => {
	for (const name of ["@earendil-works/pi-coding-agent", "../escape", "Bad Name"]) {
		const result = spawnSync(process.execPath, [script, "--name", name], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /own valid npm package name/);
	}
});
