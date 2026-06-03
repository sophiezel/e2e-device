import { browser } from "@wdio/globals";
import { optimizedLaunch } from "../helpers/deeplink";
import { isLoggedIn, isLoginScreenVisible, performAutoLogin } from "../helpers/login";

describe("App Launch", () => {
	it("should launch app and navigate to target page", async () => {
		const domain = process.env.E2E_DOMAIN || "followUpMark";

		// 使用优化启动流程
		const launchSuccess = await optimizedLaunch(domain);

		if (!launchSuccess) {
			// 如果优化启动失败，尝试传统方式
			console.log("[app-launch] Optimized launch failed, trying traditional way...");

			// 等待 App 启动
			await browser.pause(5000);

			// 检查登录状态
			if (await isLoginScreenVisible()) {
				console.log("[app-launch] Login screen visible, performing login...");
				await performAutoLogin();
			}

			// 等待 WebView 出现
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
			}
		}

		// 验证页面加载
		const currentUrl = await browser.getUrl();
		console.log("[app-launch] Current URL:", currentUrl);

		// 验证是否在目标页面
		expect(currentUrl).toContain("/v2");

		console.log("[app-launch] App launched successfully");
	});
});
