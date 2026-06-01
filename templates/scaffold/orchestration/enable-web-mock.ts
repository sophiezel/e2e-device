import fs from "node:fs";
import path from "node:path";
import type { FixtureProfile } from "../resilience/types";
import { e2eDeviceRoot } from "./paths";
import { serializeRulesForProfile } from "./web-mock-rules";

export type WebMockSession = {
	profile: FixtureProfile;
	enabled: boolean;
	warnings: string[];
};

export async function enableWebMock(profile: FixtureProfile): Promise<WebMockSession> {
	const warnings: string[] = [];
	const rules = serializeRulesForProfile(profile);
	const injectPath = path.join(e2eDeviceRoot(), "inject", "web-request-mock.js");
	const scriptContent = fs.readFileSync(injectPath, "utf-8");

	try {
		const result = await browser.execute(
			(rulesPayload, script) => {
				const win = window as Window & {
					__E2E_REQUEST_MOCK__?: {
						enabled: boolean;
						rules: unknown[];
						lastHit?: string;
					};
					__E2E_REQUEST_MOCK_INSTALLED__?: boolean;
				};
				win.__E2E_REQUEST_MOCK__ = { enabled: true, rules: rulesPayload };
				if (!win.__E2E_REQUEST_MOCK_INSTALLED__) {
					// eslint-disable-next-line no-eval
					eval(script);
				}
				return { ok: true, installed: !!win.__E2E_REQUEST_MOCK_INSTALLED__ };
			},
			rules,
			scriptContent,
		);
		if (!result?.ok) {
			warnings.push("web_mock_inject_failed");
		}
		return { profile, enabled: !!result?.ok, warnings };
	} catch (error) {
		warnings.push(`web_mock_error:${String(error)}`);
		return { profile, enabled: false, warnings };
	}
}

export async function disableWebMock(): Promise<void> {
	try {
		await browser.execute(() => {
			const win = window as Window & {
				__E2E_REQUEST_MOCK__?: { enabled: boolean };
			};
			if (win.__E2E_REQUEST_MOCK__) {
				win.__E2E_REQUEST_MOCK__.enabled = false;
			}
		});
	} catch {
		// ignore
	}
}
