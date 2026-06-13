/**
 * Deep link launch with vendor-aware self-healing.
 */
import { execFileSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { resolvePageOrigin } from "./build-h5-url";
import { switchToWebViewContaining } from "./webview-context";
import { timeouts } from "../config/timeouts";
import {
	detectVendor,
	classifyVendor,
	getVendorWorkarounds,
	applyVendorWorkarounds,
} from "./android-vendor";
import { ensureChromedriver, forceRestartApp } from "./app-launcher";

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
 * 通过 DeepLink 启动 App
 */
export async function launchByDeepLink(url: string): Promise<boolean> {
	try {
		console.log("[deeplink] Launching with URL:", url);

		const appPackage = process.env.E2E_APP_PACKACE || process.env.E2E_APP_PACKAGE || "";
		const args = ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url];
		if (appPackage) {
			args.push("-p", appPackage);
		}

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
 * 通过 DeepLink 直接进入目标页面
 */
export async function launchTargetPage(domain: string): Promise<boolean> {
	const pageOrigin = resolvePageOrigin();
	if (!pageOrigin) {
		console.error("[deeplink] pageOrigin missing, cannot launch target page.");
		return false;
	}
	const targetUrl = `${pageOrigin}/${domain}`;

	let deepLinkUrl = targetUrl;
	try {
		const { loadProjectManifest } = await import("../config/project-manifest");
		const m = loadProjectManifest();
		const scheme = m.hybrid.deepLink.scheme;
		if (scheme) {
			const openPath = m.hybrid.deepLink.openPath || "openapi";
			const h5Action = m.hybrid.deepLink.h5Action || "openWebview";
			const encodedUrl = encodeURIComponent(targetUrl);
			deepLinkUrl = `${scheme}://${openPath}/${h5Action}?url=${encodedUrl}`;
		}
	} catch {
		// fallback
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
			// Try fallback deep link format (without action path)
			const fallbackUrl = targetUrl.replace(/\/openWebview\?/, "/?");
			console.log("[deeplink] Primary format failed, trying fallback...");
			const fallbackSuccess = await launchByDeepLink(fallbackUrl);
			if (fallbackSuccess) {
				try {
					await switchToWebViewContaining(domain, timeouts.webViewAfterDeeplink);
					console.log("[deeplink] Switched to WebView via fallback format");
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
export async function optimizedLaunch(domain: string): Promise<boolean> {
	console.log("[launch] Starting optimized launch...");

	// 方案 1：尝试 DeepLink
	const deepLinkSuccess = await launchTargetPage(domain);
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
