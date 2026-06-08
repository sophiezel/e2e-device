import fs from "node:fs";
import path from "node:path";
import { artifactsRoot, e2eDeviceRoot, runDir } from "./paths";
import { RUN_ID_FILE, ARCHIVE_JSON, ARCHIVE_MD } from "./constants";

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
	};
}

/** Registry of active run archives, keyed by runId. Supports multiple concurrent runs. */
const archives = new Map<string, RunArchive>();

/** Load archive from disk as fallback when in-memory map is empty. */
function loadArchiveFromDisk(runId: string): RunArchive | null {
	try {
		const file = path.join(runDir(runId), ARCHIVE_JSON);
		if (fs.existsSync(file)) {
			return JSON.parse(fs.readFileSync(file, "utf-8")) as RunArchive;
		}
	} catch {
		// ignore parse errors
	}
	return null;
}

/** Get the most recently created archive (for backward compatibility). */
function latestArchive(): RunArchive | null {
	if (archives.size === 0) {
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
	return [...archives.values()].pop() || null;
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
	const archive = runId ? archives.get(runId) : latestArchive();
	if (!archive) return;
	archive.sections.issues.push(issue);
	persistArchive(archive.runId);
}

export function updateSection(
	key: keyof RunArchive["sections"],
	data: Record<string, unknown>,
	runId?: string,
): void {
	const archive = runId ? archives.get(runId) : latestArchive();
	if (!archive) return;
	const existing = archive.sections[key] as Record<string, unknown>;
	(archive.sections as Record<string, unknown>)[key as string] = { ...existing, ...data };
	persistArchive(archive.runId);
}

export function finishRunArchive(status: RunArchive["status"], runId?: string): void {
	const archive = runId ? archives.get(runId) : latestArchive();
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
	fs.writeFileSync(path.join(dir, ARCHIVE_MD), lines.join("\n"));
}

export function listRunArtifacts(runId: string): void {
	const archive = archives.get(runId) || latestArchive();
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
