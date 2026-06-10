/**
 * App launcher — open H5 pages via ADB deep link or activity launch.
 */
import { execFileSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { resolvePageOrigin } from "./build-h5-url";
import { loadProjectManifest } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";

/** Check if app is in foreground via ADB. Returns true if package matches current focus. */
function isAppInForeground(pkg: string): boolean {
	try {
		const out = execFileSync("adb", ["shell", "dumpsys", "window"], {
			encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
		});
		return out.includes(pkg);
	} catch {
		return false;
	}
}

/** Wake device screen, dismiss lock, keep screen on during tests. */
function wakeDevice(): void {
	try {
		// System-level: prevent screen from sleeping during test session
		execFileSync("adb", ["shell", "svc", "power", "stayon", "true"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
		// Wake screen (power button toggle — works regardless of current state)
		execFileSync("adb", ["shell", "input", "keyevent", "224"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); // KEYCODE_WAKEUP
		// Dismiss lock screen (swipe up is most universal)
		execFileSync("adb", ["shell", "input", "swipe", "500", "2000", "500", "500"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
		execFileSync("adb", ["shell", "input", "keyevent", "3"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); // Home
	} catch { /* best-effort */ }
}

/** Restore screen sleep to normal (call at end of test session). */
export function restoreScreenSleep(): void {
	try {
		execFileSync("adb", ["shell", "svc", "power", "stayon", "false"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
	} catch { /* best-effort */ }
}

/** Ensure the app is in the foreground. If not, wake device and launch it. */
export function ensureAppForeground(): void {
	const m = loadProjectManifest();
	const pkg = m.hybrid?.container?.package || "";
	if (!pkg || pkg === "unknown") {
		console.warn("[app-launcher] package unknown, cannot ensure foreground");
		return;
	}

	if (isAppInForeground(pkg)) return;

	// Wake device first (screen may be off/locked)
	wakeDevice();

	// Wait a moment for device to settle
	try { execFileSync("sleep", ["2"], { timeout: 3000 }); } catch {}

	// Wake/launch the app via its scheme + openapi authority (minimal URL)
	const scheme = m.hybrid?.deepLink?.scheme;
	const pageOrigin = resolvePageOrigin() || "";
	const openPath = m.hybrid?.deepLink?.openPath || "h5";
	if (scheme && pageOrigin) {
		const wakeUrl = `${scheme}://${openPath}?url=${encodeURIComponent(pageOrigin)}`;
		try {
			execFileSync("adb", ["shell", "am", "start",
				"-a", "android.intent.action.VIEW",
				"-c", "android.intent.category.BROWSABLE",
				"-d", wakeUrl,
			], { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
			console.log(`[app-launcher] Waking app via ${wakeUrl}`);
		} catch { /* best-effort */ }
	} else {
		// Fallback: monkey launch
		try {
			execFileSync("adb", ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"],
				{ encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
		} catch { /* best-effort */ }
	}
}

/**
 * Open an H5 page via ADB deep link using the manifest's deep link scheme.
 * Uses manifest.deepLink.h5Action (auto-detected from Android source if available).
 */
export function openH5ViaAdb(routePath: string): void {
	const pageOrigin = resolvePageOrigin();
	if (!pageOrigin) {
		throw new Error(
			"pageOrigin missing. Set E2E_PAGE_ORIGIN or run discover-project.",
		);
	}

	const m = loadProjectManifest();
	const scheme = m.hybrid?.deepLink?.scheme || "";
	const targetUrl = `${pageOrigin}/${routePath.replace(/^\//, "")}`;

	if (scheme) {
		const openPath = m.hybrid?.deepLink?.openPath || "openapi";
		const h5Action = m.hybrid?.deepLink?.h5Action || "openWebview";

		// Format: scheme://authority/action?url=<encoded>
		// Example: jiangz://openapi/openWebview?url=https%3A%2F%2F...
		const deepLinkUrl = `${scheme}://${openPath}/${h5Action}?url=${encodeURIComponent(targetUrl)}`;
		execFileSync(
			"adb",
			["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", deepLinkUrl],
			{ encoding: "utf-8", timeout: 10000 },
		);
	} else {
		// Fallback: use generic VIEW intent with the full H5 URL
		execFileSync(
			"adb",
			["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", targetUrl],
			{ encoding: "utf-8", timeout: 10000 },
		);
	}
}

/**
 * Probe multiple deep link URL formats and return the first one that produces
 * a WebView context. Used as fallback when auto-detected format doesn't work.
 * Returns the successful URL or null if none worked.
 */
export function probeDeepLinkFormats(routePath: string): string | null {
	const m = loadProjectManifest();
	const scheme = m.hybrid?.deepLink?.scheme || "";
	const openPath = m.hybrid?.deepLink?.openPath || "openapi";
	const pageOrigin = resolvePageOrigin();
	if (!scheme || !pageOrigin) return null;

	const targetUrl = `${pageOrigin}/${routePath.replace(/^\//, "")}`;
	const encoded = encodeURIComponent(targetUrl);

	// Ordered by likelihood (from Android source code analysis)
	const candidates = [
		`${scheme}://${openPath}/openWebview?url=${encoded}`,
		`${scheme}://${openPath}?url=${encoded}`,
		targetUrl,  // direct HTTP URL as last resort
	];

	for (const url of candidates) {
		try {
			execFileSync("adb", ["shell", "am", "start",
				"-a", "android.intent.action.VIEW", "-d", url,
			], { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
			console.log(`[app-launcher] Probing: ${url}`);
			return url;
		} catch { /* try next */ }
	}
	return null;
}

/**
 * Launch the app's main activity via ADB.
 */
export function launchMainActivity(): void {
	const m = loadProjectManifest();
	const pkg = m.hybrid?.container?.package || "";
	const activity = m.hybrid?.container?.openApiActivity || "";

	if (!pkg || !activity) {
		throw new Error(
			"App package/activity not configured. Run discover-project or set in skill.project.json.",
		);
	}

	const component = activity.includes("/")
		? activity
		: `${pkg}/${activity}`;

	execFileSync(
		"adb",
		["shell", "am", "start", "-n", component],
		{ encoding: "utf-8", timeout: 10000 },
	);
}
