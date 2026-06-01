import fs from "node:fs";
import path from "node:path";
import { discoverCases } from "./discover-cases";
import { discoverIntent } from "./discover-intent";
import { discoverRoutes } from "./discover-routes";
import { paths, repoRoot } from "./paths";

export interface TestPlan {
	requirementId: string;
	domain: string;
	sources: string[];
	routes: ReturnType<typeof discoverRoutes>;
	cases: ReturnType<typeof discoverCases>;
	guaziFlowHint?: string;
}

export function presentTestPlan(): { plan: TestPlan; markdownPath: string } {
	const intent = discoverIntent(process.env.E2E_USER_INTENT);
	const routes = discoverRoutes(intent.domain);
	const cases = discoverCases({ union: true, domain: intent.domain });

	let guaziFlowHint: string | undefined;
	if (fs.existsSync(paths.projectJson())) {
		try {
			const m = JSON.parse(fs.readFileSync(paths.projectJson(), "utf-8")) as {
				docs?: { guaziFlow?: string };
			};
			guaziFlowHint = m.docs?.guaziFlow;
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
		guaziFlowHint,
	};

	const lines = [
		"# 真机 E2E 测试计划",
		"",
		`| 项 | 值 |`,
		`|----|-----|`,
		`| 需求 ID | ${plan.requirementId} |`,
		`| domain | ${plan.domain} |`,
		`| 来源 | ${plan.sources.join(", ")} |`,
		guaziFlowHint ? `| guazi-flow | ${guaziFlowHint} |` : "",
		"",
		"## 用例清单",
		"",
		"| case id | spec | tags | 来源 |",
		"|---------|------|------|------|",
		...plan.cases.map(
			(c) => `| ${c.id} | ${c.spec} | ${c.tags.join(",")} | ${c.source} |`,
		),
		"",
	];

	const mdPath = path.join(repoRoot(), "e2e-device", "test-plan.md");
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
