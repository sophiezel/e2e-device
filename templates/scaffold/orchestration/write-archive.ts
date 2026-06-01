import fs from "node:fs";
import path from "node:path";
import { artifactsRoot, e2eDeviceRoot, runDir } from "./paths";

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

let current: RunArchive | null = null;

export function startRunArchive(meta: Record<string, unknown> = {}): string {
	const runId = `run-${Date.now()}`;
	const dir = runDir(runId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(e2eDeviceRoot(), ".e2e-run-id"), runId, "utf-8");
	current = {
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
	persist();
	return runId;
}

export function appendIssue(issue: ArchiveIssue): void {
	if (!current) {
		return;
	}
	current.sections.issues.push(issue);
	persist();
}

export function updateSection(
	key: keyof RunArchive["sections"],
	data: Record<string, unknown>,
): void {
	if (!current) {
		return;
	}
	current.sections[key] = { ...current.sections[key], ...data } as never;
	persist();
}

export function finishRunArchive(status: RunArchive["status"]): void {
	if (!current) {
		return;
	}
	current.status = status;
	current.finishedAt = new Date().toISOString();
	persist();
	writeMarkdown(current);
	current = null;
}

function persist(): void {
	if (!current) {
		return;
	}
	const dir = runDir(current.runId);
	fs.writeFileSync(path.join(dir, "archive.json"), JSON.stringify(current, null, 2));
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
	fs.writeFileSync(path.join(dir, "archive.md"), lines.join("\n"));
}

export function listRunArtifacts(runId: string): void {
	const dir = runDir(runId);
	if (!current) {
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
	current.sections.artifacts = files;
	persist();
}
