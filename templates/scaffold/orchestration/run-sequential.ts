import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeResilienceReports } from "../resilience/issue-ledger";
import { artifactsRoot, e2eDeviceRoot, paths, repoRoot } from "./paths";
import { BOOTSTRAP_CASE_ID, CASES_EXECUTED_FILE } from "./constants";
import { wdioArgv } from "./resolve-bin";
import { finalizeCoverage } from "./coverage";
import type { CoverageSummary, IncrementalCoverage } from "./coverage";
import { recordFrameworkFailure } from "../helpers/diagnostic-collector";

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

/** Shared wdio spec executor — L0/L1 环境问题保留 auto-fix，L2 业务断言 spec 内部 recordFailure 不阻断 */
function executeWdioSpec(
	spec: string,
	runId: string,
	extraEnv: Record<string, string> = {},
): { exitCode: number; durationMs: number; signal?: string; stderr?: string } {
	const root = repoRoot();
	const argv = wdioArgv(root, ["--spec", spec]);
	const start = Date.now();
	const wdio = spawnSync(argv[0], argv.slice(1), {
		cwd: root,
		stdio: ["inherit", "inherit", "pipe"], // capture stderr for error diagnostics
		env: {
			...process.env,
			E2E_RUN_ID: runId,
			E2E_CONTINUE_ON_FAILURE: "1",
			E2E_CURRENT_SPEC: spec,
			...extraEnv,
		},
	});
	const durationMs = Date.now() - start;
	return {
		exitCode: wdio.status ?? 1,
		durationMs,
		stderr: wdio.stderr?.toString() || "",
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

	// Sequential mode: run each spec individually — 失败记录不阻断
	const seen = new Set<string>();
	let caseIndex = 0;
	const totalCases = ordered.length;
	for (const entry of ordered) {
		const spec = entry.spec;
		if (seen.has(spec) || !fs.existsSync(path.join(root, spec))) {
			continue;
		}
		seen.add(spec);
		caseIndex++;
		
		// 用户可见进度输出
		console.log(`\n[${caseIndex}/${totalCases}] ${entry.id} ⏳ running...`);
		
		const { exitCode, durationMs, signal, stderr } = executeWdioSpec(spec, runId);
		const passed = exitCode === 0;
		const outcome = passed ? "passed" : "recorded_failure";
		
		// 用户可见结果输出
		console.log(`[${caseIndex}/${totalCases}] ${entry.id} ${passed ? '✅ passed' : '❌ recorded'} (${(durationMs / 1000).toFixed(1)}s)`);

		// 框架级失败（非 spec 内部断言失败）：提取 stderr 中的错误详情
		if (!passed && stderr) {
			// 提取关键错误行（跳过 INFO/WARN 日志，取 ERROR 和 TS 错误）
			const errLines: string[] = [];
			for (const line of stderr.split("\n")) {
				const trimmed = line.trim();
				if (
					trimmed.includes("ERROR") ||
					trimmed.includes("Error:") ||
					trimmed.includes("error TS") ||
					trimmed.includes("TSError") ||
					trimmed.includes("Failed to") ||
					trimmed.includes("Unable to") ||
					trimmed.includes("Neither")
				) {
					errLines.push(trimmed);
				}
			}
			const errorSummary = errLines.slice(0, 15).join("\n");

			// 归类根因并写入诊断数据
			const caseId = entry.id;
			if (errorSummary) {
				recordFrameworkFailure(caseId, errorSummary.slice(0, 2000), spec, stderr.slice(0, 5000));
			}

			// 复现路径 - 框架级错误的标准化输出
			console.log(`   🔍 测试路径:`);
			console.log(`     ✓ WDIO spec runner 启动: ${spec}`);
			console.log(`     ✗ Framework error detected (exit=${exitCode})`);
			console.log(`   🔄 复现:`);
			for (const el of errLines.slice(0, 3)) {
				console.log(`     ${el.slice(0, 150)}`);
			}
			console.log(`   🔧 建议: 参见诊断快照中的修复建议`);
		}
		
		const row: Record<string, unknown> = {
			caseId: entry.id,
			spec,
			exitCode,
			outcome,
			durationMs,
			at: new Date().toISOString(),
		};
		if (signal) row.signal = signal;
		results.push(row as unknown as CaseRunResult);
		fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
		
		// 失败后不重试、不阻断，继续下一个 case
	}

	// 全部跑完后生成汇总报告
	console.log(`\n=== 全部 ${caseIndex} 条用例执行完毕 ===`);
	writeResilienceReports(runId);

	// 汇总覆盖率（探测到 Istanbul 或快照文件存在即汇总）
	if (process.env.E2E_COVERAGE_DETECTED === "1" || fs.existsSync(path.join(runDir(runId), "coverage-snapshots"))) {
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
