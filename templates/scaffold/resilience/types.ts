export type FixtureProfile = "pendingList" | "detail" | "default";

// ===== Diagnostic Types =====

/** JS error captured from WebView during test execution. */
export interface JsError {
	message: string;
	source: string;
	lineno: number;
	colno: number;
	timestamp: number;
}

/** JSBridge call event captured from WebView. */
export interface BridgeEvent {
	direction: "native_to_h5" | "h5_to_native";
	method: string;
	data?: unknown;
	timestamp: number;
}

/** Network event captured during test for diagnostic purposes. */
export interface NetworkEvent {
	url?: string;
	statusCode?: number;
	bodyPreview?: string;
}

/** Snapshot taken by resilience layer for diagnosis and classification. */
export interface DiagnosticSnapshot {
	url?: string;
	pageSource?: string;
	toastMessages?: string[];
	networkEvents?: NetworkEvent[];
	/** JS errors captured from WebView console / runtime. */
	jsErrors?: JsError[];
	/** JSBridge call events captured during test. */
	bridgeEvents?: BridgeEvent[];
	/** WebView performance metrics (FCP, LCP, etc.) in milliseconds. */
	performance?: {
		fcp?: number;
		lcp?: number;
		domInteractive?: number;
	};
	/** Android device vendor info for compatibility tracking. */
	vendorInfo?: {
		manufacturer: string;
		model: string;
		androidVersion: string;
		webViewPackage?: string;
		webViewVersion?: string;
	};
	[index: string]: unknown;
}

// ===== Resilience Types =====

export interface Issue {
	caseId: string;
	rootCause: string;
	message: string;
	apiPath?: string;
}

export interface AutoFix {
	file: string;
	summary: string;
}

// ===== Device Edge 诊断类型 (NEW) =====

/** 问题栈 — 单次失败的完整诊断信息 */
export interface ProblemStack {
	timestamp: string;
	errorType: string;
	errorMessage: string;
	callStack?: string;
	screenshotPath?: string;
	domSnapshot?: string;
	networkLog?: NetworkEvent[];
	extra?: Record<string, unknown>;
}

/** 复现路径 — 用户可按此精确复现问题 */
export interface ReproductionPath {
	deviceModel: string;
	osVersion: string;
	webViewVersion?: string;
	networkCondition: string;
	stepsToReproduce: string[];
	probability: string;
	extra?: Record<string, unknown>;
}

/** 修复建议 — 每个问题至少附带一条可操作建议 */
export interface SuggestedFix {
	caseId: string;
	approaches: string[];
	risk: "low" | "medium" | "high" | "unknown";
	estimatedEffort: string;
	references: string[];
}

export interface CaseRecord {
	caseId: string;
	spec: string;
	title: string;
	outcome: "passed" | "failed" | "blocked" | "skipped" | "error" | "recorded_failure";
	duration?: number;
	error?: string;
	rootCause?: string;
	mockUsed?: boolean;
	issues: Issue[];
	autoFixes: AutoFix[];
	pendingItems: string[];
	// 新增：诊断信息
	problemStacks?: ProblemStack[];
	reproductionPath?: ReproductionPath;
	suggestedFixes?: SuggestedFix[];
}

export interface ResilienceRunSummary {
	runId: string;
	startedAt?: string;
	finishedAt?: string;
	totalCases: number;
	passed: number;
	passedLive: number;
	passedWithMock: number;
	passedAfterAutofix: number;
	failed: number;
	degradedFailures: number;
	blockedAuth: number;
	skipped: number;
	errors: number;
	autoFixCount: number;
	cases: CaseRecord[];
}
