import type { FixtureProfile } from "./types";

export interface CdpMockSession {
	enabled: boolean;
}

/**
 * Enable CDP-based request mocking in the current WebView.
 * Returns a session object indicating whether mocking was activated.
 */
export async function enableCdpMock(profile?: FixtureProfile): Promise<CdpMockSession> {
	console.log("[cdp-mock] stub: profile=%s", profile);
	return { enabled: false };
}