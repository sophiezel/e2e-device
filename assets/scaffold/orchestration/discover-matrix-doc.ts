import fs from "node:fs";
import path from "node:path";
import { repoRoot, sandboxDir } from "./paths";
import { loadProjectManifest } from "../config/project-manifest";
import type { CaseEntry } from "./discover-cases";
import {
	inferStateIdFromPreconditions,
	loadDomainStates,
} from "./mock-state";
import { HOST_FIXTURE_DIR } from "./discover-request-layer";

export interface MatrixCase {
	caseId: string;
	source: string;
	pageModule: string;
	acceptanceCriteria: string;
	preconditions: string;
	operation: string;
	expectedResult: string;
	executionMethod: string;
	minimalVerification: string;
	/** Resolved mock state id (host states.json / keyword heuristics). */
	mockStateId?: string;
	mockQuery?: Record<string, string>;
	mockProfile?: string;
}

/**
 * 从 skill.project.json 读取 matrixDoc 路径
 */
export function getMatrixDocPath(): string | null {
	const manifest = loadProjectManifest();
	if (manifest?.docs?.matrixDoc) {
		return path.join(repoRoot(), manifest.docs.matrixDoc);
	}
	return null;
}

/**
 * 解析验收矩阵表格
 */
export function parseMatrixTable(content: string): MatrixCase[] {
	const cases: MatrixCase[] = [];
	const lines = content.split("\n");

	// 找到验收矩阵标题
	let matrixStart = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes("验收与验证矩阵")) {
			matrixStart = i;
			break;
		}
	}

	if (matrixStart === -1) return cases;

	// 找到表格开始（| Case ID | ...）
	let tableStart = -1;
	for (let i = matrixStart; i < lines.length; i++) {
		if (
			lines[i].includes("| Case ID") ||
			lines[i].includes("| Case")
		) {
			tableStart = i;
			break;
		}
	}

	if (tableStart === -1) return cases;

	// 跳过表头分隔线
	let dataStart = tableStart + 1;
	if (lines[dataStart]?.includes("---")) {
		dataStart++;
	}

	// 解析数据行
	for (let i = dataStart; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line.startsWith("|") || line === "") break;

		const cols = line
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean);
		if (cols.length >= 9) {
			cases.push({
				caseId: cols[0],
				source: cols[1],
				pageModule: cols[2],
				acceptanceCriteria: cols[3],
				preconditions: cols[4],
				operation: cols[5],
				expectedResult: cols[6],
				executionMethod: cols[7],
				minimalVerification: cols[8],
			});
		}
	}

	return cases;
}

/**
 * Attach mock state from host states.json + precondition heuristics.
 */
export function enrichMatrixWithMockStates(
	matrix: MatrixCase[],
	domain: string,
): MatrixCase[] {
	const fixtureRoot = path.join(repoRoot(), HOST_FIXTURE_DIR);
	const statesFile = loadDomainStates(fixtureRoot, domain);
	const byId = new Map(
		(statesFile?.states || []).map((s) => [s.id, s] as const),
	);

	return matrix.map((m) => {
		const stateId =
			inferStateIdFromPreconditions(
				m.preconditions,
				statesFile?.matrixKeywords,
			) || undefined;
		if (!stateId) return m;
		const state = byId.get(stateId);
		return {
			...m,
			mockStateId: stateId,
			mockProfile: state?.profile || stateId,
			...(state?.query ? { mockQuery: { ...state.query } } : {}),
		};
	});
}

/**
 * 转换为 CaseEntry。仅保留 pageModule 匹配当前 domain 的行，避免串文档矩阵。
 */
export function convertToCaseEntry(
	matrix: MatrixCase[],
	domain: string,
): CaseEntry[] {
	const sb = sandboxDir();
	const scoped = matrix.filter((m) => {
		const mod = (m.pageModule || "").trim();
		if (!mod) return false;
		return (
			mod === domain ||
			mod.startsWith(`${domain} `) ||
			mod.startsWith(`${domain}/`) ||
			mod.includes(domain)
		);
	});
	const enriched = enrichMatrixWithMockStates(
		scoped.length ? scoped : matrix,
		domain,
	);
	return enriched.map((m) => ({
		id: `${domain}.${m.caseId}`,
		spec: path.join(sb, "specs", `${domain}.${m.caseId}.spec.ts`),
		tags: [
			"biz",
			"matrix",
			m.source.toLowerCase(),
			...(m.caseId === "C01" ? ["smoke"] : []),
			...(m.mockStateId ? [`mock:${m.mockStateId}`] : []),
		],
		source: "domain-matrix",
		metadata: {
			...(m as unknown as Record<string, unknown>),
			description: m.operation,
			...(m.mockStateId
				? {
						mockStateId: m.mockStateId,
						mockProfile: m.mockProfile,
						query: m.mockQuery,
					}
				: {}),
		},
	}));
}

/**
 * 主函数：发现 matrix 测试用例
 */
export function discoverMatrixDocCases(domain: string): CaseEntry[] {
	const docPath = getMatrixDocPath();
	if (!docPath || !fs.existsSync(docPath)) return [];

	const content = fs.readFileSync(docPath, "utf-8");
	const matrix = parseMatrixTable(content);

	return convertToCaseEntry(matrix, domain);
}
