import { execSync } from "node:child_process";
import { repoRoot } from "./paths";
import type { CaseEntry } from "./discover-cases";

export interface CrossValidationResult {
	totalChanges: number;
	coveredChanges: number;
	coverage: number;
	gaps: string[];
}

/**
 * 获取 git diff 变更的文件
 */
function getChangedFiles(): string[] {
	const bases = ["origin/main", "origin/master", "main", "master"];

	for (const base of bases) {
		try {
			const out = execSync(`git diff --name-only ${base}...HEAD`, {
				cwd: repoRoot(),
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			const files = out.split("\n").filter(Boolean);
			if (files.length > 0) return files;
		} catch {
			// try next base
		}
	}

	return [];
}

/**
 * 交叉验证：检查测试用例是否覆盖了变更的代码
 */
export function crossValidate(cases: CaseEntry[]): CrossValidationResult {
	const changedFiles = getChangedFiles();
	const totalChanges = changedFiles.length;

	if (totalChanges === 0) {
		return { totalChanges: 0, coveredChanges: 0, coverage: 100, gaps: [] };
	}

	const coveredFiles = new Set<string>();
	const gaps: string[] = [];

	for (const file of changedFiles) {
		// 检查是否有测试用例覆盖了这个文件
		const isCovered = cases.some(
			(c) =>
				c.spec.includes(file.replace(/\.[^.]+$/, "")) ||
				file.includes(c.id.split(".")[0]) ||
				c.tags.some((tag) => file.includes(tag)),
		);

		if (isCovered) {
			coveredFiles.add(file);
		} else {
			gaps.push(file);
		}
	}

	return {
		totalChanges,
		coveredChanges: coveredFiles.size,
		coverage: (coveredFiles.size / totalChanges) * 100,
		gaps,
	};
}
