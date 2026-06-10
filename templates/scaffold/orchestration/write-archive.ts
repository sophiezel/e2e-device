import fs from "node:fs";
import path from "node:path";
import { artifactsRoot, e2eDeviceRoot, runDir } from "./paths";
import { RUN_ID_FILE, ARCHIVE_JSON, ARCHIVE_MD } from "./constants";
import type { CoverageSummary, IncrementalCoverage } from "./coverage";

export interface ArchiveIssue {
	id: string;
	severity: string;
	title: string;
	repro: string;
	cause: string;
	autoFixAttempted: boolean;
	autoFixResult?: string;
	resolved: boolean;
}

export interface RunArchive {
	runId: string;
	startedAt: string;
	finishedAt?: string;
	status: "running" | "passed" | "failed" | "partial";
	sections: {
		plan: Record<string, unknown>;
		execution: Record<string, unknown>;
		resilience: Record<string, unknown>;
		issues: ArchiveIssue[];
		artifacts: string[];
		hybridEvidence: Record<string, unknown>;
		coverage?: CoverageSummary;
		incrementalCoverage?: IncrementalCoverage;
	};
}

/** Registry of active run archives, keyed by runId. Supports multiple concurrent runs. */
const archives = new Map<string, RunArchive>();

/** Load archive from disk, used as fallback for cross-process access. */
function loadArchiveFromDisk(runId: string): RunArchive | null {
	try {
		const file = path.join(runDir(runId), ARCHIVE_JSON);
		if (fs.existsSync(file)) {
			const raw = fs.readFileSync(file, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			if (isRunArchive(parsed)) {
				return parsed;
			}
		}
	} catch {
		// ignore parse/type errors
	}
	return null;
}

/** Type guard: validates the structure matches RunArchive at runtime. */
function isRunArchive(v: unknown): v is RunArchive {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.runId === "string" &&
		typeof o.startedAt === "string" &&
		typeof o.sections === "object" &&
		o.sections !== null
	);
}

/** Resolve archive by runId with disk fallback for cross-process access. */
function resolveArchive(runId?: string): RunArchive | null {
	if (runId) {
		return archives.get(runId) || loadArchiveFromDisk(runId);
	}
	return latestArchive();
}

/** Keys of RunArchive.sections whose values are object-like (excludes arrays). */
type ObjectSectionKey = {
	[K in keyof RunArchive["sections"]]: RunArchive["sections"][K] extends Record<string, unknown>
		? K
		: never;
}[keyof RunArchive["sections"]];

/** Get the most recently created archive (for backward compatibility).
 *  Tries in-memory Map first, then falls back to disk by reading .e2e-run-id. */
function latestArchive(): RunArchive | null {
	if (archives.size > 0) {
		return [...archives.values()].pop() || null;
	}
	// Fallback: read the current run id from disk and load archive
	try {
		const idFile = path.join(e2eDeviceRoot(), RUN_ID_FILE);
		if (fs.existsSync(idFile)) {
			const runId = fs.readFileSync(idFile, "utf-8").trim();
			const archive = loadArchiveFromDisk(runId);
			if (archive) {
				archives.set(runId, archive);
				return archive;
			}
		}
	} catch {
		// ignore
	}
	return null;
}

export function startRunArchive(meta: Record<string, unknown> = {}): string {
	const runId = `run-${Date.now()}`;
	const dir = runDir(runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(e2eDeviceRoot(), RUN_ID_FILE), runId, "utf-8");
	const archive: RunArchive = {
		runId,
		startedAt: new Date().toISOString(),
		status: "running",
		sections: {
			plan: meta,
			execution: {},
			resilience: {},
			issues: [],
			artifacts: [],
			hybridEvidence: {},
		},
	};
	archives.set(runId, archive);
	persistArchive(runId);
	return runId;
}

export function appendIssue(issue: ArchiveIssue, runId?: string): void {
	const archive = resolveArchive(runId);
	if (!archive) return;
	archive.sections.issues.push(issue);
	persistArchive(archive.runId);
}

/** Update an object-like section of the archive with partial data.
 *  Only accepts keys whose section values are Record<string, unknown> (excludes arrays). */
export function updateSection<K extends ObjectSectionKey>(
	key: K,
	data: Partial<RunArchive["sections"][K] & Record<string, unknown>>,
	runId?: string,
): void {
	const archive = resolveArchive(runId);
	if (!archive) return;
	const existing = archive.sections[key] as Record<string, unknown>;
	archive.sections[key] = { ...existing, ...data } as RunArchive["sections"][K];
	persistArchive(archive.runId);
}

export function finishRunArchive(status: RunArchive["status"], runId?: string): void {
	const archive = resolveArchive(runId);
	if (!archive) return;
	archive.status = status;
	archive.finishedAt = new Date().toISOString();
	persistArchive(archive.runId);
	writeMarkdown(archive);
}

function persistArchive(runId: string): void {
	const archive = archives.get(runId);
	if (!archive) return;
	const dir = runDir(archive.runId);
	fs.writeFileSync(path.join(dir, ARCHIVE_JSON), JSON.stringify(archive, null, 2));
}

function writeMarkdown(archive: RunArchive): void {
	const dir = runDir(archive.runId);
	const lines = [
		`# E2E Run ${archive.runId}`,
		"",
		`- Status: **${archive.status}**`,
		`- Started: ${archive.startedAt}`,
		`- Finished: ${archive.finishedAt || "—"}`,
		"",
		"## Plan",
		"```json",
		JSON.stringify(archive.sections.plan, null, 2),
		"```",
		"",
		"## Execution",
		"```json",
		JSON.stringify(archive.sections.execution, null, 2),
		"```",
		"",
		"## Resilience",
		"```json",
		JSON.stringify(archive.sections.resilience, null, 2),
		"```",
		"",
		"## Issues",
	];
	if (!archive.sections.issues.length) {
		lines.push("_No unresolved issues._");
	} else {
		for (const i of archive.sections.issues) {
			lines.push(
				`### ${i.id}: ${i.title}`,
				`- Severity: ${i.severity}`,
				`- Resolved: ${i.resolved}`,
				`- Repro: ${i.repro}`,
				`- Cause: ${i.cause}`,
				`- Auto-fix attempted: ${i.autoFixAttempted} (${i.autoFixResult || "n/a"})`,
				"",
			);
		}
	}
	lines.push("## Artifacts", ...(archive.sections.artifacts.map((a) => `- ${a}`) || ["_none_"]));
	lines.push("", "## Hybrid evidence", "```json", JSON.stringify(archive.sections.hybridEvidence, null, 2), "```");

	// Coverage section
	if (archive.sections.coverage) {
		const c = archive.sections.coverage;
		const ic = archive.sections.incrementalCoverage;
		lines.push("", "## Code Coverage");
		if (c.enabled) {
			// 增量
			if (ic?.enabled) {
				lines.push(
					"", "### Incremental (git diff vs " + ic.base + ")",
					`- Business files changed: ${ic.businessFiles} (${ic.matchedFiles} matched to coverage)`,
					`| Metric | Covered | Total | Pct |`,
					`|--------|---------|-------|-----|`,
					`| Statements | ${ic.statements.covered} | ${ic.statements.total} | ${ic.statements.pct}% |`,
					`| Branches | ${ic.branches.covered} | ${ic.branches.total} | ${ic.branches.pct}% |`,
					`| Functions | ${ic.functions.covered} | ${ic.functions.total} | ${ic.functions.pct}% |`,
					`| Lines | ${ic.lines.covered} | ${ic.lines.total} | ${ic.lines.pct}% |`,
				);
				if (ic.uncoveredFiles.length > 0) {
					lines.push("", "_Changed but not covered:_");
					for (const f of ic.uncoveredFiles) lines.push(`- \`${f}\``);
				}
			}
			// 全量
			lines.push(
				"", "### Full Project",
				`- Files: ${c.filesCount}`,
				`- Statements: ${c.statements.covered}/${c.statements.total} (${c.statements.pct}%)`,
				`- Branches: ${c.branches.covered}/${c.branches.total} (${c.branches.pct}%)`,
				`- Functions: ${c.functions.covered}/${c.functions.total} (${c.functions.pct}%)`,
				`- Lines: ${c.lines.covered}/${c.lines.total} (${c.lines.pct}%)`,
				`- Source: ${c.source}`,
			);
		} else {
			lines.push("_Coverage data not available._");
		}
	}

	fs.writeFileSync(path.join(dir, ARCHIVE_MD), lines.join("\n"));
}

export function listRunArtifacts(runId: string): void {
	const archive = resolveArchive(runId);
	const dir = runDir(runId);
	if (!archive) {
		return;
	}
	const files: string[] = [];
	const walk = (d: string) => {
		for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, ent.name);
			if (ent.isDirectory()) {
				walk(p);
			} else {
				files.push(path.relative(artifactsRoot(), p));
			}
		}
	};
	if (fs.existsSync(dir)) {
		walk(dir);
	}
	archive.sections.artifacts = files;
	persistArchive(archive.runId);
}
