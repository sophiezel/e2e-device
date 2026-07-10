/**
 * Expert-style reset between cases within a warm Journey session.
 * Swaps mock profile + reloads page — seconds, not full cold-start minutes.
 */
import { browser } from "@wdio/globals";
import { optimizedLaunch } from "./deeplink";
import { switchToWebViewContaining } from "./webview-context";
import { enableWebMock } from "../orchestration/enable-web-mock";
import { cleanupAfterTest } from "./reset-session";
import { timeouts } from "../config/timeouts";

export interface ExpertResetOptions {
	domain: string;
	pageModule?: string;
	mockProfile?: string;
	query?: Record<string, string>;
}

function warmWebViewTimeout(): number {
	if (process.env.E2E_WARM_SESSION === "1") {
		return parseInt(process.env.E2E_TIMEOUT_WEBVIEW_CONTEXT || "10000", 10) || 10_000;
	}
	return timeouts.webviewContext;
}

/** Hide soft keyboard if visible (best-effort). */
async function hideKeyboard(): Promise<void> {
	try {
		await browser.hideKeyboard();
	} catch {
		/* not always available */
	}
}

/**
 * Case间专家式 reset：清 storage → mock → 重进页 → WebView warm 切换。
 * @returns reset duration in ms
 */
export async function expertResetBetweenCases(opts: ExpertResetOptions): Promise<number> {
	const start = Date.now();
	const routeKey = opts.pageModule || opts.domain;
	const needle = routeKey.split("/").filter(Boolean).pop() || routeKey;

	console.log(`[expert-reset] ${opts.domain} → ${routeKey} mock=${opts.mockProfile || "default"}`);

	await cleanupAfterTest();

	if (opts.mockProfile) {
		process.env.E2E_MOCK_PROFILE = opts.mockProfile;
		process.env.E2E_ENABLE_WEB_MOCK = "1";
		await enableWebMock(opts.mockProfile);
	}

	await optimizedLaunch(routeKey, opts.query ? { query: opts.query } : undefined);
	await switchToWebViewContaining(needle, warmWebViewTimeout());
	await hideKeyboard();

	const resetMs = Date.now() - start;
	console.log(`[expert-reset] done (${resetMs}ms)`);
	return resetMs;
}
