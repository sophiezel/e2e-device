import type { FixtureProfile } from "./types";
import { enableWebMock } from "../orchestration/enable-web-mock";

export interface InjectMockSession {
	enabled: boolean;
}

/** @deprecated Use enableInjectMock — name kept for callers. */
export type CdpMockSession = InjectMockSession;

/**
 * WebView inject mock (fetch/XHR). Not CDP Network interception.
 */
export async function enableInjectMock(profile?: FixtureProfile): Promise<InjectMockSession> {
	const resolved = (profile || process.env.E2E_MOCK_PROFILE || "default") as FixtureProfile;
	try {
		const session = await enableWebMock(resolved);
		if (session.enabled) {
			console.log("[inject-mock] enableWebMock profile=%s ok", resolved);
		} else {
			console.warn("[inject-mock] enableWebMock failed:", session.warnings.join(", "));
		}
		return { enabled: session.enabled };
	} catch (err) {
		console.warn("[inject-mock] enableWebMock error:", String(err));
		return { enabled: false };
	}
}

/** @deprecated Alias for enableInjectMock */
export const enableCdpMock = enableInjectMock;
