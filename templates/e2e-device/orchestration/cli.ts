#!/usr/bin/env node
/**
 * Unified orchestration CLI for device E2E init / discover / probe.
 */
import fs from "node:fs";
import { applyLocalConfigToEnv, readLocalConfig, writeLocalConfig } from "../config/local-config";
import { discoverCases } from "./discover-cases";
import { discoverChaos } from "./discover-chaos";
import { discoverFromDiff } from "./discover-from-diff";
import { discoverIntent } from "./discover-intent";
import { discoverProject } from "./discover-project";
import { discoverRoutes } from "./discover-routes";
import { installAndroidSdk } from "./install-android-sdk";
import { installAppium } from "./install-appium";
import { presentTestPlan } from "./present-test-plan";
import { probeEnv } from "./probe-env";
import { publishReports } from "./publish-reports";
import { runNextCase, runSequentialCases } from "./run-sequential";
import { finishRunArchive, startRunArchive } from "./write-archive";
import { paths } from "./paths";

const [, , command, ...args] = process.argv;

function print(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
	switch (command) {
		case "discover-project":
			print(discoverProject());
			break;
		case "discover-intent":
			print(discoverIntent(args.join(" ") || process.env.E2E_USER_INTENT));
			break;
		case "discover-routes":
			print(discoverRoutes(args[0]));
			break;
		case "discover-cases": {
			const union = args.includes("--union");
			print(
				discoverCases({
					union,
					domain: args.find((a) => !a.startsWith("--")),
				}),
			);
			break;
		}
		case "discover-from-diff":
			print(discoverFromDiff(args[0] || "origin/main"));
			break;
		case "discover-chaos":
			print(discoverChaos(args[0]));
			break;
		case "probe-env":
			applyLocalConfigToEnv();
			print(probeEnv({ adbOnly: args.includes("--adb-only") }));
			break;
		case "install-appium":
			print(installAppium());
			break;
		case "install-android-sdk":
			print(installAndroidSdk());
			break;
		case "present-test-plan":
			print(presentTestPlan());
			break;
		case "publish-reports":
			print(publishReports(args[0]));
			break;
		case "run-sequential": {
			const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
			print({ runId, results: runSequentialCases(runId) });
			break;
		}
		case "run-next-case": {
			const runId = args[0] || process.env.E2E_RUN_ID || `run-${Date.now()}`;
			print({ runId, result: runNextCase(runId) });
			break;
		}
		case "save-local-config": {
			const raw = args[0] || fs.readFileSync(0, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			writeLocalConfig({
				initialized: true,
				initializedAt: new Date().toISOString(),
				env: (parsed.env as Record<string, string>) || {},
			});
			print({ ok: true });
			break;
		}
		case "load-local-config":
			applyLocalConfigToEnv();
			print(readLocalConfig());
			break;
		case "archive-start": {
			const meta = args[0] ? JSON.parse(args[0]) : {};
			const runId = startRunArchive(meta);
			const { markRunStarted } = await import("../resilience/issue-ledger");
			markRunStarted(runId);
			print({ runId });
			break;
		}
		case "archive-finish":
			finishRunArchive((args[0] as "passed" | "failed" | "partial") || "passed");
			print({ ok: true });
			break;
		case "plan-only": {
			applyLocalConfigToEnv();
			discoverProject();
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
			};
			fs.writeFileSync(
				paths.runJson(),
				JSON.stringify({ mode: "plan-only", plan, at: new Date().toISOString() }, null, 2),
			);
			print(plan);
			break;
		}
		default:
			console.error(
				`Unknown command: ${command}\nCommands: discover-project, discover-intent, discover-routes, discover-cases, discover-from-diff, discover-chaos, probe-env, install-appium, present-test-plan, publish-reports, run-sequential, run-next-case, save-local-config, load-local-config, archive-start, archive-finish, plan-only`,
			);
			process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
