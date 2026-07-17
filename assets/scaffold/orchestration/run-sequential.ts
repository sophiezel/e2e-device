import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxDir, e2eDeviceRoot, repoRoot } from "./paths";
import { BOOTSTRAP_CASE_ID, CASES_EXECUTED_FILE } from "./constants";
import { finalizeCoverage } from "./coverage";
import { preclassifyFailures } from "./preclassify-failures";

export interface CaseRunResult {
	caseId: string;
	spec: string;
	status: "passed" | "failed" | "timeout" | "skipped";
	durationMs: number;
	progressMs: number;
	resetMs: number;
	error?: string;
	errorStack?: string;
	screenshotPath?: string;
	logSnapshotPath?: string;
	llmInterventions: Array<{ reason: string; tokens: number; at: string }>;
}

const CASE_TIMEOUT_MS = parseInt(process.env.CASE_TIMEOUT_MS || "", 10) || 45000;
const PROGRESS_FILE = "progress.jsonl";

interface CaseRegistryEntry {
	id: string;
	spec: string;
	name?: string;
	description?: string;
	metadata?: {
		domain?: string;
		navigationDepth?: number;
	};
}

function loadRegistry(): CaseRegistryEntry[] {
	const file = path.join(sandboxDir(), "case-registry.json");
	if (!fs.existsSync(file)) {
		return [];
	}
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
			cases?: CaseRegistryEntry[];
		};
		return data.cases ?? [];
	} catch {
		return [];
	}
}

/** Group cases by domain, sort each group by navigation depth (shallow->deep) */
function groupAndSort(cases: CaseRegistryEntry[]): CaseRegistryEntry[] {
	const domainMap = new Map<string, CaseRegistryEntry[]>();
	const noDomain: CaseRegistryEntry[] = [];

	for (const c of cases) {
		const domain = c.metadata?.domain || "";
		if (domain) {
			const group = domainMap.get(domain) || [];
			group.push(c);
			domainMap.set(domain, group);
		} else {
			noDomain.push(c);
		}
	}

	// Sort each group by navigationDepth (shallow first, default 0)
	const sorted: CaseRegistryEntry[] = [];
	for (const [, group] of domainMap) {
		group.sort((a, b) => (a.metadata?.navigationDepth ?? 0) - (b.metadata?.navigationDepth ?? 0));
		sorted.push(...group);
	}
	noDomain.sort((a, b) => (a.metadata?.navigationDepth ?? 0) - (b.metadata?.navigationDepth ?? 0));
	sorted.push(...noDomain);

	return sorted;
}

function sandboxRunDir(runId: string): string {
	return path.join(sandboxDir(), "artifacts", "runs", runId);
}

function progressPath(runId: string): string {
	return path.join(sandboxRunDir(runId), PROGRESS_FILE);
}

function casesExecutedPath(runId: string): string {
	return path.join(sandboxRunDir(runId), CASES_EXECUTED_FILE);
}

function writeProgress(runId: string, entry: Record<string, unknown>): void {
	const p = progressPath(runId);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
}

/** Capture screenshot path for failed/timeout case */
function screenshotPath(runId: string, caseId: string): string {
	const dir = path.join(sandboxRunDir(runId), "screenshots");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${caseId}.png`);
}

function logSnapshotPath(runId: string, caseId: string): string {
	const dir = path.join(sandboxRunDir(runId), "logs");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${caseId}.log`);
}

/** Launch diagnosis request for Agent (does not spawn LLM). */
function launchDiagnoseSubagent(runId: string, failedCases: CaseRunResult[]): void {
	const diagnosePayload = {
		runId,
		failedCaseIds: failedCases.map((c) => c.caseId),
		artifactsDir: sandboxRunDir(runId),
		protocol: "agent-must-read-failure-triage",
	};
	const diagFile = path.join(sandboxRunDir(runId), "diagnose-request.json");
	fs.writeFileSync(diagFile, JSON.stringify(diagnosePayload, null, 2), "utf-8");
	console.log(`[run-sequential] Diagnose request written: ${diagFile}`);
	console.log(`[run-sequential] Agent MUST load references/failure-triage.md for: ${failedCases.map((c) => c.caseId).join(", ")}`);
}

function resolveSpecPath(spec: string): string {
	const sb = sandboxDir();
	if (path.isAbsolute(spec) && fs.existsSync(spec)) return spec;
	const candidates = [
		path.join(sb, spec),
		path.join(sb, "specs", path.basename(spec)),
		path.join(sb, "specs", spec),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return path.join(sb, "specs", path.basename(spec));
}

function resolveWdioBin(): string {
	const skillRoot = e2eDeviceRoot();
	for (const root of [sandboxDir(), skillRoot, repoRoot()]) {
		const bin = path.join(root, "node_modules", ".bin", "wdio");
		if (fs.existsSync(bin)) return bin;
	}
	return "wdio";
}

/** Execute a single wdio spec with timeout via spawnSync. On timeout, kills process and captures partial output. */
function executeWdioSpec(
	spec: string,
	runId: string,
	extraEnv: Record<string, string> = {},
): { exitCode: number; durationMs: number; signal?: string; stderr?: string; timedOut: boolean } {
	const sb = sandboxDir();
	const specPath = resolveSpecPath(spec);
	const wdioConf = path.join(sb, "wdio.conf.ts");
	const wdio = resolveWdioBin();
	const start = Date.now();

	try {
		const result = spawnSync(wdio, ["run", wdioConf, "--spec", specPath], {
			cwd: sb,
			stdio: ["inherit", "inherit", "pipe"],
			timeout: CASE_TIMEOUT_MS,
			env: {
				...process.env,
				E2E_RUN_ID: runId,
				E2E_CONTINUE_ON_FAILURE: "1",
				E2E_CURRENT_SPEC: spec,
				...extraEnv,
			},
		});
		const durationMs = Date.now() - start;
		const stderrStr = result.stderr?.toString() || "";
		return {
			exitCode: result.status ?? 1,
			durationMs,
			stderr: stderrStr,
			signal: result.signal ?? undefined,
			timedOut: false,
		};
	} catch (err: unknown) {
		const durationMs = Date.now() - start;
		const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; signal?: string };
		// spawnSync throws on timeout with err.killed = true
		const stderrStr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() || String(e.message || "");
		return {
			exitCode: 1,
			durationMs,
			stderr: stderrStr || `Timeout after ${CASE_TIMEOUT_MS}ms`,
			signal: e.signal || (e.code === "ETIMEDOUT" ? "SIGTERM" : undefined),
			timedOut: true,
		};
	}
}

/** v2: Run cases sequentially with timeout, progress tracking, light reset, and LLM diagnosis. */
export function runSequentialCases(runId: string): CaseRunResult[] {
	const results: CaseRunResult[] = [];

	const cLogFile = casesExecutedPath(runId);
	fs.mkdirSync(path.dirname(cLogFile), { recursive: true });
	fs.writeFileSync(cLogFile, "", "utf-8");

	// v2: group by domain, sort by navigation depth (shallow->deep)
	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === BOOTSTRAP_CASE_ID);
	const rest = registry.filter((c) => c.id !== BOOTSTRAP_CASE_ID);
	const sorted = groupAndSort(rest);
	const ordered = [...(bootstrap ? [bootstrap] : []), ...sorted];

	const seen = new Set<string>();
	let seq = 0;
	const totalCases = ordered.length;
	const runStart = Date.now();

	for (const entry of ordered) {
		const spec = entry.spec;
		if (seen.has(spec) || !fs.existsSync(resolveSpecPath(spec))) {
			continue;
		}
		seen.add(spec);
		seq++;

		const progressStart = Date.now();

		// Progress: running
		writeProgress(runId, { seq, caseId: entry.id, status: "running", at: new Date().toISOString() });
		console.log(`\n[${seq}/${totalCases}] ${entry.id} running...`);

		const { exitCode, durationMs, signal, stderr, timedOut } = executeWdioSpec(spec, runId);
		const progressMs = Date.now() - progressStart;

		let status: CaseRunResult["status"];
		let error: string | undefined;
		let errorStack: string | undefined;
		let ssPath: string | undefined;
		let logPath: string | undefined;

		if (timedOut) {
			status = "timeout";
			error = `Timeout after ${CASE_TIMEOUT_MS}ms`;
			errorStack = stderr;
			// Capture screenshot + log on timeout
			ssPath = screenshotPath(runId, entry.id);
			logPath = logSnapshotPath(runId, entry.id);
			if (stderr) fs.writeFileSync(logPath, stderr, "utf-8");
			console.log(`[${seq}/${totalCases}] ${entry.id} timeout (${(durationMs / 1000).toFixed(1)}s)`);
		} else if (exitCode === 0) {
			status = "passed";
			console.log(`[${seq}/${totalCases}] ${entry.id} passed (${(durationMs / 1000).toFixed(1)}s)`);
		} else {
			status = "failed";
			error = stderr?.slice(0, 2000) || `Exit code ${exitCode}`;
			errorStack = stderr;
			// Capture screenshot + log on failure
			ssPath = screenshotPath(runId, entry.id);
			logPath = logSnapshotPath(runId, entry.id);
			if (stderr) fs.writeFileSync(logPath, stderr, "utf-8");

			if (stderr) {
				const errLines = stderr.split("\n").filter((l) =>
					l.includes("ERROR") || l.includes("Error:") || l.includes("Failed") || l.includes("Unable"),
				);
				console.log(`   error: ${errLines.slice(0, 3).join(" | ").slice(0, 200)}`);
			}
			console.log(`[${seq}/${totalCases}] ${entry.id} failed (${(durationMs / 1000).toFixed(1)}s)`);
		}

		// Write cases-executed.jsonl entry
		const executedEntry: Record<string, unknown> = {
			caseId: entry.id,
			spec,
			status,
			durationMs,
			progressMs,
			resetMs: 0, // updated below after reset
			llmInterventions: [],
			at: new Date().toISOString(),
		};
		if (error) executedEntry.error = error;
		if (errorStack) executedEntry.errorStack = errorStack;
		if (ssPath) executedEntry.screenshotPath = ssPath;
		if (logPath) executedEntry.logSnapshotPath = logPath;

		const result: CaseRunResult = {
			caseId: entry.id,
			spec,
			status,
			durationMs,
			progressMs,
			resetMs: 0,
			error,
			errorStack,
			screenshotPath: ssPath,
			logSnapshotPath: logPath,
			llmInterventions: [],
		};
		results.push(result);
		fs.appendFileSync(cLogFile, JSON.stringify(executedEntry) + "\n", "utf-8");

		// Progress: result
		writeProgress(runId, { seq, caseId: entry.id, status, durationMs, at: new Date().toISOString() });

		// NEVER stop on failure - continue to next case

		// Light reset between cases (unless last case)
		if (seq < totalCases) {
			const resetStart = Date.now();
			console.log(`   Light reset...`);
			try {
				// Light reset: cookies + localStorage + anchor page + hideKeyboard
				// The actual reset runs in the WDIO hook; here we record timing
				result.resetMs = Date.now() - resetStart;
				executedEntry.resetMs = result.resetMs;
			} catch {
				result.resetMs = Date.now() - resetStart;
			}
			console.log(`   Reset done (${result.resetMs}ms)`);
		}
	}

	// All cases done - final summary
	const totalDuration = Date.now() - runStart;
	const passedCount = results.filter((r) => r.status === "passed").length;
	const failedCount = results.filter((r) => r.status === "failed").length;
	const timeoutCount = results.filter((r) => r.status === "timeout").length;

	console.log(`\n=== All ${seq} cases done (${(totalDuration / 1000).toFixed(1)}s) ===`);
	console.log(`   passed: ${passedCount} | failed: ${failedCount} | timeout: ${timeoutCount}`);

	// If any failures, write diagnose-request + rule preclassify (no LLM spawn)
	const failedCases = results.filter((r) => r.status === "failed" || r.status === "timeout");
	if (failedCases.length > 0) {
		console.log(`\n[run-sequential] Writing diagnose request for ${failedCases.length} failed case(s)...`);
		launchDiagnoseSubagent(runId, failedCases);
		try {
			preclassifyFailures(
				runId,
				failedCases.map((c) => c.caseId),
			);
		} catch (e) {
			console.warn("[run-sequential] preclassify skipped:", (e as Error).message);
		}
	}

	// Finalize coverage
	if (process.env.E2E_COVERAGE_DETECTED === "1" || fs.existsSync(path.join(sandboxRunDir(runId), "coverage-snapshots"))) {
		try {
			const { full, incremental } = finalizeCoverage(runId);
			if (full.enabled) {
				const parts: string[] = [];
				if (incremental.enabled) {
					parts.push(
						`incremental(${incremental.base}): stmt ${incremental.statements.pct}% branch ${incremental.branches.pct}% ` +
						`func ${incremental.functions.pct}% line ${incremental.lines.pct}% (${incremental.matchedFiles}/${incremental.businessFiles} biz files)`,
					);
				}
				parts.push(
					`full: stmt ${full.statements.pct}% branch ${full.branches.pct}% ` +
					`func ${full.functions.pct}% line ${full.lines.pct}% (${full.filesCount} files)`,
				);
				console.log(`[coverage] ${parts.join(" | ")}`);
			}
		} catch (e) {
			console.error("[coverage] finalize failed:", e);
		}
	}

	return results;
}

// ---- v2: utility exports ----

/** Dry-run: list what would be executed without actually running. v2 uses sandbox case-registry. */
export function dryRunPlan(): Array<{ caseId: string; spec: string; exists: boolean }> {
	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === BOOTSTRAP_CASE_ID);
	const rest = registry.filter((c) => c.id !== BOOTSTRAP_CASE_ID);
	const sorted = groupAndSort(rest);
	const ordered = [...(bootstrap ? [bootstrap] : []), ...sorted];
	const seen = new Set<string>();
	const plan: Array<{ caseId: string; spec: string; exists: boolean }> = [];
	for (const entry of ordered) {
		if (seen.has(entry.spec)) continue;
		seen.add(entry.spec);
		plan.push({
			caseId: entry.id,
			spec: entry.spec,
			exists: fs.existsSync(resolveSpecPath(entry.spec)),
		});
	}
	return plan;
}
