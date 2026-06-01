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
	match: (url: string) => boolean;
	body: FixtureBody;
};

function loadFixtureBody(fixtureDir: string, relative: string): FixtureBody {
	const filePath = path.join(repoRoot(), fixtureDir, relative);
	const raw = fs.readFileSync(filePath, "utf-8");
	return JSON.parse(raw) as FixtureBody;
}

export function loadMockRulesFromManifest(
	profile?: FixtureProfile,
): ManifestMockRule[] {
	const manifest = loadProjectManifest();
	const mock = manifest.mock;
	if (!mock?.routes?.length) {
		return [];
	}

	const routeIdsForProfile =
		profile && mock.profileRouteMap?.[profile]
			? new Set(mock.profileRouteMap[profile])
			: null;

	const rules: ManifestMockRule[] = [];
	for (const route of mock.routes) {
		if (routeIdsForProfile && !routeIdsForProfile.has(route.id)) {
			continue;
		}
		if (!route.fixture) {
			continue;
		}
		try {
			const body = loadFixtureBody(mock.fixtureDir, route.fixture);
			const matchSegment = route.match;
			rules.push({
				id: route.id,
				urlPattern: matchSegment,
				method: (route.method || "GET").toUpperCase(),
				match: (url) => url.includes(matchSegment),
				body,
			});
		} catch {
			// fixture missing — skip; l2-readiness should block earlier
		}
	}
	return rules;
}

/** Dynamic list/getById/submit resolution (manifest route ids). */
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
		if (rule.id.includes("list") && rule.id.includes("audited")) {
			if (
				url.includes("tableType=audited") ||
				url.includes("tableType%3Daudited")
			) {
				return rule.body;
			}
			continue;
		}
		if (rule.id.includes("list") && rule.id.includes("un_audit")) {
			if (
				url.includes("tableType=un_audit") ||
				url.includes("tableType%3Dun_audit")
			) {
				return rule.body;
			}
			continue;
		}
		if (rule.id.includes("list")) {
			const audited = rules.find((r) => r.id.includes("audited"));
			const pending = rules.find((r) => r.id.includes("un_audit"));
			if (
				url.includes("tableType=audited") ||
				url.includes("tableType%3Daudited")
			) {
				return audited?.body ?? rule.body;
			}
			if (
				url.includes("tableType=un_audit") ||
				url.includes("tableType%3Dun_audit")
			) {
				return pending?.body ?? rule.body;
			}
		}
		if (rule.id.includes("getById")) {
			const idMatch = url.match(/[?&]id=([^&]+)/);
			const id = idMatch?.[1] ? decodeURIComponent(idMatch[1]) : "";
			const errRule = rules.find((r) => r.id.includes("999") || r.id.includes("error"));
			if (id === "999" && errRule) {
				return errRule.body;
			}
			return rule.body;
		}
		if (rule.id.includes("submit")) {
			if (
				url.includes("id=999") ||
				url.includes('"id":999') ||
				url.includes('"id":"999"')
			) {
				const err = rules.find((r) => r.id.includes("submit") && r.id.includes("error"));
				return err?.body ?? rule.body;
			}
			const ok = rules.find((r) => r.id.includes("submit") && r.id.includes("success"));
			return ok?.body ?? rule.body;
		}
		return rule.body;
	}
	return null;
}
