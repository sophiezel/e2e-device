import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "../..");
const tsNode = path.join(skillRoot, "scripts/node_modules/.bin/ts-node");

test("buildH5Url hash routing + vue route graph", () => {
	const r = spawnSync(
		tsNode,
		[
			"--compiler-options",
			JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
			path.join(__dirname, "helpers/build-h5-url-check.ts"),
		],
		{ encoding: "utf-8", cwd: skillRoot },
	);
	if (r.status !== 0) {
		console.error(r.stdout, r.stderr);
	}
	assert.equal(r.status, 0, r.stderr || r.stdout);
	assert.match(r.stdout, /build-h5-url contract: ok/);
});
