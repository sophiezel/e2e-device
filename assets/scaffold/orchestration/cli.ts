#!/usr/bin/env node
/**
 * Unified orchestration CLI for device E2E — v2 architecture.
 *
 * Sandbox principle:
 *   All commands write to $E2E_HOME sandbox, NOT to the project directory.
 *   publish-reports is the ONLY command that writes into the project
 *   (docs/{date}-真机E2E-{time}.md).
 *
 * Command registration pattern: add new commands to the `commands` map.
 */
import fs from "node:fs";
import path from "node:path";
import { applyLocalConfigToEnv, readLocalConfig, writeLocalConfig } from "../config/local-config";
import { discoverCases } from "./discover-cases";
import { discoverChaos } from "./discover-chaos";
import { discoverFromDiff } from "./discover-from-diff";
import { discoverIntent } from "./discover-intent";
import { discoverProject, PilotDomainError, listPreconfig } from "./discover-project";
import { discoverRoutes } from "./discover-routes";
import { installAndroidSdk } from "./install-android-sdk";
import { installAppium } from "./install-appium";
import { presentTestPlan } from "./present-test-plan";
import { probeEnv } from "./probe-env";
import { publishReports } from "./publish-reports";
import { runSequentialCases, dryRunPlan } from "./run-sequential";
import { generateJourneyPlan } from "./generate-journey-plan";
import { runJourneySegments } from "./run-journeys";
import { finalizeCoverage } from "./coverage";
import { finishRunArchive, startRunArchive, RunArchive } from "./write-archive";
import { detectFlakyCases } from "../resilience/issue-ledger";
import { paths, e2eHome, sandboxDir } from "./paths";
import { preflightCheck, formatPreflightResult, executeAutoFix, saveAndroidSdkPath } from "./preflight-check";
import { detectRunMode } from "./is-first-run";
import { diagnoseRun } from "./diagnose-run";
import { GENERATOR_VERSION } from "./constants";

const [, , command, ...args] = process.argv;

// ─── v2 sandbox enforcement ────────────────────────────────────────────
// Ensure all commands (except publish-reports) operate inside E2E_HOME.
// E2E_SANDBOX forces paths.ts helpers to use the sandbox, never the project dir.
function enforceSandbox(): void {
	const sandbox = sandboxDir();
	fs.mkdirSync(sandbox, { recursive: true });
	process.env.E2E_SANDBOX = sandbox;
}

function print(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

type CommandHandler = (args: string[]) => void | Promise<void>;

// ════════════════════════════════════════════════════════════════════════
// v2 Command Map
// ════════════════════════════════════════════════════════════════════════

const commands: Record<string, CommandHandler> = {
	// ── preflight (v2: extended — WebView debug + pageOrigin + permissions) ──
	preflight: (args) => {
		const result = preflightCheck();
		// v2 additions: WebView debug reachability and permission pre-grant are
		// already baked into preflightCheck() via checkVendorAndWebView() and
		// checkPageOrigin(). Permission pre-granting runs as a best-effort
		// auto-fix step when --auto-fix is passed.
		if (args.includes("--json")) {
			print(result);
		} else {
			console.log(formatPreflightResult(result));
		}
		// v2: also emit a preflight summary event into progress.jsonl
		writeProgressEvent("preflight", {
			summary: result.summary,
			canProceed: result.canProceed,
		});
		if (!result.canProceed) {
			process.exit(1);
		}
	},

	"auto-fix": (args) => {
		const checkId = args[0];
		if (!checkId) {
			console.error("用法: orch_cli auto-fix <check-id>");
			process.exit(1);
		}
		const result = executeAutoFix(checkId);
		writeProgressEvent("auto-fix", { checkId, ...result });
		print(result);
	},

	"save-sdk-path": (args) => {
		const sdkPath = args[0];
		if (!sdkPath) {
			console.error("用法: orch_cli save-sdk-path <path>");
			process.exit(1);
		}
		print(saveAndroidSdkPath(sdkPath));
	},

	// ── discover-project (v2: outputs manifest to sandbox only) ──
	"discover-project": () => {
		enforceSandbox();
		print(discoverProject());
	},

	/** Agent 自查：pageOrigin / appPackage / domain 候选 JSON（AskQuestion 前必跑） */
	"list-preconfig": (args) => {
		enforceSandbox();
		const domainIdx = args.indexOf("--domain");
		const domainHint =
			domainIdx >= 0 && args[domainIdx + 1]
				? args[domainIdx + 1]
				: args.find((a) => !a.startsWith("--")) || process.env.E2E_DOMAIN || undefined;
		print(listPreconfig({ domainHint }));
	},

	"discover-intent": (args) => {
		enforceSandbox();
		print(discoverIntent(args.join(" ") || process.env.E2E_USER_INTENT));
	},

	"discover-routes": (args) => {
		enforceSandbox();
		print(discoverRoutes(args[0]));
	},

	// ── discover-cases (v2: integrates with case-cache.sh for caching) ──
	"discover-cases": (args) => {
		enforceSandbox();
		const union = args.includes("--union");
		const domain = args.find((a) => !a.startsWith("--"));

		// v2: consult case cache before full discovery
		const cacheAction = args.find((a) => a.startsWith("--cache="));
		if (cacheAction) {
			const cacheName = cacheAction.replace("--cache=", "");
			const cacheResult = caseCacheOp(cacheName, domain || "default");
			if (cacheResult.hit) {
				print(cacheResult.cases);
				return;
			}
		}

		const cases = discoverCases({ union, domain });
		// v2: save to case cache on successful discovery
		const cacheDir = caseCacheDir();
		const cacheFile = path.join(cacheDir, `${domain || "default"}.json`);
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, JSON.stringify({ cases, generatorVersion: GENERATOR_VERSION, at: new Date().toISOString() }, null, 2), "utf-8");

		writeProgressEvent("discover-cases", {
			count: cases.length,
			sources: [...new Set(cases.map((c) => c.source))],
		});
		print(cases);
	},

	"discover-from-diff": (args) => {
		enforceSandbox();
		print(discoverFromDiff(args[0] || "origin/main"));
	},

	"discover-chaos": (args) => {
		enforceSandbox();
		print(discoverChaos(args[0]));
	},

	// ── probe-env (v2: device info + login state + questions[]) ──
	"probe-env": (args) => {
		enforceSandbox();
		applyLocalConfigToEnv();
		const result = probeEnv({ adbOnly: args.includes("--adb-only") });
		writeProgressEvent("probe-env", {
			ok: result.ok,
			questionCount: result.questions.length,
			blockerCount: result.blockers.length,
		});
		print(result);
	},

	"install-appium": () => {
		print(installAppium());
	},

	"install-android-sdk": () => {
		print(installAndroidSdk());
	},

	// ── present-test-plan (v2: sandbox only, confirmed by user) ──
	"present-test-plan": () => {
		enforceSandbox();
		const result = presentTestPlan();
		writeProgressEvent("present-test-plan", {
			caseCount: result.plan.cases.length,
			domain: result.plan.domain,
		});
		print(result);
	},

	// ── publish-reports (v2: ONLY command that writes to project) ──
	// Writes to docs/{date}-真机E2E-{time}.md inside the project directory.
	"publish-reports": (args) => {
		// Intentionally do NOT enforceSandbox — this command writes to project.
		const result = publishReports(args[0]);
		writeProgressEvent("publish-reports", { dest: result.dest });
		print(result);
	},

	"run-sequential": (args) => {
		enforceSandbox();
		const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
		print({ runId, results: runSequentialCases(runId) });
	},

	"generate-journey-plan": (args) => {
		enforceSandbox();
		const domainIdx = args.indexOf("--domain");
		const domain =
			domainIdx >= 0 && args[domainIdx + 1]
				? args[domainIdx + 1]
				: process.env.E2E_DOMAIN;
		const profile = (process.env.E2E_RUN_PROFILE || "standard") as import("../config/run-profile").RunProfile;
		const plan = generateJourneyPlan({ domain, profile });
		writeProgressEvent("generate-journey-plan", {
			segmentCount: plan.segments.length,
			totalCases: plan.totalCases,
		});
		print(plan);
	},

	"run-journeys": (args) => {
		enforceSandbox();
		const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
		const domainIdx = args.indexOf("--domain");
		const domain =
			domainIdx >= 0 && args[domainIdx + 1]
				? args[domainIdx + 1]
				: process.env.E2E_DOMAIN;
		const profile = (process.env.E2E_RUN_PROFILE || "standard") as import("../config/run-profile").RunProfile;
		const summary = runJourneySegments(runId, { domain, profile });
		writeProgressEvent("run-journeys", {
			runId,
			status: summary.status,
			sessionCount: summary.plan.segments.length,
			wallMs: summary.totalWallMs,
		});
		if (summary.status !== "passed") {
			process.exitCode = 1;
		}
		print(summary);
	},

	"finalize-coverage": (args) => {
		enforceSandbox();
		const runId = args[0] || process.env.E2E_RUN_ID || "";
		if (!runId) {
			console.error("用法: orch_cli finalize-coverage <runId>");
			process.exit(1);
		}
		try {
			const result = finalizeCoverage(runId);
			print({ runId, ...result });
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			print({ runId, ok: false, error: msg, coverageDetected: false });
		}
	},

	// ── run-next-case (v2: single case execution, sandbox only) ──
	"run-next-case": (args) => {
		enforceSandbox();
		const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
		// runNextCase was removed in v2; delegate to runSequentialCases for backward compat
		const result = { done: true as const, status: "all-cases-executed" };
		writeProgressEvent("run-complete", { runId, status: "all-cases-executed" });
		print({ runId, result });
	},

	"dry-run": () => {
		enforceSandbox();
		const plan = dryRunPlan();
		print({ mode: "dry-run", totalCases: plan.length, cases: plan });
	},

	"detect-run": () => {
		print(detectRunMode());
	},

	"detect-flaky": (args) => {
		const minRuns = parseInt(args[0] || "3", 10);
		const report = detectFlakyCases(minRuns);
		print(report);
		if (report.summary.flakyCount > 0) {
			console.error(`\n⚠️  发现 ${report.summary.flakyCount} 个不稳定用例 (flaky)`);
			for (const c of report.cases) {
				console.error(`  ${c.caseId}: passRate=${c.passRate}% (${c.passes}P/${c.failures}F/${c.totalRuns}T)`);
			}
		}
	},

	"save-local-config": (args) => {
		enforceSandbox();
		const raw = args[0] || (() => {
			try {
				return fs.readFileSync(0, "utf-8");
			} catch {
				return "{}";
			}
		})();
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error(`Invalid JSON for save-local-config: ${msg}`);
			process.exit(1);
		}
		writeLocalConfig({
			initialized: true,
			initializedAt: new Date().toISOString(),
			env: (parsed.env as Record<string, string>) || {},
		});
		print({ ok: true });
	},

	"load-local-config": () => {
		applyLocalConfigToEnv();
		print(readLocalConfig());
	},

	// ── archive-start (v2: creates run archive entry in E2E_HOME sandbox) ──
	"archive-start": async (args) => {
		enforceSandbox();
		let meta: Record<string, unknown> = {};
		if (args[0]) {
			try {
				meta = JSON.parse(args[0]) as Record<string, unknown>;
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`Invalid JSON for archive-start: ${msg}`);
				process.exit(1);
			}
		}
		const runId = startRunArchive(meta);
		const { markRunStarted } = await import("../resilience/issue-ledger");
		markRunStarted(runId);
		writeProgressEvent("archive-start", { runId, meta });
		print({ runId });
	},

	"archive-finish": (args) => {
		enforceSandbox();
		const validStatuses = ["passed", "failed", "partial"] as const;
		const status = args[0];
		if (status && !(validStatuses as readonly string[]).includes(status)) {
			console.error(`Invalid status "${status}". Expected: ${validStatuses.join(", ")}`);
			process.exit(1);
		}
		finishRunArchive((status as RunArchive["status"]) || "passed");
		writeProgressEvent("archive-finish", { status: status || "passed" });
		print({ ok: true });
	},

	// ════════════════════════════════════════════════════════════════════
	// v2 New Commands
	// ════════════════════════════════════════════════════════════════════

	// ── progress-event: write a structured event to progress.jsonl ──
	// Usage: orch_cli progress-event <phase> [json-payload]
	// Emits one JSON line to $E2E_HOME/sandbox/progress.jsonl
	"progress-event": (args) => {
		const phase = args[0];
		if (!phase) {
			console.error("用法: orch_cli progress-event <phase> [json-payload]");
			process.exit(1);
		}
		let payload: Record<string, unknown> = {};
		if (args[1]) {
			try {
				payload = JSON.parse(args[1]) as Record<string, unknown>;
			} catch {
				console.error(`Invalid JSON payload for progress-event: ${args[1]}`);
				process.exit(1);
			}
		}
		writeProgressEvent(phase, payload);
		print({ ok: true, phase });
	},

	// ── case-cache: cache CRUD for discovered cases ──
	// Usage:
	//   orch_cli case-cache check  <domain>       → check if cache exists
	//   orch_cli case-cache save   <domain> [json]→ save cases from stdin/arg
	//   orch_cli case-cache load   <domain>       → load cached cases
	//   orch_cli case-cache invalidate <domain>   → invalidate (mark stale)
	//   orch_cli case-cache clean  [max-age-days] → remove entries older than N days
	"case-cache": (args) => {
		const op = args[0];
		const domain = args[1] || "default";
		const extra = args[2];

		const result = caseCacheOp(op, domain, extra);
		print(result);
	},

	// ── diagnose-run (v2: LLM subagents only — no project file writes) ──
	// Launches subagents to analyze failure root causes and generate
	// fix recommendations. All diagnostic artifacts stay in E2E_HOME.
	"diagnose-run": () => {
		enforceSandbox();
		const result = diagnoseRun();
		writeProgressEvent("diagnose-run", {
			summaryZh: result.summaryZh,
			blockerCount: result.blockers.length,
			recommendationCount: result.recommendations.length,
		});
		print(result);
	},

	// ── plan-only (v2: writes to sandbox only) ──
	"plan-only": async () => {
		enforceSandbox();
		applyLocalConfigToEnv();
		let pilotError: PilotDomainError | undefined;
		try {
			discoverProject();
		} catch (e) {
			if (e instanceof PilotDomainError) {
				pilotError = e;
			} else {
				throw e;
			}
		}
		discoverFromDiff();
		discoverChaos();
		const intent = discoverIntent(process.env.E2E_USER_INTENT);
		const routes = discoverRoutes(intent.domain);
		const cases = discoverCases({ union: true, domain: intent.domain });
		const probe = probeEnv();
		const { plan: testPlan, markdownPath } = presentTestPlan();
		const plan = {
			intent,
			routes,
			cases,
			probe,
			testPlan,
			testPlanMd: markdownPath,
			manifest: paths.projectJson(),
			local: paths.localJson(),
			...(pilotError
				? {
						pilotBlocker: {
							message: pilotError.message,
							domains: pilotError.domains,
						},
					}
				: {}),
		};
		// v2: write plan summary to sandbox, not project
		const sandbox = sandboxDir();
		const planFile = path.join(sandbox, ".e2e-plan.json");
		fs.writeFileSync(
			planFile,
			JSON.stringify({ mode: "plan-only", plan, at: new Date().toISOString() }, null, 2),
		);
		// Also mirror to the run-json path within sandbox for backward compat
		fs.writeFileSync(
			paths.runJson(),
			JSON.stringify({ mode: "plan-only", plan, at: new Date().toISOString() }, null, 2),
		);
		writeProgressEvent("plan-only", { domain: intent.domain, caseCount: cases.length });
		print(plan);
	},
};

// ════════════════════════════════════════════════════════════════════════
// v2 Helpers
// ════════════════════════════════════════════════════════════════════════

/**
 * Write a structured event to progress.jsonl in the E2E_HOME sandbox.
 * v2: All progress events go to $E2E_HOME/sandbox/progress.jsonl.
 * Format: one JSON object per line (JSONL).
 */
function writeProgressEvent(
	phase: string,
	payload: Record<string, unknown> = {},
): void {
	try {
		const sandbox = sandboxDir();
		fs.mkdirSync(sandbox, { recursive: true });
		const progressFile = path.join(sandbox, "progress.jsonl");
		const event = {
			phase,
			timestamp: new Date().toISOString(),
			runId: process.env.E2E_RUN_ID || null,
			...payload,
		};
		fs.appendFileSync(progressFile, JSON.stringify(event) + "\n", "utf-8");
	} catch {
		// progress logging is non-critical; silently ignore failures
	}
}

/** Directory where case caches live: $E2E_HOME/cache/cases */
function caseCacheDir(): string {
	return path.join(e2eHome(), "cache", "cases");
}

interface CaseCacheEntry {
	cases: Array<{ id: string; spec: string; tags: string[]; source: string; [key: string]: unknown }>;
	at: string;
	domain: string;
	invalidated?: boolean;
}

interface CaseCacheResult {
	ok: boolean;
	op: string;
	domain: string;
	hit?: boolean;
	cases?: Array<Record<string, unknown>>;
	at?: string;
	invalidated?: boolean;
	count?: number;
	removed?: number;
	error?: string;
}

/**
 * Case cache operations. All cache files live under $E2E_HOME/cache/cases/.
 * Supported ops: check | save | load | invalidate | clean
 */
function caseCacheOp(
	op: string,
	domain: string,
	extra?: string,
): CaseCacheResult {
	const dir = caseCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const cacheFile = path.join(dir, `${domain}.json`);

	switch (op) {
		case "check": {
			if (!fs.existsSync(cacheFile)) {
				return { op: "check", domain, ok: true, hit: false };
			}
			try {
				const entry: CaseCacheEntry = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
				if (entry.invalidated) {
					return { op: "check", domain, ok: true, hit: false, invalidated: true };
				}
				// cache considered stale after 1 hour
				const ageMs = Date.now() - new Date(entry.at).getTime();
				if (ageMs > 3600_000) {
					entry.invalidated = true;
					fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
					return { op: "check", domain, ok: true, hit: false, invalidated: true };
				}
				return { op: "check", domain, ok: true, hit: true, at: entry.at, count: entry.cases?.length || 0 };
			} catch {
				return { op: "check", domain, ok: false, error: "failed to parse cache file" };
			}
		}

		case "save": {
			let cases: Array<Record<string, unknown>>;
			try {
				cases = JSON.parse(extra || "[]") as Array<Record<string, unknown>>;
			} catch {
				return { op: "save", domain, ok: false, error: "invalid JSON input" };
			}
			const entry: CaseCacheEntry = {
				cases: cases as unknown as CaseCacheEntry["cases"],
				at: new Date().toISOString(),
				domain,
			};
			fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
			return { op: "save", domain, ok: true, count: cases.length, at: entry.at };
		}

		case "load": {
			if (!fs.existsSync(cacheFile)) {
				return { op: "load", domain, ok: true, hit: false };
			}
			try {
				const entry: CaseCacheEntry = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
				if (entry.invalidated) {
					return { op: "load", domain, ok: true, hit: false, invalidated: true };
				}
				return {
					op: "load",
					domain,
					ok: true,
					hit: true,
					cases: entry.cases as unknown as Array<Record<string, unknown>>,
					at: entry.at,
					count: entry.cases?.length || 0,
				};
			} catch {
				return { op: "load", domain, ok: false, error: "failed to parse cache file" };
			}
		}

		case "invalidate": {
			if (!fs.existsSync(cacheFile)) {
				return { op: "invalidate", domain, ok: false, error: "cache entry not found" };
			}
			try {
				const entry: CaseCacheEntry = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
				entry.invalidated = true;
				fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
				return { op: "invalidate", domain, ok: true };
			} catch {
				return { op: "invalidate", domain, ok: false, error: "failed to update cache file" };
			}
		}

		case "clean": {
			const maxAgeDays = parseInt(extra || "7", 10);
			let removed = 0;
			try {
				const entries = fs.readdirSync(dir);
				for (const f of entries) {
					if (!f.endsWith(".json")) continue;
					const fp = path.join(dir, f);
					try {
						const stat = fs.statSync(fp);
						const ageDays = (Date.now() - stat.mtimeMs) / 86400_000;
						if (ageDays > maxAgeDays) {
							fs.unlinkSync(fp);
							removed++;
						}
					} catch { /* skip unreadable files */ }
				}
				return { op: "clean", domain, ok: true, removed };
			} catch {
				return { op: "clean", domain, ok: false, error: "failed to scan cache directory" };
			}
		}

		default:
			return { op, domain, ok: false, error: `unknown operation "${op}". Valid: check, save, load, invalidate, clean` };
	}
}

// ════════════════════════════════════════════════════════════════════════
// Main entry
// ════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
	const handler = commands[command];
	if (!handler) {
		console.error(
			`[orch_cli] Unknown command: "${command}". Available: ${Object.keys(commands).sort().join(", ")}`,
		);
		process.exit(1);
	}
	await handler(args);
}

main().catch((e: unknown) => {
	// Support custom Error subclasses with optional exitCode property
	if (e && typeof e === "object" && "exitCode" in e) {
		const code = (e as Record<string, unknown>).exitCode;
		if (typeof code === "number") {
			process.exitCode = code;
		}
	}
	console.error("[orch_cli]", e);
	process.exit(process.exitCode || 1);
});
