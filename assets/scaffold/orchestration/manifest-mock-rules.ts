import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import type { FixtureProfile } from "../resilience/types";
import type { FixtureBody } from "../resilience/fixture-loader";
import { repoRoot } from "./paths";

export type ManifestMockRule = {
	id: string;
	urlPattern: string;
	method: string;
	matchQuery?: string;
	match: (url: string) => boolean;
	body: FixtureBody;
};

function loadFixtureBody(fixtureDir: string, relative: string): FixtureBody {
	const filePath = path.join(repoRoot(), fixtureDir, relative);
	const raw = fs.readFileSync(filePath, "utf-8");
	return JSON.parse(raw) as FixtureBody;
}

function urlMatchesQuery(url: string, matchQuery?: string): boolean {
	if (!matchQuery) return true;
	if (url.includes(matchQuery)) return true;
	// encoded form
	try {
		const parts = matchQuery.split("&");
		return parts.every((p) => {
			const [k, v] = p.split("=");
			if (!k) return true;
			return (
				url.includes(`${k}=${v}`) ||
				url.includes(`${encodeURIComponent(k)}=${encodeURIComponent(v || "")}`)
			);
		});
	} catch {
		return false;
	}
}

export function loadMockRulesFromManifest(
	profile?: FixtureProfile,
): ManifestMockRule[] {
	const manifest = loadProjectManifest();
	const mock = manifest.mock;
	if (!mock?.routes?.length) {
		return [];
	}

	const profileKey = profile || process.env.E2E_MOCK_PROFILE || "default";
	const routeIdsForProfile =
		profileKey && mock.profileRouteMap?.[profileKey]
			? new Set(mock.profileRouteMap[profileKey])
			: null;

	const rules: ManifestMockRule[] = [];
	for (const route of mock.routes) {
		if (routeIdsForProfile) {
			if (!routeIdsForProfile.has(route.id)) continue;
		} else if (route.matchQuery) {
			// Without an explicit profile, skip state-specific query variants
			// (avoid ambiguous multi-state matches). Base routes still load.
			continue;
		}
		if (!route.fixture) {
			continue;
		}
		try {
			const body = loadFixtureBody(mock.fixtureDir, route.fixture);
			const matchSegment = route.match;
			const matchQuery = route.matchQuery;
			rules.push({
				id: route.id,
				urlPattern: matchSegment,
				method: (route.method || "GET").toUpperCase(),
				...(matchQuery ? { matchQuery } : {}),
				match: (url) =>
					url.includes(matchSegment) && urlMatchesQuery(url, matchQuery),
				body,
			});
		} catch {
			// fixture missing — skip; l2-readiness should block earlier
		}
	}

	// Prefer more specific (matchQuery) rules first
	rules.sort((a, b) => (b.matchQuery ? 1 : 0) - (a.matchQuery ? 1 : 0));
	return rules;
}

/** Resolve body by urlPattern + method + optional matchQuery (declarative). */
export function resolveManifestBodyForUrl(
	url: string,
	method: string,
	rules: ManifestMockRule[],
): FixtureBody | null {
	const upper = method.toUpperCase();
	for (const rule of rules) {
		if (!rule.match(url)) {
			continue;
		}
		if (rule.method && rule.method !== upper) {
			continue;
		}
		return rule.body;
	}
	return null;
}
