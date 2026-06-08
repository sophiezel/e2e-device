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

export interface CaseRecord {
	caseId: string;
	spec: string;
	title: string;
	outcome: "passed" | "failed" | "blocked" | "skipped" | "error";
	duration?: number;
	error?: string;
	rootCause?: string;
	mockUsed?: boolean;
	issues: Issue[];
	autoFixes: AutoFix[];
	pendingItems: string[];
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
