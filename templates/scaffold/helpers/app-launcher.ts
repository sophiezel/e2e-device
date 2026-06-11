/**
 * App launcher — open H5 pages via ADB deep link or activity launch.
 *
 * Self-healing features:
 * - Multi-format deep link probing (3 formats, ordered by likelihood)
 * - Vendor-aware launch fallbacks (monkey → activity → deeplink)
 * - Screen wake + PIN unlock + swipe-to-unlock
 * - Persistent chromedriver path caching
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { resolvePageOrigin } from "./build-h5-url";
import { loadProjectManifest } from "../config/project-manifest";
import { switchToWebViewContaining } from "./webview-context";
import { timeouts } from "../config/timeouts";

// ── ADB Helpers ──────────────────────────────────────────────────────

function adbShell(cmd: string, timeout = 5000): string {
	try {
		return execFileSync("adb", ["shell", cmd], {
			encoding: "utf-8", timeout, stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
}

/** Check if app is in foreground via ADB. */
function isAppInForeground(pkg: string): boolean {
	try {
		const out = execFileSync("adb", ["shell", "dumpsys", "window", "windows"],
			{ encoding: "utf-8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"] });
		return out.includes(`mCurrentFocus`) && out.includes(pkg);
	} catch {
		return false;
	}
}

/** Get the Chrome/WebView version from the device. */
function getDeviceWebViewVersion(): string {
	const info = adbShell(`dumpsys package com.google.android.webview 2>/dev/null | grep versionName | head -1`);
	if (info) {
		const m = info.match(/versionName=([^\s]+)/);
		if (m) return m[1];
	}
	// Fallback: try Chrome
	const chromeInfo = adbShell(`dumpsys package com.android.chrome 2>/dev/null | grep versionName | head -1`);
	if (chromeInfo) {
		const m = chromeInfo.match(/versionName=([^\s]+)/);
		if (m) return m[1];
	}
	return "";
}

// ── Screen / Lock Management ─────────────────────────────────────────

function wakeDevice(): void {
	try {
		execFileSync("adb", ["shell", "svc", "power", "stayon", "true"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
		execFileSync("adb", ["shell", "settings", "put", "global", "stay_on_while_plugged_in", "7"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
		execFileSync("adb", ["shell", "input", "keyevent", "224"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); // WAKEUP

		const pin = process.env.E2E_DEVICE_PIN;
		if (pin && /^\d+$/.test(pin)) {
			for (const ch of pin) {
				execFileSync("adb", ["shell", "input", "keyevent", String(7 + parseInt(ch, 10))],
					{ encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] });
			}
			execFileSync("adb", ["shell", "input", "keyevent", "66"],
				{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); // ENTER
		} else {
			execFileSync("adb", ["shell", "input", "swipe", "500", "2000", "500", "500"],
				{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
		}
		execFileSync("adb", ["shell", "input", "keyevent", "3"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); // HOME
	} catch { /* best-effort */ }
}

export function restoreScreenSleep(): void {
	try {
		execFileSync("adb", ["shell", "svc", "power", "stayon", "false"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] });
	} catch { /* best-effort */ }
}

// ── Chromedriver Auto-Download (vendor self-healing) ────────────────

/**
 * Auto-download matching chromedriver for the device's WebView version.
 * Downloads to ~/.appium/chromedriver/ directory so Appium auto-discovers it.
 */
export function ensureChromedriver(webViewVersion?: string): string | null {
	const version = webViewVersion || getDeviceWebViewVersion();
	if (!version) return null;

	const major = version.split(".")[0];
	if (!major) return null;

	const home = process.env.HOME || "";
	const cdDir = path.join(home, ".appium", "chromedriver");

	// Check if already have a matching chromedriver
	if (fs.existsSync(cdDir)) {
		const entries = fs.readdirSync(cdDir).filter(e => e.startsWith("chromedriver"));
		for (const e of entries) {
			const binPath = path.join(cdDir, e, "chromedriver-mac-arm64", "chromedriver");
			const binAlt = path.join(cdDir, e, "chromedriver");
			const actual = fs.existsSync(binPath) ? binPath : fs.existsSync(binAlt) ? binAlt : null;
			if (actual && e.includes(major)) {
				console.log(`[chromedriver] Found matching chromedriver v${major} at ${actual}`);
				process.env.E2E_CHROMEDRIVER_PATH = actual;
				return actual;
			}
		}
	}

	// Auto-download from Chrome for Testing
	try {
		// Get exact version from milestones API
		const url = `https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone.json`;
		const resp = execFileSync("curl", ["-sL", url], {
			encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
		});
		const milestones = JSON.parse(resp).milestones || {};
		const milestone = milestones[major];
		const exactVersion = milestone?.version;

		if (!exactVersion) {
			console.warn(`[chromedriver] No version info for Chrome ${major}`);
			return null;
		}

		const downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${exactVersion}/mac-arm64/chromedriver-mac-arm64.zip`;
		const targetDir = path.join(cdDir, `chromedriver-${exactVersion}`);
		const zipPath = path.join(targetDir, "chromedriver.zip");
		const binPath = path.join(targetDir, "chromedriver-mac-arm64", "chromedriver");

		fs.mkdirSync(targetDir, { recursive: true });
		console.log(`[chromedriver] Downloading chromedriver v${exactVersion}...`);
		execFileSync("curl", ["-sL", downloadUrl, "-o", zipPath], {
			encoding: "utf-8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
		});
		execFileSync("unzip", ["-o", zipPath, "-d", targetDir], {
			encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
		});

		if (fs.existsSync(binPath)) {
			fs.chmodSync(binPath, 0o755);
			process.env.E2E_CHROMEDRIVER_PATH = binPath;
			console.log(`[chromedriver] Downloaded to ${binPath}`);

			// Persist to .e2e-local.json
			try {
				const localFile = path.join(process.cwd(), "e2e-device", ".e2e-local.json");
				if (fs.existsSync(localFile)) {
					const cfg = JSON.parse(fs.readFileSync(localFile, "utf-8"));
					cfg.env = cfg.env || {};
					cfg.env.E2E_CHROMEDRIVER_PATH = binPath;
					fs.writeFileSync(localFile, JSON.stringify(cfg, null, 2), "utf-8");
				}
			} catch { /* best-effort */ }

			return binPath;
		}
	} catch (err) {
		console.warn(`[chromedriver] Auto-download failed:`, (err as Error).message);
	}

	return null;
}

// ── Force-stop + re-launch (clean state for vendor devices) ─────────

/**
 * Force-stop and re-launch the app.
 * Useful for vendor devices that keep WebView state across launches.
 */
export function forceRestartApp(pkg: string): void {
	try {
		execFileSync("adb", ["shell", "am", "force-stop", pkg],
			{ encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
		execFileSync("adb", ["shell", "input", "keyevent", "3"],
			{ encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }); // HOME
		execFileSync("sleep", ["2"], { timeout: 3000 });
	} catch { /* best-effort */ }
}

// ── Deep Link Probes ─────────────────────────────────────────────────

/**
 * Probe multiple deep link URL formats and launch the first one that works.
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

	// Ordered by likelihood (from Android source analysis)
	const candidates = [
		`${scheme}://${openPath}/openWebview?url=${encoded}`,  // with action
		`${scheme}://${openPath}?url=${encoded}`,                // no action
		targetUrl,                                                // HTTP fallback
	];

	for (const url of candidates) {
		try {
			execFileSync("adb", ["shell", "am", "start",
				"-a", "android.intent.action.VIEW", "-d", url,
			], { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
			console.log(`[app-launcher] DeepLink probed: ${url}`);
			return url;
		} catch {
			console.warn(`[app-launcher] DeepLink failed: ${url}`);
		}
	}
	return null;
}

// ── App Foreground & Launch ──────────────────────────────────────────

export function ensureAppForeground(): void {
	const m = loadProjectManifest();
	const pkg = m.hybrid?.container?.package || "";
	if (!pkg || pkg === "unknown") {
		console.warn("[app-launcher] package unknown, cannot ensure foreground");
		return;
	}

	if (isAppInForeground(pkg)) return;

	wakeDevice();
	try { execFileSync("sleep", ["2"], { timeout: 3000 }); } catch {}

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
		try {
			execFileSync("adb", ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"],
				{ encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
		} catch { /* best-effort */ }
	}
}

/**
 * Open an H5 page via ADB deep link.
 * Automatically probes multiple URL formats if needed.
 */
export function openH5ViaAdb(routePath: string): void {
	const pageOrigin = resolvePageOrigin();
	if (!pageOrigin) {
		throw new Error("pageOrigin missing. Set E2E_PAGE_ORIGIN or run discover-project.");
	}

	const m = loadProjectManifest();
	const scheme = m.hybrid?.deepLink?.scheme || "";
	const targetUrl = `${pageOrigin}/${routePath.replace(/^\//, "")}`;

	if (scheme) {
		const openPath = m.hybrid?.deepLink?.openPath || "openapi";
		const h5Action = m.hybrid?.deepLink?.h5Action || "openWebview";
		const deepLinkUrl = `${scheme}://${openPath}/${h5Action}?url=${encodeURIComponent(targetUrl)}`;

		try {
			execFileSync("adb", ["shell", "am", "start",
				"-a", "android.intent.action.VIEW", "-d", deepLinkUrl,
			], { encoding: "utf-8", timeout: 10000 });
		} catch {
			// Fallback: try without action
			const fallbackUrl = `${scheme}://${openPath}?url=${encodeURIComponent(targetUrl)}`;
			execFileSync("adb", ["shell", "am", "start",
				"-a", "android.intent.action.VIEW", "-d", fallbackUrl,
			], { encoding: "utf-8", timeout: 10000 });
		}
	} else {
		execFileSync("adb", ["shell", "am", "start",
			"-a", "android.intent.action.VIEW", "-d", targetUrl,
		], { encoding: "utf-8", timeout: 10000 });
	}
}

export function launchMainActivity(): void {
	const m = loadProjectManifest();
	const pkg = m.hybrid?.container?.package || "";
	const activity = m.hybrid?.container?.openApiActivity || "";

	if (!pkg || !activity) {
		throw new Error(
			"App package/activity not configured. Run discover-project or set in skill.project.json.",
		);
	}

	const component = activity.includes("/") ? activity : `${pkg}/${activity}`;
	execFileSync("adb", ["shell", "am", "start", "-n", component],
		{ encoding: "utf-8", timeout: 10000 });
}
