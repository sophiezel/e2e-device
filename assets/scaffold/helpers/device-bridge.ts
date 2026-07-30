/**
 * DeviceBridge — platform-agnostic device control interface.
 *
 * Android implementation wraps ADB commands.
 * iOS implementation is reserved (will wrap xcrun simctl / tidevice).
 *
 * All direct ADB calls should eventually route through this bridge.
 */

import { execFileSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { timeouts } from "../config/timeouts";

// ===== Interface =====

export interface DeviceBridge {
	/** Platform identifier (android | ios). */
	readonly platform: "android" | "ios";

	/** Get the connected device state (e.g., "device", "offline", "unauthorized"). */
	getDeviceState(): string;

	/** Launch an app by package name. */
	launchApp(packageName: string): void;

	/** Open a URL via deep link or browser intent. */
	openUrl(url: string): void;

	/** Dismiss system dialogs (permissions, overlays). */
	dismissDialogs(): void;

	/** Get the currently foreground package name. */
	getForegroundPackage(): string;

	/** Terminate (force-stop) an app by package name. */
	terminateApp(packageName: string): void;

	/** Execute an arbitrary shell command on the device. */
	shell(cmd: string, timeout?: number): string;
}

// ===== Android Implementation =====

export class AndroidBridge implements DeviceBridge {
	readonly platform = "android" as const;

	getDeviceState(): string {
		try {
			return execFileSync("adb", ["get-state"], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 5000,
			}).trim();
		} catch {
			return "offline";
		}
	}

	launchApp(packageName: string): void {
		execFileSync("adb", ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
		});
	}

	openUrl(url: string): void {
		execFileSync("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		});
	}

	dismissDialogs(): void {
		try {
			const dump = this.shell("dumpsys window displays");
			const dialogPkgs = [
				"com.android.permissioncontroller",
				"com.google.android.permissioncontroller",
				"com.android.packageinstaller",
			];
			const onPermissionDialog = dialogPkgs.some(
				(pkg) => dump.includes("mCurrentFocus=Window{") && dump.includes(pkg),
			);
			if (onPermissionDialog) {
				console.warn(
					"[device-bridge] Permission dialog detected — use run.sh preflight pm grant or tap Allow manually (no BACK)",
				);
			}
		} catch {
			// non-critical
		}
	}

	getForegroundPackage(): string {
		try {
			const focus = this.shell("dumpsys window | grep mCurrentFocus");
			const m = focus.match(/u0\s+([^/]+)\//) || focus.match(/\s(\S+)\//);
			return m ? m[1].trim() : "";
		} catch {
			return "";
		}
	}

	terminateApp(packageName: string): void {
		try {
			this.shell(`am force-stop ${packageName}`);
		} catch {
			// app may not be running
		}
	}

	shell(cmd: string, timeout = 5000): string {
		return execFileSync("adb", ["shell", cmd], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout,
		}).trim();
	}
}

// ===== iOS Implementation (Reserved — not instantiated until getDeviceBridge is updated) =====

export class IOSBridge implements DeviceBridge {
	readonly platform = "ios" as const;

	getDeviceState(): string {
		throw new Error("iOS support not yet implemented. Use E2E_PLATFORM=android.");
	}

	launchApp(_packageName: string): void {
		throw new Error("iOS support not yet implemented");
	}

	openUrl(_url: string): void {
		// Reserved: xcrun simctl openurl booted <url> (simulator)
		// Reserved: idevicedebug run <app> (real device via libimobiledevice)
		throw new Error("iOS support not yet implemented");
	}

	dismissDialogs(): void {
		// iOS system dialogs handled differently (SpringBoard alerts)
	}

	getForegroundPackage(): string {
		throw new Error("iOS support not yet implemented");
	}

	terminateApp(_packageName: string): void {
		throw new Error("iOS support not yet implemented");
	}

	shell(_cmd: string, _timeout?: number): string {
		throw new Error("iOS support not yet implemented");
	}
}

// ===== Bridge Factory =====

let _bridge: DeviceBridge | undefined;

/** Get or create the platform-appropriate DeviceBridge instance. */
export function getDeviceBridge(): DeviceBridge {
	if (_bridge) return _bridge;

	const platform = (process.env.E2E_PLATFORM || "android").toLowerCase();
	if (platform === "ios") {
		throw new Error(
			"iOS E2E is not yet supported. Use E2E_PLATFORM=android or see references/arch-details.md for roadmap.",
		);
	}
	_bridge = new AndroidBridge();
	return _bridge;
}

/** Reset the cached bridge (mainly for testing). */
export function resetDeviceBridge(): void {
	_bridge = undefined;
}
