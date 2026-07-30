import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectHash } from "../../scripts/lib/project-hash.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "../..");
const tsNode = path.join(skillRoot, "scripts/node_modules/.bin/ts-node");

function hashFromPathsTs(projectRoot) {
	const r = spawnSync(
		tsNode,
		[path.join(skillRoot, "assets/scaffold/orchestration/hash-cli.ts"), projectRoot],
		{ cwd: skillRoot, encoding: "utf-8" },
	);
	assert.equal(r.status, 0, `ts-node paths.projectHash failed: ${r.stderr}`);
	return r.stdout.trim();
}

function hashFromBash(projectRoot) {
	const r = spawnSync(
		"node",
		[path.join(skillRoot, "scripts/lib/project-hash.mjs"), projectRoot],
		{ encoding: "utf-8" },
	);
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}

test("projectHash matches paths.ts and bash CLI", () => {
	const samples = [
		"/tmp/my-hybrid-app",
		path.join(skillRoot, "assets/scaffold"),
		"/Users/test/project with spaces",
	];
	for (const p of samples) {
		const fromMjs = projectHash(p);
		const fromTs = hashFromPathsTs(p);
		const fromCli = hashFromBash(p);
		assert.equal(fromMjs, fromTs, `mjs vs ts for ${p}`);
		assert.equal(fromMjs, fromCli, `mjs vs cli for ${p}`);
		assert.match(fromMjs, /^[A-Za-z0-9_-]+$/);
		assert.ok(fromMjs.length > 0 && fromMjs.length <= 32);
	}
});
