export type FixtureProfile = "pendingList" | "detail" | "default";

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
