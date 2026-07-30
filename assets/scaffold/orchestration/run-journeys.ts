import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxDir, repoRoot } from "./paths";
import {
	CASES_EXECUTED_FILE,
	QUICK_BUDGET_MS,
	STANDARD_BUDGET_MS,
	BUDGET_SKIP_RATIO,
	JOURNEY_SEGMENT_TIMEOUT_MS,
} from "./constants";
import { generateJourneyPlan, type JourneyPlan, type JourneyPlanSegment } from "./generate-journey-plan";
import { finalizeCoverage } from "./coverage";
import { preclassifyFailures } from "./preclassify-failures";
import { writeDurationFeedback } from "./duration-feedback";
import type { RunProfile } from "../config/run-profile";

export interface JourneyRunResult {
	segment: string;
	specPath: string;
	exitCode: number;
	wallMs: number;
	caseCount: number;
	skipped?: boolean;
	timedOut?: boolean;
}

export interface JourneyRunSummary {
	runId: string;
	plan: JourneyPlan;
	results: JourneyRunResult[];
	totalWallMs: number;
	status: "passed" | "partial" | "failed";
	budgetSkippedSegments?: string[];
}

function profileBudgetMs(profile: RunProfile): number {
	if (profile === "quick") return QUICK_BUDGET_MS;
	if (profile === "standard") return STANDARD_BUDGET_MS;
	return 0;
}

/** Segments that may be skipped when wall budget is nearly exhausted (never skip env/list/form). */
function isSkippableUnderBudget(segment: string): boolean {
	return segment === "infra" || segment === "chaos";
}

function journeyMetaPath(runId: string): string {
	return path.join(sandboxDir(), "artifacts", "runs", runId, "journey-meta.json");
}

/** After a failed segment: probe Appium and close stale sessions (success path skips). */
function healAppiumIfNeeded(segmentFailed: boolean): void {
	if (!segmentFailed) return;
	const port = process.env.E2E_APPIUM_PORT || "4723";
	try {
		const status = spawnSync(
			"curl",
			["-s", "--connect-timeout", "3", "--max-time", "5", `http://127.0.0.1:${port}/status`],
			{ encoding: "utf-8" },
		);
		if (status.status !== 0) {
			console.warn("[journey] Appium /status unreachable after failed segment — next segment will recreate");
			return;
		}
		const sessionsRaw = spawnSync(
			"curl",
			["-s", "--connect-timeout", "3", "--max-time", "5", `http://127.0.0.1:${port}/wd/hub/sessions`],
			{ encoding: "utf-8" },
		);
		const body = sessionsRaw.stdout || "";
		const ids = (() => {
			try {
				const d = JSON.parse(body) as { value?: Array<{ id?: string }> };
				return (d.value || []).map((s) => s.id).filter(Boolean) as string[];
			} catch {
				return [] as string[];
			}
		})();
		for (const sid of ids) {
			spawnSync(
				"curl",
				["-s", "-X", "DELETE", "--max-time", "8", `http://127.0.0.1:${port}/wd/hub/session/${sid}`],
				{ encoding: "utf-8" },
			);
			console.log(`[journey] closed stale session ${sid} before next segment`);
		}
	} catch (e) {
		console.warn("[journey] healAppiumIfNeeded:", (e as Error).message);
	}
}

function resolveWdioBin(): string {
	const skillRoot =
		process.env.E2E_DEVICE_SKILL_ROOT ||
		path.join(process.env.HOME || "", ".agents", "skills", "e2e-device");
	for (const root of [sandboxDir(), skillRoot, repoRoot()]) {
		const bin = path.join(root, "node_modules", ".bin", "wdio");
		if (fs.existsSync(bin)) return bin;
	}
	return "wdio";
}

function executeJourneySegment(
	segment: JourneyPlanSegment,
	runId: string,
	domain: string,
): JourneyRunResult {
	const sb = sandboxDir();
	const wdioConf = path.join(sb, "wdio.conf.ts");
	const start = Date.now();

	const env: NodeJS.ProcessEnv = {
		...process.env,
		E2E_RUN_ID: runId,
		E2E_JOURNEY_SEGMENT: segment.segment,
		E2E_JOURNEY_SPEC: segment.specPath,
		E2E_DOMAIN: domain,
		E2E_CONTINUE_ON_FAILURE: "1",
		E2E_CURRENT_SPEC: segment.specPath,
	};

	if (
		segment.segment === "form" ||
		segment.segment.startsWith("form_") ||
		segment.segment === "list"
	) {
		env.E2E_WARM_SESSION = "1";
		// Default 20: fewer mid-segment reloadSession costs under standard 25min budget
		env.E2E_SESSION_RESET_INTERVAL = process.env.E2E_SESSION_RESET_INTERVAL || "20";
	}

	if (segment.segment === "form" || segment.segment.startsWith("form_")) {
		try {
			const manifestPath = path.join(sb, "skill.project.json");
			if (fs.existsSync(manifestPath)) {
				const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
					pilot?: { relatedRoutes?: Record<string, string> };
				};
				const formModule = m.pilot?.relatedRoutes?.form;
				if (formModule) env.E2E_FORM_MODULE = formModule;
			}
		} catch { /* optional */ }
	}

	if (segment.segment === "infra" || segment.segment === "chaos") {
		env.E2E_JOURNEY_FORCE_ENTRY = "1";
	}

	console.log(
		`\n[journey] ▶ ${segment.segment} (${segment.caseCount} cases) → ${path.basename(segment.specPath)}`,
	);

	const wdio = resolveWdioBin();
	const segmentTimeout =
		parseInt(process.env.E2E_JOURNEY_SEGMENT_TIMEOUT_MS || "", 10) ||
		JOURNEY_SEGMENT_TIMEOUT_MS;
	const result = spawnSync(
		wdio,
		["run", wdioConf, "--spec", segment.specPath],
		{
			cwd: sb,
			stdio: "inherit",
			env,
			timeout: segmentTimeout,
		},
	);

	const wallMs = Date.now() - start;
	const timedOut = result.error?.message?.includes("ETIMEDOUT") || result.signal === "SIGTERM";
	const exitCode = timedOut ? 1 : (result.status ?? 1);
	console.log(
		`[journey] ◼ ${segment.segment} exit=${exitCode} wall=${(wallMs / 1000).toFixed(1)}s` +
			(timedOut ? " TIMED_OUT" : ""),
	);

	return {
		segment: segment.segment,
		specPath: segment.specPath,
		exitCode,
		wallMs,
		caseCount: segment.caseCount,
		timedOut: !!timedOut,
	};
}

/** Run all journey segments serially (1 session per segment). */
export function runJourneySegments(runId: string, opts?: {
	domain?: string;
	profile?: RunProfile;
}): JourneyRunSummary {
	const plan = generateJourneyPlan(opts);
	const profile = opts?.profile || (process.env.E2E_RUN_PROFILE as RunProfile) || "standard";
	const budgetMs = profileBudgetMs(profile);
	const results: JourneyRunResult[] = [];
	const runStart = Date.now();
	let failures = 0;
	const budgetSkippedSegments: string[] = [];
	const timingPath = path.join(
		sandboxDir(),
		"artifacts",
		"runs",
		runId,
		"segment-timing.jsonl",
	);
	fs.mkdirSync(path.dirname(timingPath), { recursive: true });

	for (const segment of plan.segments) {
		const elapsed = Date.now() - runStart;
		if (
			budgetMs > 0 &&
			elapsed >= budgetMs * BUDGET_SKIP_RATIO &&
			isSkippableUnderBudget(segment.segment)
		) {
			console.warn(
				`[journey] BUDGET_SKIP segment=${segment.segment} elapsed=${(elapsed / 1000).toFixed(1)}s ` +
					`budget=${(budgetMs / 1000).toFixed(0)}s (${BUDGET_SKIP_RATIO * 100}% gate)`,
			);
			budgetSkippedSegments.push(segment.segment);
			const skipped: JourneyRunResult = {
				segment: segment.segment,
				specPath: segment.specPath,
				exitCode: 0,
				wallMs: 0,
				caseCount: segment.caseCount,
				skipped: true,
			};
			results.push(skipped);
			fs.appendFileSync(
				timingPath,
				JSON.stringify({
					segment: segment.segment,
					skipped: true,
					elapsedMs: elapsed,
					budgetMs,
					at: new Date().toISOString(),
				}) + "\n",
			);
			continue;
		}

		const r = executeJourneySegment(segment, runId, plan.domain);
		results.push(r);
		fs.appendFileSync(
			timingPath,
			JSON.stringify({
				segment: r.segment,
				wallMs: r.wallMs,
				exitCode: r.exitCode,
				caseCount: r.caseCount,
				timedOut: !!r.timedOut,
				budgetRemainingMs: budgetMs > 0 ? Math.max(0, budgetMs - (Date.now() - runStart)) : null,
				at: new Date().toISOString(),
			}) + "\n",
		);
		if (r.exitCode !== 0) failures++;
		healAppiumIfNeeded(r.exitCode !== 0);
	}

	const totalWallMs = Date.now() - runStart;
	const summary: JourneyRunSummary = {
		runId,
		plan,
		results,
		totalWallMs,
		status: failures === 0 ? "passed" : failures < results.length ? "partial" : "failed",
		budgetSkippedSegments: budgetSkippedSegments.length ? budgetSkippedSegments : undefined,
	};

	fs.mkdirSync(path.dirname(journeyMetaPath(runId)), { recursive: true });
	fs.writeFileSync(journeyMetaPath(runId), JSON.stringify(summary, null, 2), "utf-8");

	try {
		finalizeCoverage(runId);
		console.log("[journey] finalize-coverage complete");
	} catch (e) {
		console.warn("[journey] finalize-coverage skipped:", (e as Error).message);
	}

	try {
		const fb = writeDurationFeedback(runId);
		if (fb) console.log("[journey] duration-feedback:", fb);
	} catch (e) {
		console.warn("[journey] duration-feedback skipped:", (e as Error).message);
	}

	if (failures > 0) {
		writeDiagnoseRequest(runId, results);
		try {
			preclassifyFailures(runId);
		} catch (e) {
			console.warn("[journey] preclassify skipped:", (e as Error).message);
		}
	}

	console.log(
		`\n[journey] Done: ${plan.segments.length} session(s), ${plan.totalCases} case(s), ` +
			`wall=${(totalWallMs / 1000).toFixed(1)}s, status=${summary.status}`,
	);

	return summary;
}

/** Write diagnose-request.json for Agent failure-triage (does not spawn LLM). */
function writeDiagnoseRequest(runId: string, results: JourneyRunResult[]): void {
	const failedSegments = results.filter((r) => r.exitCode !== 0).map((r) => r.segment);
	const artifactsDir = path.join(sandboxDir(), "artifacts", "runs", runId);
	const payload = {
		runId,
		failedSegments,
		failedCaseIds: collectFailedCaseIds(runId),
		artifactsDir,
		protocol: "agent-must-read-failure-triage",
	};
	fs.mkdirSync(artifactsDir, { recursive: true });
	const diagFile = path.join(artifactsDir, "diagnose-request.json");
	fs.writeFileSync(diagFile, JSON.stringify(payload, null, 2), "utf-8");
	console.log(`[journey] Diagnose request written: ${diagFile}`);
	console.log("[journey] Agent MUST load references/failure-triage.md");
}

function collectFailedCaseIds(runId: string): string[] {
	const file = path.join(sandboxDir(), "artifacts", "runs", runId, CASES_EXECUTED_FILE);
	if (!fs.existsSync(file)) return [];
	const ids: string[] = [];
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as { caseId?: string; status?: string; outcome?: string };
			const st = row.outcome || row.status || "";
			if (row.caseId && st && /fail|error|timeout/i.test(st)) {
				ids.push(row.caseId);
			}
		} catch { /* skip */ }
	}
	return ids;
}

/** Read journey timing meta for report generation. */
export function loadJourneyMeta(runId: string): JourneyRunSummary | null {
	const p = journeyMetaPath(runId);
	if (!fs.existsSync(p)) return null;
	try {
		return JSON.parse(fs.readFileSync(p, "utf-8")) as JourneyRunSummary;
	} catch {
		return null;
	}
}

/** Sum resetMs from cases-executed.jsonl for a segment. */
export function sumResetMsForSegment(runId: string, segment: string): number {
	const file = path.join(sandboxDir(), "artifacts", "runs", runId, CASES_EXECUTED_FILE);
	if (!fs.existsSync(file)) return 0;
	let sum = 0;
	for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as { journeySegment?: string; resetMs?: number };
			if (row.journeySegment === segment && row.resetMs) sum += row.resetMs;
		} catch { /* skip */ }
	}
	return sum;
}
