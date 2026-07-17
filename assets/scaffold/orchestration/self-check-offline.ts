/**
 * Offline self-check for assert-quality + preclassify (no device).
 * Exit 0 on pass. Invoked by validate-skill-dry-run.sh / self-check-offline.sh
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyAssertQuality } from "./assert-quality";
import { preclassifyFailures, loadDiagnosis } from "./preclassify-failures";
import {
	QUICK_BUDGET_MS,
	STANDARD_BUDGET_MS,
	BOOTSTRAP_CASE_ID,
	BUDGET_SKIP_RATIO,
} from "./constants";
import { runDir, runsRoot } from "./paths";

function assertEq(actual: string, expected: string, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`);
	}
}

function checkAssertQuality(): void {
	assertEq(
		classifyAssertQuality({
			expectedResult: "Toast 提示缺少车源号",
			minimalVerification: "可见 Toast",
		}),
		"assert-strong",
		"toast+copy",
	);
	assertEq(
		classifyAssertQuality({
			expectedResult: "页面渲染",
			minimalVerification: "首屏展示",
		}),
		"pending-assert",
		"render-only",
	);
	assertEq(
		classifyAssertQuality({ expectedResult: "", minimalVerification: "" }),
		"pending-assert",
		"empty",
	);
	assertEq(
		classifyAssertQuality({
			expectedResult: "跳转到 /form 且 URL 包含 evaluate",
			minimalVerification: "导航成功",
		}),
		"assert-strong",
		"url-nav",
	);
	assertEq(
		classifyAssertQuality({
			expectedResult: '按钮 [data-e2e="submit"] 可点',
			minimalVerification: "提交成功",
		}),
		"assert-strong",
		"data-e2e",
	);
	console.log("[self-check] assert-quality OK");
}

function checkPreclassify(): void {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-preclassify-"));
	const runId = "run-selfcheck";
	const sandbox = path.join(home, "sandbox", "hash", "demo");
	const runDir = path.join(sandbox, "artifacts", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	process.env.E2E_SANDBOX = sandbox;
	process.env.E2E_HOME = home;

	const jsonl = path.join(runDir, "cases-executed.jsonl");
	fs.writeFileSync(
		jsonl,
		[
			JSON.stringify({
				caseId: "demo.C01",
				status: "failed",
				error: "Failed to create session: UiAutomator2",
			}),
			JSON.stringify({
				caseId: "demo.C02",
				status: "failed",
				error: "no such context WEBVIEW / chromedriver",
			}),
			JSON.stringify({
				caseId: "demo.C03",
				status: "failed",
				error: "expect(toastVisible).toBe(true)",
			}),
			JSON.stringify({
				caseId: "demo.C04",
				status: "failed",
				error: "401 unauthorized login required",
			}),
		].join("\n") + "\n",
		"utf-8",
	);

	const report = preclassifyFailures(runId);
	const byId = Object.fromEntries(report.items.map((i) => [i.caseId, i.rootCause]));
	assertEq(byId["demo.C01"], "L0_native", "uiautomator");
	assertEq(byId["demo.C02"], "L1_hybrid", "webview");
	assertEq(byId["demo.C03"], "L2_biz", "assert");
	assertEq(byId["demo.C04"], "L0_auth", "auth");

	const loaded = loadDiagnosis(runId);
	if (!loaded || loaded.items.length !== 4) {
		throw new Error("loadDiagnosis failed");
	}

	fs.rmSync(home, { recursive: true, force: true });
	console.log("[self-check] preclassify-failures OK");
}

function checkBudgetConstants(): void {
	if (QUICK_BUDGET_MS !== 12 * 60 * 1000) {
		throw new Error(`QUICK_BUDGET_MS expected 12min, got ${QUICK_BUDGET_MS}`);
	}
	if (STANDARD_BUDGET_MS !== 25 * 60 * 1000) {
		throw new Error(`STANDARD_BUDGET_MS expected 25min, got ${STANDARD_BUDGET_MS}`);
	}
	if (BOOTSTRAP_CASE_ID !== "infra.app-launch") {
		throw new Error(`BOOTSTRAP_CASE_ID expected infra.app-launch, got ${BOOTSTRAP_CASE_ID}`);
	}
	if (BUDGET_SKIP_RATIO !== 0.95) {
		throw new Error(`BUDGET_SKIP_RATIO expected 0.95, got ${BUDGET_SKIP_RATIO}`);
	}
	console.log("[self-check] budget/bootstrap constants OK");
}

function checkArtifactsPathHelpers(): void {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-paths-"));
	const sandbox = path.join(home, "sandbox", "hash", "demo");
	const runId = "run-pathcheck";
	const runDirPath = path.join(sandbox, "artifacts", "runs", runId);
	fs.mkdirSync(runDirPath, { recursive: true });
	fs.writeFileSync(path.join(runDirPath, "diagnose-request.json"), '{"runId":"run-pathcheck"}');
	process.env.E2E_SANDBOX = sandbox;
	process.env.E2E_HOME = home;
	process.env.E2E_RUN_ID = runId;

	const rd = runDir(runId);
	if (rd.includes(`${path.sep}runs${path.sep}${runId}${path.sep}runs`)) {
		throw new Error(`runDir double-nested: ${rd}`);
	}
	if (!fs.existsSync(path.join(rd, "diagnose-request.json"))) {
		throw new Error(`diagnose-request not under runDir: ${rd}`);
	}
	const root = runsRoot();
	if (!fs.existsSync(path.join(root, runId, "diagnose-request.json"))) {
		throw new Error(`runsRoot missing run: ${root}`);
	}

	fs.rmSync(home, { recursive: true, force: true });
	console.log("[self-check] artifacts path helpers OK");
}

function main(): void {
	checkAssertQuality();
	checkPreclassify();
	checkBudgetConstants();
	checkArtifactsPathHelpers();
	console.log("[self-check] all offline checks passed");
}

main();
