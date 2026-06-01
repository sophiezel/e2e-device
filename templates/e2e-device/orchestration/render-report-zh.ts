import type { CaseRecord } from "../resilience/types";
import type { ResilienceRunSummary } from "../resilience/types";

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
}): string {
	const s = payload.summary;
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
		"",
	].join("\n");
}
