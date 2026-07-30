import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "../..");
const tsNode = path.join(skillRoot, "scripts/node_modules/.bin/ts-node");
const cli = path.join(skillRoot, "assets/scaffold/orchestration/cli.ts");

test("writeProgressEvent writes under artifacts/runs/{runId}/progress.jsonl", () => {
	const work = fs.mkdtempSync(path.join("/tmp", "e2e-progress-"));
	const sandbox = path.join(work, "sandbox");
	const runId = "test-run-001";
	fs.mkdirSync(sandbox, { recursive: true });

	const r = spawnSync(
		tsNode,
		[cli, "progress-event", "contract-test", JSON.stringify({ runId, ok: true })],
		{
			cwd: skillRoot,
			encoding: "utf-8",
			env: {
				...process.env,
				E2E_SANDBOX: sandbox,
				E2E_RUN_ID: runId,
				E2E_PROJECT_ROOT: work,
				E2E_DOMAIN: "testDomain",
			},
		},
	);
	assert.equal(r.status, 0, r.stderr || r.stdout);

	const progressFile = path.join(sandbox, "artifacts", "runs", runId, "progress.jsonl");
	const legacyFile = path.join(sandbox, "progress.jsonl");
	assert.ok(fs.existsSync(progressFile), `expected ${progressFile}`);
	assert.ok(!fs.existsSync(legacyFile), "must not write sandbox root progress.jsonl");

	const line = fs.readFileSync(progressFile, "utf-8").trim().split("\n").pop();
	const event = JSON.parse(line);
	assert.equal(event.phase, "contract-test");
	assert.equal(event.runId, runId);

	fs.rmSync(work, { recursive: true, force: true });
});
