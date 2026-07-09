/**
 * Deep link launch with vendor-aware self-healing.
 */
import { execFileSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { resolvePageOrigin, buildH5Url } from "./build-h5-url";
import { switchToWebViewContaining } from "./webview-context";
import { timeouts } from "../config/timeouts";
import {
	detectVendor,
	classifyVendor,
	getVendorWorkarounds,
	applyVendorWorkarounds,
} from "./android-vendor";
import { ensureChromedriver } from "./app-launcher";

import { loadProjectManifest } from "../config/project-manifest";

/**
 * Resolve target Android app package for deeplink `-p` binding.
 * Priority: E2E_APP_PACKAGE env > manifest.hybrid.container.package
 */
export function resolveAppPackage(): string {
	const fromEnv =
		process.env.E2E_APP_PACKACE?.trim() || process.env.E2E_APP_PACKAGE?.trim() || "";
	if (fromEnv) return fromEnv;

	try {
		const pkg = loadProjectManifest().hybrid.container.package?.trim() || "";
		if (pkg && pkg !== "unknown") return pkg;
	} catch {
		/* manifest unavailable */
	}

	return "";
}

function requireAppPackage(): string {
	const pkg = resolveAppPackage();
	if (!pkg) {
		throw new Error(
			"appPackage missing. Set E2E_APP_PACKAGE or configure hybrid.container.package in manifest.",
		);
	}
	return pkg;
}

/**
 * Apply vendor-specific workarounds before deep link launch.
 */
function prepareVendorEnvironment(): void {
	try {
		const v = detectVendor();
		const clazz = classifyVendor(v);
		const w = getVendorWorkarounds(clazz);
		applyVendorWorkarounds(w);
		console.log(
			`[deeplink] Vendor: ${v.manufacturer} ${v.model} (${clazz})` +
			` | WebView: ${v.webViewPackage || "?"} v${v.webViewVersion || "?"}`,
		);

		if (v.webViewVersion) {
			const cdPath = ensureChromedriver(v.webViewVersion);
			if (cdPath) {
				console.log(`[deeplink] Chromedriver ready`);
			}
		}
	} catch { /* best-effort */ }
}

/**
 * 通过 DeepLink 启动 App（必须绑定 -p 包名）
 */
export async function launchByDeepLink(url: string): Promise<boolean> {
	try {
		const appPackage = requireAppPackage();
		console.log("[deeplink] Launching with URL:", url);
		console.log("[deeplink] Target package:", appPackage);

		const args = [
			"shell", "am", "start",
			"-a", "android.intent.action.VIEW",
			"-d", url,
			"-p", appPackage,
		];

		execFileSync("adb", args, {
			encoding: "utf-8",
			timeout: 10000,
		});

		await browser.pause(timeouts.deeplinkAppStart);
		console.log("[deeplink] Launch successful");
		return true;
	} catch (error) {
		console.error("[deeplink] Launch failed:", error);
		return false;
	}
}

/**
 * Build scheme-based deeplink URL (preferred for Hybrid container).
 */
function buildSchemeDeepLink(targetUrl: string): string | null {
	try {
		const m = loadProjectManifest();
		const scheme = m.hybrid.deepLink.scheme?.trim();
		if (!scheme) return null;
		const openPath = m.hybrid.deepLink.openPath || "openapi";
		const h5Action = m.hybrid.deepLink.h5Action || "openWebview";
		const encodedUrl = encodeURIComponent(targetUrl);
		return `${scheme}://${openPath}/${h5Action}?url=${encodedUrl}`;
	} catch {
		return null;
	}
}

/**
 * 通过 DeepLink 直接进入目标页面。
 * Optional query via opts or E2E_PAGE_QUERY (host/case supplies values).
 */
export async function launchTargetPage(
	domain: string,
	opts?: { query?: Record<string, string> },
): Promise<boolean> {
	const pageOrigin = resolvePageOrigin();
	if (!pageOrigin) {
		console.error("[deeplink] pageOrigin missing, cannot launch target page.");
		return false;
	}
	const targetUrl = buildH5Url(domain, { query: opts?.query });

	const deepLinkUrl = buildSchemeDeepLink(targetUrl);
	if (!deepLinkUrl) {
		console.error(
			"[deeplink] deepLink.scheme missing in manifest — cannot launch Hybrid App. " +
			"Run discover-project or set hybrid.deepLink.scheme.",
		);
		return false;
	}

	console.log("[deeplink] DeepLink URL:", deepLinkUrl);

	prepareVendorEnvironment();

	const success = await launchByDeepLink(deepLinkUrl);

	if (success) {
		try {
			await switchToWebViewContaining(domain, timeouts.webViewAfterDeeplink);
			console.log("[deeplink] Switched to WebView containing:", domain);
			return true;
		} catch (err) {
			// Try fallback: scheme without h5Action path segment
			const fallbackScheme = deepLinkUrl.replace(/\/openWebview\?/, "/?");
			console.log("[deeplink] Primary format failed, trying fallback scheme...");
			const fallbackSuccess = await launchByDeepLink(fallbackScheme);
			if (fallbackSuccess) {
				try {
					await switchToWebViewContaining(domain, timeouts.webViewAfterDeeplink);
					console.log("[deeplink] Switched to WebView via fallback scheme");
					return true;
				} catch { /* continue to https fallback */ }
			}

			// Last resort: HTTPS URL with -p (still bound to app package)
			console.log("[deeplink] Scheme formats failed, trying HTTPS fallback with -p...");
			const httpsSuccess = await launchByDeepLink(targetUrl);
			if (httpsSuccess) {
				try {
					await switchToWebViewContaining(domain, timeouts.webViewAfterDeeplink);
					console.log("[deeplink] Switched to WebView via HTTPS fallback");
					return true;
				} catch { /* both failed */ }
			}
			console.error("[deeplink] WebView switch failed:", err);
			return false;
		}
	}

	return false;
}

/**
 * 优化启动流程：先尝试 DeepLink，失败再走正常流程
 */
export async function optimizedLaunch(
	domain: string,
	opts?: { query?: Record<string, string> },
): Promise<boolean> {
	console.log("[launch] Starting optimized launch...");

	// 方案 1：尝试 DeepLink
	const deepLinkSuccess = await launchTargetPage(domain, opts);
	if (deepLinkSuccess) {
		console.log("[launch] DeepLink launch successful");
		return true;
	}

	// 方案 2：走正常启动流程
	console.log("[launch] DeepLink failed, falling back to normal launch...");
	await browser.pause(timeouts.loginRetryWait);

	const { isLoginScreenVisible, performAutoLogin } = await import("./login");

	if (await isLoginScreenVisible()) {
		console.log("[launch] Login screen detected, performing auto login...");
		const loginSuccess = await performAutoLogin();
		if (!loginSuccess) {
			console.log("[launch] Auto login failed");
			return false;
		}
	}

	console.log("[launch] Waiting for WebView...");
	try {
		await switchToWebViewContaining(domain, timeouts.webViewNormal);
		console.log("[launch] Switched to WebView containing:", domain);
		return true;
	} catch (err) {
		console.log("[launch] Domain-specific WebView not found, trying any WebView...");
		try {
			await switchToWebViewContaining("", timeouts.webViewNormal);
			console.log("[launch] Switched to first available WebView");
			return true;
		} catch {
			console.error("[launch] No WebView available:", err);
			return false;
		}
	}
}
