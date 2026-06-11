// @ts-nocheck
import { browser } from "@wdio/globals";
import { optimizedLaunch } from "../helpers/deeplink";
import { isLoginScreenVisible, performAutoLogin } from "../helpers/login";
import { switchToWebViewContaining } from "../helpers/webview-context";
import { loadProjectManifest } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";

describe("App Launch", () => {
	it("should launch app and navigate to target page", async () => {
		const domain = process.env.E2E_DOMAIN || "";

		// 使用优化启动流程
		const launchSuccess = await optimizedLaunch(domain);

		if (!launchSuccess) {
			// 如果优化启动失败，尝试传统方式
			console.log("[app-launch] Optimized launch failed, trying traditional way...");

			// 等待 App 启动
			await browser.pause(timeouts.deeplinkAppStart);

			// 检查登录状态
			if (await isLoginScreenVisible()) {
				console.log("[app-launch] Login screen visible, performing login...");
				await performAutoLogin();
			}

			// 复用共享 WebView 切换函数
			await switchToWebViewContaining(domain, timeouts.webViewNormal);
		}

		// 验证页面加载
		const currentUrl = await browser.getUrl();
		console.log("[app-launch] Current URL:", currentUrl);

		// 验证 WebView 已加载（URL 非空且为 http）
		expect(currentUrl).toMatch(/^https?:\/\//);

		console.log("[app-launch] App launched successfully");
	});
});
