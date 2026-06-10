import type { CaseRecord } from "../resilience/types";
import type { ResilienceRunSummary } from "../resilience/types";
import type { CoverageSummary, IncrementalCoverage } from "./coverage";

export function renderResilienceReportZh(
	summary: ResilienceRunSummary,
	records: CaseRecord[],
): string {
	const discovered = records.flatMap((r) => r.issues);
	const autoFixed = records.flatMap((r) =>
		r.autoFixes.map((fix) => ({ caseId: r.caseId, ...fix })),
	);
	const pending = records.flatMap((r) =>
		r.pendingItems.map((item) => ({ caseId: r.caseId, title: r.title, item })),
	);
	const tested = records.map((r) => ({
		caseId: r.caseId,
		title: r.title,
		outcome: r.outcome,
		rootCause: r.rootCause ?? "unknown",
		mockUsed: r.mockUsed,
	}));

	return [
		"# 真机 E2E 韧性执行报告",
		"",
		"## 执行摘要",
		`- 开始时间：${summary.startedAt}`,
		`- 结束时间：${summary.finishedAt}`,
		`- 总用例：${summary.totalCases}`,
		`- 纯 live 通过：${summary.passedLive}`,
		`- Mock 兜底通过：${summary.passedWithMock}`,
		`- 自动修复后通过：${summary.passedAfterAutofix}`,
		`- degraded 失败：${summary.degradedFailures}`,
		`- 自动修复次数：${summary.autoFixCount}`,
		"",
		"## 已测项",
		...tested.map(
			(t) =>
				`- ${t.caseId} ${t.title} → ${t.outcome}（rootCause=${t.rootCause}${t.mockUsed ? ", mockUsed" : ""}）`,
		),
		"",
		"## 已发现问题",
		...(discovered.length
			? discovered.map(
					(i) =>
						`- [${i.caseId}] ${i.rootCause}: ${i.message}${i.apiPath ? ` (${i.apiPath})` : ""}`,
				)
			: ["- 无"]),
		"",
		"## 已自动解决",
		...(autoFixed.length
			? autoFixed.map((i) => `- [${i.caseId}] ${i.file}: ${i.summary}`)
			: ["- 无"]),
		"",
		"## 待解决",
		...(pending.length
			? pending.map((i) => `- [${i.caseId}] ${i.title}: ${i.item}`)
			: ["- 无"]),
		"",
	].join("\n");
}

export function renderRunArchiveZh(payload: {
	runId: string;
	status: string;
	startedAt: string;
	finishedAt?: string;
	summary: ResilienceRunSummary;
	issues: Array<{
		title: string;
		cause: string;
		repro: string;
		resolved: boolean;
		autoFixAttempted: boolean;
	}>;
	mockLayer?: string;
	coverage?: CoverageSummary;
	incrementalCoverage?: IncrementalCoverage;
}): string {
	const s = payload.summary;
	const covParts: string[] = [];

	if (payload.coverage) {
		const c = payload.coverage;
		const ic = payload.incrementalCoverage;
		if (c.enabled) {
			covParts.push(
				"",
				"## 📊 代码覆盖率",
				"",
				`> 来源：\`${c.source}\` · 全量 ${c.filesCount} 个文件`,
			);

			// ---- 增量覆盖率（重点优先展示） ----
			if (ic?.enabled) {
				covParts.push(
					"",
					"### 🔍 增量覆盖率（git diff vs `" + ic.base + "`）",
					"",
					`> 变更文件 ${ic.totalChangedFiles} 个 · 业务文件 ${ic.businessFiles} 个 · 匹配覆盖率 ${ic.matchedFiles} 个`,
					"",
					"| 指标 | 已覆盖 | 总数 | 覆盖率 |",
					"|------|--------|------|--------|",
					`| 语句 | ${ic.statements.covered} | ${ic.statements.total} | **${ic.statements.pct}%** |`,
					`| 分支 | ${ic.branches.covered} | ${ic.branches.total} | **${ic.branches.pct}%** |`,
					`| 函数 | ${ic.functions.covered} | ${ic.functions.total} | **${ic.functions.pct}%** |`,
					`| 行 | ${ic.lines.covered} | ${ic.lines.total} | **${ic.lines.pct}%** |`,
				);
				// 变更文件明细（按覆盖率从低到高）
				if (ic.files.length > 0) {
					const sorted = [...ic.files].sort((a, b) => a.lines.pct - b.lines.pct || a.branches.pct - b.branches.pct);
					covParts.push("", "<details><summary>📁 变更文件明细（按覆盖率 ↑）</summary>", "");
					covParts.push("| 文件 | 语句% | 分支% | 函数% | 行% |");
					covParts.push("|------|-------|-------|-------|------|");
					for (const f of sorted) {
						covParts.push(`| \`${f.shortPath}\` | ${f.statements.pct}% | ${f.branches.pct}% | ${f.functions.pct}% | ${f.lines.pct}% |`);
					}
					covParts.push("", "</details>");
				}
				// 未覆盖告警
				if (ic.uncoveredFiles.length > 0) {
					covParts.push("", `<details><summary>⚠️ 变更但未匹配覆盖率（${ic.uncoveredFiles.length} 个）</summary>`, "");
					for (const f of ic.uncoveredFiles) covParts.push(`- \`${f}\``);
					covParts.push("", "</details>");
				}
				if (ic.lines.pct < 60) {
					covParts.push("", "> ⚠️ 增量代码行覆盖率低于 60%，建议补充测试用例。");
				}
				covParts.push("");
			}

			// ---- 全量覆盖率（折叠） ----
			covParts.push(
				"<details>",
				"<summary>📦 全量覆盖率（全部 " + c.filesCount + " 个已插桩文件）</summary>",
				"",
				"| 指标 | 已覆盖 | 总数 | 覆盖率 |",
				"|------|--------|------|--------|",
				`| 语句 | ${c.statements.covered} | ${c.statements.total} | **${c.statements.pct}%** |`,
				`| 分支 | ${c.branches.covered} | ${c.branches.total} | **${c.branches.pct}%** |`,
				`| 函数 | ${c.functions.covered} | ${c.functions.total} | **${c.functions.pct}%** |`,
				`| 行 | ${c.lines.covered} | ${c.lines.total} | **${c.lines.pct}%** |`,
				"",
				"> 原始数据：`artifacts/runs/<runId>/coverage-raw.json`",
				"",
				"</details>",
			);
		} else {
			covParts.push(
				"",
				"## 📊 代码覆盖率",
				"",
				"⚠️ 未检测到 Istanbul 覆盖率数据。",
				"请在构建时启用 babel-plugin-istanbul 或 vite-plugin-istanbul。",
			);
		}
	}

	return [
		`# 真机 E2E 运行归档 ${payload.runId}`,
		"",
		`- 状态：**${payload.status}**`,
		`- 开始：${payload.startedAt}`,
		`- 结束：${payload.finishedAt || "—"}`,
		payload.mockLayer ? `- Mock 层：${payload.mockLayer}` : "",
		"",
		"## 执行摘要",
		`- 总用例：${s.totalCases}`,
		`- live 通过：${s.passedLive}`,
		`- mock 通过：${s.passedWithMock}`,
		`- autofix 通过：${s.passedAfterAutofix}`,
		`- degraded 失败：${s.degradedFailures}`,
		"",
		"## 未解问题",
		...(payload.issues.length
			? payload.issues.map(
					(i) =>
						`- ${i.title}（${i.cause}）resolved=${i.resolved} autoFix=${i.autoFixAttempted}`,
				)
			: ["- 无"]),
		...covParts,
		"",
	].join("\n");
}
