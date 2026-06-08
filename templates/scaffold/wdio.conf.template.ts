import path from "node:path";
import fs from "node:fs";
import type { Options } from "@wdio/types";
import { getCapabilities } from "./config/app";
import { applyAndroidSdkEnv } from "./helpers/android-sdk";
import { timeouts } from "./config/timeouts";

applyAndroidSdkEnv();

/**
 * Resolve appium command with priority:
 * 1. E2E_APPIUM_BIN environment variable
 * 2. Project local node_modules/.bin/appium
 * 3. Skill directory node_modules/.bin/appium
 * 4. Global appium
 */
function resolveAppiumCommand(): string {
	const repoRoot = path.join(__dirname, "..");
	const skillRoot =
		process.env.E2E_DEVICE_SKILL_ROOT ||
		path.join(process.env.HOME || "", ".agents", "skills", "e2e-device");

	// Priority 0: Environment variable override
	const envBin = process.env.E2E_APPIUM_BIN;
	if (envBin && fs.existsSync(envBin)) {
		return envBin;
	}

	// Priority 1: Project local
	const projectAppium = path.join(repoRoot, "node_modules", ".bin", "appium");
	if (fs.existsSync(projectAppium)) {
		return projectAppium;
	}

	// Priority 2: Skill directory
	const skillAppium = path.join(skillRoot, "node_modules", ".bin", "appium");
	if (fs.existsSync(skillAppium)) {
		return skillAppium;
	}

	// Fallback to global
	return "appium";
}

const specsDir = path.join(__dirname, "specs");
const appiumCmd = resolveAppiumCommand();

export const config: Options.Testrunner = {
	runner: "local",
	specs: [path.join(specsDir, "**/*.spec.ts")],
	maxInstances: 1,
	capabilities: [getCapabilities() as WebdriverIO.Capabilities],
	logLevel: "info" as const,
	bail: 0,
	waitforTimeout: timeouts.wdioWaitFor,
	connectionRetryTimeout: timeouts.wdioConnectionRetry,
	connectionRetryCount: 2,
	services: [
		[
			"appium",
			{
				command: appiumCmd,
				// Set E2E_APPIUM_RELAXED_SECURITY=1 to disable Appium security checks (needed for some deep link / context switch scenarios)
				args: { relaxedSecurity: process.env.E2E_APPIUM_RELAXED_SECURITY === "1", logLevel: "warn" },
			},
		],
	],
	framework: "mocha",
	reporters: [
		"spec",
		[
			"json",
			{
				outputDir: process.env.E2E_RUN_ID
					? path.join("e2e-device", "artifacts", "runs", process.env.E2E_RUN_ID)
					: path.join("e2e-device", "artifacts"),
				outputFileFormat: () => "wdio-<cid>-report.json",
			},
		],
	],
	mochaOpts: { ui: "bdd", timeout: timeouts.mochaTest },

	onPrepare: async () => {
		const { applyLocalConfigToEnv } = await import("./config/local-config");
		const { applyCredentials } = await import("./helpers/credentials");
		const { applyProfileDefaults } = await import("./config/run-profile");
		applyLocalConfigToEnv();
		applyCredentials();
		applyProfileDefaults();
		const { assertDeviceOnline } = await import("./helpers/adb");
		assertDeviceOnline();
		const { markSpecStarted } = await import("./resilience/issue-ledger");
		markSpecStarted(process.env.E2E_CURRENT_SPEC || "unknown");
	},

	before: async () => {
		const { prepareDeviceSession } = await import("./helpers/session");
		await prepareDeviceSession();
	},

	afterTest: async (
		_test: unknown,
		_context: unknown,
		_result: { passed?: boolean; title?: string },
	) => {
		if (!_result.passed && _result.title) {
			const { captureFailureArtifacts } = await import("./helpers/on-failure");
			await captureFailureArtifacts(_result.title);
		}
		const { cleanupAfterTest } = await import("./helpers/reset-session");
		await cleanupAfterTest();
		const { resetRuntimeOverrides } = await import("./resilience/runtime-session");
		resetRuntimeOverrides();
	},

	onWorkerEnd: async () => {
		// Resilience reports are written in onComplete; no-op here to avoid duplication
	},

	onComplete: async () => {
		const { writeResilienceReports } = await import("./resilience/issue-ledger");
		writeResilienceReports();
	},
};
