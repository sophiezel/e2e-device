import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";
import { loadProjectManifest } from "../config/project-manifest";
import type { CaseEntry } from "./discover-cases";

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
}

/**
 * 从 skill.project.json 读取 guaziFlow 路径
 */
export function getGuaziFlowPath(): string | null {
	const manifest = loadProjectManifest();
	if (manifest?.docs?.guaziFlow) {
		return path.join(repoRoot(), manifest.docs.guaziFlow);
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
 * 转换为 CaseEntry
 */
export function convertToCaseEntry(
	matrix: MatrixCase[],
	domain: string,
): CaseEntry[] {
	return matrix.map((m) => ({
		id: `${domain}.${m.caseId}`,
		spec: `e2e-device/specs/${domain}.${m.caseId}.spec.ts`,
		tags: ["guazi-flow", m.source.toLowerCase()],
		source: "guazi-flow",
		metadata: {
			...m as unknown as Record<string, unknown>,
			description: m.operation,  // 中文描述
		},
	}));
}

/**
 * 主函数：发现 guazi-flow 测试用例
 */
export function discoverGuaziFlowCases(domain: string): CaseEntry[] {
	const docPath = getGuaziFlowPath();
	if (!docPath || !fs.existsSync(docPath)) return [];

	const content = fs.readFileSync(docPath, "utf-8");
	const matrix = parseMatrixTable(content);

	return convertToCaseEntry(matrix, domain);
}
