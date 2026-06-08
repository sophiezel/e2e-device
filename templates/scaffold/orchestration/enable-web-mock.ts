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

	// Load bridge mock script if enabled
	const bridgeMockPath = path.join(e2eDeviceRoot(), "inject", "web-bridge-mock.js");
	const bridgeScriptContent = fs.existsSync(bridgeMockPath)
		? fs.readFileSync(bridgeMockPath, "utf-8")
		: "";
	const enableBridgeMock = process.env.E2E_ENABLE_BRIDGE_MOCK === "1" && bridgeScriptContent.length > 0;

	try {
		const result = await browser.execute(
			(rulesPayload, script, bridgeScript, enableBridge) => {
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
				// Inject bridge mock if enabled (depends on request mock being installed first)
				if (enableBridge && win.__E2E_REQUEST_MOCK_INSTALLED__) {
					try {
						// eslint-disable-next-line no-eval
						eval(bridgeScript);
					} catch {
						// bridge mock injection failure is non-fatal
					}
				}
				return { ok: true, installed: !!win.__E2E_REQUEST_MOCK_INSTALLED__ };
			},
			rules,
			scriptContent,
			bridgeScriptContent,
			enableBridgeMock,
		);
		if (!result?.ok) {
			warnings.push("web_mock_inject_failed");
		}
		if (enableBridgeMock) {
			console.log("[enable-web-mock] Bridge mock injection enabled");
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
