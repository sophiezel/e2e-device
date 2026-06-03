import fs from "node:fs";
import path from "node:path";
import type { ResilienceRunSummary, CaseRecord } from "./types";

const ARTIFACTS_DIR = "e2e-device/artifacts/runs";

function ensureDir(dir: string): void {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

/** Mark a spec as started — writes to cases-executed.jsonl for audit trail */
export function markSpecStarted(specName: string): void {
	console.log(`[issue-ledger] Spec started: ${specName}`);
	const runId = process.env.E2E_RUN_ID || "";
	if (!runId) return;
	const runDir = path.join(ARTIFACTS_DIR, runId);
	ensureDir(runDir);
	const ledgerPath = path.join(runDir, "cases-executed.jsonl");
	if (!fs.existsSync(ledgerPath)) {
		fs.writeFileSync(ledgerPath, "");
	}
	const row = {
		event: "spec_started",
		spec: specName,
		at: new Date().toISOString(),
	};
	fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`, "utf-8");
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

/** Aggregate summary from cases-executed.jsonl */
function aggregateFromRunDir(runId: string): ResilienceRunSummary | null {
	const runDir = path.join(ARTIFACTS_DIR, runId);
	const jsonlPath = path.join(runDir, "cases-executed.jsonl");
	const metaPath = path.join(runDir, "run-meta.json");

	if (!fs.existsSync(jsonlPath)) {
		return null;
	}

	let startedAt = "";
	if (fs.existsSync(metaPath)) {
		try {
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { startedAt?: string };
			startedAt = meta.startedAt || "";
		} catch {
			// ignore
		}
	}

	const cases: CaseRecord[] = [];
	for (const line of fs.readFileSync(jsonlPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as {
				caseId?: string;
				spec?: string;
				exitCode?: number;
				at?: string;
				outcome?: string;
				durationMs?: number;
			};
			if (row.caseId) {
				const outcome = row.outcome || (row.exitCode === 0 ? "passed" : "failed");
				cases.push({
					caseId: row.caseId,
					spec: row.spec || "",
					title: row.caseId,
					outcome: outcome as CaseRecord["outcome"],
					duration: row.durationMs || 0,
					issues: [],
					autoFixes: [],
					pendingItems: [],
				});
			}
		} catch {
			// ignore bad line
		}
	}

	const passed = cases.filter((c) => c.outcome === "passed").length;
	const failed = cases.filter((c) => c.outcome === "failed").length;
	const blockedAuth = cases.filter((c) => c.outcome === "blocked").length;
	const skipped = cases.filter((c) => c.outcome === "skipped").length;

	return {
		runId,
		totalCases: cases.length,
		passed,
		passedLive: 0,
		passedWithMock: 0,
		passedAfterAutofix: 0,
		failed,
		degradedFailures: failed,
		blockedAuth,
		skipped,
		errors: 0,
		autoFixCount: 0,
		startedAt: startedAt || (cases.length > 0 ? new Date().toISOString() : ""),
		finishedAt: new Date().toISOString(),
		cases,
	};
}

/** Write resilience reports to artifacts */
export function writeResilienceReports(
	runId?: string,
	summary?: ResilienceRunSummary,
): void {
	// Support no-parameter calls: auto-detect runId from .e2e-run-id file
	if (!runId) {
		const runIdFile = "e2e-device/.e2e-run-id";
		if (fs.existsSync(runIdFile)) {
			runId = fs.readFileSync(runIdFile, "utf-8").trim();
		}
	}
	if (!runId) {
		return;
	}

	// If no summary provided, aggregate from cases-executed.jsonl
	if (!summary) {
		const aggregated = aggregateFromRunDir(runId);
		if (!aggregated) {
			return;
		}
		summary = aggregated;
	}

	const dir = path.join(ARTIFACTS_DIR, runId);
	ensureDir(dir);

	const jsonPath = path.join(dir, "resilience-report.json");
	fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

	const mdPath = path.join(dir, "resilience-report.md");
	const allCases = summary.cases;
	const totalDurationMs = allCases.reduce((sum: number, c: CaseRecord) => sum + (c.duration || 0), 0);
	const slowest = [...allCases]
		.filter((c: CaseRecord) => (c.duration ?? 0) > 0)
		.sort((a: CaseRecord, b: CaseRecord) => (b.duration ?? 0) - (a.duration ?? 0))
		.slice(0, 3);

	const lines: string[] = [
		"# E2E Resilience Report",
		"",
		`**Run ID:** ${runId}`,
		`**Started:** ${summary.startedAt || "N/A"}`,
		`**Finished:** ${summary.finishedAt || "N/A"}`,
		`**Total Duration:** ${(totalDurationMs / 1000).toFixed(1)}s`,
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

	if (slowest.length > 0) {
		lines.push(
			"",
			"## Slowest Cases",
			"",
		);
		for (const c of slowest) {
			lines.push(`- **${c.caseId}** — ${((c.duration ?? 0) / 1000).toFixed(1)}s (${c.spec})`);
		}
	}

	fs.writeFileSync(mdPath, lines.join("\n") + "\n");
}
