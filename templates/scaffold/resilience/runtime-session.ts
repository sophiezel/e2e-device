import { browser } from "@wdio/globals";

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
