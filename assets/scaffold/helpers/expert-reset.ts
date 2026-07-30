/**
 * Expert-style reset between cases within a warm Journey session.
 * Budget ≤4s; on timeout/failure caller should cold-enter once.
 */
import { browser } from "@wdio/globals";
import { optimizedLaunch } from "./deeplink";
import { switchToWebViewContaining } from "./webview-context";
import { enableWebMock } from "../orchestration/enable-web-mock";
import { cleanupAfterTest } from "./reset-session";
import { timeouts } from "../config/timeouts";
import { resolveWebViewNeedle } from "../config/project-manifest";
import { recordExpertResetTimeout } from "./session-adaptive";

export interface ExpertResetOptions {
	domain: string;
	pageModule?: string;
	mockProfile?: string;
	query?: Record<string, string>;
	/** Hard budget ms (default 4000). */
	budgetMs?: number;
}

export class ExpertResetTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExpertResetTimeoutError";
	}
}

function warmWebViewTimeout(): number {
	if (process.env.E2E_WARM_SESSION === "1") {
		return Math.min(
			parseInt(process.env.E2E_TIMEOUT_WEBVIEW_CONTEXT || "10000", 10) || 10_000,
			3000,
		);
	}
	return Math.min(timeouts.webviewContext, 3000);
}

async function hideKeyboard(): Promise<void> {
	try {
		await browser.hideKeyboard();
	} catch {
		/* not always available */
	}
}

function withBudget<T>(budgetMs: number, work: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new ExpertResetTimeoutError(`expertReset exceeded ${budgetMs}ms`));
		}, budgetMs);
		work()
			.then((v) => {
				clearTimeout(timer);
				resolve(v);
			})
			.catch((e) => {
				clearTimeout(timer);
				reject(e);
			});
	});
}

/**
 * Case间专家式 reset：清 storage → mock → 重进页 → WebView warm 切换。
 * @returns reset duration in ms
 * @throws ExpertResetTimeoutError or underlying errors when budget exceeded / launch fails
 */
export async function expertResetBetweenCases(opts: ExpertResetOptions): Promise<number> {
	const start = Date.now();
	const budgetMs =
		opts.budgetMs ??
		(parseInt(process.env.E2E_EXPERT_RESET_BUDGET_MS || "4000", 10) || 4000);
	const routeKey = opts.pageModule || opts.domain;
	const needle = resolveWebViewNeedle(routeKey);

	console.log(`[expert-reset] ${opts.domain} → ${routeKey} mock=${opts.mockProfile || "default"} budget=${budgetMs}ms`);

	await withBudget(budgetMs, async () => {
		await cleanupAfterTest();

		if (opts.mockProfile) {
			process.env.E2E_MOCK_PROFILE = opts.mockProfile;
			process.env.E2E_ENABLE_WEB_MOCK = "1";
			await enableWebMock(opts.mockProfile);
		}

		await optimizedLaunch(routeKey, opts.query ? { query: opts.query } : undefined);
		await switchToWebViewContaining(needle, warmWebViewTimeout());
		await hideKeyboard();
	}).catch((e) => {
		if (e instanceof ExpertResetTimeoutError) {
			recordExpertResetTimeout();
		}
		throw e;
	});

	const resetMs = Date.now() - start;
	console.log(`[expert-reset] done (${resetMs}ms)`);
	return resetMs;
}
