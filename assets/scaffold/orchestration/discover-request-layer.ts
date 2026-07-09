import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";
import { discoverPageApiGraph, type PageApiGraph } from "./discover-page-api-graph";
import {
	buildProfileRouteMap,
	loadDomainStates,
	type DomainStatesFile,
} from "./mock-state";

export interface MockRouteEntry {
	id: string;
	match: string;
	method: string;
	fixture?: string;
	source: string;
	/** Optional query substring that must appear in URL (e.g. clueId=xxx). */
	matchQuery?: string;
}

export const HOST_FIXTURE_DIR = "e2e-device/fixtures";

function findSourceRecursive(dir: string, exts: string[]): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			out.push(...findSourceRecursive(p, exts));
		} else if (exts.some((e) => ent.name.endsWith(e))) {
			out.push(p);
		}
	}
	return out;
}

function collectServiceFiles(root: string, pilotDomain?: string): string[] {
	const out = new Set<string>();
	const serviceRoots = [
		path.join(root, "src", "services"),
		path.join(root, "src", "service"),
	];
	for (const base of serviceRoots) {
		if (pilotDomain) {
			for (const ext of [".ts", ".js"]) {
				const pilotFile = path.join(base, `${pilotDomain}${ext}`);
				if (fs.existsSync(pilotFile)) {
					out.add(pilotFile);
				}
			}
		}
		for (const f of findSourceRecursive(base, [".ts", ".js"])) {
			out.add(f);
		}
	}
	const pagesDir = path.join(root, "src", "pages");
	const pageDir = path.join(root, "src", "page");
	for (const dir of [pagesDir, pageDir]) {
		if (!fs.existsSync(dir)) {
			continue;
		}
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isDirectory()) {
				continue;
			}
			const sub = path.join(dir, ent.name);
			for (const f of findSourceRecursive(sub, [".ts", ".js"])) {
				if (/service/i.test(path.basename(f)) || /api/i.test(f)) {
					out.add(f);
				}
			}
		}
	}
	return [...out];
}

/**
 * Attach fixtures from host e2e-device/fixtures/{domain}/ and root fixtures.
 * Prefer domain-scoped files; keep routes without fixtures (visible for L2).
 */
function attachFixturesFromDir(
	routes: MockRouteEntry[],
	fixtureDir: string,
	domain?: string,
): void {
	if (!fs.existsSync(fixtureDir)) {
		return;
	}
	const jsonFiles: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(p, prefix ? `${prefix}/${ent.name}` : ent.name);
			} else if (ent.name.endsWith(".json") && ent.name !== "states.json") {
				jsonFiles.push(prefix ? `${prefix}/${ent.name}` : ent.name);
			}
		}
	};
	walk(fixtureDir, "");

	const domainPrefixed = domain
		? jsonFiles.filter((f) => f.startsWith(`${domain}/`) || f.includes(`/${domain}/`))
		: [];
	const pool = domainPrefixed.length ? domainPrefixed : jsonFiles;

	for (const route of routes) {
		if (route.fixture) {
			continue;
		}
		const seg = route.match.split("/").filter(Boolean).pop() || "";
		if (!seg) continue;
		// Prefer .ok.json for default attachment
		const hit =
			pool.find((f) => f.includes(seg) && f.includes(".ok.")) ||
			pool.find((f) => f.includes(seg));
		if (!hit) {
			continue;
		}
		const rel = hit.replace(/\\/g, "/");
		const fp = path.join(fixtureDir, rel);
		if (fs.existsSync(fp)) {
			route.fixture = rel;
		}
	}
}

/**
 * Expand host states.json into route variants with matchQuery + fixture.
 * state.routes entries are fixture stems under fixtures/{domain}/ (e.g. recovery-info.ok).
 */
function expandStateRoutes(
	routes: MockRouteEntry[],
	statesFile: DomainStatesFile | undefined,
	fixtureRoot: string,
	domain: string,
): { routes: MockRouteEntry[]; profileRouteMap: Record<string, string[]> } {
	if (!statesFile?.states?.length) {
		return { routes, profileRouteMap: {} };
	}
	const extra: MockRouteEntry[] = [];
	const profileRouteMap: Record<string, string[]> = {};

	for (const state of statesFile.states) {
		const ids: string[] = [];
		for (const stem of state.routes) {
			const fixtureRel = stem.endsWith(".json")
				? `${domain}/${stem}`
				: `${domain}/${stem}.json`;
			const fixturePath = path.join(fixtureRoot, fixtureRel);
			if (!fs.existsSync(fixturePath)) continue;

			const match = inferMatchFromFixtureName(stem.replace(/\.json$/, ""));
			if (!match) continue;

			const base = routes.find((r) => r.match.includes(match.replace(/^\//, "").split("/").pop() || "")) || null;
			const id = `${stem.replace(/\.json$/, "")}__${state.id}`;
			const matchQuery = state.query && Object.keys(state.query).length
				? Object.entries(state.query)
						.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
						.join("&")
				: undefined;
			// Also accept unencoded query form for matching
			const matchQueryRaw = state.query && Object.keys(state.query).length
				? Object.entries(state.query).map(([k, v]) => `${k}=${v}`).join("&")
				: undefined;

			extra.push({
				id,
				match,
				method: base?.method || inferMethodFromStem(stem),
				fixture: fixtureRel,
				source: `states.json:${state.id}`,
				...(matchQueryRaw ? { matchQuery: matchQueryRaw } : {}),
			});
			ids.push(id);
			void matchQuery;
		}
		profileRouteMap[state.id] = ids;
		if (state.profile && state.profile !== state.id) {
			profileRouteMap[state.profile] = ids;
		}
	}
	return { routes: [...routes, ...extra], profileRouteMap };
}

function inferMatchFromFixtureName(stem: string): string | undefined {
	// recovery-info.ok → recovery/info ; getPriceInfo.ok → getPriceInfo
	// recommend-result stays hyphenated (API path segment, not path slash)
	const base = stem.replace(/\.(ok|fail)$/, "");
	if (!base) return undefined;
	const consign = base.match(/^(store-consign)-([a-z0-9]+)$/i);
	if (consign) {
		return `${consign[1]}/${consign[2]}`;
	}
	const pathStyle = base.match(/^([a-z0-9]+)-(info|list|detail)$/i);
	if (pathStyle) {
		return `${pathStyle[1]}/${pathStyle[2]}`;
	}
	return base;
}

function inferMethodFromStem(stem: string): string {
	if (/submit|sendsms|bind/i.test(stem)) return "POST";
	return "GET";
}

export function discoverRequestLayer(pilotDomain?: string): {
	strategy: string;
	hasBmock: boolean;
	routes: MockRouteEntry[];
	profileRouteMap?: Record<string, string[]>;
	pageApiGraph?: PageApiGraph;
	mockStates?: DomainStatesFile;
} {
	const root = repoRoot();
	const routes: MockRouteEntry[] = [];
	const seen = new Set<string>();
	const hasBmock = fs.existsSync(
		path.join(root, "src", "utils", "bmock", "index.js"),
	);

	const pageGraph = discoverPageApiGraph(pilotDomain);

	// Prefer URLs from page API graph when available
	if (pageGraph?.calls?.length) {
		for (const call of pageGraph.calls) {
			if (!call.url || !call.url.startsWith("/")) continue;
			if (seen.has(call.url)) continue;
			seen.add(call.url);
			const id = call.url.replace(/\//g, "_").replace(/^_/, "");
			routes.push({
				id,
				match: call.url,
				method: call.method || "GET",
				source: call.source,
			});
		}
	}

	for (const file of collectServiceFiles(root, pilotDomain)) {
		const text = fs.readFileSync(file, "utf-8");
		for (const m of text.matchAll(/["'](\/[a-zA-Z0-9_/-]+)["']/g)) {
			const matchPath = m[1];
			if (!matchPath.startsWith("/") || matchPath.length < 4) {
				continue;
			}
			if (!/^\/[a-zA-Z0-9]/.test(matchPath)) {
				continue;
			}
			if (seen.has(matchPath)) {
				continue;
			}
			seen.add(matchPath);
			const method = /method:\s*['"]POST['"]/i.test(text) ? "POST" : "GET";
			const id = matchPath.replace(/\//g, "_").replace(/^_/, "");
			routes.push({
				id,
				match: matchPath,
				method,
				source: path.relative(root, file),
			});
		}
	}

	const fixtureRoot = path.join(root, HOST_FIXTURE_DIR);
	attachFixturesFromDir(routes, fixtureRoot, pilotDomain);

	const statesFile = pilotDomain
		? loadDomainStates(fixtureRoot, pilotDomain)
		: undefined;
	const { routes: expanded, profileRouteMap: fromStates } = expandStateRoutes(
		routes,
		statesFile,
		fixtureRoot,
		pilotDomain || "",
	);
	const profileRouteMap =
		Object.keys(fromStates).length > 0
			? fromStates
			: statesFile?.states
				? buildProfileRouteMap(statesFile.states)
				: undefined;

	return {
		strategy: hasBmock ? "inject+bmock-optional" : "inject",
		hasBmock,
		routes: expanded,
		...(profileRouteMap ? { profileRouteMap } : {}),
		...(pageGraph ? { pageApiGraph: pageGraph } : {}),
		...(statesFile ? { mockStates: statesFile } : {}),
	};
}
