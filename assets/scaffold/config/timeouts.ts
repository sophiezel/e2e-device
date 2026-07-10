/**
 * Centralized timeout configuration for e2e-device.
 * All values can be overridden via E2E_TIMEOUT_* environment variables.
 * Unit: milliseconds.
 */

function envInt(key: string, fallback: number): number {
	const raw = process.env[key];
	if (raw) {
		const val = parseInt(raw, 10);
		if (!isNaN(val) && val > 0) return val;
	}
	return fallback;
}

function warmFactor(): number {
	return process.env.E2E_WARM_SESSION === "1" ? 1 : 0;
}

export const timeouts = {
	/** Wait after DeepLink adb command for App to start */
	get deeplinkAppStart(): number {
		const cold = envInt("E2E_TIMEOUT_DEEPLINK_APP_START", 3000);
		return warmFactor() ? Math.min(cold, 1000) : cold;
	},

	/** Wait after login failure before retry */
	get loginRetryWait(): number {
		return envInt("E2E_TIMEOUT_LOGIN_RETRY", 5000);
	},

	/** Timeout for WebView context to appear after DeepLink */
	get webViewAfterDeeplink(): number {
		return envInt("E2E_TIMEOUT_WEBVIEW_DEEPLINK", 60000);
	},

	/** Timeout for WebView context to appear after normal launch */
	get webViewNormal(): number {
		return envInt("E2E_TIMEOUT_WEBVIEW_NORMAL", 120000);
	},

	/** Wait for login page to be ready */
	get loginPageReady(): number {
		return envInt("E2E_TIMEOUT_LOGIN_PAGE", 2000);
	},

	/** Wait after login action for completion */
	get loginComplete(): number {
		return envInt("E2E_TIMEOUT_LOGIN_COMPLETE", 3000);
	},

	/** Wait for device session preparation */
	get sessionPrepare(): number {
		return envInt("E2E_TIMEOUT_SESSION_PREPARE", 2000);
	},

	/** Timeout for WEBVIEW context to be available */
	get webviewContext(): number {
		const cold = envInt("E2E_TIMEOUT_WEBVIEW_CONTEXT", 25000);
		return warmFactor() ? Math.min(cold, 10_000) : cold;
	},

	/** Timeout for H5 DOM to be ready after WebView switch */
	get domReady(): number {
		const cold = envInt("E2E_TIMEOUT_DOM_READY", 35000);
		return warmFactor() ? Math.min(cold, 12_000) : cold;
	},

	/** WebdriverIO global waitforTimeout */
	get wdioWaitFor(): number {
		return envInt("E2E_TIMEOUT_WDIO_WAITFOR", 20000);
	},

	/** WebdriverIO connection retry timeout */
	get wdioConnectionRetry(): number {
		return envInt("E2E_TIMEOUT_WDIO_CONNECTION", 120000);
	},

	/** Mocha test timeout */
	get mochaTest(): number {
		return envInt("E2E_TIMEOUT_MOCHA_TEST", 120000);
	},

	/** H5 element selector wait timeout */
	get h5Selector(): number {
		return envInt("E2E_TIMEOUT_H5_SELECTOR", 20000);
	},

	// ── Generic pause constants (replace hardcoded browser.pause(N)) ──

	/** Micro pause for context switches, back presses */
	get PAUSE_MICRO(): number {
		return envInt("E2E_TIMEOUT_PAUSE_MICRO", 300);
	},

	/** Short pause for animations, scroll settle */
	get PAUSE_SHORT(): number {
		return envInt("E2E_TIMEOUT_PAUSE_SHORT", 500);
	},

	/** Medium pause for keyboard show/hide, general transitions */
	get PAUSE_MEDIUM(): number {
		return envInt("E2E_TIMEOUT_PAUSE_MEDIUM", 1000);
	},

	/** Long pause for orientation changes, heavy operations */
	get PAUSE_LONG(): number {
		return envInt("E2E_TIMEOUT_PAUSE_LONG", 2000);
	},

	/** Extra-long pause for background/foreground transitions */
	get PAUSE_EXTRA_LONG(): number {
		return envInt("E2E_TIMEOUT_PAUSE_EXTRA_LONG", 4000);
	},

	/** Wait after clicking submit for response */
	get submitResponseWait(): number {
		return envInt("E2E_TIMEOUT_SUBMIT_RESPONSE", 2000);
	},

	/** Wait after API error injection for UI to react */
	get apiErrorResponseWait(): number {
		return envInt("E2E_TIMEOUT_API_ERROR_RESPONSE", 3000);
	},
};
