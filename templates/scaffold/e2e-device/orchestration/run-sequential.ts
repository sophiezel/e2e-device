import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { hasCredentials } from "../helpers/credentials";
import { writeResilienceReports } from "../resilience/issue-ledger";
import { artifactsRoot, e2eDeviceRoot, paths, repoRoot, runDir } from "./paths";
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

/** 30s auth 交互超时 */
const AUTH_INPUT_TIMEOUT_MS = parseInt(process.env.E2E_AUTH_INPUT_TIMEOUT_MS || "30000", 10);

interface RegistryEntry {
	id: string;
	spec: string;
	metadata?: { description?: string; name?: string; caseId?: string; [k: string]: unknown };
	tags?: string[];
	name?: string;
	averageDurationMs?: number;
}

function loadRegistry(): RegistryEntry[] {
	const file = paths.caseRegistry();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: RegistryEntry[];
	};
	return data.cases ?? [];
}

/** 从 registry entry 提取中文描述 */
function caseDisplayName(entry: RegistryEntry): string {
	return entry.metadata?.description || entry.name || entry.id;
}

/** 打印 TODO 清单 */
function printTodoList(ordered: RegistryEntry[]): void {
	const root = repoRoot();
	const valid = ordered.filter((e) => fs.existsSync(path.join(root, e.spec)));
	console.log(`\n📋 测试执行清单 (${valid.length} 用例)`);
	console.log("═".repeat(72));
	for (let i = 0; i < valid.length; i++) {
		const idx = String(i + 1).padStart(3, " ");
		const desc = caseDisplayName(valid[i]);
		const id = valid[i].id;
		const est = valid[i].averageDurationMs
			? ` ~${(valid[i].averageDurationMs! / 1000).toFixed(0)}s`
			: "";
		console.log(`  [ ] ${idx}  ${desc.padEnd(40).slice(0, 40)}  (${id})${est}`);
	}
	console.log("═".repeat(72));
	console.log(`⏳ 预计总耗时: ~${estimateTotalMinutes(ordered)}min  |  批量 Session 模式`);
	console.log("");
}

function estimateTotalMinutes(ordered: RegistryEntry[]): string {
	let totalMs = 0;
	for (const c of ordered) {
		totalMs += c.averageDurationMs || 25000;
	}
	const min = Math.ceil(totalMs / 60000);
	return String(min);
}

function progressBar(done: number, total: number, width = 20): string {
	const filled = Math.round((done / total) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
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

/** Execute multiple specs in a single wdio call (batch mode) with heartbeat progress */
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

	console.log(`⏳ 批量执行 ${specs.length} 个 spec (心跳间隔: 30s)...`);

	const child = spawn(argv[0], argv.slice(1), {
		cwd: root,
		stdio: ["inherit", "inherit", "pipe"],
		env: {
			...process.env,
			E2E_RUN_ID: runId,
			E2E_ENABLE_WEB_MOCK: "1",
		},
	});

	// 每 30s 打印心跳，避免用户以为卡死
	const heartbeat = setInterval(() => {
		const elapsed = ((Date.now() - start) / 1000).toFixed(0);
		console.log(`⏳ 批量执行中... (已耗时 ${elapsed}s)`);
	}, 30000);

	return new Promise((resolve) => {
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

		child.on("close", (code, signal) => {
			clearInterval(heartbeat);
			const durationMs = Date.now() - start;
			const exitCode = code ?? 1;
			console.log(`⏱  批量执行完成: ${(durationMs / 1000).toFixed(1)}s`);
			resolve({
				exitCode,
				durationMs,
				...(signal ? { signal } : {}),
			});
		});

		child.on("error", (err) => {
			clearInterval(heartbeat);
			const durationMs = Date.now() - start;
			console.error(`❌ 批量执行异常: ${err.message}`);
			resolve({ exitCode: 1, durationMs });
		});
	});
}

export async function runSequentialCases(runId: string): Promise<CaseRunResult[]> {
	const root = repoRoot();
	const results: CaseRunResult[] = [];
	const logFile = path.join(artifactsRoot(), "runs", runId, CASES_EXECUTED_FILE);
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.writeFileSync(logFile, "", "utf-8");

	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === BOOTSTRAP_CASE_ID);
	const rest = registry.filter((c) => c.id !== BOOTSTRAP_CASE_ID);
	const ordered = [...(bootstrap ? [bootstrap] : []), ...rest];

	// 打印 TODO 清单
	printTodoList(ordered);

	// 检查是否需要鉴权交互
	const authRequiredCases = ordered.filter((c) =>
		c.tags?.some((t) => t.includes("auth") || t.includes("login")) ?? false
	);
	let authSkipped = false;
	if (authRequiredCases.length > 0 && !hasCredentials()) {
		console.log(`\n🔐 检测到 ${authRequiredCases.length} 个用例需要登录。`);
		console.log("   请输入 E2E_ACCOUNT / E2E_PASSWORD，或等待 30s 自动跳过这些用例。");
		console.log(`   (超时: ${AUTH_INPUT_TIMEOUT_MS / 1000}s)`);
		authSkipped = true;
		// Agent 层会处理交互；此处标记 auth 用例将跳过
	}

	// 默认批量模式：所有 spec 单次 wdio 调用（减少 session 开销）
	// 设置 E2E_SEQUENTIAL_INDIVIDUAL=1 强制逐 spec 执行
	const useIndividual = process.env.E2E_SEQUENTIAL_INDIVIDUAL === "1";

	if (!useIndividual) {
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
			console.log(`🚀 开始批量执行 ${deduped.length} 个 spec (单 Session)...\n`);
			const batchStart = Date.now();

			const { exitCode, durationMs, signal } = await executeWdioBatch(deduped, runId);

			for (const entry of ordered) {
				if (!deduped.includes(entry.spec)) continue;
				const desc = caseDisplayName(entry);
				const icon = exitCode === 0 ? "✅" : "❌";
				const row: Record<string, unknown> = {
					caseId: entry.id,
					spec: entry.spec,
					exitCode,
					outcome: authSkipped && authRequiredCases.some((c) => c.id === entry.id)
						? "skipped_auth"
						: exitCode === 0
							? "passed"
							: "failed",
					durationMs: Math.round(durationMs / deduped.length),
					at: new Date().toISOString(),
				};
				if (signal) row.signal = signal;
				if (process.env.E2E_MOCK_LAYER) row.mockLayer = process.env.E2E_MOCK_LAYER;
				results.push(row as unknown as CaseRunResult);
				fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
			}

			console.log(`\n⏱  批量执行完成: ${(durationMs / 1000).toFixed(1)}s`);
		}

		writeResilienceReports(runId);
		printCoverage(runId);
		return results;
	}

	// E2E_SEQUENTIAL_INDIVIDUAL=1: 逐 spec 执行 — 失败记录不阻断
	console.log("🔧 逐 spec 模式 (E2E_SEQUENTIAL_INDIVIDUAL=1)\n");
	const seenSpecs = new Set<string>();
	let caseIndex = 0;
	const totalCases = ordered.length;
	const runStart = Date.now();

	for (const entry of ordered) {
		const spec = entry.spec;
		if (seenSpecs.has(spec) || !fs.existsSync(path.join(root, spec))) {
			continue;
		}
		seenSpecs.add(spec);
		caseIndex++;

		const desc = caseDisplayName(entry);
		const bar = progressBar(caseIndex - 1, totalCases);

		// Auth skip check
		if (authSkipped && authRequiredCases.some((c) => c.id === entry.id)) {
			console.log(`\n[${caseIndex}/${totalCases}] ${bar}`);
			console.log(`🔐 ${desc} (${entry.id}) — ⏭  跳过 (未登录，无凭据)`);
			const row: Record<string, unknown> = {
				caseId: entry.id,
				spec,
				exitCode: -1,
				outcome: "skipped_auth",
				durationMs: 0,
				at: new Date().toISOString(),
			};
			results.push(row as unknown as CaseRunResult);
			fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
			continue;
		}

		// 用户可见进度输出（含中文描述）
		console.log(`\n[${caseIndex}/${totalCases}] ${bar}  ${desc} (${entry.id}) ⏳ 执行中...`);

		const specStart = Date.now();
		const { exitCode, durationMs, signal, stderr } = executeWdioSpec(spec, runId);
		const passed = exitCode === 0;
		const outcome = passed ? "passed" : "recorded_failure";

		// 用户可见结果输出（含中文描述）
		const elapsed = specStart > 0 ? ((Date.now() - specStart) / 1000).toFixed(1) : "?";
		console.log(`[${caseIndex}/${totalCases}] ${bar}  ${desc} (${entry.id}) ${passed ? '✅ passed' : '❌ failed'} (${elapsed}s)`);

		// 框架级失败诊断
		if (!passed && stderr) {
			const errLines: string[] = [];
			for (const line of stderr.split("\n")) {
				const trimmed = line.trim();
				if (
					trimmed.includes("ERROR") || trimmed.includes("Error:") ||
					trimmed.includes("TSError") || trimmed.includes("Failed to") ||
					trimmed.includes("Unable to") || trimmed.includes("Neither")
				) {
					errLines.push(trimmed);
				}
			}
			const errorSummary = errLines.slice(0, 15).join("\n");
			if (errorSummary) {
				recordFrameworkFailure(entry.id, errorSummary.slice(0, 2000), spec, stderr.slice(0, 5000));
			}
			console.log(`   🔄 复现: ${errLines.slice(0, 2).map((l) => l.slice(0, 120)).join(" | ")}`);
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
	}

	// 全部跑完后生成汇总报告
	const passed = results.filter((r) => (r as Record<string, unknown>).outcome === "passed").length;
	const failed = results.filter((r) => (r as Record<string, unknown>).outcome === "failed" || (r as Record<string, unknown>).outcome === "recorded_failure").length;
	const skipped = results.filter((r) => (r as Record<string, unknown>).outcome === "skipped_auth").length;
	console.log(`\n═══════════════════════════════════════════`);
	console.log(`  执行完成: ✅ ${passed} passed  |  ❌ ${failed} failed  |  ⏭  ${skipped} skipped`);
	console.log(`  总耗时: ${((Date.now() - runStart) / 1000).toFixed(0)}s`);
	console.log(`═══════════════════════════════════════════`);
	writeResilienceReports(runId);
	printCoverage(runId);

	return results;
}

function printCoverage(runId: string): void {
	if (process.env.E2E_COVERAGE_DETECTED === "1" || fs.existsSync(path.join(runDir(runId), "coverage-snapshots"))) {
		try {
			const { full, incremental } = finalizeCoverage(runId);
			const parts: string[] = [];
			if (full.enabled) {
				if (incremental.enabled) {
					parts.push(
						`增量(${incremental.base}): 语句 ${incremental.statements.pct}% 分支 ${incremental.branches.pct}% ` +
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
