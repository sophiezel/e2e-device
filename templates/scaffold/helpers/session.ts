/**
 * Device session preparation with vendor-aware self-healing.
 * Handles system dialog dismissal, WebView context refresh,
 * and chromedriver sanity check before tests run.
 */

import { browser } from "@wdio/globals";
import { timeouts } from "../config/timeouts";
import { getDeviceBridge } from "./device-bridge";
import { detectVendor, classifyVendor, getVendorWorkarounds, applyVendorWorkarounds } from "./android-vendor";
import { ensureChromedriver } from "./app-launcher";

/**
 * Dismiss common system dialogs using the DeviceBridge (platform-agnostic).
 */
function dismissSystemDialogs(): void {
	const bridge = getDeviceBridge();
	bridge.dismissDialogs();
}

/** Run vendor detection and apply workarounds at session start. */
function applyVendorConfig(): void {
	try {
		const v = detectVendor();
		const clazz = classifyVendor(v);
		const workarounds = getVendorWorkarounds(clazz);
		applyVendorWorkarounds(workarounds);

		console.log(
			`[session] Vendor: ${v.manufacturer} ${v.model} (${clazz}) ` +
			`Android ${v.androidVersion} | WebView: ${v.webViewPackage || "?"} v${v.webViewVersion || "?"}`,
		);

		// Ensure chromedriver is ready
		if (v.webViewVersion) {
			const cdPath = ensureChromedriver(v.webViewVersion);
			if (cdPath) {
				console.log(`[session] Chromedriver: ${cdPath}`);
			}
		}
	} catch {
		// vendor detection is best-effort
	}
}

/** Check if the webview context is available. */
async function checkAppForeground(): Promise<void> {
	try {
		const contexts = await browser.getContexts();
		console.log("[session] Available contexts:", contexts);
	} catch {
		console.log("[session] Could not get contexts (expected on cold start)");
	}
}

export async function prepareDeviceSession(): Promise<void> {
	// Step 1: Apply vendor-specific workarounds
	applyVendorConfig();

	// Step 2: Dismiss system dialogs that may block the app
	dismissSystemDialogs();

	// Step 3: Wait for app to be ready
	await browser.pause(timeouts.sessionPrepare);

	// Step 4: Verify app state
	await checkAppForeground();
}
