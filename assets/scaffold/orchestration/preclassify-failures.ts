/**
 * Rule-based failure preclassification (local, ms–s). Writes diagnosis.json.
 * Does not spawn LLM. Agent deep-dives only unknown / L2.
 */
import fs from "node:fs";
import path from "node:path";
import { sandboxDir } from "./paths";
import { CASES_EXECUTED_FILE } from "./constants";

export type DiagnosisLayer = "L0" | "L1" | "L2";

export interface DiagnosisItem {
	caseId: string;
	layer: DiagnosisLayer;
	rootCause:
		| "L0_native"
		| "L0_auth"
		| "L1_hybrid"
		| "L1_spec_invalid"
		| "L2_biz"
		| "unknown";
	evidence: string[];
	suggestion: string;
	errorSnippet?: string;
}

export interface DiagnosisReport {
	runId: string;
	at: string;
	items: DiagnosisItem[];
}

interface ExecutedLine {
	caseId?: string;
	status?: string;
	error?: string;
	errorStack?: string;
}

const SUGGESTIONS: Record<DiagnosisItem["rootCause"], string> = {
	L0_native: "检查 adb/USB、Appium session、OEM 弹窗；必要时重连设备后续跑",
	L0_auth: "本机 export E2E_ACCOUNT/E2E_PASSWORD 后 ensureLoggedIn；禁止 mock 绕过鉴权",
	L1_hybrid: "核对 E2E_PAGE_ORIGIN、WEBVIEW startsWith、chromedriver；见 hybrid-contract",
	L1_spec_invalid: "生成器输出了 UiAutomator2 不支持的选择器；检查 GENERATOR_VERSION 是否过期并 regen spec",
	L2_biz: "核对 fixture/mock、data-e2e 断言与矩阵 expected；只记录业务缺陷不改代码",
	unknown: "读截图 + logcat + failure-triage 人工分诊",
};

function classifyError(text: string): Pick<DiagnosisItem, "layer" | "rootCause"> {
	const t = text.toLowerCase();
	if (
		/session not created|uiautomator|adbd|adb |instrumentation|device offline|cannot start the appium|econnrefused.*4723/.test(
			t,
		)
	) {
		return { layer: "L0", rootCause: "L0_native" };
	}
	if (/auth|login|401|unauthorized|凭据|password|e2e_account/.test(t)) {
		return { layer: "L0", rootCause: "L0_auth" };
	}
	if (
		/webview|chromedriver|context|page_origin|host mismatch|deeplink|no such context|switchcontext/.test(
			t,
		)
	) {
		return { layer: "L1", rootCause: "L1_hybrid" };
	}
	// Selector syntax errors are infrastructure (spec generation) defects, not business logic
	if (/invalid selector|unsupported css selector|malformed selector|failed to execute 'queryselector'/.test(t)) {
		return { layer: "L1", rootCause: "L1_spec_invalid" };
	}
	// L2_biz: require business-assertion context, not bare selector/element keywords
	if (/expect\s*\(|assert\.|data-e2e=.*expect|timeoutmsg|auto-spec|提交按钮/.test(t)) {
		return { layer: "L2", rootCause: "L2_biz" };
	}
	return { layer: "L2", rootCause: "unknown" };
}

function readFailedCases(runId: string): ExecutedLine[] {
	const file = path.join(sandboxDir(), "artifacts", "runs", runId, CASES_EXECUTED_FILE);
	if (!fs.existsSync(file)) return [];
	const out: ExecutedLine[] = [];
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as ExecutedLine;
			if (row.status && /fail|error|timeout/i.test(row.status)) out.push(row);
		} catch {
			/* skip */
		}
	}
	return out;
}

function readLogcatTail(runId: string, caseId: string): string {
	const logsDir = path.join(sandboxDir(), "artifacts", "runs", runId, "logs");
	if (!fs.existsSync(logsDir)) return "";
	const safe = caseId.replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
	const candidates = [
		path.join(logsDir, `${safe}.log`),
		path.join(logsDir, "logcat.txt"),
		path.join(logsDir, "wdio-output.log"),
	];
	for (const f of candidates) {
		if (!fs.existsSync(f)) continue;
		try {
			const raw = fs.readFileSync(f, "utf-8");
			return raw.slice(-2000);
		} catch {
			/* skip */
		}
	}
	return "";
}

/** Preclassify failures and write artifacts/runs/<runId>/diagnosis.json */
export function preclassifyFailures(runId: string, failedCaseIds?: string[]): DiagnosisReport {
	const executed = readFailedCases(runId);
	const idFilter = failedCaseIds && failedCaseIds.length > 0 ? new Set(failedCaseIds) : null;
	const items: DiagnosisItem[] = [];

	const rows: ExecutedLine[] =
		executed.length > 0
			? executed
			: (failedCaseIds || []).map((caseId) => ({
					caseId,
					status: "failed",
					error: "",
				}));

	for (const row of rows) {
		const caseId = row.caseId || "unknown";
		if (idFilter && !idFilter.has(caseId)) continue;
		const err = `${row.error || ""}\n${row.errorStack || ""}\n${readLogcatTail(runId, caseId)}`;
		const { layer, rootCause } = classifyError(err);
		const evidence: string[] = [];
		const ssDir = path.join(sandboxDir(), "artifacts", "runs", runId, "screenshots");
		if (fs.existsSync(ssDir)) {
			const safe = caseId.replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
			const hit = fs.readdirSync(ssDir).find((n) => n.includes(safe) || n.startsWith(safe.slice(0, 20)));
			if (hit) evidence.push(path.join(ssDir, hit));
		}
		evidence.push(path.join(sandboxDir(), "artifacts", "runs", runId, CASES_EXECUTED_FILE));
		items.push({
			caseId,
			layer,
			rootCause,
			evidence,
			suggestion: SUGGESTIONS[rootCause],
			errorSnippet: (row.error || "").slice(0, 500),
		});
	}

	const report: DiagnosisReport = {
		runId,
		at: new Date().toISOString(),
		items,
	};
	const outDir = path.join(sandboxDir(), "artifacts", "runs", runId);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "diagnosis.json"), JSON.stringify(report, null, 2), "utf-8");
	console.log(`[preclassify] wrote diagnosis.json (${items.length} item(s))`);
	return report;
}

export function loadDiagnosis(runId: string): DiagnosisReport | null {
	const f = path.join(sandboxDir(), "artifacts", "runs", runId, "diagnosis.json");
	if (!fs.existsSync(f)) return null;
	try {
		return JSON.parse(fs.readFileSync(f, "utf-8")) as DiagnosisReport;
	} catch {
		return null;
	}
}
