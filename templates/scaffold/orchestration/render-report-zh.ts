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

	const lines: string[] = [
		"# 真机 E2E 韧性执行报告",
		"",
		"## 执行摘要",
		"",
		"| 指标 | 数值 |",
		"|------|------|",
		`| 总用例 | ${summary.totalCases} |`,
		`| 通过 | ${summary.passed} |`,
		`| 纯 live 通过 | ${summary.passedLive} |`,
		`| Mock 兜底通过 | ${summary.passedWithMock} |`,
		`| 自动修复后通过 | ${summary.passedAfterAutofix} |`,
		`| 失败 | ${summary.failed} |`,
		`| 错误 | ${summary.errors} |`,
		`| 自动修复次数 | ${summary.autoFixCount} |`,
		`| 开始 | ${summary.startedAt || "—"} |`,
		`| 结束 | ${summary.finishedAt || "—"} |`,
		"",
		"## 用例详情",
		"",
	];

	const statusIcon: Record<string, string> = {
		passed: "✅",
		failed: "❌",
		blocked: "⛔",
		skipped: "⏭️",
		error: "💥",
		recorded_failure: "❌",
	};

	lines.push("| # | case | 结果 | 耗时 | 根因 |", "|---|------|------|------|------|");
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const icon = statusIcon[r.outcome] || "❓";
		const duration = r.duration != null ? `${(r.duration / 1000).toFixed(1)}s` : "—";
		const rootCause = r.rootCause || r.error?.slice(0, 60) || "—";
		const label = r.title && r.title !== r.caseId ? `${r.title} (${r.caseId})` : r.caseId;
		lines.push(`| ${i + 1} | ${label} | ${icon} ${r.outcome} | ${duration} | ${rootCause.replace(/\|/g, "\\|")} |`);
	}
	lines.push("");

	// 每个 case 的详细测试路径
	lines.push("## 各用例测试路径", "");
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const icon = statusIcon[r.outcome] || "❓";
		const label = r.title && r.title !== r.caseId ? `${r.title} (${r.caseId})` : r.caseId;
		const duration = r.duration != null ? `${(r.duration / 1000).toFixed(1)}s` : "—";

		lines.push(`### ${i + 1}. ${icon} ${label}`);
		lines.push("");
		lines.push(`- **结果**: ${r.outcome} | **耗时**: ${duration}`);
		if (r.rootCause) lines.push(`- **根因**: ${r.rootCause}`);
		if (r.error && r.outcome !== "passed") {
			lines.push("", "<details><summary>📋 错误详情</summary>", "", "```", r.error.slice(0, 3000), "```", "", "</details>", "");
		}

		// 测试步骤
		const steps = r.testSteps && r.testSteps.length > 0
			? r.testSteps
			: r.pendingItems.length > 0 ? r.pendingItems : [];
		if (steps.length > 0) {
			lines.push("", "**🔍 测试路径**:", "");
			for (const s of steps) {
				lines.push(`   - ${s}`);
			}
			lines.push("");
		}

		// 复现路径（仅失败/错误）
		if (r.outcome !== "passed" && r.outcome !== "skipped" && r.reproductionPath) {
			const rp = r.reproductionPath;
			lines.push("**🔄 复现路径**:", "");
			if (rp.deviceModel) lines.push(`- 设备: ${rp.deviceModel} / ${rp.osVersion}`);
			if (rp.networkCondition) lines.push(`- 网络: ${rp.networkCondition}`);
			lines.push(`- 复现概率: ${rp.probability || "必现"}`);
			if (rp.stepsToReproduce.length > 0) {
				lines.push("- 步骤:");
				for (const [j, s] of rp.stepsToReproduce.entries()) {
					lines.push(`  ${j + 1}. ${s}`);
				}
			}
			lines.push("");
		}

		// 修复建议（仅失败/错误）
		if (r.outcome !== "passed" && r.outcome !== "skipped" && r.suggestedFixes && r.suggestedFixes.length > 0) {
			lines.push("**🔧 修复建议**:", "");
			for (const sf of r.suggestedFixes) {
				for (const a of sf.approaches) lines.push(`- ${a}`);
				if (sf.references.length > 0) lines.push(`  参考: ${sf.references.join(", ")}`);
			}
			lines.push("");
		}

		// Problem stacks (detailed)
		if (r.problemStacks && r.problemStacks.length > 0) {
			for (const ps of r.problemStacks) {
				if (ps.callStack) {
					lines.push("<details><summary>📋 调用栈</summary>", "", "```", ps.callStack.slice(0, 3000), "```", "", "</details>", "");
				}
			}
		}

		lines.push("---", "");
	}
	lines.push("");

	// 已发现问题 (issues)
	if (discovered.length > 0) {
		lines.push("## 已发现问题", "");
		for (const i of discovered) {
			lines.push(`- **[${i.caseId}]** ${i.rootCause}: ${i.message}${i.apiPath ? ` (\`${i.apiPath}\`)` : ""}`);
		}
		lines.push("");
	}

	// 已自动解决
	if (autoFixed.length > 0) {
		lines.push("## 已自动解决", "");
		for (const i of autoFixed) {
			lines.push(`- **[${i.caseId}]** ${i.file}: ${i.summary}`);
		}
		lines.push("");
	}

	return lines.join("\n");
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

	const lines: string[] = [
		`# 真机 E2E 运行归档 ${payload.runId}`,
		"",
		`- 状态：**${payload.status}**`,
		`- 开始：${payload.startedAt}`,
		`- 结束：${payload.finishedAt || "—"}`,
		payload.mockLayer ? `- Mock 层：${payload.mockLayer}` : "",
		"",
		"## 执行摘要",
		"",
		"| 指标 | 数值 |",
		"|------|------|",
		`| 总用例 | ${s.totalCases} |`,
		`| live 通过 | ${s.passedLive} |`,
		`| mock 通过 | ${s.passedWithMock} |`,
		`| autofix 通过 | ${s.passedAfterAutofix} |`,
		`| 失败 | ${s.failed} |`,
		`| degraded 失败 | ${s.degradedFailures} |`,
		"",
		"## 用例结果",
		"",
	];

	const statusIcon: Record<string, string> = {
		passed: "✅", failed: "❌", blocked: "⛔", skipped: "⏭️", error: "💥", recorded_failure: "❌",
	};

	lines.push("| # | case | 结果 | 耗时 |", "|---|------|------|------|");
	for (let i = 0; i < s.cases.length; i++) {
		const c = s.cases[i];
		const icon = statusIcon[c.outcome] || "❓";
		const duration = c.duration != null ? `${(c.duration / 1000).toFixed(1)}s` : "—";
		const label = c.title && c.title !== c.caseId ? `${c.title} (${c.caseId})` : c.caseId;
		lines.push(`| ${i + 1} | ${label} | ${icon} ${c.outcome} | ${duration} |`);
	}
	lines.push("");

	// 失败/错误用例详情 (not skipped)
	const failures = s.cases.filter((c: CaseRecord) => c.outcome === "failed" || c.outcome === "error" || c.outcome === "recorded_failure");
	if (failures.length > 0) {
		lines.push("## ❌ 失败用例详情", "");
		for (const c of failures) {
			lines.push(`### ${c.caseId}`);
			lines.push("");
			if (c.rootCause) lines.push(`- **根因**: ${c.rootCause}`);
			if (c.error) {
				lines.push("", "<details><summary>📋 错误详情</summary>", "", "```", c.error.slice(0, 4000), "```", "", "</details>", "");
			}
			if (c.suggestedFixes && c.suggestedFixes.length > 0) {
				lines.push("**🔧 修复建议:**", "");
				for (const sf of c.suggestedFixes) {
					for (const a of sf.approaches) {
						lines.push(`- ${a}`);
					}
				}
				lines.push("");
			}
			lines.push("---", "");
		}
	}

	lines.push("## 未解问题");
	if (payload.issues.length) {
		for (const i of payload.issues) {
			lines.push(`- ${i.title}（${i.cause}）resolved=${i.resolved} autoFix=${i.autoFixAttempted}`);
		}
	} else {
		lines.push("- 无");
	}
	lines.push("");
	for (const cp of covParts) lines.push(cp);
	lines.push("");

	return lines.join("\n");
}
