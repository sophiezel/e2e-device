import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";

/** Host page roots (framework-agnostic). */
const PAGE_ROOT_SEGMENTS = ["page", "pages", "views", "screens"] as const;

const PAGE_IMPORT_RE = new RegExp(
	`import\\s+(\\w+)\\s+from\\s+['"]@/(?:${PAGE_ROOT_SEGMENTS.join("|")})/([^'"]+)['"]`,
	"g",
);
const PAGE_LAZY_IMPORT_RE = new RegExp(
	`import\\s*\\(\\s*['"]@/(?:${PAGE_ROOT_SEGMENTS.join("|")})/([^'"]+)['"]\\s*\\)`,
	"g",
);
const CHANGED_PAGE_FILE_RE = new RegExp(
	`src/(?:${PAGE_ROOT_SEGMENTS.join("|")})/(.+?)\\.(?:vue|tsx|jsx)$`,
	"i",
);

/** Strip dynamic segments (`:id`) for deeplink path building. */
export function normalizeRoutePath(routePath: string): string {
	return routePath
		.replace(/^\//, "")
		.replace(/\/:[^/]+/g, "")
		.replace(/\/$/, "");
}

function collectRouterFiles(root: string): string[] {
	const files: string[] = [];
	const candidates = [
		path.join(root, "src", "router", "index.ts"),
		path.join(root, "src", "router", "index.js"),
		path.join(root, "src", "routes", "index.ts"),
		path.join(root, "src", "routes", "index.js"),
		path.join(root, "src", "App.tsx"),
		path.join(root, "src", "App.jsx"),
	];
	for (const fp of candidates) {
		if (fs.existsSync(fp)) files.push(fp);
	}
	const extendDirs = [
		path.join(root, "src", "router", "extend"),
		path.join(root, "src", "routes"),
	];
	for (const dir of extendDirs) {
		if (!fs.existsSync(dir)) continue;
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (ent.isFile() && /\.(t|j)sx?$/.test(ent.name)) {
				const fp = path.join(dir, ent.name);
				if (!files.includes(fp)) files.push(fp);
			}
		}
	}
	return files;
}

function indexPageImports(text: string): Map<string, string> {
	const compToPage = new Map<string, string>();
	for (const m of text.matchAll(PAGE_IMPORT_RE)) {
		compToPage.set(m[1], m[2].replace(/\.(vue|tsx|jsx)$/i, ""));
	}
	for (const m of text.matchAll(PAGE_LAZY_IMPORT_RE)) {
		const pagePath = m[1].replace(/\.(vue|tsx|jsx)$/i, "");
		const lazyKey = pagePath.split("/").pop() || pagePath;
		compToPage.set(lazyKey, pagePath);
	}
	return compToPage;
}

function extractNamedRoutes(
	text: string,
	compToPage: Map<string, string>,
	routes: Record<string, string>,
	pageFileToRoutes: Record<string, string[]>,
): void {
	const blockRe =
		/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*path:\s*['"]([^'"]+)['"][^{}]*(?:\{[^{}]*\}[^{}]*)*name:\s*['"]([^'"]+)['"][^{}]*(?:\{[^{}]*\}[^{}]*)*component:\s*([^,}\n]+)/gs;
	let bm: RegExpExecArray | null;
	while ((bm = blockRe.exec(text)) !== null) {
		const routePath = normalizeRoutePath(bm[1]);
		const routeName = bm[2].trim();
		const compRef = bm[3].trim().replace(/\(\)\s*=>\s*import\([^)]+\)/, "");
		if (!routePath || routePath === "/") continue;
		routes[routeName] = routePath;
		const compName = compRef.replace(/[^a-zA-Z0-9_$]/g, "");
		const pageFile = compToPage.get(compName);
		if (pageFile) {
			linkPageToRoute(pageFile, routeName, pageFileToRoutes);
		}
	}

	const pathRe = /path:\s*['"]([^'"]+)['"]/gi;
	let pm: RegExpExecArray | null;
	while ((pm = pathRe.exec(text)) !== null) {
		const routePath = normalizeRoutePath(pm[1]);
		if (!routePath || routePath === "/") continue;
		const key = routePath.split("/").pop() || routePath;
		if (!routes[key]) routes[key] = routePath;
		if (!routes[routePath]) routes[routePath] = routePath;
	}

	const reactRe = /<Route\s+path=["']([^"':*]+)["']/gi;
	let rm: RegExpExecArray | null;
	while ((rm = reactRe.exec(text)) !== null) {
		const routePath = normalizeRoutePath(rm[1]);
		if (!routePath || routePath === "/") continue;
		if (!routes[routePath]) routes[routePath] = routePath;
	}
}

function linkPageToRoute(
	pageFile: string,
	routeName: string,
	pageFileToRoutes: Record<string, string[]>,
): void {
	const key = pageFile.toLowerCase();
	if (!pageFileToRoutes[key]) pageFileToRoutes[key] = [];
	if (!pageFileToRoutes[key].includes(routeName)) {
		pageFileToRoutes[key].push(routeName);
	}
}

/**
 * Parse SPA router modules → route name/path map + page-file → route names.
 * Framework-agnostic: Vue-style route tables + React `<Route path=`.
 */
export function discoverRouteGraph(root: string): {
	routes: Record<string, string>;
	pageFileToRoutes: Record<string, string[]>;
} {
	const routes: Record<string, string> = {};
	const pageFileToRoutes: Record<string, string[]> = {};

	for (const fp of collectRouterFiles(root)) {
		try {
			const text = fs.readFileSync(fp, "utf-8");
			const compToPage = indexPageImports(text);
			extractNamedRoutes(text, compToPage, routes, pageFileToRoutes);
		} catch {
			/* non-critical */
		}
	}

	return { routes, pageFileToRoutes };
}

/** @deprecated Use discoverRouteGraph */
export function discoverVueRouteGraph(root: string): ReturnType<typeof discoverRouteGraph> {
	return discoverRouteGraph(root);
}

function routesForDomainFolder(
	domain: string,
	pageFileToRoutes: Record<string, string[]>,
): string[] {
	const prefix = `${domain.toLowerCase()}/`;
	const hits: string[] = [];
	for (const [pageKey, routeNames] of Object.entries(pageFileToRoutes)) {
		if (pageKey.startsWith(prefix) || pageKey.split("/")[0] === domain.toLowerCase()) {
			for (const name of routeNames) {
				if (!hits.includes(name)) hits.push(name);
			}
		}
	}
	return hits;
}

/** Prefer list/index-style entry routes when multiple candidates exist. */
function pickDefaultRoute(candidates: string[]): string | undefined {
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	const scored = candidates.map((name) => {
		const lower = name.toLowerCase();
		let score = 0;
		if (/list|index|home|main/.test(lower)) score += 10;
		if (lower.endsWith("list")) score += 5;
		return { name, score };
	});
	scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
	return scored[0]?.name;
}

function tryCreatePrefixedRoute(domain: string, routes: Record<string, string>): string | undefined {
	const variants = [
		`create${domain}`,
		`create-${domain}`,
		`create${domain.replace(/-/g, "")}`,
	];
	for (const v of variants) {
		if (routes[v]) return v;
	}
	for (const [name] of Object.entries(routes)) {
		if (name.toLowerCase() === `create${domain.toLowerCase()}`) return name;
	}
	return undefined;
}

/** Map page-folder domain → concrete route key for deeplink / WebView needle. */
export function inferLaunchRoute(
	domain: string,
	opts?: {
		routes?: Record<string, string>;
		pageFileToRoutes?: Record<string, string[]>;
		changedFiles?: string[];
	},
): string {
	const routes = opts?.routes ?? {};
	const pageFileToRoutes = opts?.pageFileToRoutes ?? {};
	const changedFiles = opts?.changedFiles ?? [];

	for (const f of changedFiles) {
		const m = f.match(CHANGED_PAGE_FILE_RE);
		if (!m) continue;
		const pageKey = m[1].toLowerCase();
		const folder = pageKey.split("/")[0];
		if (folder.toLowerCase() !== domain.toLowerCase() && domain.toLowerCase() !== folder) {
			continue;
		}
		const hits = pageFileToRoutes[pageKey];
		if (hits?.[0]) return hits[0];
	}

	const envRoute =
		process.env.E2E_ROUTE?.trim() || process.env.E2E_PILOT_ROUTE?.trim() || "";
	if (envRoute) return envRoute;

	try {
		const m = loadProjectManifest();
		const pilotDomain = (m.pilot?.domain || "").trim();
		if (pilotDomain && pilotDomain.toLowerCase() === domain.toLowerCase()) {
			if (m.pilot?.launchRoute) return m.pilot.launchRoute;
			const related = m.pilot?.relatedRoutes?.list;
			if (related && routes[related]) return related;
		}
	} catch {
		/* manifest optional during discover */
	}

	if (routes[domain]) return domain;

	const lower = domain.toLowerCase();
	for (const [name, routePath] of Object.entries(routes)) {
		if (name.toLowerCase() === lower || routePath.toLowerCase() === lower) {
			return name;
		}
	}

	const created = tryCreatePrefixedRoute(domain, routes);
	if (created) return created;

	const folderRoutes = routesForDomainFolder(domain, pageFileToRoutes);
	const preferred = pickDefaultRoute(folderRoutes);
	if (preferred) return preferred;

	for (const [name] of Object.entries(routes)) {
		if (name.toLowerCase().includes(lower) && lower.length >= 3) return name;
	}

	return domain;
}

/** Resolve E2E domain (page folder) → concrete route key for deeplink / WebView needle. */
export function resolveRouteKey(domain: string, routes?: Record<string, string>): string {
	return inferLaunchRoute(domain, { routes: routes ?? {} });
}
