import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeResilienceReports } from "../resilience/issue-ledger";
import { artifactsRoot, e2eDeviceRoot, paths, repoRoot } from "./paths";
import { BOOTSTRAP_CASE_ID, CASES_EXECUTED_FILE } from "./constants";
import { wdioArgv } from "./resolve-bin";
import { finalizeCoverage } from "./coverage";
import type { CoverageSummary, IncrementalCoverage } from "./coverage";

export interface CaseRunResult {
	caseId: string;
	spec: string;
	exitCode: number;
	durationMs: number;
}

function loadRegistry(): Array<{ id: string; spec: string }> {
	const file = paths.caseRegistry();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: Array<{ id: string; spec: string }>;
	};
	return data.cases ?? [];
}

/** Shared wdio spec executor */
function executeWdioSpec(
	spec: string,
	runId: string,
	extraEnv: Record<string, string> = {},
): { exitCode: number; durationMs: number; signal?: string } {
	const root = repoRoot();
	const argv = wdioArgv(root, ["--spec", spec]);
	const start = Date.now();
	const wdio = spawnSync(argv[0], argv.slice(1), {
		cwd: root,
		stdio: "inherit",
		env: {
			...process.env,
			E2E_RUN_ID: runId,
			E2E_ENABLE_WEB_MOCK: "1",
			E2E_CURRENT_SPEC: spec,
			...extraEnv,
		},
	});
	const durationMs = Date.now() - start;
	return {
		exitCode: wdio.status ?? 1,
		durationMs,
		...(wdio.signal ? { signal: wdio.signal } : {}),
	};
}

/** Execute multiple specs in a single wdio call (batch mode) */
function executeWdioBatch(
	specs: string[],
	runId: string,
): { exitCode: number; durationMs: number; signal?: string } {
	const root = repoRoot();
	const specArgs: string[] = [];
	for (const s of specs) {
		specArgs.push("--spec", s);
	}
	const argv = wdioArgv(root, specArgs);
	const start = Date.now();
	const wdio = spawnSync(argv[0], argv.slice(1), {
		cwd: root,
		stdio: "inherit",
		env: {
			...process.env,
			E2E_RUN_ID: runId,
			E2E_ENABLE_WEB_MOCK: "1",
		},
	});
	const durationMs = Date.now() - start;
	return {
		exitCode: wdio.status ?? 1,
		durationMs,
		...(wdio.signal ? { signal: wdio.signal } : {}),
	};
}

export function runSequentialCases(runId: string): CaseRunResult[] {
	const root = repoRoot();
	const results: CaseRunResult[] = [];
	const logFile = path.join(artifactsRoot(), "runs", runId, CASES_EXECUTED_FILE);
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.writeFileSync(logFile, "", "utf-8");

	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === BOOTSTRAP_CASE_ID);
	const rest = registry.filter((c) => c.id !== BOOTSTRAP_CASE_ID);
	const ordered = [...(bootstrap ? [bootstrap] : []), ...rest];

	// Batch mode: run all specs in a single wdio call
	if (process.env.E2E_SEQUENTIAL_BATCH === "1") {
		const validSpecs = ordered
			.filter((e) => fs.existsSync(path.join(root, e.spec)))
			.map((e) => e.spec);
		const seen = new Set<string>();
		const deduped = validSpecs.filter((s) => {
			if (seen.has(s)) return false;
			seen.add(s);
			return true;
		});

		if (deduped.length > 0) {
			const { exitCode, durationMs, signal } = executeWdioBatch(deduped, runId);
			for (const entry of ordered) {
				if (!deduped.includes(entry.spec)) continue;
				const row: Record<string, unknown> = {
					caseId: entry.id,
					spec: entry.spec,
					exitCode,
					outcome: exitCode === 0 ? "passed" : "failed",
					durationMs: Math.round(durationMs / deduped.length),
					at: new Date().toISOString(),
				};
				if (signal) row.signal = signal;
				if (process.env.E2E_MOCK_LAYER) row.mockLayer = process.env.E2E_MOCK_LAYER;
				results.push(row as unknown as CaseRunResult);
				fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
			}
		}

		writeResilienceReports(runId);
		return results;
	}

	// Sequential mode: run each spec individually
	const seen = new Set<string>();
	for (const entry of ordered) {
		const spec = entry.spec;
		if (seen.has(spec) || !fs.existsSync(path.join(root, spec))) {
			continue;
		}
		seen.add(spec);
		const { exitCode, durationMs, signal } = executeWdioSpec(spec, runId);
		const row: Record<string, unknown> = {
			caseId: entry.id,
			spec,
			exitCode,
			outcome: exitCode === 0 ? "passed" : "failed",
			durationMs,
			at: new Date().toISOString(),
		};
		if (signal) row.signal = signal;
		if (process.env.E2E_MOCK_LAYER) row.mockLayer = process.env.E2E_MOCK_LAYER;
		results.push(row as unknown as CaseRunResult);
		fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
	}

	writeResilienceReports(runId);

	// 汇总覆盖率（仅当探测到 Istanbul 时）
	if (process.env.E2E_COVERAGE_DETECTED === "1") {
		try {
			const { full, incremental } = finalizeCoverage(runId);
			const parts: string[] = [];
			if (full.enabled) {
				if (incremental.enabled) {
					parts.push(
						`增量(${incremental.base}): ` +
						`语句 ${incremental.statements.pct}% 分支 ${incremental.branches.pct}% ` +
						`函数 ${incremental.functions.pct}% 行 ${incremental.lines.pct}% ` +
						`(${incremental.matchedFiles}/${incremental.businessFiles} 业务文件)`,
					);
				} else {
					parts.push("(无增量变更文件)");
				}
				parts.push(
					`全量: 语句 ${full.statements.pct}% 分支 ${full.branches.pct}% ` +
					`函数 ${full.functions.pct}% 行 ${full.lines.pct}% (${full.filesCount} 文件)`,
				);
				console.log(`[coverage] 汇总完成:\n  ${parts.join("\n  ")}`);
			}
		} catch (e) {
			console.error("[coverage] 汇总失败:", e);
		}
	}

	return results;
}

function readExecutedCaseIds(logFile: string): Set<string> {
	const ids = new Set<string>();
	if (!fs.existsSync(logFile)) {
		return ids;
	}
	for (const line of fs.readFileSync(logFile, "utf-8").split("\n")) {
		if (!line.trim()) {
			continue;
		}
		try {
			const row = JSON.parse(line) as { caseId?: string };
			if (row.caseId) {
				ids.add(row.caseId);
			}
		} catch {
			// ignore bad line
		}
	}
	return ids;
}

function runOneCase(
	runId: string,
	entry: { id: string; spec: string },
	logFile: string,
): CaseRunResult {
	const { exitCode, durationMs } = executeWdioSpec(entry.spec, runId);
	const row: CaseRunResult & { at: string } = {
		caseId: entry.id,
		spec: entry.spec,
		exitCode,
		durationMs,
		at: new Date().toISOString(),
	};
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
	return row;
}

/** Run the next registry case not yet recorded in cases-executed.jsonl.
 *  Honor E2E_SEQUENTIAL_LOCK env (set to "1" to prevent concurrent runNextCase calls). */
export function runNextCase(runId: string): CaseRunResult | { done: true } {
	const lockFile = path.join(artifactsRoot(), "runs", runId, ".next-case.lock");

	// Acquire lock if E2E_SEQUENTIAL_LOCK is enabled
	if (process.env.E2E_SEQUENTIAL_LOCK === "1") {
		if (fs.existsSync(lockFile)) {
			console.error("[run-sequential] Lock file exists; another runNextCase may be in progress.");
			return { done: true };
		}
		fs.writeFileSync(lockFile, String(process.pid), "utf-8");
	}

	try {
		const logFile = path.join(artifactsRoot(), "runs", runId, CASES_EXECUTED_FILE);
		const executed = readExecutedCaseIds(logFile);
		const registry = loadRegistry();
		const bootstrap = registry.find((c) => c.id === BOOTSTRAP_CASE_ID);
		const rest = registry.filter((c) => c.id !== BOOTSTRAP_CASE_ID);
		const ordered = [...(bootstrap ? [bootstrap] : []), ...rest];

		for (const entry of ordered) {
			if (executed.has(entry.id)) {
				continue;
			}
			if (!fs.existsSync(path.join(repoRoot(), entry.spec))) {
				continue;
			}
			return runOneCase(runId, entry, logFile);
		}
		return { done: true };
	} finally {
		// Release lock after execution (ignore errors — lock file may already be gone)
		if (process.env.E2E_SEQUENTIAL_LOCK === "1") {
			try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
		}
	}
}

export function listBootstrapFirst(): string[] {
	const bootstrap = path.join(e2eDeviceRoot(), "specs", `${BOOTSTRAP_CASE_ID}.spec.ts`);
	const all = loadRegistry().map((c) => path.join(repoRoot(), c.spec));
	const ordered = fs.existsSync(bootstrap)
		? [bootstrap, ...all.filter((p) => !p.endsWith(`${BOOTSTRAP_CASE_ID}.spec.ts`))]
		: all;
	return [...new Set(ordered)].filter((p) => fs.existsSync(p));
}

/** Dry-run: list what would be executed without actually running */
export function dryRunPlan(): Array<{ caseId: string; spec: string; exists: boolean }> {
	const root = repoRoot();
	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === BOOTSTRAP_CASE_ID);
	const rest = registry.filter((c) => c.id !== BOOTSTRAP_CASE_ID);
	const ordered = [...(bootstrap ? [bootstrap] : []), ...rest];
	const seen = new Set<string>();
	const plan: Array<{ caseId: string; spec: string; exists: boolean }> = [];
	for (const entry of ordered) {
		if (seen.has(entry.spec)) continue;
		seen.add(entry.spec);
		plan.push({
			caseId: entry.id,
			spec: entry.spec,
			exists: fs.existsSync(path.join(root, entry.spec)),
		});
	}
	return plan;
}
