import { browser } from "@wdio/globals";
import type { JsError, BridgeEvent } from "./types";

/**
 * Runtime session management.
 * Resets mock-related environment overrides and injected flags between tests.
 */

const MOCK_ENV_KEYS = [
	"E2E_MOCK_LAYER",
	"E2E_MOCK_PROFILE",
	"E2E_DATA_MODE",
] as const;

export function resetRuntimeOverrides(): void {
	// Reset mock-related env vars set during test execution
	for (const key of MOCK_ENV_KEYS) {
		delete process.env[key];
	}
}

/**
 * Clear injected mock state from the WebView.
 * Call this before navigating to a new page to ensure clean mock state.
 */
export async function clearWebViewMockState(): Promise<void> {
	try {
		await browser.execute(() => {
			const w = window as unknown as Record<string, unknown>;
			if (w.__E2E_REQUEST_MOCK__) {
				(w.__E2E_REQUEST_MOCK__ as Record<string, unknown>).enabled = false;
				(w.__E2E_REQUEST_MOCK__ as Record<string, unknown>).lastHit = "";
			}
		});
	} catch (err) {
		// WebView may not be available in non-wdio context
		if (process.env.E2E_DEBUG) { console.debug("[runtime-session]", err); }
	}
}

/** Collect JS errors captured by web-request-mock.js in the WebView.
 *  Returns captured errors and clears the buffer for the next collection cycle. */
export async function collectJsErrors(): Promise<JsError[]> {
	try {
		return await browser.execute(() => {
			const w = window as unknown as Record<string, unknown>;
			const mock = w.__E2E_REQUEST_MOCK__ as Record<string, unknown> | undefined;
			const errors = (mock?.jsErrors as JsError[]) || [];
			// Clear after collection to avoid duplicates
			if (mock) { mock.jsErrors = []; }
			return errors;
		});
	} catch (err) {
		if (process.env.E2E_DEBUG) { console.debug("[runtime-session] collectJsErrors failed:", err); }
		return [];
	}
}

/** Collect JSBridge call events captured by web-bridge-mock.js in the WebView.
 *  Returns captured events and clears the buffer. */
export async function collectBridgeEvents(): Promise<BridgeEvent[]> {
	try {
		return await browser.execute(() => {
			const w = window as unknown as Record<string, unknown>;
			const mock = w.__E2E_REQUEST_MOCK__ as Record<string, unknown> | undefined;
			const events = (mock?.bridgeEvents as BridgeEvent[]) || [];
			if (mock) { mock.bridgeEvents = []; }
			return events;
		});
	} catch (err) {
		if (process.env.E2E_DEBUG) { console.debug("[runtime-session] collectBridgeEvents failed:", err); }
		return [];
	}
}

/** Collect WebView performance metrics (FCP, LCP, DOM interactive). */
export async function collectPerformanceMetrics(): Promise<NonNullable<import("./types").DiagnosticSnapshot["performance"]>> {
	try {
		return await browser.execute(() => {
			const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
			const paints = performance.getEntriesByType("paint") as PerformanceEntry[];
			const fcp = paints.find((p) => p.name === "first-contentful-paint");
			let lcp = 0;
			try {
				const lcpEntries = performance.getEntriesByType("largest-contentful-paint") as PerformanceEntry[];
				if (lcpEntries.length > 0) {
					lcp = lcpEntries[lcpEntries.length - 1].startTime;
				}
			} catch {
				// LCP API not available in some WebView versions
			}
			return {
				fcp: fcp ? Math.round(fcp.startTime) : undefined,
				lcp: lcp ? Math.round(lcp) : undefined,
				domInteractive: nav?.domInteractive ? Math.round(nav.domInteractive) : undefined,
			};
		});
	} catch {
		return {};
	}
}
