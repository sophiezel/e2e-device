import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxDir, repoRoot } from "./paths";
import { CASES_EXECUTED_FILE } from "./constants";
import { generateJourneyPlan, type JourneyPlan, type JourneyPlanSegment } from "./generate-journey-plan";
import { finalizeCoverage } from "./coverage";
import type { RunProfile } from "../config/run-profile";

export interface JourneyRunResult {
	segment: string;
	specPath: string;
	exitCode: number;
	wallMs: number;
	caseCount: number;
}

export interface JourneyRunSummary {
	runId: string;
	plan: JourneyPlan;
	results: JourneyRunResult[];
	totalWallMs: number;
	status: "passed" | "partial" | "failed";
}

function journeyMetaPath(runId: string): string {
	return path.join(sandboxDir(), "artifacts", "runs", runId, "journey-meta.json");
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

	if (segment.segment === "form" || segment.segment === "list") {
		env.E2E_WARM_SESSION = "1";
		env.E2E_SESSION_RESET_INTERVAL = process.env.E2E_SESSION_RESET_INTERVAL || "12";
	}

	if (segment.segment === "form") {
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
	const result = spawnSync(
		wdio,
		["run", wdioConf, "--spec", segment.specPath],
		{
			cwd: sb,
			stdio: "inherit",
			env,
		},
	);

	const wallMs = Date.now() - start;
	const exitCode = result.status ?? 1;
	console.log(
		`[journey] ◼ ${segment.segment} exit=${exitCode} wall=${(wallMs / 1000).toFixed(1)}s`,
	);

	return {
		segment: segment.segment,
		specPath: segment.specPath,
		exitCode,
		wallMs,
		caseCount: segment.caseCount,
	};
}

/** Run all journey segments serially (1 session per segment). */
export function runJourneySegments(runId: string, opts?: {
	domain?: string;
	profile?: RunProfile;
}): JourneyRunSummary {
	const plan = generateJourneyPlan(opts);
	const results: JourneyRunResult[] = [];
	const runStart = Date.now();
	let failures = 0;

	for (const segment of plan.segments) {
		const r = executeJourneySegment(segment, runId, plan.domain);
		results.push(r);
		if (r.exitCode !== 0) failures++;
	}

	const totalWallMs = Date.now() - runStart;
	const summary: JourneyRunSummary = {
		runId,
		plan,
		results,
		totalWallMs,
		status: failures === 0 ? "passed" : failures < results.length ? "partial" : "failed",
	};

	fs.mkdirSync(path.dirname(journeyMetaPath(runId)), { recursive: true });
	fs.writeFileSync(journeyMetaPath(runId), JSON.stringify(summary, null, 2), "utf-8");

	try {
		finalizeCoverage(runId);
		console.log("[journey] finalize-coverage complete");
	} catch (e) {
		console.warn("[journey] finalize-coverage skipped:", (e as Error).message);
	}

	console.log(
		`\n[journey] Done: ${plan.segments.length} session(s), ${plan.totalCases} case(s), ` +
			`wall=${(totalWallMs / 1000).toFixed(1)}s, status=${summary.status}`,
	);

	return summary;
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
