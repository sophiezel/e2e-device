/**
 * Device session preparation.
 * Handles system dialog dismissal and app state verification before tests.
 */

import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { timeouts } from "../config/timeouts";

/**
 * Dismiss common Android system dialogs using BACK key press.
 * Avoids force-stop which can destabilize the system.
 */
function dismissSystemDialogs(): void {
	try {
		// Check if a system dialog is in foreground
		const dumpResult = execFileSync("adb", ["shell", "dumpsys", "window", "displays"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 5000,
		}).toString();

		const systemDialogPackages = [
			"com.android.permissioncontroller",
			"com.google.android.permissioncontroller",
			"com.android.packageinstaller",
			"com.android.systemui",
		];

		const hasSystemDialog = systemDialogPackages.some((pkg) =>
			dumpResult.includes(`mCurrentFocus=Window{`) && dumpResult.includes(pkg),
		);

		if (hasSystemDialog) {
			// Press BACK to dismiss the dialog instead of force-stopping
			execFileSync("adb", ["shell", "input", "keyevent", "KEYCODE_BACK"], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: 3000,
			});
		}
	} catch {
		// dumpsys or input may fail; non-critical, continue
	}
}

/** Check if the app is in foreground */
async function checkAppForeground(): Promise<void> {
	try {
		const contexts = await browser.getContexts();
		console.log("[session] Available contexts:", contexts);
	} catch (e) {
		console.log("[session] Could not get contexts:", e);
	}
}

export async function prepareDeviceSession(): Promise<void> {
	// Dismiss system dialogs that may block the app
	dismissSystemDialogs();

	// Wait for app to be ready
	await browser.pause(timeouts.sessionPrepare);

	// Verify app state
	await checkAppForeground();
}
