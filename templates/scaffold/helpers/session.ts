/**
 * Device session preparation
 */

import { browser } from "@wdio/globals";

export async function prepareDeviceSession(): Promise<void> {
	// Wait for app to be ready
	await browser.pause(2000);

	// Log current context for debugging
	try {
		const contexts = await browser.getContexts();
		console.log("[session] Available contexts:", contexts);
	} catch (e) {
		console.log("[session] Could not get contexts:", e);
	}
}
