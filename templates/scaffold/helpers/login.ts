import { browser } from "@wdio/globals";
import { loadProjectManifest } from "../config/project-manifest";

/**
 * Resolve login UI selectors from manifest (hybrid.container.loginResourceIds)
 * and hybrid.auth.h5 patterns. Falls back to generic heuristics only.
 */
interface LoginSelectors {
	accountInput: string;
	passwordInput: string;
	loginBtn: string;
	loggedInIndicators: string[];
	loginScreenPatterns: string[];
}

function resolveLoginSelectors(): LoginSelectors {
	let ids: { account: string; password: string; loginBtn: string } | undefined;
	let loginScreenPatterns: string[] = [];
	let loggedInIndicators: string[] = [];

	try {
		const m = loadProjectManifest();
		ids = m.hybrid.container.loginResourceIds;
		loginScreenPatterns = m.hybrid.auth?.h5?.unauthTextPatterns || [];
		loggedInIndicators = m.hybrid.auth?.h5?.loginPathPatterns
			? [] // login path patterns are for H5, not native post-login indicators
			: [];
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
		loggedInIndicators,
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
 * Check if user is already logged in (WebView context present or native indicators).
 */
export async function isLoggedIn(): Promise<boolean> {
	try {
		const contexts = await browser.getContexts();
		// WebView context presence typically indicates post-login state
		if (contexts.some((c: string) => typeof c === "string" && c.includes("WEBVIEW"))) {
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Perform auto-login using manifest-configured resource IDs.
 */
export async function performAutoLogin(): Promise<boolean> {
	try {
		console.log("[auth] Starting auto login...");

		// Wait for login page to be ready
		await browser.pause(2000);

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

		// Wait for login to complete
		await browser.pause(3000);

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
