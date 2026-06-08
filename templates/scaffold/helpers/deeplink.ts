import { execFileSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { resolvePageOrigin } from "./build-h5-url";
import { switchToWebViewContaining } from "./webview-context";
import { timeouts } from "../config/timeouts";

/**
 * 通过 DeepLink 启动 App
 */
export async function launchByDeepLink(url: string): Promise<boolean> {
	try {
		console.log("[deeplink] Launching with URL:", url);

		// Use execFileSync with argument array to prevent command injection
		execFileSync("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], {
			encoding: "utf-8",
			timeout: 10000,
		});

		// Wait for App to start
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
		console.error("[deeplink] pageOrigin missing, cannot launch target page. Set E2E_PAGE_ORIGIN or run discover-project.");
		return false;
	}
	const targetUrl = `${pageOrigin}/${domain}`;

	console.log("[deeplink] Target URL:", targetUrl);

	// 尝试通过 DeepLink 启动
	const success = await launchByDeepLink(targetUrl);

	if (success) {
		try {
			// 复用 webview-context 的共享函数等待并切换到 WebView
			await switchToWebViewContaining(domain, timeouts.webViewAfterDeeplink);
			console.log("[deeplink] Switched to WebView containing:", domain);
			return true;
		} catch (err) {
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

	// Wait before checking login state
	await browser.pause(timeouts.loginRetryWait);

	// 检查是否需要登录
	const { isLoginScreenVisible, performAutoLogin } = await import("./login");

	if (await isLoginScreenVisible()) {
		console.log("[launch] Login screen detected, performing auto login...");
		const loginSuccess = await performAutoLogin();
		if (!loginSuccess) {
			console.log("[launch] Auto login failed");
			return false;
		}
	}

	// 复用 webview-context 的共享函数等待并切换到 WebView
	console.log("[launch] Waiting for WebView...");
	try {
		await switchToWebViewContaining(domain, timeouts.webViewNormal);
		console.log("[launch] Switched to WebView containing:", domain);
		return true;
	} catch (err) {
		// 如果带 domain 匹配失败，尝试不带 domain 的通用 WebView 切换
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
