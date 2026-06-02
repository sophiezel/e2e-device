/**
 * Auto-detect Android app configuration via ADB
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../orchestration/paths";
import { readLocalConfig, writeLocalConfig } from "../config/local-config";

export interface AppConfig {
	package: string;
	activity: string;
}

/** Check if ADB is available and device is connected */
export function checkAdbAvailable(): { ok: boolean; error?: string } {
	try {
		const output = execSync("adb devices", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		const lines = output.split("\n").filter((l) => l.includes("\t"));
		const devices = lines.filter((l) => l.includes("\tdevice"));
		const unauthorized = lines.filter((l) => l.includes("unauthorized"));

		if (unauthorized.length > 0) {
			return { ok: false, error: "设备未授权，请在手机上允许 USB 调试" };
		}
		if (devices.length === 0) {
			return { ok: false, error: "未检测到已连接的 USB 设备，请插入真机并开启 USB 调试" };
		}
		return { ok: true };
	} catch {
		return { ok: false, error: "ADB 未安装，请安装 Android platform-tools" };
	}
}

/** Get current foreground app package and activity */
export function detectForegroundApp(): AppConfig | null {
	try {
		const output = execSync("adb shell dumpsys window | grep mCurrentFocus", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Parse: mCurrentFocus=Window{... u0 com.example.app/com.example.app.MainActivity ...}
		const match = output.match(/u0\s+([^/]+)\/([^}]+)/);
		if (!match) {
			return null;
		}

		return {
			package: match[1],
			activity: match[2],
		};
	} catch {
		return null;
	}
}

/** Get launch activity for a package */
export function detectLaunchActivity(pkg: string): string | null {
	try {
		const output = execSync(
			`adb shell dumpsys package ${pkg} | grep -A1 "android.intent.action.MAIN"`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);

		// Parse: 11947a com.example.app/.activity.SplashActivity filter ...
		const match = output.match(new RegExp(`${pkg.replace(/\./g, "\\.")}/([^\\s]+)`));
		return match ? `${pkg}/${match[1]}` : null;
	} catch {
		return null;
	}
}

/** Load app config from .e2e-local.json */
export function loadAppJson(): AppConfig | null {
	const local = readLocalConfig();
	if (local?.app?.android?.appPackage && local?.app?.android?.appActivity) {
		return {
			package: local.app.android.appPackage,
			activity: local.app.android.appActivity,
		};
	}
	return null;
}

/** Save app config to .e2e-local.json */
export function saveAppJson(config: AppConfig, pageOrigin?: string): void {
	const appData: Record<string, unknown> = {
		android: {
			appPackage: config.package,
			appActivity: config.activity,
		},
	};

	if (pageOrigin) {
		appData.h5 = { pageOrigin };
	}

	writeLocalConfig({ app: appData as any });
}

/** Auto-detect and save app config */
export function autoDetectAndSaveAppConfig(): AppConfig | null {
	// 1. Check ADB
	const adbCheck = checkAdbAvailable();
	if (!adbCheck.ok) {
		console.error(`\n❌ ${adbCheck.error}\n`);
		return null;
	}

	// 2. Detect foreground app
	const foreground = detectForegroundApp();
	if (!foreground) {
		console.error("\n❌ 无法检测当前前台 App，请确保 App 已打开\n");
		return null;
	}

	// 3. Detect launch activity
	const launchActivity = detectLaunchActivity(foreground.package);
	const activity = launchActivity || foreground.activity;

	return {
		package: foreground.package,
		activity: activity,
	};
}
