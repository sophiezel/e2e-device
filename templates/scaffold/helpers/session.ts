/**
 * Device session preparation.
 * Handles system dialog dismissal and app state verification before tests.
 */

import { browser } from "@wdio/globals";
import { timeouts } from "../config/timeouts";
import { getDeviceBridge } from "./device-bridge";

/**
 * Dismiss common system dialogs using the DeviceBridge (platform-agnostic).
 */
function dismissSystemDialogs(): void {
	const bridge = getDeviceBridge();
	bridge.dismissDialogs();
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
