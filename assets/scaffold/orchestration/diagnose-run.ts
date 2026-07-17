import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import { paths, sandboxDir, runsRoot, runDir } from "./paths";

export interface DiagnoseRunResult {
	summaryZh: string;
	rootCauseCounts: Record<string, number>;
	recommendations: string[];
	blockers: string[];
}

export function diagnoseRun(): DiagnoseRunResult {
	const sb = sandboxDir();
	const reportPath = path.join(sb, "resilience-report.json");
	const authPath = paths.authRecovery();

	const rootCauseCounts: Record<string, number> = {};
	const recommendations: string[] = [];
	const blockers: string[] = [];

	if (fs.existsSync(authPath)) {
		blockers.push("AUTH_RECOVERY");
		recommendations.push(
			"读取 auth-recovery.json；引导用户在本机终端 export E2E_ACCOUNT/E2E_PASSWORD（禁止贴进对话），ensureLoggedIn 后用 scripts/run.sh 续跑失败 case",
		);
	}

	let manifest;
	try {
		manifest = loadProjectManifest();
	} catch {
		manifest = undefined;
	}

	if (!process.env.E2E_PAGE_ORIGIN && !process.env.E2E_H5_ORIGIN && !manifest?.hybrid?.network?.pageOrigin) {
		blockers.push("PAGE_ORIGIN_UNKNOWN");
		recommendations.push(
			"先配置 E2E_PAGE_ORIGIN 或运行 discover-project，再跑 DeepLink（优先于 mock/造数）",
		);
	}

	if (fs.existsSync(reportPath)) {
		try {
			const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
				rootCauseCounts?: Record<string, number>;
				pending?: Array<{ rootCause?: string }>;
			};
			Object.assign(rootCauseCounts, report.rootCauseCounts || {});
			for (const item of report.pending || []) {
				if (item.rootCause) {
					rootCauseCounts[item.rootCause] = (rootCauseCounts[item.rootCause] || 0) + 1;
				}
			}
		} catch {
			recommendations.push("resilience-report.json 解析失败，改读 cases-executed.jsonl");
		}
	}

	const diagRequest = findDiagnoseRequest();
	if (diagRequest) {
		recommendations.push(
			`发现 diagnose-request.json（runId=${diagRequest.runId}）：Agent MUST 加载 references/failure-triage.md，按 L0→L1→L2 读截图/logcat 后输出诊断摘要`,
		);
	}

	if (recommendations.length === 0) {
		recommendations.push("无明确 blockers；检查 journey-meta.json 与 cases-executed.jsonl");
	}

	const summaryZh =
		blockers.length > 0
			? `诊断完成：阻断 ${blockers.join(", ")}`
			: `诊断完成：根因分布 ${JSON.stringify(rootCauseCounts)}`;

	return { summaryZh, rootCauseCounts, recommendations, blockers };
}

function findDiagnoseRequest(): { runId: string } | null {
	try {
		const current = process.env.E2E_RUN_ID;
		if (current) {
			const f = path.join(runDir(current), "diagnose-request.json");
			if (fs.existsSync(f)) return { runId: current };
		}
		const runsDir = runsRoot();
		if (!fs.existsSync(runsDir)) return null;
		const runs = fs.readdirSync(runsDir).sort().reverse();
		for (const runId of runs) {
			const f = path.join(runsDir, runId, "diagnose-request.json");
			if (fs.existsSync(f)) {
				return { runId };
			}
		}
	} catch {
		// ignore
	}
	return null;
}
