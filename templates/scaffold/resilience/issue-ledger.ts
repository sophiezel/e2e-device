import fs from "node:fs";
import path from "node:path";
import type { ResilienceRunSummary, CaseRecord } from "./types";
import { artifactsRoot, runDir as resolveRunDir, e2eDeviceRoot } from "../orchestration/paths";
import { CASES_EXECUTED_FILE, RUN_META_FILE, RESILIENCE_REPORT_JSON, RESILIENCE_REPORT_MD } from "../orchestration/constants";

function runsDir(): string {
	return path.join(artifactsRoot(), "runs");
}

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
	const dir = path.join(runsDir(), runId);
	ensureDir(dir);
	const ledgerPath = path.join(dir, CASES_EXECUTED_FILE);
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
	const dir = path.join(runsDir(), runId);
	ensureDir(dir);

	const ledgerPath = path.join(dir, CASES_EXECUTED_FILE);
	if (!fs.existsSync(ledgerPath)) {
		fs.writeFileSync(ledgerPath, "");
	}

	const metaPath = path.join(dir, RUN_META_FILE);
	fs.writeFileSync(
		metaPath,
		JSON.stringify({ runId, startedAt: new Date().toISOString() }, null, 2),
	);
}

/** Aggregate summary from cases-executed.jsonl */
function aggregateFromRunDir(runId: string): ResilienceRunSummary | null {
	const dir = path.join(runsDir(), runId);
	const jsonlPath = path.join(dir, CASES_EXECUTED_FILE);
	const metaPath = path.join(dir, RUN_META_FILE);

	if (!fs.existsSync(jsonlPath)) {
		return null;
	}

	let startedAt = "";
	if (fs.existsSync(metaPath)) {
		try {
			const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as { startedAt?: string };
			startedAt = meta.startedAt || "";
		} catch (err) {
			if (process.env.E2E_DEBUG) { console.debug("[issue-ledger] meta parse error:", err); }
		}
	}

	const cases: CaseRecord[] = [];
	let passedLive = 0;
	let passedWithMock = 0;
	let passedAfterAutofix = 0;
	let errorCount = 0;
	let autoFixCount = 0;

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
				mockLayer?: string;
				autoFixed?: boolean;
				autoFixAttempted?: boolean;
				event?: string;
			};
			// Skip non-case rows (spec_started, run_started, etc.)
			if (!row.caseId) continue;

			const outcome = row.outcome || (row.exitCode === 0 ? "passed" : "failed");

			// Compute granular pass metrics
			if (outcome === "passed") {
				if (row.mockLayer === "inject" || row.outcome === "pass_with_mock") {
					passedWithMock++;
				} else if (row.autoFixed || row.outcome === "pass_after_autofix") {
					passedAfterAutofix++;
				} else {
					passedLive++;
				}
			} else if (outcome === "error" || outcome === "degraded_fail") {
				errorCount++;
			}

			// Track auto-fix attempts
			if (row.autoFixAttempted) {
				autoFixCount++;
			}

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
		} catch (err) {
			if (process.env.E2E_DEBUG) { console.debug("[issue-ledger] bad JSONL line:", err); }
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
		passedLive,
		passedWithMock,
		passedAfterAutofix,
		failed,
		degradedFailures: failed,
		blockedAuth,
		skipped,
		errors: errorCount,
		autoFixCount,
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
		const runIdFile = path.join(e2eDeviceRoot(), ".e2e-run-id");
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

	const dir = path.join(runsDir(), runId);
	ensureDir(dir);

	const jsonPath = path.join(dir, RESILIENCE_REPORT_JSON);
	fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

	const mdPath = path.join(dir, RESILIENCE_REPORT_MD);
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

// ===== Flaky Detection =====

export interface FlakyCase {
	caseId: string;
	passRate: number;
	totalRuns: number;
	passes: number;
	failures: number;
	isFlaky: boolean;
	lastOutcomes: string[];
}

export interface FlakyReport {
	cases: FlakyCase[];
	summary: { totalAnalyzed: number; flakyCount: number; stableCount: number };
}

/** Detect flaky cases by analyzing recent run histories.
 *  A case is considered flaky if pass rate is between FLAKY_THRESHOLD_LOW and FLAKY_THRESHOLD_HIGH
 *  (i.e., not consistently failing OR consistently passing). */
export function detectFlakyCases(minRuns = 3): FlakyReport {
	const root = runsDir();
	if (!fs.existsSync(root)) {
		return { cases: [], summary: { totalAnalyzed: 0, flakyCount: 0, stableCount: 0 } };
	}

	const thresholdLow = parseFloat(process.env.E2E_FLAKY_THRESHOLD_LOW || "0.2");
	const thresholdHigh = parseFloat(process.env.E2E_FLAKY_THRESHOLD_HIGH || "0.8");

	// Collect all runs sorted by time (newest first)
	const runs = fs.readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => ({
			id: d.name,
			mtime: fs.statSync(path.join(root, d.name)).mtime.getTime(),
		}))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, 20); // Analyze at most 20 most recent runs

	// Aggregate outcomes per caseId across runs
	const caseHistory = new Map<string, { passes: number; failures: number; outcomes: string[] }>();

	for (const run of runs) {
		const jsonlPath = path.join(root, run.id, CASES_EXECUTED_FILE);
		if (!fs.existsSync(jsonlPath)) continue;

		const seenInThisRun = new Set<string>();
		for (const line of fs.readFileSync(jsonlPath, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as { caseId?: string; exitCode?: number; outcome?: string };
				if (!row.caseId || seenInThisRun.has(row.caseId)) continue;
				seenInThisRun.add(row.caseId);

				const outcome = row.outcome || (row.exitCode === 0 ? "passed" : "failed");
				const h = caseHistory.get(row.caseId) || { passes: 0, failures: 0, outcomes: [] };
				if (outcome === "passed") {
					h.passes++;
				} else if (outcome === "failed" || outcome === "error") {
					h.failures++;
				}
				h.outcomes.push(outcome);
				caseHistory.set(row.caseId, h);
			} catch {
				// skip bad line
			}
		}
	}

	// Classify each case
	const flakyCases: FlakyCase[] = [];
	let stableCount = 0;

	for (const [caseId, h] of caseHistory) {
		const total = h.passes + h.failures;
		if (total < minRuns) continue; // Not enough data

		const passRate = h.passes / total;
		const isFlaky = passRate > thresholdLow && passRate < thresholdHigh;

		if (isFlaky) {
			flakyCases.push({
				caseId,
				passRate: Math.round(passRate * 100),
				totalRuns: total,
				passes: h.passes,
				failures: h.failures,
				isFlaky: true,
				lastOutcomes: h.outcomes.slice(-5).reverse(),
			});
		} else {
			stableCount++;
		}
	}

	// Sort flaky cases by pass rate (worst first)
	flakyCases.sort((a, b) => a.passRate - b.passRate);

	return {
		cases: flakyCases,
		summary: {
			totalAnalyzed: caseHistory.size,
			flakyCount: flakyCases.length,
			stableCount,
		},
	};
}
