import { browser } from "@wdio/globals";

/**
 * 检查是否在登录页面
 */
export async function isLoginScreenVisible(): Promise<boolean> {
	try {
		// 检查常见的登录页面元素
		const loginBtn = await browser.$('android.widget.Button[text*="登录"]');
		const loginBtnAlt = await browser.$('android.widget.Button[text*="登 录"]');
		const loginBtnAlt2 = await browser.$('android.widget.Button[text*="Login"]');

		return (
			(await loginBtn.isExisting()) ||
			(await loginBtnAlt.isExisting()) ||
			(await loginBtnAlt2.isExisting())
		);
	} catch {
		return false;
	}
}

/**
 * 检查是否已登录（通过检查是否有 WebView 或特定元素）
 */
export async function isLoggedIn(): Promise<boolean> {
	try {
		const contexts = await browser.getContexts();
		// 如果有 WebView context，说明已登录
		if (contexts.some((c) => typeof c === "string" && c.includes("WEBVIEW"))) {
			return true;
		}

		// 检查是否有登录后的特定元素
		const mainPage = await browser.$('android.widget.TextView[text*="首页"]');
		return await mainPage.isExisting();
	} catch {
		return false;
	}
}

/**
 * 执行自动登录
 */
export async function performAutoLogin(): Promise<boolean> {
	try {
		console.log("[auth] Starting auto login...");

		// 等待登录页面加载
		await browser.pause(2000);

		// 检查是否需要登录
		if (!(await isLoginScreenVisible())) {
			console.log("[auth] Login screen not visible, skipping login");
			return true;
		}

		// 从环境变量获取凭据
		const account = process.env.E2E_ACCOUNT;
		const password = process.env.E2E_PASSWORD;

		if (!account || !password) {
			console.log("[auth] No credentials provided, skipping auto login");
			return false;
		}

		// 输入账号
		const accountInput = await browser.$('android.widget.EditText[resource-id*="account"]');
		if (await accountInput.isExisting()) {
			await accountInput.setValue(account);
		}

		// 输入密码
		const passwordInput = await browser.$('android.widget.EditText[resource-id*="password"]');
		if (await passwordInput.isExisting()) {
			await passwordInput.setValue(password);
		}

		// 点击登录按钮
		const loginBtn = await browser.$('android.widget.Button[text*="登录"]');
		if (await loginBtn.isExisting()) {
			await loginBtn.click();
		}

		// 等待登录完成
		await browser.pause(3000);

		// 验证登录是否成功
		if (await isLoggedIn()) {
			console.log("[auth] Login successful");
			return true;
		}

		console.log("[auth] Login failed");
		return false;
	} catch (error) {
		console.error("[auth] Login error:", error);
		return false;
	}
}
