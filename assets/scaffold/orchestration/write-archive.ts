import fs from "node:fs";
import path from "node:path";
import { sandboxDir } from "./paths";
import { RUN_ID_FILE, ARCHIVE_JSON, CASES_EXECUTED_FILE } from "./constants";
import type { CoverageSummary, IncrementalCoverage } from "./coverage";

// ---- v2: sandbox-only paths ----

function sandboxRunDir(runId: string): string {
	return path.join(sandboxDir(), "artifacts", "runs", runId);
}

function casesExecutedPath(runId: string): string {
	return path.join(sandboxRunDir(runId), CASES_EXECUTED_FILE);
}

/** v2: write a cases-executed.jsonl line with llmInterventions, progressMs, resetMs */
export function appendExecutedCase(
	runId: string,
	entry: {
		caseId: string;
		spec: string;
		status: "passed" | "failed" | "timeout" | "skipped";
		durationMs: number;
		progressMs: number;
		resetMs: number;
		error?: string;
		errorStack?: string;
		screenshotPath?: string;
		logSnapshotPath?: string;
		llmInterventions: Array<{ reason: string; tokens: number; at: string }>;
		at: string;
	},
): void {
	const file = casesExecutedPath(runId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

/** v2: append an LLM intervention record for a specific case */
export function appendLlmIntervention(
	runId: string,
	caseId: string,
	intervention: { reason: string; tokens: number },
): void {
	const file = casesExecutedPath(runId);
	if (!fs.existsSync(file)) return;
	// Read all lines, find the last entry for caseId, append intervention
	const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
	const updated: string[] = [];
	let found = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.caseId === caseId && !found) {
				entry.llmInterventions = entry.llmInterventions || [];
				entry.llmInterventions.push({
					reason: intervention.reason,
					tokens: intervention.tokens,
					at: new Date().toISOString(),
				});
				found = true;
			}
			updated.unshift(JSON.stringify(entry));
		} catch {
			updated.unshift(lines[i]);
		}
	}
	if (found) {
		fs.writeFileSync(file, updated.join("\n") + "\n", "utf-8");
	}
}

// ---- v2: RunArchive types (sandbox-only, no project writes) ----

export interface ArchiveIssue {
	id: string;
	severity: string;
	title: string;
	repro: string;
	cause: string;
	autoFixAttempted: boolean;
	autoFixResult?: string;
	resolved: boolean;
	problemStack?: string;
	reproductionPath?: Record<string, unknown>;
	suggestedFixes?: Array<{ approach: string; risk: string; effort: string; refs: string[] }>;
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

/** v2: In-memory archive registry and on-disk persistence to sandbox only */
const archives = new Map<string, RunArchive>();

/** Load archive from sandbox disk */
function loadArchiveFromDisk(runId: string): RunArchive | null {
	try {
		const file = path.join(sandboxRunDir(runId), ARCHIVE_JSON);
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

function resolveArchive(runId?: string): RunArchive | null {
	if (runId) {
		return archives.get(runId) || loadArchiveFromDisk(runId);
	}
	return latestArchive();
}

type ObjectSectionKey = {
	[K in keyof RunArchive["sections"]]: RunArchive["sections"][K] extends Record<string, unknown>
		? K
		: never;
}[keyof RunArchive["sections"]];

function latestArchive(): RunArchive | null {
	if (archives.size > 0) {
		return [...archives.values()].pop() || null;
	}
	// Fallback: read the current run id from sandbox
	try {
		const idFile = path.join(sandboxDir(), RUN_ID_FILE);
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

/** v2: Start a new run archive in sandbox. NO writes to project directory. */
export function startRunArchive(meta: Record<string, unknown> = {}): string {
	const runId = `run-${Date.now()}`;
	const dir = sandboxRunDir(runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(sandboxDir(), RUN_ID_FILE), runId, "utf-8");
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

export function updateSection<K extends ObjectSectionKey & keyof RunArchive["sections"]>(
	key: K,
	data: Partial<RunArchive["sections"][K] & Record<string, unknown>>,
	runId?: string,
): void {
	const archive = resolveArchive(runId);
	if (!archive) return;
	const existing = archive.sections[key];
	archive.sections[key] = { ...existing, ...data } as RunArchive["sections"][K];
	persistArchive(archive.runId);
}

export function finishRunArchive(status: RunArchive["status"], runId?: string): void {
	const archive = resolveArchive(runId);
	if (!archive) return;
	archive.status = status;
	archive.finishedAt = new Date().toISOString();
	persistArchive(archive.runId);
}

/** v2: Persist archive to sandbox only */
function persistArchive(runId: string): void {
	const archive = archives.get(runId);
	if (!archive) return;
	const dir = sandboxRunDir(archive.runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ARCHIVE_JSON), JSON.stringify(archive, null, 2), "utf-8");
}

/** v2: List all artifact files under a run directory in sandbox */
export function listRunArtifacts(runId: string): void {
	const archive = resolveArchive(runId);
	const dir = sandboxRunDir(runId);
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
				files.push(path.relative(sandboxDir(), p));
			}
		}
	};
	if (fs.existsSync(dir)) {
		walk(dir);
	}
	archive.sections.artifacts = files;
	persistArchive(archive.runId);
}
