#!/usr/bin/env node
/**
 * Unified orchestration CLI for device E2E init / discover / probe.
 * Command registration pattern: add new commands to the `commands` map.
 */
import fs from "node:fs";
import { applyLocalConfigToEnv, readLocalConfig, writeLocalConfig } from "../config/local-config";
import { discoverCases } from "./discover-cases";
import { discoverChaos } from "./discover-chaos";
import { discoverFromDiff } from "./discover-from-diff";
import { discoverIntent } from "./discover-intent";
import { discoverProject, PilotDomainError } from "./discover-project";
import { discoverRoutes } from "./discover-routes";
import { installAndroidSdk } from "./install-android-sdk";
import { installAppium } from "./install-appium";
import { presentTestPlan } from "./present-test-plan";
import { probeEnv } from "./probe-env";
import { publishReports } from "./publish-reports";
import { runNextCase, runSequentialCases, dryRunPlan } from "./run-sequential";
import { finishRunArchive, startRunArchive, RunArchive } from "./write-archive";
import { paths } from "./paths";
import { preflightCheck, formatPreflightResult, executeAutoFix, saveAndroidSdkPath } from "./preflight-check";
import { detectRunMode } from "./is-first-run";

const [, , command, ...args] = process.argv;

function print(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

type CommandHandler = (args: string[]) => void | Promise<void>;

const commands: Record<string, CommandHandler> = {
	preflight: (args) => {
		const result = preflightCheck();
		if (args.includes("--json")) {
			print(result);
		} else {
			console.log(formatPreflightResult(result));
		}
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
		print(executeAutoFix(checkId));
	},

	"save-sdk-path": (args) => {
		const sdkPath = args[0];
		if (!sdkPath) {
			console.error("用法: orch_cli save-sdk-path <path>");
			process.exit(1);
		}
		print(saveAndroidSdkPath(sdkPath));
	},

	"discover-project": () => {
		print(discoverProject());
	},

	"discover-intent": (args) => {
		print(discoverIntent(args.join(" ") || process.env.E2E_USER_INTENT));
	},

	"discover-routes": (args) => {
		print(discoverRoutes(args[0]));
	},

	"discover-cases": (args) => {
		const union = args.includes("--union");
		print(
			discoverCases({
				union,
				domain: args.find((a) => !a.startsWith("--")),
			}),
		);
	},

	"discover-from-diff": (args) => {
		print(discoverFromDiff(args[0] || "origin/main"));
	},

	"discover-chaos": (args) => {
		print(discoverChaos(args[0]));
	},

	"probe-env": (args) => {
		applyLocalConfigToEnv();
		print(probeEnv({ adbOnly: args.includes("--adb-only") }));
	},

	"install-appium": () => {
		print(installAppium());
	},

	"install-android-sdk": () => {
		print(installAndroidSdk());
	},

	"present-test-plan": () => {
		print(presentTestPlan());
	},

	"publish-reports": (args) => {
		print(publishReports(args[0]));
	},

	"run-sequential": (args) => {
		const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
		print({ runId, results: runSequentialCases(runId) });
	},

	"run-next-case": (args) => {
		const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
		print({ runId, result: runNextCase(runId) });
	},

	"dry-run": () => {
		const plan = dryRunPlan();
		print({ mode: "dry-run", totalCases: plan.length, cases: plan });
	},

	"detect-run": () => {
		print(detectRunMode());
	},

	"save-local-config": (args) => {
		const raw = args[0] || fs.readFileSync(0, "utf-8");
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

	"archive-start": async (args) => {
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
		print({ runId });
	},

	"archive-finish": (args) => {
		const validStatuses = ["passed", "failed", "partial"] as const;
		const status = args[0];
		if (status && !(validStatuses as readonly string[]).includes(status)) {
			console.error(`Invalid status "${status}". Expected: ${validStatuses.join(", ")}`);
			process.exit(1);
		}
		finishRunArchive((status as RunArchive["status"]) || "passed");
		print({ ok: true });
	},

	"plan-only": async () => {
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
		fs.writeFileSync(
			paths.runJson(),
			JSON.stringify({ mode: "plan-only", plan, at: new Date().toISOString() }, null, 2),
		);
		print(plan);
	},
};

async function main(): Promise<void> {
	const handler = commands[command];
	if (!handler) {
		console.error(
			`Unknown command: ${command}\nCommands: ${Object.keys(commands).join(", ")}`,
		);
		process.exit(1);
	}
	await handler(args);
}

main().catch((e: unknown) => {
	// Support custom Error subclasses with optional exitCode property
	if (e && typeof e === 'object' && 'exitCode' in e) {
		const code = (e as Record<string, unknown>).exitCode;
		if (typeof code === 'number') {
			process.exitCode = code;
		}
	}
	console.error(e);
	process.exit(process.exitCode || 1);
});
