import type { FixtureProfile } from "./types";
import { enableWebMock } from "../orchestration/enable-web-mock";

export interface CdpMockSession {
	enabled: boolean;
}

/**
 * Compatibility entry: historically named CDP mock, now delegates to WebView inject.
 * Callers (webview-context) keep using this name.
 */
export async function enableCdpMock(profile?: FixtureProfile): Promise<CdpMockSession> {
	const resolved = (profile || process.env.E2E_MOCK_PROFILE || "default") as FixtureProfile;
	try {
		const session = await enableWebMock(resolved);
		if (session.enabled) {
			console.log("[cdp-mock] delegated to enableWebMock profile=%s rules=%s", resolved, "ok");
		} else {
			console.warn("[cdp-mock] enableWebMock failed:", session.warnings.join(", "));
		}
		return { enabled: session.enabled };
	} catch (err) {
		console.warn("[cdp-mock] enableWebMock error:", String(err));
		return { enabled: false };
	}
}
