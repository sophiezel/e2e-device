import fs from "node:fs";
import path from "node:path";
import { discoverCases, type CaseEntry } from "./discover-cases";
import { discoverIntent } from "./discover-intent";
import { discoverRoutes } from "./discover-routes";
import { crossValidate } from "./cross-validate";
import { paths, sandboxDir, projectCacheDir, repoRoot } from "./paths";
import { deviceEdgeMetadata } from "./discover-device-edge";
import { getRunProfile } from "../config/run-profile";
import { specExists } from "./spec-resolver";
import {
	QUICK_BUDGET_MS,
	STANDARD_BUDGET_MS,
	LAYER_SLO_MS,
} from "./constants";
import { checkL2Readiness } from "./l2-readiness";

export interface TestPlan {
	requirementId: string;
	domain: string;
	sources: string[];
	routes: ReturnType<typeof discoverRoutes>;
	cases: CaseEntry[];
	domainDocHint?: string;
	deviceEdgeMeta?: ReturnType<typeof deviceEdgeMetadata>;
	totalEstimatedDuration: string;
	estimatedMs: number;
	budgetMs: number;
	budgetGate: "ok" | "fail" | "n/a";
	recommendedMode: string;
	budgetWarnings: string[];
	fromRegistry: boolean;
}

function loadDurationP50(caseId: string): number | undefined {
	try {
		const statsPath = path.join(projectCacheDir(repoRoot()), "duration-stats.json");
		if (!fs.existsSync(statsPath)) return undefined;
		const stats = JSON.parse(fs.readFileSync(statsPath, "utf-8")) as {
			cases?: Record<string, { p50?: number; samples?: number[] }>;
		};
		const entry = stats.cases?.[caseId];
		if (entry?.p50 && entry.p50 > 0) return entry.p50;
	} catch {
		/* ignore */
	}
	return undefined;
}

/** Per-case estimate: prefer historical P50, then averageDurationMs, then tag defaults. */
export function estimateCaseMs(c: CaseEntry): number {
	const p50 = loadDurationP50(c.id);
	if (p50) return p50;
	if (c.averageDurationMs && c.averageDurationMs > 0) return c.averageDurationMs;
	const tags = c.tags || [];
	if (tags.includes("list-journey") || c.metadata?.journeySegment === "list") return 12_000;
	if (tags.includes("form") || c.metadata?.journeySegment === "form" || /\.C\d+$/.test(c.id)) {
		return 14_000;
	}
	if (tags.includes("chaos")) return 35_000;
	if (tags.includes("hybrid") || tags.includes("infra")) return 28_000;
	return 22_000;
}

function estimateTotalDuration(cases: CaseEntry[]): {
	label: string;
	ms: number;
} {
	let totalMs = 0;
	for (const c of cases) {
		totalMs += estimateCaseMs(c);
	}
	// Journey overhead: ~1 cold session start per segment (~4 × 15s)
	totalMs += Math.min(cases.length, 5) * 15_000;
	if (totalMs < 60000) {
		return { label: `${(totalMs / 1000).toFixed(0)}s`, ms: totalMs };
	}
	const minutes = Math.floor(totalMs / 60000);
	const seconds = Math.round((totalMs % 60000) / 1000);
	return { label: `${minutes}m${seconds}s`, ms: totalMs };
}

/** Prefer existing case-registry.json to avoid rediscovering (cache bypass). */
function loadCasesFromRegistry(domain: string): CaseEntry[] | null {
	const registryPath = path.join(sandboxDir(), "case-registry.json");
	if (!fs.existsSync(registryPath)) return null;
	try {
		const data = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
			cases?: CaseEntry[];
			domain?: string;
		};
		const cases = data.cases || [];
		if (cases.length === 0) return null;
		return cases;
	} catch {
		return null;
	}
}

export function presentTestPlan(): { plan: TestPlan; markdownPath: string; jsonPath: string } {
	const intent = discoverIntent(process.env.E2E_USER_INTENT);
	const domain = intent.domain;
	const routes = discoverRoutes(domain);
	const profile = getRunProfile();

	let fromRegistry = false;
	let cases = loadCasesFromRegistry(domain);
	if (cases) {
		fromRegistry = true;
		console.log(`[plan] using existing case-registry.json (${cases.length} cases)`);
	} else {
		cases = discoverCases({ union: true, domain });
	}

	let domainDocHint: string | undefined;
	if (fs.existsSync(paths.projectJson())) {
		try {
			const m = JSON.parse(fs.readFileSync(paths.projectJson(), "utf-8")) as {
				docs?: { matrixDoc?: string };
			};
			domainDocHint = m.docs?.matrixDoc;
		} catch {
			// ignore
		}
	}

	const pendingAssert = cases.filter((c) => c.tags.includes("pending-assert")).length;
	const formCount = cases.filter(
		(c) => c.tags.includes("form") || c.metadata?.journeySegment === "form" || /\.C\d+$/.test(c.id),
	).length;
	const est = estimateTotalDuration(cases);
	const budgetWarnings: string[] = [];
	const budgetMs =
		profile === "quick" ? QUICK_BUDGET_MS : profile === "standard" ? STANDARD_BUDGET_MS : 0;
	let budgetGate: TestPlan["budgetGate"] = "n/a";
	let recommendedMode = profile;

	if (profile !== "resilience" && budgetMs > 0 && est.ms > budgetMs) {
		const mins = Math.round(budgetMs / 60000);
		budgetGate = "fail";
		recommendedMode = "quick";
		budgetWarnings.push(
			`预估 ${est.label} 超过 ${profile} 预算 ${mins}min — 建议 --mode quick、降低 E2E_STANDARD_FORM_CAP（当前 form≈${formCount}）、或剔弱断言后重跑 plan`,
		);
	} else if (profile !== "resilience") {
		budgetGate = "ok";
	}

	const plan: TestPlan = {
		requirementId: intent.requirementId,
		domain,
		sources: intent.sources,
		routes,
		cases,
		domainDocHint,
		deviceEdgeMeta: deviceEdgeMetadata(),
		totalEstimatedDuration: est.label,
		estimatedMs: est.ms,
		budgetMs,
		budgetGate,
		recommendedMode,
		budgetWarnings,
		fromRegistry,
	};

	const validation = crossValidate(cases);
	const warnings: string[] = [...budgetWarnings];
	if (validation.gaps?.length) {
		warnings.push(`覆盖率缺口: ${validation.gaps.length} 项`);
	}
	const missingSpecs = cases.filter((c) => !specExists(c.spec) && !c.tags.includes("pending-spec"));
	if (missingSpecs.length > 0) {
		warnings.push(`${missingSpecs.length} 个用例的 spec 文件不存在`);
	}
	warnings.push(
		`断言过滤: standard/quick 已排除 pending-assert；form≈${formCount}（cap 默认 12）；registry=${fromRegistry ? "hit" : "discover"}`,
	);
	if (pendingAssert > 0 && profile === "resilience") {
		warnings.push(`resilience 含 ${pendingAssert} 个 pending-assert（弱断言）`);
	}

	const l2 = checkL2Readiness({ runL2: true, profile });
	const l2Ready = l2.ok;
	if (!l2Ready) {
		for (const b of l2.blockers) {
			warnings.push(`[L2] ${b.id}: ${b.messageZh}`);
		}
	}
	fs.writeFileSync(
		path.join(sandboxDir(), "l2-readiness.json"),
		JSON.stringify({ ok: l2Ready, blockers: l2.blockers, at: new Date().toISOString() }, null, 2),
		"utf-8",
	);

	const slo = LAYER_SLO_MS[profile] || LAYER_SLO_MS.standard;
	const lines = [
		"# 真机 E2E 测试计划",
		"",
		`| 项 | 值 |`,
		`|----|-----|`,
		`| 需求 ID | ${plan.requirementId} |`,
		`| domain | ${plan.domain} |`,
		`| 来源 | ${plan.sources.join(", ")} |`,
		`| 运行模式 | ${profile} |`,
		`| 效率预算 | ${profile === "quick" ? "≤12min" : profile === "standard" ? "≤25min" : "无硬顶"} |`,
		`| 预算门禁 | ${budgetGate} |`,
		`| 建议 mode | ${recommendedMode} |`,
		domainDocHint ? `| domain-doc | ${domainDocHint} |` : "",
		"",
		"## 分层 SLO（软）",
		"",
		`| 层 | 预算 |`,
		`|----|------|`,
		`| L-prep | ${Math.round(slo.prep / 1000)}s |`,
		`| L-boot | ${Math.round(slo.boot / 1000)}s |`,
		`| L-warm | ${slo.warm ? Math.round(slo.warm / 60000) + "min" : "无硬顶"} |`,
		`| L-infra | ${slo.infra ? Math.round(slo.infra / 60000) + "min" : "0"} |`,
		`| L-post | ${Math.round(slo.post / 1000)}s |`,
		"",
	];

	if (warnings.length > 0) {
		lines.push("## 警告 / 效率提示", "");
		for (const w of warnings) {
			lines.push(`- ${w}`);
		}
		lines.push("");
	}

	lines.push(
		"## 用例清单",
		"",
		"| case id | 名称 | 优先级 | 来源 | 断言 | 预估耗时 |",
		"|---------|------|--------|------|------|---------|",
		...plan.cases.map((c) => {
			const name = c.name || (c.metadata?.description as string) || c.id;
			const priority = c.priority || "—";
			const source = c.source;
			const aq =
				c.tags.find((t) => t === "assert-strong" || t === "pending-assert") ||
				(c.metadata?.assertQuality as string) ||
				"—";
			const estMs = estimateCaseMs(c);
			const estLabel = `${(estMs / 1000).toFixed(0)}s`;
			return `| ${c.id} | ${name} | ${priority} | ${source} | ${aq} | ${estLabel} |`;
		}),
		"",
		`> 预估总耗时: **${plan.totalEstimatedDuration}**`,
		"",
	);

	const mdPath = path.join(sandboxDir(), "test-plan.md");
	fs.writeFileSync(mdPath, lines.filter(Boolean).join("\n"), "utf-8");

	const jsonPath = path.join(sandboxDir(), "test-plan.json");
	fs.writeFileSync(
		jsonPath,
		JSON.stringify(
			{
				...plan,
				profile,
				layerSlo: slo,
				at: new Date().toISOString(),
			},
			null,
			2,
		),
		"utf-8",
	);

	const runPath = paths.runJson();
	const prev = fs.existsSync(runPath)
		? (JSON.parse(fs.readFileSync(runPath, "utf-8")) as Record<string, unknown>)
		: {};
	fs.writeFileSync(
		runPath,
		JSON.stringify(
			{ ...prev, testPlan: plan, testPlanMd: mdPath, testPlanJson: jsonPath, at: new Date().toISOString() },
			null,
			2,
		),
		"utf-8",
	);

	for (const w of budgetWarnings) {
		console.warn(`[plan] ⚠️ ${w}`);
	}
	if (!l2Ready) {
		for (const b of l2.blockers) {
			console.warn(`[plan] L2 ${b.severity}: ${b.messageZh}`);
		}
		if (process.env.E2E_STRICT_L2 === "1") {
			console.error("[plan] L2_STRICT_FAIL");
			process.exitCode = 3;
		}
	}

	if (budgetGate === "fail") {
		console.error(
			`[plan] BUDGET_GATE_FAIL estimatedMs=${est.ms} budgetMs=${budgetMs} recommendedMode=${recommendedMode}`,
		);
		process.exitCode = 2;
	}

	return { plan, markdownPath: mdPath, jsonPath };
}
