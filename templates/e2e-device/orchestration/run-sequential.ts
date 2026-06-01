import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeResilienceReports } from "../resilience/issue-ledger";
import { artifactsRoot, e2eDeviceRoot, paths, repoRoot } from "./paths";
import { wdioArgv } from "./resolve-bin";

export interface CaseRunResult {
	caseId: string;
	spec: string;
	exitCode: number;
}

function loadRegistry(): Array<{ id: string; spec: string }> {
	const file = paths.caseRegistry();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: Array<{ id: string; spec: string }>;
	};
	return data.cases ?? [];
}

export function runSequentialCases(runId: string): CaseRunResult[] {
	const root = repoRoot();
	const results: CaseRunResult[] = [];
	const logFile = path.join(artifactsRoot(), "runs", runId, "cases-executed.jsonl");
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.writeFileSync(logFile, "", "utf-8");

	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === "00-bootstrap");
	const rest = registry.filter((c) => c.id !== "00-bootstrap");
	const ordered = [...(bootstrap ? [bootstrap] : []), ...rest];

	const seen = new Set<string>();
	for (const entry of ordered) {
		const spec = entry.spec;
		if (seen.has(spec) || !fs.existsSync(path.join(root, spec))) {
			continue;
		}
		seen.add(spec);
		const caseId = entry.id;
		let exitCode = 0;
		const argv = wdioArgv(root, ["--spec", spec]);
		const wdio = spawnSync(argv[0], argv.slice(1), {
			cwd: root,
			stdio: "inherit",
			env: {
				...process.env,
				E2E_RUN_ID: runId,
				E2E_ENABLE_WEB_MOCK: "1",
				E2E_CURRENT_SPEC: spec,
			},
		});
		if (wdio.status !== 0) {
			exitCode = 1;
		}
		const row = { caseId, spec, exitCode, at: new Date().toISOString() };
		results.push(row);
		fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
	}

	writeResilienceReports();

	return results;
}

function readExecutedCaseIds(logFile: string): Set<string> {
	const ids = new Set<string>();
	if (!fs.existsSync(logFile)) {
		return ids;
	}
	for (const line of fs.readFileSync(logFile, "utf-8").split("\n")) {
		if (!line.trim()) {
			continue;
		}
		try {
			const row = JSON.parse(line) as { caseId?: string };
			if (row.caseId) {
				ids.add(row.caseId);
			}
		} catch {
			// ignore bad line
		}
	}
	return ids;
}

function runOneCase(
	runId: string,
	entry: { id: string; spec: string },
	logFile: string,
): CaseRunResult {
	let exitCode = 0;
	const root = repoRoot();
	const argv = wdioArgv(root, ["--spec", entry.spec]);
	const wdio = spawnSync(argv[0], argv.slice(1), {
		cwd: root,
		stdio: "inherit",
		env: {
			...process.env,
			E2E_RUN_ID: runId,
			E2E_ENABLE_WEB_MOCK: "1",
			E2E_CURRENT_SPEC: entry.spec,
		},
	});
	if (wdio.status !== 0) {
		exitCode = 1;
	}
	const row: CaseRunResult & { at: string } = {
		caseId: entry.id,
		spec: entry.spec,
		exitCode,
		at: new Date().toISOString(),
	};
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	fs.appendFileSync(logFile, `${JSON.stringify(row)}\n`, "utf-8");
	return row;
}

/** Run the next registry case not yet recorded in cases-executed.jsonl */
export function runNextCase(runId: string): CaseRunResult | { done: true } {
	const logFile = path.join(artifactsRoot(), "runs", runId, "cases-executed.jsonl");
	const executed = readExecutedCaseIds(logFile);
	const registry = loadRegistry();
	const bootstrap = registry.find((c) => c.id === "00-bootstrap");
	const rest = registry.filter((c) => c.id !== "00-bootstrap");
	const ordered = [...(bootstrap ? [bootstrap] : []), ...rest];

	for (const entry of ordered) {
		if (executed.has(entry.id)) {
			continue;
		}
		if (!fs.existsSync(path.join(repoRoot(), entry.spec))) {
			continue;
		}
		return runOneCase(runId, entry, logFile);
	}
	return { done: true };
}

export function listBootstrapFirst(): string[] {
	const bootstrap = path.join(e2eDeviceRoot(), "specs", "00-bootstrap.spec.ts");
	const all = loadRegistry().map((c) => path.join(repoRoot(), c.spec));
	const ordered = fs.existsSync(bootstrap)
		? [bootstrap, ...all.filter((p) => !p.endsWith("00-bootstrap.spec.ts"))]
		: all;
	return [...new Set(ordered)].filter((p) => fs.existsSync(p));
}
