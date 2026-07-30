/**
 * Test helper: invoke preclassifyFailures with a synthetic invalid-selector error
 * and print the diagnosis rootCause. Invoked by the contract test via ts-node.
 *
 * This is a TEST-ONLY helper — not part of the Skill runtime.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preclassifyFailures } from "../../../assets/scaffold/orchestration/preclassify-failures";

// Redirect console.log to stderr so stdout contains only JSON
const origLog = console.log;
console.log = (...args) => console.error(...args);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-preclassify-ctract-"));
const sandbox = path.join(home, "sandbox", "hash", "contract");
const runId = "run-contract";
const runDir = path.join(sandbox, "artifacts", "runs", runId);
fs.mkdirSync(runDir, { recursive: true });
process.env.E2E_SANDBOX = sandbox;
process.env.E2E_HOME = home;

const jsonl = path.join(runDir, "cases-executed.jsonl");
fs.writeFileSync(
	jsonl,
	[
		JSON.stringify({
			caseId: "contract.L01",
			status: "failed",
			error: "invalid selector: Unsupported CSS selector '[data-e2e=\"list\"], .list-container, main, body'",
		}),
		JSON.stringify({
			caseId: "contract.L02",
			status: "failed",
			error: "Error: Unsupported CSS selector 'input[type=\"search\"], input[placeholder*=\"搜索\"]'",
		}),
		JSON.stringify({
			caseId: "contract.L03",
			status: "failed",
			error: "expect(await card.isExisting()).toBe(true)",
		}),
	].join("\n") + "\n",
	"utf-8",
);

const report = preclassifyFailures(runId);
const result = report.items.map((i) => ({ caseId: i.caseId, layer: i.layer, rootCause: i.rootCause }));
// Suppress any stdout noise from preclassifyFailures by writing only JSON
console.log = origLog;
process.stdout.write(JSON.stringify(result));

fs.rmSync(home, { recursive: true, force: true });
