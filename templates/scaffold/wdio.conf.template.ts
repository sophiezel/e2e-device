import path from "node:path";
import fs from "node:fs";
import type { Options } from "@wdio/types";
import { getAndroidCapabilities } from "./config/app";
import { applyAndroidSdkEnv } from "./helpers/android-sdk";

applyAndroidSdkEnv();

const specsDir = path.join(__dirname, "specs");
const repoRoot = path.join(__dirname, "..");
const localAppium = path.join(repoRoot, "node_modules", ".bin", "appium");
const appiumCmd = fs.existsSync(localAppium) ? localAppium : "appium";

export const config: Options.Testrunner = {
	runner: "local",
	specs: [path.join(specsDir, "**/*.spec.ts")],
	maxInstances: 1,
	capabilities: [getAndroidCapabilities() as WebdriverIO.Capabilities],
	logLevel: "info" as const,
	bail: 0,
	waitforTimeout: 20000,
	connectionRetryTimeout: 120000,
	connectionRetryCount: 2,
	services: [
		[
			"appium",
			{
				command: appiumCmd,
				args: { relaxedSecurity: true, logLevel: "warn" },
			},
		],
	],
	framework: "mocha",
	reporters: ["spec"],
	mochaOpts: { ui: "bdd", timeout: 120000 },

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
		result: { passed?: boolean; title?: string },
	) => {
		if (!result.passed && result.title) {
			const { captureFailureArtifacts } = await import("./helpers/on-failure");
			await captureFailureArtifacts(result.title);
		}
		const { cleanupAfterTest } = await import("./helpers/reset-session");
		await cleanupAfterTest();
		const { resetRuntimeOverrides } = await import("./resilience/runtime-session");
		resetRuntimeOverrides();
	},

	onWorkerEnd: async () => {
		const { writeResilienceReports } = await import("./resilience/issue-ledger");
		writeResilienceReports();
	},

	onComplete: async () => {
		const { writeResilienceReports } = await import("./resilience/issue-ledger");
		writeResilienceReports();
	},
};
