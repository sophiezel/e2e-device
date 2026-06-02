/**
 * Android app capabilities configuration
 * Priority: env vars > .e2e-local.json app config > manifest
 */

import { loadProjectManifest } from "./project-manifest";
import { readLocalConfig } from "./local-config";

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

	return {
		platformName: "Android",
		"appium:automationName": "UiAutomator2",
		"appium:udid": process.env.ANDROID_UDID || process.env.E2E_DEVICE_SERIAL,
		"appium:noReset": true,
		"appium:skipDeviceInitialization": true,
		"appium:skipUnlock": true,
		"appium:adbExecTimeout": 120000,
		"appium:newCommandTimeout": 240,
		"appium:chromedriverAutodownload": true,
		...(appPackage ? { "appium:appPackage": appPackage } : {}),
		...(appActivity ? { "appium:appActivity": appActivity } : {}),
	};
}
