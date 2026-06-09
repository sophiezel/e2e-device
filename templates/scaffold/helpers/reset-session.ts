import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { loadProjectManifest } from "../config/project-manifest";

/**
 * Clean up all test data between specs to ensure isolation.
 * Clears: localStorage, sessionStorage, cookies, and optionally SharedPreferences.
 * Skips cleanup in NATIVE_APP context to avoid costly retry loops (404/405).
 */

/** Quick check: is the current context a WebView? */
async function isWebViewContext(): Promise<boolean> {
	try {
		const ctx = await browser.getContext();
		return !!ctx && ctx !== "NATIVE_APP";
	} catch {
		return false;
	}
}

async function clearWebStorage(): Promise<void> {
	if (!(await isWebViewContext())) return;
	try {
		await browser.execute(() => {
			try {
				localStorage.clear();
				sessionStorage.clear();
			} catch {
				// Some WebView environments may restrict storage access
			}
		});
	} catch {
		// WebView may not be available (e.g. during native-only steps)
	}
}

async function clearCookies(): Promise<void> {
	if (!(await isWebViewContext())) return;
	try {
		await browser.deleteAllCookies();
	} catch {
		// Cookie deletion may fail if WebView context is not active
	}
}

function clearSharedPreferences(): void {
	try {
		const m = loadProjectManifest();
		const pkg = m.hybrid?.container?.package;
		if (!pkg) return;

		// Only clear E2E-related prefs, not the entire app data
		execFileSync(
			"adb",
			["shell", "run-as", pkg, "rm", "-rf", "/data/data/" + pkg + "/shared_prefs/"],
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 },
		);
	} catch {
		// run-as may fail on non-debuggable builds; non-critical
	}
}

/**
 * Full cleanup between test cases.
 * Ensures spec isolation: no localStorage, sessionStorage, or cookie leakage.
 */
export async function cleanupAfterTest(): Promise<void> {
	console.log("[reset-session] Cleaning up test data...");

	await clearCookies();
	await clearWebStorage();

	// Clear SharedPreferences only when opted-in (can be destructive)
	if (process.env.E2E_CLEAR_SHARED_PREFS === "1") {
		clearSharedPreferences();
	}

	console.log("[reset-session] Cleanup complete");
}
