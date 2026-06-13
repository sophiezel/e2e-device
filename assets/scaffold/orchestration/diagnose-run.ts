import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import { paths, artifactsRoot } from "./paths";

export interface DiagnoseRunResult {
	summaryZh: string;
	rootCauseCounts: Record<string, number>;
	recommendations: string[];
	blockers: string[];
}

export function diagnoseRun(): DiagnoseRunResult {
	const sandboxArtifacts = path.join(artifactsRoot(), "..", ".."); // up to sandbox root
	const reportPath = path.join(sandboxArtifacts, "resilience-report.json");
	const authPath = paths.authRecovery();

	const rootCauseCounts: Record<string, number> = {};
	const recommendations: string[] = [];
	const blockers: string[] = [];

	if (fs.existsSync(authPath)) {
		blockers.push("AUTH_RECOVERY");
		recommendations.push(
			"读取 auth-recovery.json，向用户询问 E2E_ACCOUNT/E2E_PASSWORD（仅写入 env），ensureLoggedIn 后使用 init.sh --sequential 重跑失败 case",
		);
	}

	let manifest;
	try {
		manifest = loadProjectManifest();
	} catch {
		recommendations.push("运行 bash e2e-device/scripts/init.sh --plan-only");
	}

	if (!process.env.E2E_H5_ORIGIN && !manifest?.hybrid.network.pageOrigin) {
		blockers.push("PAGE_ORIGIN_UNKNOWN");
		recommendations.push(
			"先配置 E2E_H5_ORIGIN 或运行 discover-project，再跑 DeepLink（优先于 mock/造数）",
		);
	}

	if (fs.existsSync(reportPath)) {
		const report = JSON.parse(
			fs.readFileSync(reportPath, "utf-8"),
		) as {
			cases?: Array<{ rootCause?: string; outcome?: string; message?: string }>;
		};
		for (const c of report.cases || []) {
			const rc = c.rootCause || "unknown";
			rootCauseCounts[rc] = (rootCauseCounts[rc] || 0) + 1;
			if (c.outcome === "blocked_auth") {
				blockers.push("AUTH_RECOVERY");
			}
		}
		if ((rootCauseCounts.authRequired || 0) > 0) {
			recommendations.push(
				"authRequired：不要启用 inject mock；处理登录后重试",
			);
		}
		if ((rootCauseCounts.paramError || 0) > 0 && blockers.includes("PAGE_ORIGIN_UNKNOWN")) {
			recommendations.unshift(
				"page host / origin 问题须先于 paramError / mock 处理",
			);
		}
	}

	const ledger = path.join(sandboxArtifacts, "resilience-ledger.jsonl");
	if (fs.existsSync(ledger)) {
		for (const line of fs.readFileSync(ledger, "utf-8").split("\n")) {
			if (!line.trim()) {
				continue;
			}
			try {
				const row = JSON.parse(line) as { rootCause?: string };
				const rc = row.rootCause || "unknown";
				rootCauseCounts[rc] = (rootCauseCounts[rc] || 0) + 1;
			} catch {
				// skip
			}
		}
	}

	const parts = Object.entries(rootCauseCounts).map(([k, v]) => `${k}:${v}`);
	const summaryZh =
		parts.length > 0
			? `根因统计 ${parts.join(", ")}`
			: "无 resilience-report，请先跑测";

	return {
		summaryZh,
		rootCauseCounts,
		recommendations: [...new Set(recommendations)],
		blockers: [...new Set(blockers)],
	};
}
