/**
 * Persist per-case wall durations so present-test-plan can use P50 estimates.
 */
import fs from "node:fs";
import path from "node:path";
import { projectCacheDir, repoRoot, sandboxDir } from "./paths";
import { CASES_EXECUTED_FILE } from "./constants";

export interface DurationStatsFile {
	updatedAt: string;
	cases: Record<string, { samples: number[]; p50: number }>;
}

function percentile50(samples: number[]): number {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
	}
	return sorted[mid];
}

/** Read cases-executed.jsonl and merge duration samples into project duration-stats.json. */
export function writeDurationFeedback(runId: string): string | null {
	const executed = path.join(sandboxDir(), "artifacts", "runs", runId, CASES_EXECUTED_FILE);
	if (!fs.existsSync(executed)) return null;

	const byCase = new Map<string, number[]>();
	for (const line of fs.readFileSync(executed, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as {
				caseId?: string;
				durationMs?: number;
				outcome?: string;
				status?: string;
			};
			if (!row.caseId || !row.durationMs || row.durationMs <= 0) continue;
			const st = row.outcome || row.status || "";
			if (st && /fail|error|timeout|skip/i.test(st)) continue;
			const arr = byCase.get(row.caseId) || [];
			arr.push(row.durationMs);
			byCase.set(row.caseId, arr);
		} catch {
			/* skip */
		}
	}

	if (byCase.size === 0) return null;

	const statsPath = path.join(projectCacheDir(repoRoot()), "duration-stats.json");
	fs.mkdirSync(path.dirname(statsPath), { recursive: true });

	let prev: DurationStatsFile = { updatedAt: "", cases: {} };
	if (fs.existsSync(statsPath)) {
		try {
			prev = JSON.parse(fs.readFileSync(statsPath, "utf-8")) as DurationStatsFile;
		} catch {
			prev = { updatedAt: "", cases: {} };
		}
	}

	const next: DurationStatsFile = {
		updatedAt: new Date().toISOString(),
		cases: { ...prev.cases },
	};

	for (const [caseId, samples] of byCase) {
		const existing = next.cases[caseId]?.samples || [];
		const merged = [...existing, ...samples].slice(-40);
		next.cases[caseId] = { samples: merged, p50: percentile50(merged) };
	}

	fs.writeFileSync(statsPath, JSON.stringify(next, null, 2), "utf-8");

	const feedbackPath = path.join(
		sandboxDir(),
		"artifacts",
		"runs",
		runId,
		"duration-feedback.json",
	);
	fs.writeFileSync(
		feedbackPath,
		JSON.stringify(
			{
				runId,
				updatedCases: [...byCase.keys()],
				statsPath,
				at: next.updatedAt,
			},
			null,
			2,
		),
		"utf-8",
	);
	return feedbackPath;
}
