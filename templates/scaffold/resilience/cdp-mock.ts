/**
 * CDP mock adapter — delegates to inject-based mock.
 *
 * In real-device WebView scenarios, Chrome DevTools Protocol (CDP) mock
 * is unreliable. This module exists as a compatibility shim: it always
 * falls back to the inject-based mock strategy (web-request-mock.js).
 */
import type { FixtureProfile } from "./types";

export interface CdpMockSession {
	enabled: boolean;
	strategy: "inject" | "cdp";
	profile: FixtureProfile;
}

/**
 * Enable mock via inject strategy (the only reliable approach on real devices).
 * The actual injection is performed by webview-context.ts → enable-web-mock.ts.
 */
export async function enableCdpMock(
	profile: FixtureProfile,
): Promise<CdpMockSession> {
	// On real-device WebView, CDP mock is not reliable.
	// Always delegate to inject-based mock.
	process.env.E2E_MOCK_PROFILE = profile;
	process.env.E2E_MOCK_LAYER = "inject";

	return {
		enabled: true,
		strategy: "inject",
		profile,
	};
}

/**
 * Disable mock session (cleanup).
 */
export async function disableCdpMock(): Promise<void> {
	delete process.env.E2E_MOCK_PROFILE;
	delete process.env.E2E_MOCK_LAYER;
}
