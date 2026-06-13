import fs from "node:fs";
import path from "node:path";
import { sandboxDir, repoRoot } from "./paths";
import { CASES_EXECUTED_FILE, COVERAGE_RAW_FILE } from "./constants";
import type { CoverageSummary, IncrementalCoverage } from "./coverage";
import { loadCoverageResult } from "./coverage";

// ---- v2: sandbox artifact types ----

interface ExecutedCaseLine {
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
	testSteps?: string[];
	reproductionPath?: {
		deviceModel: string;
		osVersion: string;
		networkCondition: string;
		stepsToReproduce: string[];
		probability: string;
	};
	suggestedFixes?: Array<{
		caseId: string;
		approaches: string[];
		risk: "low" | "medium" | "high" | "unknown";
		estimatedEffort: string;
		references: string[];
	}>;
	llmInterventions: Array<{
		reason: string;
		tokens: number;
		at: string;
	}>;
	at: string;
}

interface CaseRegistryEntry {
	id: string;
	spec?: string;
	name?: string;
	description?: string;
	metadata?: {
		description?: string;
		acceptanceCriteria?: string;
		operation?: string;
		preconditions?: string;
		expectedResult?: string;
	};
}

// ---- v2: helpers ----

function datePrefixShanghai(): { date: string; hhmm: string } {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(new Date());
	const y = parts.find((p) => p.type === "year")?.value ?? "1970";
	const m = parts.find((p) => p.type === "month")?.value ?? "01";
	const d = parts.find((p) => p.type === "day")?.value ?? "01";
	const h = parts.find((p) => p.type === "hour")?.value ?? "00";
	const min = parts.find((p) => p.type === "minute")?.value ?? "00";
	return { date: `${y}-${m}-${d}`, hhmm: `${h}${min}` };
}

function resolveReportDir(): string {
	if (process.env.E2E_REPORT_PATH) {
		return process.env.E2E_REPORT_PATH;
	}
	return path.join(repoRoot(), "docs");
}

function resolveRunId(runId?: string): string {
	if (runId) return runId;
	const runDir = path.join(sandboxDir(), "artifacts", "runs");
	if (!fs.existsSync(runDir)) return `run-${Date.now()}`;
	const dirs = fs.readdirSync(runDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.startsWith("run-"))
		.map((d) => d.name)
		.sort()
		.reverse();
	return dirs[0] || `run-${Date.now()}`;
}

function readExecutedCases(runId: string): ExecutedCaseLine[] {
	const file = path.join(sandboxDir(), "artifacts", "runs", runId, CASES_EXECUTED_FILE);
	if (!fs.existsSync(file)) return [];
	const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
	const cases: ExecutedCaseLine[] = [];
	for (const line of lines) {
		try {
			cases.push(JSON.parse(line) as ExecutedCaseLine);
		} catch { /* skip malformed */ }
	}
	return cases;
}

function loadCaseNameMap(): Map<string, string> {
	const map = new Map<string, string>();
	const registryPath = path.join(sandboxDir(), "case-registry.json");
	if (!fs.existsSync(registryPath)) return map;
	try {
		const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
			cases?: CaseRegistryEntry[];
		};
		for (const c of registry.cases || []) {
			const name = c.metadata?.description || c.description || c.name || c.id;
			map.set(c.id, name);
		}
	} catch { /* best-effort */ }
	return map;
}

// ---- v2: markdown report generation (self-contained, no base64 images) ----

function generateReportMarkdown(
	runId: string,
	cases: ExecutedCaseLine[],
	coverage: { full: CoverageSummary; incremental: IncrementalCoverage } | null,
): string {
	const nameMap = loadCaseNameMap();
	const passed = cases.filter((c) => c.status === "passed").length;
	const failed = cases.filter((c) => c.status === "failed").length;
	const timeout = cases.filter((c) => c.status === "timeout").length;
	const skipped = cases.filter((c) => c.status === "skipped").length;
	const total = cases.length;
	const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0.0";

	const lines: string[] = [
		`# 真机 E2E 测试报告`,
		"",
		`> Run ID: \`${runId}\``,
		"",
		"## 结果总览",
		"",
		"| 指标 | 数值 |",
		"|------|------|",
		`| 总用例 | ${total} |`,
		`| ✅ 通过 | ${passed} |`,
		`| ❌ 失败 | ${failed} |`,
		`| ⏱️ 超时 | ${timeout} |`,
		`| ⏭️ 跳过 | ${skipped} |`,
		`| 通过率 | ${passRate}% |`,
		"",
	];

	// 用例执行明细
	lines.push("## 用例执行明细", "");
	lines.push("| # | caseId | 结果 | 耗时 | 执行(ms) | 重置(ms) |",
		"|---|--------|------|------|----------|----------|");
	for (let i = 0; i < cases.length; i++) {
		const c = cases[i];
		const icon = c.status === "passed" ? "✅" : c.status === "failed" ? "❌" : c.status === "timeout" ? "⏱️" : "⏭️";
		const name = nameMap.get(c.caseId) || c.caseId;
		const dur = c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)}s` : "—";
		lines.push(`| ${i + 1} | ${name} | ${icon} ${c.status} | ${dur} | ${c.progressMs || "—"} | ${c.resetMs || "—"} |`);
	}
	lines.push("");

	// 失败详情
	const failedCases = cases.filter((c) => c.status === "failed" || c.status === "timeout");
	if (failedCases.length > 0) {
		lines.push("## 失败详情", "");
		for (let i = 0; i < failedCases.length; i++) {
			const c = failedCases[i];
			const name = nameMap.get(c.caseId) || c.caseId;
			lines.push(`### ${i + 1}. ${name}`);
			lines.push("");
			lines.push(`- **caseId**: \`${c.caseId}\``);
			lines.push(`- **状态**: ${c.status === "timeout" ? "⏱️ 超时" : "❌ 失败"}`);
			lines.push(`- **spec**: \`${c.spec}\``);
			if (c.durationMs) lines.push(`- **耗时**: ${(c.durationMs / 1000).toFixed(1)}s`);

			// 测试路径
			if (c.testSteps && c.testSteps.length > 0) {
				lines.push("", "**测试路径**:", "");
				for (const step of c.testSteps) {
					lines.push(`  - ${step}`);
				}
			}

			// 错误栈
			if (c.errorStack) {
				lines.push("", "**错误栈**:", "", "```", c.errorStack.slice(0, 3000), "```");
			} else if (c.error) {
				lines.push("", "**错误信息**:", "", "```", c.error.slice(0, 3000), "```");
			}

			// 复现步骤
			if (c.reproductionPath) {
				const rp = c.reproductionPath;
				lines.push("", "**复现步骤**:", "");
				if (rp.deviceModel) lines.push(`- 设备: ${rp.deviceModel} / ${rp.osVersion}`);
				if (rp.networkCondition) lines.push(`- 网络: ${rp.networkCondition}`);
				lines.push(`- 概率: ${rp.probability || "必现"}`);
				if (rp.stepsToReproduce.length > 0) {
					for (let j = 0; j < rp.stepsToReproduce.length; j++) {
						lines.push(`  ${j + 1}. ${rp.stepsToReproduce[j]}`);
					}
				}
			}

			// 修复建议
			if (c.suggestedFixes && c.suggestedFixes.length > 0) {
				lines.push("", "**建议修复**:", "");
				for (const sf of c.suggestedFixes) {
					for (const a of sf.approaches) {
						lines.push(`- ${a} (风险: ${sf.risk}, 预估: ${sf.estimatedEffort})`);
					}
					if (sf.references.length > 0) {
						lines.push(`  参考: ${sf.references.join(", ")}`);
					}
				}
			}

			// LLM介入标记
			if (c.llmInterventions && c.llmInterventions.length > 0) {
				lines.push("", "**LLM 介入**:", "");
				for (const li of c.llmInterventions) {
					lines.push(`- ${li.reason} (tokens: ${li.tokens}, at: ${li.at})`);
				}
			}

			// 产物引用（无 base64）
			if (c.screenshotPath) {
				lines.push("", `> 截图: \`${c.screenshotPath}\``);
			}
			if (c.logSnapshotPath) {
				lines.push("", `> 日志: \`${c.logSnapshotPath}\``);
			}

			lines.push("", "---", "");
		}
	}

	// LLM 介入统计表
	const llmCases = cases.filter((c) => c.llmInterventions && c.llmInterventions.length > 0);
	if (llmCases.length > 0) {
		lines.push("## LLM 介入统计", "");
		lines.push("| caseId | 原因 | tokens | 时间 |",
			"|--------|------|--------|------|");
		for (const c of llmCases) {
			for (const li of c.llmInterventions) {
				lines.push(`| ${c.caseId} | ${li.reason} | ${li.tokens} | ${li.at} |`);
			}
		}
		lines.push("");
	}

	// 增量覆盖率
	if (coverage?.incremental?.enabled) {
		const ic = coverage.incremental;
		lines.push(
			"## 增量覆盖率",
			"",
			`> base: \`${ic.base}\` · 变更文件 ${ic.totalChangedFiles} · 业务文件 ${ic.businessFiles} · 匹配 ${ic.matchedFiles}`,
			"",
			"| 指标 | 已覆盖 | 总数 | 覆盖率 |",
			"|------|--------|------|--------|",
			`| 语句 | ${ic.statements.covered} | ${ic.statements.total} | ${ic.statements.pct}% |`,
			`| 分支 | ${ic.branches.covered} | ${ic.branches.total} | ${ic.branches.pct}% |`,
			`| 函数 | ${ic.functions.covered} | ${ic.functions.total} | ${ic.functions.pct}% |`,
			`| 行 | ${ic.lines.covered} | ${ic.lines.total} | ${ic.lines.pct}% |`,
			"",
		);
	} else if (coverage?.full?.enabled) {
		const c = coverage.full;
		lines.push(
			"## 全量覆盖率",
			"",
			`> 文件数: ${c.filesCount} · 来源: \`${c.source}\``,
			"",
			"| 指标 | 已覆盖 | 总数 | 覆盖率 |",
			"|------|--------|------|--------|",
			`| 语句 | ${c.statements.covered} | ${c.statements.total} | ${c.statements.pct}% |`,
			`| 分支 | ${c.branches.covered} | ${c.branches.total} | ${c.branches.pct}% |`,
			`| 函数 | ${c.functions.covered} | ${c.functions.total} | ${c.functions.pct}% |`,
			`| 行 | ${c.lines.covered} | ${c.lines.total} | ${c.lines.pct}% |`,
			"",
		);
	}

	// 产物目录
	const sandboxRoot = sandboxDir();
	lines.push(
		"---",
		"",
		"> 产物目录: \`${sandboxRoot}/artifacts/runs/${runId}/\`",
		"> 截图: \`${sandboxRoot}/artifacts/runs/${runId}/screenshots/\`",
		"> 日志: \`${sandboxRoot}/artifacts/runs/${runId}/logs/\`",
		"> 覆盖率: \`${sandboxRoot}/artifacts/runs/${runId}/${COVERAGE_RAW_FILE}\`",
		"",
	);

	return lines.join("\n");
}

// ---- v2: public API ----

export interface PublishedReports {
	dest: string;
	reportFile: string;
}

/**
 * v2 publishReports:
 * - Reads cases-executed.jsonl + case-registry.json + coverage from sandbox
 * - Generates a single markdown report
 * - Writes ONLY to reportDir (E2E_REPORT_PATH or PROJECT/docs/)
 * - NO base64 images, NO other project writes
 */
export function publishReports(runId?: string): PublishedReports {
	const { date, hhmm } = datePrefixShanghai();
	const id = resolveRunId(runId);
	const dest = resolveReportDir();
	fs.mkdirSync(dest, { recursive: true });

	const reportFile = path.join(dest, `${date}-真机E2E-${hhmm}.md`);

	// Read executed cases from sandbox
	const executedCases = readExecutedCases(id);

	// Load coverage from sandbox
	let coverageResult: { full: CoverageSummary; incremental: IncrementalCoverage } | null = null;
	try {
		coverageResult = loadCoverageResult(id);
		if (!coverageResult.full.enabled) coverageResult = null;
	} catch { /* coverage is optional */ }

	// Generate markdown
	const md = generateReportMarkdown(id, executedCases, coverageResult);
	fs.writeFileSync(reportFile, md, "utf-8");

	console.log(`[publish-reports] Report written: ${reportFile}`);

	return { dest, reportFile };
}
