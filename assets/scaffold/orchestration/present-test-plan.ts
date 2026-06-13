import fs from "node:fs";
import path from "node:path";
import { discoverCases, type CaseEntry } from "./discover-cases";
import { discoverIntent } from "./discover-intent";
import { discoverRoutes } from "./discover-routes";
import { crossValidate } from "./cross-validate";
import { paths, repoRoot, sandboxDir } from "./paths";
import { deviceEdgeMetadata } from "./discover-device-edge";
import { getRunProfile } from "../config/run-profile";

export interface TestPlan {
	requirementId: string;
	domain: string;
	sources: string[];
	routes: ReturnType<typeof discoverRoutes>;
	cases: ReturnType<typeof discoverCases>;
	domainDocHint?: string;
	deviceEdgeMeta?: ReturnType<typeof deviceEdgeMetadata>;
	totalEstimatedDuration: string;
}

/** 估算所有用例总耗时 */
function estimateTotalDuration(cases: ReturnType<typeof discoverCases>): string {
	let totalMs = 0;
	for (const c of cases) {
		totalMs += c.averageDurationMs || 25000; // 默认 25s/case
	}
	if (totalMs < 60000) {
		return `${(totalMs / 1000).toFixed(0)}s`;
	}
	const minutes = Math.floor(totalMs / 60000);
	const seconds = Math.round((totalMs % 60000) / 1000);
	return `${minutes}m${seconds}s`;
}

export function presentTestPlan(): { plan: TestPlan; markdownPath: string } {
	const intent = discoverIntent(process.env.E2E_USER_INTENT);
	const routes = discoverRoutes(intent.domain);
	const cases = discoverCases({ union: true, domain: intent.domain });
	const profile = getRunProfile();

	let domainDocHint: string | undefined;
	if (fs.existsSync(paths.projectJson())) {
		try {
			const m = JSON.parse(fs.readFileSync(paths.projectJson(), "utf-8")) as {
				docs?: { guaziFlow?: string };
			};
			domainDocHint = m.docs?.guaziFlow;
		} catch {
			// ignore
		}
	}

	const plan: TestPlan = {
		requirementId: intent.requirementId,
		domain: intent.domain,
		sources: intent.sources,
		routes,
		cases,
		domainDocHint,
		deviceEdgeMeta: deviceEdgeMetadata(),
		totalEstimatedDuration: estimateTotalDuration(cases),
	};

	// Cross-validate and collect warnings for the test plan
	const validation = crossValidate(cases);
	const warnings: string[] = [];
	if (validation.gaps?.length) {
		warnings.push(`⚠️ 覆盖率缺口: ${validation.gaps.length} 项`);
		if (process.env.E2E_DEBUG) {
			for (const gap of validation.gaps) {
				warnings.push(`  - ${JSON.stringify(gap)}`);
			}
		}
	}

	// Count cases with missing specs
	const missingSpecs = cases.filter((c) => !fs.existsSync(c.spec));
	if (missingSpecs.length > 0) {
		warnings.push(`⚠️ ${missingSpecs.length} 个用例的 spec 文件不存在（将被跳过）`);
	}

	const lines = [
		"# 真机 E2E 测试计划",
		"",
		`| 项 | 值 |`,
		`|----|-----|`,
		`| 需求 ID | ${plan.requirementId} |`,
		`| domain | ${plan.domain} |`,
		`| 来源 | ${plan.sources.join(", ")} |`,
		`| 运行模式 | ${profile} |`,
		domainDocHint ? `| domain-doc | ${domainDocHint} |` : "",
		"",
	];

	if (warnings.length > 0) {
		lines.push("## ⚠️ 交叉验证警告", "");
		lines.push(...warnings, "");
	}

	lines.push(
		"## 用例清单",
		"",
		"| case id | 名称 | 优先级 | 来源 | 预估耗时 |",
		"|---------|------|--------|------|---------|",
		...plan.cases.map(
			(c) => {
				const name = c.name || (c.metadata?.description as string) || c.id;
				const priority = c.priority || "—";
				const source = c.source;
				const est = c.averageDurationMs
					? `${(c.averageDurationMs / 1000).toFixed(0)}s`
					: "—";
				return `| ${c.id} | ${name} | ${priority} | ${source} | ${est} |`;
			},
		),
		"",
		`> 预估总耗时: **${plan.totalEstimatedDuration}**`,
		"",
	);

	const mdPath = path.join(sandboxDir(), "test-plan.md");
	fs.writeFileSync(mdPath, lines.filter(Boolean).join("\n"), "utf-8");

	const runPath = paths.runJson();
	const prev = fs.existsSync(runPath)
		? (JSON.parse(fs.readFileSync(runPath, "utf-8")) as Record<string, unknown>)
		: {};
	fs.writeFileSync(
		runPath,
		JSON.stringify({ ...prev, testPlan: plan, testPlanMd: mdPath, at: new Date().toISOString() }, null, 2),
		"utf-8",
	);

	return { plan, markdownPath: mdPath };
}
