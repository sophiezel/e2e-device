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

export const timeouts = {
	/** Wait after DeepLink adb command for App to start */
	get deeplinkAppStart(): number {
		return envInt("E2E_TIMEOUT_DEEPLINK_APP_START", 3000);
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
		return envInt("E2E_TIMEOUT_WEBVIEW_CONTEXT", 25000);
	},

	/** Timeout for H5 DOM to be ready after WebView switch */
	get domReady(): number {
		return envInt("E2E_TIMEOUT_DOM_READY", 35000);
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
};
