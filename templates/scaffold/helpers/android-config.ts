/**
 * Auto-detect Android app configuration via ADB
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../orchestration/paths";
import { readLocalConfig, writeLocalConfig, type E2eLocalConfig } from "../config/local-config";

export interface AppConfig {
	package: string;
	activity: string;
}

/** Check if ADB is available and device is connected */
export function checkAdbAvailable(): { ok: boolean; error?: string } {
	try {
		const output = execFileSync("adb", ["devices"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
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
		const output = execFileSync("adb", ["shell", "dumpsys", "window"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Find mCurrentFocus line
		const focusLine = output.split("\n").find((l) => l.includes("mCurrentFocus"));
		if (!focusLine) return null;

		// Parse: mCurrentFocus=Window{... u0 com.example.app/com.example.app.MainActivity ...}
		// Support multi-user: u0, u1, u10, etc.
		const match = focusLine.match(/u\d+\s+([^/]+)\/([^}]+)/);
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
		const output = execFileSync("adb", ["shell", "dumpsys", "package", pkg], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Find lines with android.intent.action.MAIN
		const lines = output.split("\n");
		const mainIdx = lines.findIndex((l) => l.includes("android.intent.action.MAIN"));
		if (mainIdx === -1 || mainIdx + 1 >= lines.length) return null;

		// Parse the next line for activity reference
		const nextLine = lines[mainIdx + 1];
		const match = nextLine.match(new RegExp(`${pkg.replace(/\./g, "\\.")}/([^\\s]+)`));
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

	const cfg: Partial<E2eLocalConfig> = { app: appData as E2eLocalConfig["app"] };
	writeLocalConfig(cfg);
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
