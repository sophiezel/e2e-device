import * as fs from "fs";
import * as path from "path";
import type { ResilienceRunSummary } from "./types";

const ARTIFACTS_DIR = "e2e-device/artifacts/runs";

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** Mark a spec as started */
export function markSpecStarted(specName: string): void {
	console.log(`[issue-ledger] Spec started: ${specName}`);
}

/** Mark a run as started in the issue ledger */
export function markRunStarted(runId: string): void {
	const runDir = path.join(ARTIFACTS_DIR, runId);
	ensureDir(runDir);

	const ledgerPath = path.join(runDir, "cases-executed.jsonl");
	if (!fs.existsSync(ledgerPath)) {
		fs.writeFileSync(ledgerPath, "");
	}

	const metaPath = path.join(runDir, "run-meta.json");
	fs.writeFileSync(
		metaPath,
		JSON.stringify({ runId, startedAt: new Date().toISOString() }, null, 2),
	);
}

/** Write resilience reports to artifacts */
export function writeResilienceReports(
	runId?: string,
	summary?: ResilienceRunSummary,
): void {
	if (!runId || !summary) {
		return;
	}
	const runDir = path.join(ARTIFACTS_DIR, runId);
	ensureDir(runDir);

	const jsonPath = path.join(runDir, "resilience-report.json");
	fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

	const mdPath = path.join(runDir, "resilience-report.md");
	const lines: string[] = [
		"# E2E Resilience Report",
		"",
		`**Run ID:** ${runId}`,
		`**Started:** ${summary.startedAt || "N/A"}`,
		`**Finished:** ${summary.finishedAt || "N/A"}`,
		"",
		"## Summary",
		"",
		`| Metric | Count |`,
		`|--------|-------|`,
		`| Total | ${summary.totalCases} |`,
		`| Passed | ${summary.passed} |`,
		`| Failed | ${summary.failed} |`,
		`| Blocked (Auth) | ${summary.blockedAuth} |`,
		`| Skipped | ${summary.skipped} |`,
		`| Errors | ${summary.errors} |`,
		"",
		"## Cases",
		"",
		`| Case | Spec | Outcome | Duration |`,
		`|------|------|---------|----------|`,
	];

	for (const c of summary.cases) {
		const dur = c.duration ? `${(c.duration / 1000).toFixed(1)}s` : "-";
		lines.push(`| ${c.caseId} | ${c.spec} | ${c.outcome} | ${dur} |`);
	}

	fs.writeFileSync(mdPath, lines.join("\n") + "\n");
}
