import { execSync } from "node:child_process";
import { browser } from "@wdio/globals";

/**
 * 通过 DeepLink 启动 App
 */
export async function launchByDeepLink(url: string): Promise<boolean> {
	try {
		console.log("[deeplink] Launching with URL:", url);

		// 使用 adb 启动 DeepLink
		const command = `adb shell am start -a android.intent.action.VIEW -d "${url}"`;
		execSync(command, { encoding: "utf-8" });

		// 等待 App 启动
		await browser.pause(3000);

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
	const pageOrigin = process.env.E2E_PAGE_ORIGIN || "https://xr-c2b.guazi-cloud.com/v2";
	const targetUrl = `${pageOrigin}/${domain}`;

	console.log("[deeplink] Target URL:", targetUrl);

	// 尝试通过 DeepLink 启动
	const success = await launchByDeepLink(targetUrl);

	if (success) {
		// 等待 WebView 出现
		await browser.waitUntil(
			async () => {
				const contexts = await browser.getContexts();
				return contexts.some(
					(c) => typeof c === "string" && c.includes("WEBVIEW"),
				);
			},
			{
				timeout: 60000,
				timeoutMsg: "WebView did not appear within 60s after DeepLink",
			},
		);

		// 切换到 WebView
		const contexts = await browser.getContexts();
		const webviewContext = contexts.find(
			(c) => typeof c === "string" && c.includes("WEBVIEW"),
		);

		if (webviewContext && typeof webviewContext === "string") {
			await browser.switchContext(webviewContext);
			console.log("[deeplink] Switched to WebView:", webviewContext);
			return true;
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

	// 等待 App 启动
	await browser.pause(5000);

	// 检查是否需要登录
	const { isLoginScreenVisible, performAutoLogin, isLoggedIn } = await import("./login");

	if (await isLoginScreenVisible()) {
		console.log("[launch] Login screen detected, performing auto login...");
		const loginSuccess = await performAutoLogin();
		if (!loginSuccess) {
			console.log("[launch] Auto login failed");
			return false;
		}
	}

	// 等待 WebView 出现
	console.log("[launch] Waiting for WebView...");
	await browser.waitUntil(
		async () => {
			const contexts = await browser.getContexts();
			return contexts.some(
				(c) => typeof c === "string" && c.includes("WEBVIEW"),
			);
		},
		{
			timeout: 120000,
			timeoutMsg: "WebView did not appear within 120s",
		},
	);

	// 切换到 WebView
	const contexts = await browser.getContexts();
	const webviewContext = contexts.find(
		(c) => typeof c === "string" && c.includes("WEBVIEW"),
	);

	if (webviewContext && typeof webviewContext === "string") {
		await browser.switchContext(webviewContext);
		console.log("[launch] Switched to WebView:", webviewContext);
		return true;
	}

	return false;
}
