/**
 * App capabilities configuration
 * Priority: env vars > .e2e-local.json app config > manifest
 * Supports Android (full) and iOS (placeholder).
 */

import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "./project-manifest";
import { readLocalConfig } from "./local-config";
import { resolveTargetPlatform, type TargetPlatform } from "./platform";

/** Resolve chromedriver binary path from env > local config > system PATH */
function resolveChromedriverPath(): string {
	const fromEnv = process.env.E2E_CHROMEDRIVER_PATH;
	if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

	// Check .e2e-local.json
	try {
		const local = readLocalConfig();
		const fromLocal = local?.env?.E2E_CHROMEDRIVER_PATH;
		if (fromLocal && fs.existsSync(fromLocal)) return fromLocal;
	} catch { /* read failed */ }

	// Check ~/.appium/chromedriver/
	const home = process.env.HOME || "";
	if (home) {
		const appiumDir = path.join(home, ".appium", "chromedriver");
		if (fs.existsSync(appiumDir)) {
			const entries = fs.readdirSync(appiumDir).filter((e) => e.startsWith("chromedriver"));
			for (const e of entries) {
				// Appium 3.x stores chromedriver in platform-named subfolders
				const bin = path.join(appiumDir, e, "chromedriver-mac-arm64", "chromedriver");
				const binAlt = path.join(appiumDir, e, "chromedriver");
				const actualBin = fs.existsSync(bin) ? bin : fs.existsSync(binAlt) ? binAlt : null;
				if (actualBin) return actualBin;
			}
		}
	}

	return "";
}

function loadAppFromLocalConfig(): { package: string; activity: string } | null {
	const local = readLocalConfig();
	if (local?.app?.android?.appPackage && local?.app?.android?.appActivity) {
		return {
			package: local.app.android.appPackage,
			activity: local.app.android.appActivity,
		};
	}
	return null;
}

export function getAndroidCapabilities(): Record<string, unknown> {
	// Priority 1: Environment variables
	let appPackage = process.env.E2E_APP_PACKAGE || "";
	let appActivity = process.env.E2E_APP_ACTIVITY || "";

	// Priority 2: .e2e-local.json app config
	if (!appPackage || !appActivity) {
		const appConfig = loadAppFromLocalConfig();
		if (appConfig) {
			appPackage = appPackage || appConfig.package;
			appActivity = appActivity || appConfig.activity;
		}
	}

	// Priority 3: manifest
	if (!appPackage || !appActivity) {
		try {
			const manifest = loadProjectManifest();
			appPackage = appPackage || manifest.hybrid.container.package || "";
			appActivity = appActivity || manifest.hybrid.container.openApiActivity || "";
		} catch {
			// ignore
		}
	}

	// Clean up unknown/empty values
	appPackage = appPackage && appPackage !== "unknown" ? appPackage : "";
	appActivity = appActivity || "";

	// Resolve chromedriver path (auto-detect + env override)
	const chromedriverPath = resolveChromedriverPath();

	return {
		platformName: "Android",
		"appium:automationName": "UiAutomator2",
		"appium:udid": process.env.ANDROID_UDID || process.env.E2E_DEVICE_SERIAL,
		"appium:noReset": true,
		"appium:skipDeviceInitialization": true,
		"appium:skipUnlock": true,
		"appium:adbExecTimeout": 120000,
		"appium:newCommandTimeout": 120,
		// v2: skip Appium server-level driver/plugin installation (Appium 2.x+ managed externally)
		"appium:skipServerInstallation": true,
		// Chromedriver: explicit path > auto-download.  uiautomator2@7.x dropped chromedriverAutodownload.
		...(chromedriverPath ? { "appium:chromedriverExecutable": chromedriverPath } : {}),
		// Only include appPackage/appActivity when E2E_APPIUM_LAUNCH_APP=1 (default: spec manages App lifecycle via ADB deep link)
		...(process.env.E2E_APPIUM_LAUNCH_APP === "1" && appPackage
			? { "appium:appPackage": appPackage, "appium:appActivity": appActivity }
			: {}),
	};
}

/** iOS capabilities placeholder — implement when iOS support is needed */
export function getIosCapabilities(): Record<string, unknown> {
	throw new Error(
		"iOS capabilities not yet implemented. " +
		"Set E2E_PLATFORM=android or unset E2E_PLATFORM to use Android.",
	);
}

/** Get capabilities for the current target platform */
export function getCapabilities(platform?: TargetPlatform): Record<string, unknown> {
	const p = platform || resolveTargetPlatform();
	if (p === "ios") return getIosCapabilities();
	return getAndroidCapabilities();
}
