import { browser } from "@wdio/globals";
import { loadProjectManifest } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";

/**
 * 凭据脱敏工具 — 禁止在日志/控制台/报告中输出明文账号密码
 */
export function maskAccount(account: string): string {
	if (!account || account.length <= 1) return "**";
	if (account.length <= 4) return account[0] + "***";
	return account.slice(0, 2) + "***" + account.slice(-2);
}

export function maskPassword(_pw: string): string {
	return "****";
}

/**
 * Resolve login UI selectors from manifest (hybrid.container.loginResourceIds)
 * and hybrid.auth.h5 patterns. Falls back to generic heuristics only.
 */
interface LoginSelectors {
	accountInput: string;
	passwordInput: string;
	loginBtn: string;
	loginScreenPatterns: string[];
}

function resolveLoginSelectors(): LoginSelectors {
	let ids: { account: string; password: string; loginBtn: string } | undefined;
	let loginScreenPatterns: string[] = [];

	try {
		const m = loadProjectManifest();
		ids = m.hybrid.container.loginResourceIds;
		loginScreenPatterns = m.hybrid.auth?.h5?.unauthTextPatterns || [];
	} catch {
		// manifest not available; fall through to defaults
	}

	return {
		accountInput: ids?.account
			? `android=new UiSelector().resourceId("${ids.account}")`
			: 'android.widget.EditText[resource-id*="account"]',
		passwordInput: ids?.password
			? `android=new UiSelector().resourceId("${ids.password}")`
			: 'android.widget.EditText[resource-id*="password"]',
		loginBtn: ids?.loginBtn
			? `android=new UiSelector().resourceId("${ids.loginBtn}")`
			: 'android.widget.Button[clickable=true]',
		loginScreenPatterns,
	};
}

/**
 * Check if login screen is visible using manifest-configured patterns
 * and generic heuristics (EditText + Button presence).
 */
export async function isLoginScreenVisible(): Promise<boolean> {
	try {
		const selectors = resolveLoginSelectors();

		// Check if account/password EditText fields exist (strong signal of login screen)
		const accountField = await browser.$(selectors.accountInput);
		const passwordField = await browser.$(selectors.passwordInput);

		if ((await accountField.isExisting()) && (await passwordField.isExisting())) {
			return true;
		}

		// Check for login button text patterns (generic, not business-specific)
		const loginBtnGeneric = await browser.$('android.widget.Button[clickable=true]');
		if (await loginBtnGeneric.isExisting()) {
			const btnText = await loginBtnGeneric.getText().catch(() => "");
			const loginKeywords = ["login", "sign in", "log in", "登录", "登 录", "確認", "确定"];
			if (loginKeywords.some((kw) => btnText.toLowerCase().includes(kw.toLowerCase()))) {
				return true;
			}
		}

		return false;
	} catch {
		return false;
	}
}

/**
 * Check if user is already logged in using multi-layer detection.
 */
export async function isLoggedIn(): Promise<boolean> {
	// Layer 1: Check if native login screen is visible
	if (await isLoginScreenVisible()) {
		return false;
	}

	// Layer 2: Check if current URL contains login page patterns
	try {
		const url = await browser.getUrl();
		const loginPatterns = ["/login", "/passport", "/signin", "/auth"];
		const isLoginPage = loginPatterns.some(p => url.toLowerCase().includes(p));
		if (isLoginPage) {
			return false;
		}
	} catch {
		// URL check may fail if WebView not ready
	}

	// Layer 3: If no login indicators found, consider logged in
	return true;
}

/**
 * Perform auto-login using manifest-configured resource IDs.
 */
export async function performAutoLogin(): Promise<boolean> {
	try {
		console.log("[auth] Starting auto login...");

		// Wait for login page to be ready
		await browser.waitUntil(
			async () => {
				return await isLoginScreenVisible();
			},
			{ timeout: timeouts.loginPageReady },
		);

		if (!(await isLoginScreenVisible())) {
			console.log("[auth] Login screen not visible, skipping login");
			return true;
		}

		const account = process.env.E2E_ACCOUNT;
		const password = process.env.E2E_PASSWORD;

		if (!account || !password) {
			console.log("[auth] No credentials provided, skipping auto login");
			return false;
		}
		console.log(`[auth] Attempting login for account: ${maskAccount(account)}`);

		const selectors = resolveLoginSelectors();

		// Fill account
		const accountInput = await browser.$(selectors.accountInput);
		if (await accountInput.isExisting()) {
			await accountInput.setValue(account);
		}

		// Fill password
		const passwordInput = await browser.$(selectors.passwordInput);
		if (await passwordInput.isExisting()) {
			await passwordInput.setValue(password);
		}

		// Click login button
		const loginBtn = await browser.$(selectors.loginBtn);
		if (await loginBtn.isExisting()) {
			await loginBtn.click();
		}

		// Wait for login to complete (active polling instead of static pause)
		try {
			await browser.waitUntil(
				async () => await isLoggedIn(),
				{ timeout: timeouts.loginComplete, interval: 1000, timeoutMsg: "Login did not complete within timeout" },
			);
		} catch {
			// waitUntil timed out; fall through to check
		}

		if (await isLoggedIn()) {
			console.log(`[auth] Login successful (account: ${maskAccount(account)})`);
			return true;
		}

		console.log(`[auth] Login failed (account: ${maskAccount(account)})`);
		return false;
	} catch (error) {
		console.error("[auth] Login error:", error instanceof Error ? error.message : String(error));
		return false;
	}
}
