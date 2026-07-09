import type { FixtureProfile } from "../resilience/types";
import {
	loadMockRulesFromManifest,
	resolveManifestBodyForUrl,
	type ManifestMockRule,
} from "./manifest-mock-rules";
import {
	getMockRulesForProfile,
	matchRuleByUrl,
	type MockRule,
} from "../resilience/fixture-map";
import type { FixtureBody } from "../resilience/fixture-loader";

export type SerializedMockRule = {
	id: string;
	urlPattern: string;
	method: string;
	matchQuery?: string;
	body: FixtureBody;
};

function useLegacyFixtureMap(): boolean {
	if (process.env.E2E_LEGACY_FIXTURE_MAP === "1") {
		return true;
	}
	const manifestRules = loadMockRulesFromManifest();
	return manifestRules.length === 0;
}

function serializeManifestRules(profile: FixtureProfile): SerializedMockRule[] {
	return loadMockRulesFromManifest(profile).map((r) => ({
		id: r.id,
		urlPattern: r.urlPattern,
		method: r.method,
		...(r.matchQuery ? { matchQuery: r.matchQuery } : {}),
		body: r.body,
	}));
}

function serializeLegacyRules(profile: FixtureProfile): SerializedMockRule[] {
	return getMockRulesForProfile(profile).map((r) => ({
		id: r.id,
		urlPattern: r.urlPattern,
		method: r.method ?? "GET",
		body: r.body,
	}));
}

export function serializeRulesForProfile(
	profile: FixtureProfile,
): SerializedMockRule[] {
	const manifest = serializeManifestRules(profile);
	if (manifest.length > 0) {
		return manifest;
	}
	if (useLegacyFixtureMap()) {
		return serializeLegacyRules(profile);
	}
	return [];
}

export function resolveBodyForUrl(
	url: string,
	method: string,
	rules: MockRule[] | ManifestMockRule[],
): FixtureBody | null {
	if (rules.length === 0) {
		return null;
	}
	const first = rules[0] as MockRule | ManifestMockRule;
	if (first.id.includes("/") || first.id.includes("external_")) {
		return resolveManifestBodyForUrl(
			url,
			method,
			rules as ManifestMockRule[],
		);
	}
	const legacyRules = rules as MockRule[];
	for (const rule of legacyRules) {
		if (!rule.match(url)) {
			continue;
		}
		if (rule.method && rule.method !== method) {
			continue;
		}
		return rule.body;
	}
	// Fallback: try matchRuleByUrl for custom matching logic
	const customMatch = matchRuleByUrl(url, legacyRules);
	if (customMatch) return customMatch.body;
	return resolveManifestBodyForUrl(
		url,
		method,
		rules as ManifestMockRule[],
	);
}
