import fs from "node:fs";
import path from "node:path";
import { discoverIntent } from "./discover-intent";
import { discoverRoutes } from "./discover-routes";
import { e2eDeviceRoot, paths, repoRoot } from "./paths";
import { discoverGuaziFlowCases, type MatrixCase } from "./discover-guazi-flow";
import { discoverHybridCases } from "./discover-hybrid";
import { discoverChaos } from "./discover-chaos";
import { autoGenerateCases, writeGeneratedSpecs } from "./auto-generate-cases";
import { crossValidate } from "./cross-validate";
import { type RunProfile } from "../config/run-profile";
import { deviceEdgeCases } from "./discover-device-edge";

export interface CaseEntry {
	id: string;
	spec: string;
	tags: string[];
	source: string;
	metadata?: Record<string, unknown>;
	executionMethod?: string;  // 执行方式建议
	// device-edge 扩展字段
	category?: string;          // keyboard-occlusion | modal-scroll-lock | form-navigation | webview-communication | storage-cleanup | interrupt-recovery
	name?: string;              // 中文用例名称
	description?: string;       // 场景描述
	priority?: string;          // P0 | P1 | P2
	sentinel?: boolean;         // quick 模式哨兵
	profileLevel?: string;      // p0 | p1 | p2 控制 standard 过滤
	averageDurationMs?: number; // 预估耗时
	chaosFactors?: string[];    // resilience 模式混沌因子
	preconditions?: string[];   // 前置条件
	steps?: string[];           // 测试步骤
	expectedResult?: string;    // 期望结果
	failureCriteria?: string[]; // 失败判定
}

function specExists(spec: string): boolean {
	return fs.existsSync(path.join(repoRoot(), spec));
}

export function filterCasesWithExistingSpecs(cases: CaseEntry[]): CaseEntry[] {
	return cases.filter((c) => specExists(c.spec));
}

/**
 * 根据模式筛选用例
 * 
 * quick: 验收矩阵中"运行验证"的用例 + hybrid 基础用例
 * standard: 所有验收矩阵用例 + 所有 hybrid 用例
 * resilience: standard + 混沌测试
 */
function filterByProfile(cases: CaseEntry[], profile: RunProfile): CaseEntry[] {
	switch (profile) {
		case "quick":
			// quick 模式：所有业务用例 + device-edge 哨兵，排除混沌/P2/厂商特定
			return cases.filter((c) => {
				if (c.tags.includes("chaos")) return false;
				if (c.tags.includes("device-edge") && c.tags.includes("p2")) return false;
				if (c.tags.includes("vendor-specific")) return false;
				return true;
			});

		case "standard":
			// standard 模式：除 chaos 和 P2 端侧用例外全部
			return cases.filter((c) => {
				// 排除混沌测试
				if (c.tags.includes("chaos")) return false;
				// 排除 P2 端侧用例
				if (c.tags.includes("device-edge") && c.tags.includes("p2")) return false;
				// 排除厂商特定用例
				if (c.tags.includes("vendor-specific")) return false;
				return true;
			});

		case "resilience":
			// resilience 模式：所有用例（包括混沌测试和全量端侧用例）
			return cases;

		default:
			return cases;
	}
}

// 从验收矩阵解析执行方式
function parseExecutionMethod(matrix: MatrixCase[]): Map<string, string> {
	const methodMap = new Map<string, string>();
	for (const m of matrix) {
		methodMap.set(m.caseId, m.executionMethod);
	}
	return methodMap;
}

// 设置用例的执行方式
function setExecutionMethod(cases: CaseEntry[], methodMap: Map<string, string>): CaseEntry[] {
	return cases.map((c) => {
		// 从 id 中提取 caseId（如 followUpMark.C01 -> C01）
		const match = c.id.match(/\.C(\d+)$/);
		if (match) {
			const caseId = `C${match[1]}`;
			const method = methodMap.get(caseId);
			if (method) {
				return { ...c, executionMethod: method };
			}
		}
		return c;
	});
}

function existingSpecs(): CaseEntry[] {
	const specsDir = path.join(e2eDeviceRoot(), "specs");
	if (!fs.existsSync(specsDir)) {
		return [];
	}
	return fs
		.readdirSync(specsDir)
		.filter((f) => f.endsWith(".spec.ts"))
		.map((f) => ({
			id: f.replace(".spec.ts", ""),
			spec: `e2e-device/specs/${f}`,
			tags: ["existing"],
			source: "specs-dir",
		}));
}

function matrixCases(domain: string, routes: ReturnType<typeof discoverRoutes>): CaseEntry[] {
	const cases: CaseEntry[] = [];
	const bootstrap = "e2e-device/specs/app-launch.spec.ts";
	if (specExists(bootstrap)) {
		cases.push({
			id: "app-launch",
			spec: bootstrap,
			tags: ["bootstrap", "smoke"],
			source: "matrix",
		});
	}
	const smokeSpec = `e2e-device/specs/${domain}.smoke.spec.ts`;
	if (!specExists(smokeSpec)) {
		return cases;
	}
	for (const r of routes) {
		cases.push({
			id: `${domain}.${r.name}.smoke`,
			spec: smokeSpec,
			tags: ["smoke", r.name],
			source: "matrix",
		});
	}
	return cases;
}

function diffCases(): CaseEntry[] {
	const file = paths.diffInferred();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: CaseEntry[];
	};
	return filterCasesWithExistingSpecs(
		(data.cases || []).map((c) => ({ ...c, source: c.source || "diff" })),
	);
}

function chaosCases(): CaseEntry[] {
	const file = paths.chaosRegistry();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: CaseEntry[];
	};
	return filterCasesWithExistingSpecs(
		(data.cases || []).map((c) => ({
			...c,
			tags: [...(c.tags || []), "chaos"],
			source: "chaos",
		})),
	);
}

function unionById(lists: CaseEntry[][]): CaseEntry[] {
	const map = new Map<string, CaseEntry>();
	for (const list of lists) {
		for (const c of list) {
			const prev = map.get(c.id);
			if (!prev) {
				map.set(c.id, c);
			} else {
				map.set(c.id, {
					...prev,
					tags: [...new Set([...prev.tags, ...c.tags])],
					source: `${prev.source}+${c.source}`,
					metadata: prev.metadata || c.metadata,
					executionMethod: prev.executionMethod || c.executionMethod,
				});
			}
		}
	}
	return [...map.values()];
}

export function discoverCases(opts: { union?: boolean; domain?: string; userIntent?: string } = {}): CaseEntry[] {
	const intent = discoverIntent(opts.userIntent);
	const domain = opts.domain || intent.domain;
	const routes = discoverRoutes(domain);
	const profile = intent.profile;

	const matrix = matrixCases(domain, routes);
	const existing = existingSpecs();
	const diff = diffCases();
	const chaos = chaosCases();

	// 新增：guazi-flow 验收矩阵
	const guaziFlow = discoverGuaziFlowCases(domain);

	// 解析验收矩阵中的执行方式
	const matrixCasesData = guaziFlow
		.filter((c) => c.metadata)
		.map((c) => c.metadata as unknown as MatrixCase);
	const executionMethodMap = parseExecutionMethod(matrixCasesData);

	// 新增：Hybrid 测试用例
	const hybrid = discoverHybridCases(domain);

	// 新增：混沌测试用例
	const chaosHybrid = discoverChaos(domain);

	// 新增：自动生成（如果没有找到 spec）
	if (guaziFlow.length > 0) {
		const autoGenerated = autoGenerateCases(matrixCasesData, domain);
		writeGeneratedSpecs(autoGenerated);
	}

	// 新增：真机端侧边缘用例
	const deviceEdge = deviceEdgeCases();

	const lists = opts.union
		? [matrix, existing, diff, chaos, guaziFlow, hybrid, chaosHybrid, deviceEdge]
		: [matrix, diff, chaos, guaziFlow, hybrid, chaosHybrid, deviceEdge];

	let cases = filterCasesWithExistingSpecs(unionById(lists));

	// 设置执行方式
	cases = setExecutionMethod(cases, executionMethodMap);

	// 根据模式筛选用例
	cases = filterByProfile(cases, profile);

	// 交叉验证
	const validation = crossValidate(cases);
	if (validation.gaps?.length) {
		console.warn(`[discover-cases] Cross-validation found ${validation.gaps.length} coverage gap(s)`);
		if (process.env.E2E_DEBUG) {
			console.debug("[discover-cases] Validation details:", JSON.stringify(validation, null, 2));
		}
	}

	fs.writeFileSync(
		paths.caseRegistry(),
		JSON.stringify({ domain, cases, validation, profile }, null, 2),
	);

	return cases;
}
