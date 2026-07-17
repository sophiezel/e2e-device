import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildWebViewUrlAnchor } from "../config/project-manifest";
import type { ProjectManifest } from "../config/project-manifest";
import { discoverRequestLayer } from "./discover-request-layer";
import {
	e2eDeviceRoot,
	repoRoot,
	paths,
	e2eHome,
	projectsDir,
	saveProjectConfig,
	projectHash as hashProject,
} from "./paths";
import { readLocalConfig, writeLocalConfig } from "../config/local-config";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch (err) {
		if (process.env.E2E_DEBUG) console.debug("[discover-project]", err);
		return "";
	}
}

/** Derive a stable project hash for E2E_HOME/projects/{hash}/ paths (SSOT: paths.projectHash). */
function projectHash(): string {
	return hashProject(repoRoot());
}

/** Path to the v2 manifest cache in E2E_HOME. */
function manifestCachePath(): string {
	const dir = projectsDir();
	return path.join(dir, projectHash(), "manifest.json");
}

// ─── Project State Detection ─────────────────────────────────────────────────

function detectProjectState(root: string): "A" | "B" | "C" {
	const hasDevice = fs.existsSync(path.join(root, "e2e-device", "wdio.conf.ts"));
	if (hasDevice) return "C";
	const hasPlaywright =
		fs.existsSync(path.join(root, "playwright.config.ts")) ||
		fs.existsSync(path.join(root, "e2e"));
	return hasPlaywright ? "B" : "A";
}

// ─── Routing Mode Detection ──────────────────────────────────────────────────

/**
 * Read App.tsx, App.vue, or router/index.* to determine routing mode.
 * Returns "history" (default for React Router v6, Vue Router history mode)
 * or "hash" (HashRouter, createHashRouter, hash mode).
 */
function detectRoutingMode(root: string): "history" | "hash" {
	const candidates = [
		path.join(root, "src", "App.tsx"),
		path.join(root, "src", "App.vue"),
		path.join(root, "src", "App.jsx"),
		path.join(root, "src", "app.tsx"),
		path.join(root, "src", "app.vue"),
		path.join(root, "src", "router", "index.ts"),
		path.join(root, "src", "router", "index.js"),
		path.join(root, "src", "router", "index.tsx"),
	];

	let combinedText = "";
	for (const f of candidates) {
		if (fs.existsSync(f)) combinedText += readText(f);
	}

	if (/HashRouter|createHashRouter|hashRouter|mode:\s*['"]hash['"]/i.test(combinedText)) {
		return "hash";
	}
	return "history";
}

// ─── Page Origin Detection ──────────────────────────────────────────────────

export type PageOriginCandidate = {
	url: string;
	source: string;
	confidence: "high" | "medium" | "low";
};

type PageOriginResult = {
	pageOrigin: string;
	confidence: "high" | "medium" | "low";
	candidates: PageOriginCandidate[];
};

/** Normalize origin URL: trim trailing slash, keep path prefix like /v2. */
function normalizeOriginUrl(raw: string): string {
	const trimmed = raw.trim().replace(/['"`]/g, "").replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(trimmed)) return "";
	return trimmed;
}

/** Filter obvious API / CDN / static hosts that are not H5 page origins. */
function isLikelyApiOrigin(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		if (/^i\./.test(host)) return true;
		if (/-api\./.test(host) || /\.api\./.test(host)) return true;
		if (/carsource-api|api-phx|gateway|static\./.test(host)) return true;
		return false;
	} catch {
		return true;
	}
}

function pushPageCandidate(
	list: PageOriginCandidate[],
	raw: string,
	source: string,
	confidence: "high" | "medium" | "low",
): void {
	const url = normalizeOriginUrl(raw);
	if (!url) return;
	if (isLikelyApiOrigin(url) && confidence !== "low") {
		// Keep as low-confidence hint so Agent can see the false positive
		list.push({ url, source: `${source} (likely-api)`, confidence: "low" });
		return;
	}
	if (list.some((c) => c.url === url && c.source === source)) return;
	list.push({ url, source, confidence });
}

function pickBestPageOrigin(candidates: PageOriginCandidate[]): {
	pageOrigin: string;
	confidence: "high" | "medium" | "low";
} {
	const rank = { high: 3, medium: 2, low: 1 };
	const usable = candidates.filter((c) => !c.source.includes("likely-api"));
	const pool = usable.length ? usable : candidates;
	if (!pool.length) return { pageOrigin: "", confidence: "low" };
	pool.sort((a, b) => rank[b.confidence] - rank[a.confidence]);
	return { pageOrigin: pool[0].url, confidence: pool[0].confidence };
}

/**
 * Extract page origin candidates from project config/env/docs.
 * Never silently treat bare ORIGIN / I_ORIGIN as H5 pageOrigin.
 */
function detectPageOrigin(root: string): PageOriginResult {
	const candidates: PageOriginCandidate[] = [];

	// Source 1: e2e-device/config/env.ts — explicit H5 keys only
	const e2eEnv = path.join(root, "e2e-device", "config", "env.ts");
	if (fs.existsSync(e2eEnv)) {
		const text = readText(e2eEnv);
		const exact = text.matchAll(
			/\b(?:H5_HOST|H5_ORIGIN|PAGE_ORIGIN|PUBLIC_URL)\s*=\s*['"]([^'"]+)['"]/g,
		);
		for (const m of exact) {
			pushPageCandidate(candidates, m[1], "e2e-device/config/env.ts", "high");
		}
		const react = text.matchAll(/\bREACT_APP_H5_(?:HOST|ORIGIN)\s*=\s*['"]([^'"]+)['"]/gi);
		for (const m of react) {
			pushPageCandidate(candidates, m[1], "e2e-device/config/env.ts:REACT_APP_H5", "high");
		}
	}

	// Source 2: webpack / CRA publicPath (including commented lines)
	for (const rel of ["config-overrides.js", "vue.config.js", "vite.config.ts", "vite.config.js", "webpack.config.js"]) {
		const fp = path.join(root, rel);
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);
		const re = /publicPath\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			pushPageCandidate(candidates, m[1], `${rel}:publicPath`, "high");
		}
	}

	// Source 3: project docs — H5 deploy URLs (generic https origins)
	const docsPath = path.join(root, resolveDocsPath());
	const scanDocUrls = (dir: string, depth = 0): void => {
		if (depth > 4 || !fs.existsSync(dir)) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				scanDocUrls(full, depth + 1);
				continue;
			}
			if (!/\.(md|txt)$/i.test(ent.name)) continue;
			const text = readText(full);
			const re = /https?:\/\/[a-z0-9.-]+(?::\d+)?\/[a-zA-Z0-9._~/-]*/gi;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				const url = m[0].replace(/[),.;]+$/, "");
				// Skip obvious API-only hosts when path looks like /api
				if (/\/api(\/|$)/i.test(url)) continue;
				const rel = path.relative(root, full);
				pushPageCandidate(candidates, url, `docs:${rel}`, "medium");
			}
		}
	};
	scanDocUrls(docsPath);
	scanDocUrls(path.join(docsPath, "product-specs"));

	// Source 4: Common env/config — exact H5 keys only (no bare ORIGIN / I_ORIGIN)
	const envCandidates = [
		"src/config/env.ts", "src/config/env.js", "src/config/env.tsx",
		"src/config/index.ts", "src/config/index.js",
		"src/utils/config.ts", "src/utils/config.js",
		"config/env.js", "config/env.ts",
		".env", ".env.local", ".env.development",
	];
	for (const rel of envCandidates) {
		const fp = path.join(root, ...rel.split("/"));
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);
		const exactKeys = text.matchAll(
			/\b(?:H5_ORIGIN|H5_HOST|PAGE_ORIGIN|CDN_URL|CDN_BASE|PUBLIC_URL)\s*[:=]\s*['"]([^'"]+)['"]/gi,
		);
		for (const m of exactKeys) {
			pushPageCandidate(candidates, m[1], rel, "high");
		}
		const reactH5 = text.matchAll(/\bREACT_APP_H5_[A-Z_]*\s*=\s*(\S+)/g);
		for (const m of reactH5) {
			pushPageCandidate(candidates, m[1], `${rel}:REACT_APP_H5`, "high");
		}
		const viteH5 = text.matchAll(/\bVITE_H5_[A-Z_]*\s*=\s*(\S+)/g);
		for (const m of viteH5) {
			pushPageCandidate(candidates, m[1], `${rel}:VITE_H5`, "high");
		}
		// Explicit HOST key only (not ORIGIN substring) — medium, still filter API hosts
		const hostOnly = text.matchAll(/\bHOST\s*:\s*['"](https?:\/\/[^'"]+)['"]/g);
		for (const m of hostOnly) {
			pushPageCandidate(candidates, m[1], `${rel}:HOST`, "medium");
		}
	}

	// Source 5: Existing manifest cache (hint only)
	try {
		const manifestPath = manifestCachePath();
		if (fs.existsSync(manifestPath)) {
			const existing = JSON.parse(readText(manifestPath)) as ProjectManifest;
			if (existing?.hybrid?.network?.pageOrigin) {
				pushPageCandidate(
					candidates,
					existing.hybrid.network.pageOrigin,
					"manifest-cache",
					"low",
				);
			}
		}
	} catch { /* ignore */ }

	// Source 6: Legacy skill.project.json
	try {
		const legacy = path.join(root, "e2e-device", "skill.project.json");
		if (fs.existsSync(legacy)) {
			const existing = JSON.parse(readText(legacy)) as {
				hybrid?: { network?: { pageOrigin?: string } };
			};
			if (existing?.hybrid?.network?.pageOrigin) {
				pushPageCandidate(
					candidates,
					existing.hybrid.network.pageOrigin,
					"e2e-device/skill.project.json",
					"low",
				);
			}
		}
	} catch { /* ignore */ }

	// Source 7: .e2e-local.json
	try {
		const local = readLocalConfig();
		const fromLocal = local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin;
		if (fromLocal) pushPageCandidate(candidates, fromLocal, ".e2e-local.json", "low");
	} catch { /* ignore */ }

	const best = pickBestPageOrigin(candidates);
	return { ...best, candidates };
}

// ─── API Origin Detection ───────────────────────────────────────────────────

function detectApiOrigin(root: string): {
	apiOrigin: string;
	confidence: "high" | "medium" | "low";
} {
	const envCandidates = [
		"src/config/env.js", "src/config/env.ts",
		"src/service/index.js", "src/service/index.ts",
		"src/utils/config.ts", "src/utils/config.js",
		"src/api/index.ts", "src/api/index.js",
	];

	for (const rel of envCandidates) {
		const fp = path.join(root, ...rel.split("/"));
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);

		// Direct: API_ORIGIN = 'https://...'
		const direct = text.match(/API_ORIGIN\s*=\s*['"]([^'"]+)['"]/);
		if (direct?.[1]) return { apiOrigin: direct[1], confidence: "high" };

		// `apiXxx = '//host'` pattern (framework-agnostic)
		const serviceApi = text.match(/\bapi[A-Za-z]+\s*=\s*['"](\/\/[^'"]+)['"]/);
		if (serviceApi?.[1]) {
			return { apiOrigin: serviceApi[1].replace(/^\/\//, "https://"), confidence: "high" };
		}

		// `[TEST]: { JIAN_J: '...' }` or similar
		const configBlock = text.match(/\[TEST\]:[\s\S]*?\{[^}]*\}/);
		if (configBlock) {
			const originMatch = configBlock[0].match(/(?:JIAN_J|API|HOST)\s*:\s*['"]([^'"]+)['"]/);
			if (originMatch?.[1]) return { apiOrigin: originMatch[1], confidence: "high" };
		}

		// Axios baseURL
		const baseUrl = text.match(/baseURL\s*:\s*['"]([^'"]+)['"]/);
		if (baseUrl?.[1] && /^https?:\/\//.test(baseUrl[1])) {
			return { apiOrigin: baseUrl[1], confidence: "medium" };
		}
	}

	// Fallback: environment variable files
	const envFiles = [".env", ".env.local", ".env.development"];
	for (const rel of envFiles) {
		const fp = path.join(root, rel);
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);
		const m = text.match(/(?:API_ORIGIN|VITE_API_BASE|REACT_APP_API_ORIGIN)\s*=\s*(\S+)/);
		if (m?.[1]) return { apiOrigin: m[1], confidence: "medium" };
	}

	return { apiOrigin: "", confidence: "low" };
}

// ─── Path Prefix ─────────────────────────────────────────────────────────────

function detectPathPrefix(root: string): string {
	const e2eEnv = path.join(root, "e2e-device", "config", "env.ts");
	const combined = fs.existsSync(e2eEnv) ? readText(e2eEnv) : "";

	const m = combined.match(/H5_PATH_PREFIX\s*=\s*['"]([^'"]+)['"]/);
	if (m?.[1]) return m[1];

	const legacy = combined.match(/(?:JIAN_H5_PREFIX|APP_PATH_PREFIX)\s*=\s*['"]([^'"]+)['"]/);
	return legacy?.[1] || "";
}

// ─── Route Discovery ───────────────────────────────────────────────────────

function discoverPageDirs(root: string): string[] {
	const srcDir = path.join(root, "src");
	if (!fs.existsSync(srcDir)) return [];

	// Framework-agnostic page directory detection
	const pageDirs = ["pages", "page", "views", "routes", "screens"];
	for (const dirName of pageDirs) {
		const fullDir = path.join(srcDir, dirName);
		if (!fs.existsSync(fullDir)) continue;
		try {
			return fs
				.readdirSync(fullDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.filter((name) => !name.startsWith("_") && !name.startsWith("."));
		} catch {
			continue;
		}
	}
	return [];
}

/** Extract routes from App.tsx <Route path/> patterns. */
function discoverRoutesFromApp(root: string): Record<string, string> {
	const routes: Record<string, string> = {};

	const candidates = [
		path.join(root, "src", "App.tsx"),
		path.join(root, "src", "App.jsx"),
		path.join(root, "src", "app.tsx"),
	];
	for (const fp of candidates) {
		try {
			if (!fs.existsSync(fp)) continue;
			const text = fs.readFileSync(fp, "utf-8");
			const re = /<Route\s+path=["']([^"':*]+)["']/gi;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				const routePath = m[1].replace(/^\//, "");
				if (routePath && routePath !== "/" && !routes[routePath]) {
					routes[routePath] = routePath;
				}
			}
		} catch { /* parse failure non-critical */ }
	}

	// Vue Router: router/index.*
	const vueCandidates = [
		path.join(root, "src", "router", "index.ts"),
		path.join(root, "src", "router", "index.js"),
	];
	for (const fp of vueCandidates) {
		try {
			if (!fs.existsSync(fp)) continue;
			const text = fs.readFileSync(fp, "utf-8");
			// Vue router path patterns: path: '/xxx'
			const re = /path:\s*['"]([^'"]+)['"]/gi;
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) {
				const routePath = m[1].replace(/^\//, "");
				if (routePath && routePath !== "/" && !routes[routePath]) {
					routes[routePath] = routePath;
				}
			}
		} catch { /* parse failure non-critical */ }
	}

	return routes;
}

/** Infer list/form related routes for Journey segmentation. */
function inferRelatedRoutes(
	domain: string,
	routes: Record<string, string>,
	root: string,
): Record<string, string> {
	const related: Record<string, string> = { list: domain };

	// Common pattern: checkRecovery (list) → evaluateRecovery (form)
	if (domain === "checkRecovery" && routes.evaluateRecovery) {
		related.form = "evaluateRecovery";
		return related;
	}

	// Heuristic: sibling route sharing prefix (Recovery, Detail, etc.)
	for (const [key] of Object.entries(routes)) {
		if (key === domain) continue;
		if (key.startsWith(domain) || domain.startsWith(key)) continue;
		const domainStem = domain.replace(/(List|Index|Page)$/i, "");
		if (domainStem.length > 3 && key.includes(domainStem) && key !== domain) {
			related.form = key;
			break;
		}
	}

	// Matrix doc hint: pageModule column differs from E2E_DOMAIN
	try {
		const docsRoot = path.join(root, resolveDocsPath());
		if (fs.existsSync(docsRoot)) {
			const walk = (dir: string): void => {
				for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
					const fp = path.join(dir, ent.name);
					if (ent.isDirectory()) {
						walk(fp);
						continue;
					}
					if (!ent.name.endsWith(".md")) continue;
					const text = fs.readFileSync(fp, "utf-8");
					const re = new RegExp(
						`\\|\\s*C\\d+\\s*\\|[^|]*\\|\\s*(${Object.keys(routes).join("|")})\\s*\\|`,
						"g",
					);
					let m: RegExpExecArray | null;
					while ((m = re.exec(text)) !== null) {
						const mod = m[1];
						if (mod && mod !== domain) related.form = mod;
					}
				}
			};
			walk(docsRoot);
		}
	} catch { /* non-critical */ }

	return related;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the configurable docs base path.
 * Priority: E2E_DOCS_PATH env var > project manifest > default "docs"
 */
function resolveDocsPath(): string {
	const envPath = process.env.E2E_DOCS_PATH?.trim();
	if (envPath) return envPath.replace(/\/$/, "");
	return "docs";
}

// ─── Domain Inference ────────────────────────────────────────────────────────

export type DomainCandidate = {
	domain: string;
	score: number;
	sources: string[];
	changedFiles: string[];
	guaziFlowTask?: string;
};

type DomainScoreState = {
	score: number;
	sources: string[];
	changedFiles: Set<string>;
	guaziFlowTask?: string;
};

function bumpDomain(
	map: Map<string, DomainScoreState>,
	domain: string,
	weight: number,
	evidence: string,
	file?: string,
	guaziFlowTask?: string,
): void {
	if (!domain) return;
	let st = map.get(domain);
	if (!st) {
		st = { score: 0, sources: [], changedFiles: new Set() };
		map.set(domain, st);
	}
	st.score += weight;
	if (!st.sources.includes(evidence)) st.sources.push(evidence);
	if (file) st.changedFiles.add(file);
	if (guaziFlowTask) st.guaziFlowTask = guaziFlowTask;
}

function collectGitChangedFiles(root: string): string[] {
	const bases = ["origin/main", "origin/master", "main", "master"];
	const files = new Set<string>();

	for (const base of bases) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
				cwd: root,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			for (const f of out.split("\n").filter(Boolean)) files.add(f);
			if (files.size) break;
		} catch { /* try next base */ }
	}

	// Working tree (unstaged + staged)
	try {
		const out = execFileSync("git", ["diff", "--name-only", "HEAD"], {
			cwd: root,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const f of out.split("\n").filter(Boolean)) files.add(f);
	} catch { /* ignore */ }
	try {
		const out = execFileSync("git", ["status", "-s", "--porcelain"], {
			cwd: root,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const line of out.split("\n").filter(Boolean)) {
			const f = line.replace(/^.. /, "").trim();
			if (f) files.add(f);
		}
	} catch { /* ignore */ }

	return [...files];
}

function mapFileToDomains(file: string, domains: string[]): string[] {
	const hits: string[] = [];
	for (const pattern of ["src/pages/", "src/page/", "src/views/", "src/routes/", "src/screens/"]) {
		const m = file.match(new RegExp(pattern.replace("/", "\\/") + "([^/]+)"));
		if (m && domains.includes(m[1])) hits.push(m[1]);
	}
	// services/{name}.ts → domain if name matches
	const svc = file.match(/src\/services\/([^/.]+)/);
	if (svc) {
		const name = svc[1];
		if (domains.includes(name)) hits.push(name);
		// heuristic: checkRecovery.ts also boosts related pages that share prefix
		for (const d of domains) {
			if (d !== name && (d.includes(name) || name.includes(d))) hits.push(d);
		}
	}
	return [...new Set(hits)];
}

/**
 * Multi-signal domain scoring. Returns ranked candidates with evidence.
 */
export function collectDomainCandidates(root: string, domains: string[]): {
	candidates: DomainCandidate[];
	recommended: string | undefined;
} {
	const map = new Map<string, DomainScoreState>();

	// P0: explicit env
	const envDomain =
		process.env.E2E_DOMAIN?.trim() ||
		process.env.E2E_PILOT_DOMAIN?.trim() ||
		"";
	if (envDomain) {
		bumpDomain(map, envDomain, 100, "env:E2E_DOMAIN|E2E_PILOT_DOMAIN");
	}

	// P3: natural language intent
	const intent = process.env.E2E_USER_INTENT?.trim() || "";
	if (intent) {
		for (const d of domains) {
			if (intent.includes(d)) bumpDomain(map, d, 25, "env:E2E_USER_INTENT");
		}
	}

	// P1/P3: git diff + working tree
	const changed = collectGitChangedFiles(root);
	const vsMain = new Set<string>();
	for (const base of ["origin/main", "origin/master", "main", "master"]) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
				cwd: root,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			for (const f of out.split("\n").filter(Boolean)) vsMain.add(f);
			if (vsMain.size) break;
		} catch { /* next */ }
	}

	for (const f of changed) {
		const mapped = mapFileToDomains(f, domains);
		const isCommittedDiff = vsMain.has(f);
		const weight = isCommittedDiff ? 20 : 10;
		const label = isCommittedDiff ? "git-diff" : "working-tree";
		for (const d of mapped) {
			const isService = /src\/services\//.test(f);
			bumpDomain(map, d, isService ? 15 : weight, `${label}:${f}`, f);
		}
	}

	// P1: guazi-flow write_set / routes — prefer tasks intersecting current changes
	const docsPath = path.join(root, resolveDocsPath(), "guazi-flow");
	if (fs.existsSync(docsPath)) {
		try {
			const changedDomains = new Set<string>();
			for (const f of changed) {
				for (const d of mapFileToDomains(f, domains)) changedDomains.add(d);
			}
			const tasks = fs
				.readdirSync(docsPath, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort()
				.reverse();
			for (const task of tasks.slice(0, 12)) {
				const indexMd = path.join(docsPath, task, "index.md");
				if (!fs.existsSync(indexMd)) continue;
				const text = readText(indexMd);
				const taskDomains = new Set<string>();
				for (const d of domains) {
					if (text.includes(`src/pages/${d}/`) || text.includes(`src/services/${d}`)) {
						taskDomains.add(d);
					}
				}
				const routeRe = /\/v2\/([A-Za-z][A-Za-z0-9_-]*)/g;
				let rm: RegExpExecArray | null;
				while ((rm = routeRe.exec(text)) !== null) {
					if (domains.includes(rm[1])) taskDomains.add(rm[1]);
				}
				// Skip stale tasks that share no domain with current git changes
				// (unless there are no changed domains yet — then keep top tasks)
				if (changedDomains.size > 0) {
					let overlap = false;
					for (const d of taskDomains) {
						if (changedDomains.has(d)) {
							overlap = true;
							break;
						}
					}
					if (!overlap) continue;
				}
				for (const d of taskDomains) {
					const inWriteSet =
						text.includes(`src/pages/${d}/`) || text.includes(`src/services/${d}`);
					bumpDomain(
						map,
						d,
						inWriteSet ? 30 : 20,
						inWriteSet ? `guazi-flow:写集:${task}` : `guazi-flow:route:/v2/${d}`,
						undefined,
						task,
					);
				}
				for (const d of domains) {
					if (task.toLowerCase().includes(d.toLowerCase())) {
						bumpDomain(map, d, 10, `guazi-flow:dirname:${task}`, undefined, task);
					}
				}
			}
		} catch { /* ignore */ }
	}

	// P2/P4: legacy docs dirs + App routes cross
	const docsDomain = inferDomainFromDocs(root, domains);
	if (docsDomain) bumpDomain(map, docsDomain, 10, "docs:product-specs|domain-docs");

	const routes = discoverRoutesFromApp(root);
	for (const route of Object.keys(routes)) {
		if (domains.includes(route) && map.has(route)) {
			bumpDomain(map, route, 5, "App.tsx:route-cross");
		}
	}

	// P5: manifest cache hint
	try {
		const manifestPath = manifestCachePath();
		if (fs.existsSync(manifestPath)) {
			const existing = JSON.parse(readText(manifestPath)) as ProjectManifest;
			const cached = existing?.pilot?.domain;
			if (cached) bumpDomain(map, cached, 5, "manifest-cache:pilot.domain");
		}
	} catch { /* ignore */ }

	const candidates: DomainCandidate[] = [...map.entries()]
		.map(([domain, st]) => ({
			domain,
			score: st.score,
			sources: st.sources,
			changedFiles: [...st.changedFiles].slice(0, 20),
			...(st.guaziFlowTask ? { guaziFlowTask: st.guaziFlowTask } : {}),
		}))
		.sort((a, b) => b.score - a.score);

	let recommended: string | undefined;
	if (candidates.length === 1) {
		recommended = candidates[0].domain;
	} else if (candidates.length >= 2) {
		if (candidates[0].score >= candidates[1].score + 15) {
			recommended = candidates[0].domain;
		}
	}

	// env always wins as recommended
	if (envDomain) recommended = envDomain;

	return { candidates, recommended };
}

/**
 * Infer the primary test domain from domain documentation directories.
 * Generic replacement for inferPilotFromMatrixDoc.
 */
function inferDomainFromDocs(root: string, domains: string[]): string | undefined {
	// Scan common documentation directories
	const docsPath = resolveDocsPath();
	const docDirs = [
		path.join(root, docsPath, "domain-docs"),
		path.join(root, docsPath, "product-specs"),
		path.join(root, docsPath, "features"),
	];

	for (const fullDir of docDirs) {
		if (!fs.existsSync(fullDir)) continue;

		try {
			const dirs = fs
				.readdirSync(fullDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort()
				.reverse();

			for (const dirName of dirs) {
				for (const domain of domains) {
					if (dirName.includes(domain)) return domain;
				}
			}
		} catch { /* ignore */ }
	}

	return undefined;
}

// ─── App Package Detection ─────────────────────────────────────────────────

/**
 * Read app package from project configuration files.
 */
function readAppPackage(root: string): string {
	// Source 1: e2e-device/config/app.ts
	const e2eAppTs = path.join(root, "e2e-device", "config", "app.ts");
	if (fs.existsSync(e2eAppTs)) {
		const text = readText(e2eAppTs);
		const m = text.match(/APP_PACKAGE\s*=\s*['"]([^'"]+)['"]/);
		if (m?.[1]) return m[1];
	}

	// Source 2: app.json or capacitor.config
	const appJson = path.join(root, "app.json");
	if (fs.existsSync(appJson)) {
		try {
			const cfg = JSON.parse(readText(appJson));
			if (cfg?.expo?.android?.package) return cfg.expo.android.package;
		} catch { /* ignore */ }
	}

	const capCfg = path.join(root, "capacitor.config.ts");
	if (fs.existsSync(capCfg)) {
		const text = readText(capCfg);
		const m = text.match(/appId:\s*['"]([^'"]+)['"]/);
		if (m?.[1]) return m[1];
	}

	return "";
}

/**
 * Detect app package from connected device via ADB.
 * Scans installed packages for non-system candidates with a
 * debuggable or recognizable Activity.
 */
function detectAppPackageFromDevice(_root: string): string | null {
	try {
		const pkgs = execFileSync("adb", ["shell", "pm", "list", "packages"], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const candidates = pkgs
			.split("\n")
			.map((l) => l.replace("package:", "").trim())
			.filter(
				(p) =>
					p &&
					!p.startsWith("com.android") &&
					!p.startsWith("com.google.android") &&
					!p.startsWith("android"),
			);

		// Prefer packages with debuggable flag or openapi-like Activity
		for (const pkg of candidates) {
			try {
				const dump = execFileSync("adb", ["shell", "dumpsys", "package", pkg], {
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				if (
					/OpenApiActivity/i.test(dump) ||
					/debuggable.*true/.test(dump)
				) {
					return pkg;
				}
			} catch { /* skip */ }
		}

		// Fallback: return first non-system package
		return candidates[0] || null;
	} catch {
		return null;
	}
}

// ─── Deep Link Scheme Detection ─────────────────────────────────────────────

export type DeepLinkSchemeResult = {
	scheme: string;
	source: string;
	h5SchemeHints: string[];
	needsNativeConfirm: string[];
};

/**
 * Detect deep link scheme. Prefer adb dumpsys / AndroidManifest over H5 string hints.
 */
function detectDeepLinkSchemeDetailed(root: string, pkg: string): DeepLinkSchemeResult {
	const needsNativeConfirm: string[] = [];
	const h5SchemeHints: string[] = [];

	// Collect H5 scheme hints (low confidence — not authoritative)
	const h5Files = [
		path.join(root, "src"),
	];
	const schemeRe = /\b([a-z][a-z0-9+.-]*):\/\/(?:openapi|mainpage)\/(?:openWebview|openRNView)/gi;
	const walkHint = (dir: string, depth: number): void => {
		if (depth > 3 || !fs.existsSync(dir)) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walkHint(full, depth + 1);
				continue;
			}
			if (!/\.(tsx?|jsx?|md)$/.test(ent.name)) continue;
			const text = readText(full);
			let m: RegExpExecArray | null;
			schemeRe.lastIndex = 0;
			while ((m = schemeRe.exec(text)) !== null) {
				if (!h5SchemeHints.includes(m[1])) h5SchemeHints.push(m[1]);
			}
		}
	};
	for (const d of h5Files) walkHint(d, 0);

	// Priority 1: adb dumpsys (device with test APK)
	if (pkg && pkg !== "unknown") {
		const fromDevice = detectDeepLinkSchemeFromDevice(pkg);
		if (fromDevice) {
			return {
				scheme: fromDevice,
				source: "adb:dumpsys",
				h5SchemeHints,
				needsNativeConfirm: [],
			};
		}
		needsNativeConfirm.push("deepLink.scheme");
	} else {
		needsNativeConfirm.push("appPackage", "deepLink.scheme");
	}

	// Priority 2: project android/ AndroidManifest
	const manifestFiles = [
		"android/app/src/main/AndroidManifest.xml",
		"app/src/main/AndroidManifest.xml",
	];
	for (const rel of manifestFiles) {
		const fp = path.join(root, ...rel.split("/"));
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);
		const m = text.match(/<data\s+android:scheme="([^"]+)"/);
		if (m?.[1]) {
			return {
				scheme: m[1],
				source: `android:${rel}`,
				h5SchemeHints,
				needsNativeConfirm: needsNativeConfirm.filter((x) => x !== "deepLink.scheme"),
			};
		}
	}

	// Priority 3: e2e-device/config/app.ts
	const e2eAppTs = path.join(root, "e2e-device", "config", "app.ts");
	if (fs.existsSync(e2eAppTs)) {
		const text = readText(e2eAppTs);
		const m = text.match(/scheme:\s*['"]([^'"]+)['"]/);
		if (m?.[1]) {
			return {
				scheme: m[1],
				source: "e2e-device/config/app.ts",
				h5SchemeHints,
				needsNativeConfirm: needsNativeConfirm.filter((x) => x !== "deepLink.scheme"),
			};
		}
	}

	// Priority 4: H5 hint (low confidence)
	if (h5SchemeHints.length) {
		needsNativeConfirm.push("deepLink.scheme");
		return {
			scheme: h5SchemeHints[0],
			source: "h5-string-hint",
			h5SchemeHints,
			needsNativeConfirm: [...new Set(needsNativeConfirm)],
		};
	}

	needsNativeConfirm.push("deepLink.scheme", "deepLink.openPath", "deepLink.h5Action");
	return {
		scheme: "",
		source: "unresolved",
		h5SchemeHints,
		needsNativeConfirm: [...new Set(needsNativeConfirm)],
	};
}

function detectDeepLinkScheme(root: string, pkg: string): string {
	return detectDeepLinkSchemeDetailed(root, pkg).scheme;
}

function detectDeepLinkSchemeFromDevice(pkg: string): string {
	if (!pkg || pkg === "unknown") return "";
	try {
		const dump = execFileSync("adb", ["shell", "dumpsys", "package", pkg], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const schemeMatch = dump.match(/Scheme:\s*"([a-z][a-z0-9+.-]*)"/i);
		if (schemeMatch) return schemeMatch[1];
	} catch { /* device unavailable */ }
	return "";
}

// ─── Cookie Domain ──────────────────────────────────────────────────────────

function inferCookieDomain(origin: string): string {
	if (!origin) return "";
	try {
		const hostname = new URL(origin).hostname;
		const parts = hostname.split(".");
		if (parts.length >= 2) return "." + parts.slice(-2).join(".");
		return "." + hostname;
	} catch {
		return "";
	}
}

// ─── Login Resource IDs ────────────────────────────────────────────────────

function readLoginIds(
	e2eAppTs: string,
	pkg: string,
): ProjectManifest["hybrid"]["container"]["loginResourceIds"] | undefined {
	if (!pkg || !e2eAppTs.includes("LOGIN_IDS")) return undefined;
	const id = (key: string) => {
		const re = new RegExp(`${key}:\\s*[^:]*:id/([a-zA-Z0-9_]+)`);
		const m = e2eAppTs.match(re);
		return m ? `${pkg}:id/${m[1]}` : "";
	};
	const account = id("account");
	if (!account) return undefined;
	return { account, password: id("password"), loginBtn: id("loginBtn") };
}

// ─── Discover Meta (framework-agnostic) ─────────────────────────────────────

/**
 * Detect documentation roots and source patterns.
 * Uses generic names instead of hardcoded business paths.
 */
function detectDiscoverMeta(root: string): ProjectManifest["discover"] {
	// Detect documentation directories
	const docsPath = resolveDocsPath();
	const docRoots: string[] = [];
	for (const d of [path.join(docsPath, "domain-docs"), path.join(docsPath, "product-specs"), path.join(docsPath, "features")]) {
		if (fs.existsSync(d)) docRoots.push(d);
	}
	if (docRoots.length === 0) docRoots.push(docsPath);

	// Detect pages glob
	let pagesGlob = "src/pages/**/index.tsx";
	for (const [p, glob] of [
		["src/pages", "src/pages/**/index.tsx"],
		["src/page", "src/page/**"],
		["src/views", "src/views/**"],
		["src/routes", "src/routes/**"],
		["src/screens", "src/screens/**"],
	]) {
		if (fs.existsSync(path.join(root, ...p.split("/")))) {
			pagesGlob = glob;
			break;
		}
	}

	// Detect env file
	let envFile = "src/config/env.js";
	for (const f of ["src/config/env.js", "src/config/env.ts", "src/service/index.js", "src/service/index.ts", "src/api/index.ts"]) {
		if (fs.existsSync(path.join(root, ...f.split("/")))) { envFile = f; break; }
	}

	// Detect route file
	const routeCandidates = [
		"src/App.tsx", "src/App.jsx", "src/app.tsx",
		"src/router/index.ts", "src/router/index.js",
	];
	let routeFile = "src/App.tsx";
	for (const f of routeCandidates) {
		if (fs.existsSync(path.join(root, ...f.split("/")))) { routeFile = f; break; }
	}

	return { docRoots, pagesGlob, envFile, routeFile };
}

// ─── Commands ───────────────────────────────────────────────────────────────

function detectCommands(root: string): ProjectManifest["commands"] {
	const pkgPath = path.join(root, "package.json");
	if (!fs.existsSync(pkgPath)) {
		return {
			run: "bash ~/.agents/skills/e2e-device/scripts/run.sh --project .",
			prepare: "bash ~/.agents/skills/e2e-device/scripts/run.sh --project . --plan-only",
		};
	}
	try {
		const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
		const scripts = pkg.scripts || {};
		if (scripts["test:e2e:device"]) {
			return {
				run: "yarn test:e2e:device",
				prepare:
					scripts["test:e2e:device:prepare"] ||
					"bash ~/.agents/skills/e2e-device/scripts/run.sh --project . --plan-only",
			};
		}
	} catch { /* ignore */ }
	return {
		run: "bash ~/.agents/skills/e2e-device/scripts/run.sh --project .",
		prepare: "bash ~/.agents/skills/e2e-device/scripts/run.sh --project . --plan-only",
	};
}

// ─── Domain Doc Path ────────────────────────────────────────────────────────

/**
 * Find the domain documentation file for a given domain.
 * Framework-agnostic: scans common doc directories.
 */
function findDomainDoc(root: string, domain: string): string | undefined {
	const docsPath = resolveDocsPath();
	const docDirs = [
		path.join(docsPath, "domain-docs"),
		path.join(docsPath, "product-specs"),
		path.join(docsPath, "features"),
	];

	for (const docDir of docDirs) {
		const fullDir = docDir;
		if (!fs.existsSync(fullDir)) continue;

		try {
			const entries = fs
				.readdirSync(fullDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name)
				.sort()
				.reverse();

			const match = entries.find((name) => name.includes(domain));
			if (match) return path.join(docDir, match, "index.md");

			// If no subdirectory match, look for domain.md directly
			for (const entry of entries) {
				if (entry.endsWith(".md") && entry.includes(domain)) {
					return path.join(docDir, entry);
				}
			}
		} catch { /* ignore */ }
	}

	return undefined;
}

/**
 * Resolve acceptance-matrix doc path for pilot domain.
 * Prefer guazi-flow task from domainCandidates; fall back to domainDoc / guazi-flow scan.
 */
function findMatrixDoc(
	root: string,
	domain: string | undefined,
	candidates: DomainCandidate[],
): string | undefined {
	if (!domain) return undefined;
	const taskFromCandidate = candidates.find(
		(c) => c.domain === domain && c.guaziFlowTask,
	)?.guaziFlowTask;
	if (taskFromCandidate) {
		const p = path.join(root, "docs", "guazi-flow", taskFromCandidate, "index.md");
		if (fs.existsSync(p)) return path.relative(root, p);
	}
	// Scan guazi-flow dirs whose index mentions domain in matrix pageModule column
	const gfRoot = path.join(root, "docs", "guazi-flow");
	if (fs.existsSync(gfRoot)) {
		const scored: Array<{ rel: string; score: number }> = [];
		for (const ent of fs.readdirSync(gfRoot, { withFileTypes: true })) {
			if (!ent.isDirectory()) continue;
			const indexPath = path.join(gfRoot, ent.name, "index.md");
			if (!fs.existsSync(indexPath)) continue;
			try {
				const text = fs.readFileSync(indexPath, "utf-8");
				if (!text.includes("验收与验证矩阵")) continue;
				if (!text.includes(domain)) continue;
				let score = 0;
				if (ent.name.includes(domain)) score += 50;
				// Prefer rows where page/module column is exactly the domain
				const rowHits = (
					text.match(
						new RegExp(`\\|\\s*C\\d+\\s*\\|[^|]*\\|\\s*${domain}\\s*\\|`, "g"),
					) || []
				).length;
				score += rowHits * 10;
				if (score > 0) {
					scored.push({
						rel: path.relative(root, indexPath),
						score,
					});
				}
			} catch {
				/* skip */
			}
		}
		scored.sort((a, b) => b.score - a.score);
		if (scored[0]) return scored[0].rel;
	}
	const domainDoc = findDomainDoc(root, domain);
	return domainDoc ? path.relative(root, domainDoc) : undefined;
}

// ─── Main discoverProject ───────────────────────────────────────────────────

/**
 * NEW v2: Custom error when pilot domain cannot be inferred.
 */
export class PilotDomainError extends Error {
	readonly domains: string[];
	constructor(message: string, domains: string[]) {
		super(message);
		this.name = "PilotDomainError";
		this.domains = domains;
	}
}

export function discoverProject(): ProjectManifest {
	const root = repoRoot();

	// Read source files
	const e2eAppText = (() => {
		const fp = path.join(root, "e2e-device", "config", "app.ts");
		return fs.existsSync(fp) ? readText(fp) : "";
	})();

	const domains = discoverPageDirs(root);
	const routingMode = detectRoutingMode(root);
	const pathPrefix = detectPathPrefix(root);
	const page = detectPageOrigin(root);
	const api = detectApiOrigin(root);
	const domainResult = collectDomainCandidates(root, domains);

	// E2E_DOMAIN binds webView anchor + pilot domain when user confirmed
	const envDomain =
		process.env.E2E_DOMAIN?.trim() ||
		process.env.E2E_PILOT_DOMAIN?.trim() ||
		"";

	// WebView config
	const webView = {
		routingMode,
		pathPrefix,
		hashPrefix: routingMode === "hash" ? "#/" : "",
		webViewUrlAnchor: "",
	};

	const pilotResolved =
		envDomain ||
		domainResult.recommended ||
		(domainResult.candidates.length === 1 ? domainResult.candidates[0].domain : undefined);
	if (pilotResolved) {
		webView.webViewUrlAnchor = buildWebViewUrlAnchor(webView, pilotResolved);
	} else if (domains.length > 0) {
		console.warn(
			`[discover] 无法唯一推断 pilot domain（候选 ${domainResult.candidates.length} 个）, 默认使用: ${domains[0]}`,
		);
		console.warn(
			`[discover] 请设置 E2E_DOMAIN 或经 AskQuestion 确认后 export`,
		);
		webView.webViewUrlAnchor = buildWebViewUrlAnchor(webView, domains[0]);
	} else {
		throw new PilotDomainError(
			`Cannot auto-detect test requirement. No routes found in project. ` +
				`Set E2E_DOMAIN or configure pilot.domain in skill.project.json.`,
			domains,
		);
	}

	// App package
	const localPkg = readLocalConfig()?.app?.android?.appPackage;
	let pkg = localPkg || readAppPackage(root) || process.env.E2E_APP_PACKAGE || "";
	const devicePkg = (!pkg || pkg === "unknown") ? detectAppPackageFromDevice(root) : null;
	const finalPkg = pkg && pkg !== "unknown" ? pkg : devicePkg || "";

	if (devicePkg) {
		try {
			writeLocalConfig({ app: { android: { appPackage: devicePkg, appActivity: "" } } });
		} catch { /* non-critical */ }
	}

	const loginIds = readLoginIds(e2eAppText, finalPkg);
	const deepLink = detectDeepLinkSchemeDetailed(root, finalPkg);
	if (!loginIds) {
		deepLink.needsNativeConfirm.push("loginResourceIds");
	}

	// Build manifest
	const appRoutes = discoverRoutesFromApp(root);
	const manifest: ProjectManifest = {
		id: path.basename(root),
		projectState: detectProjectState(root),
		hybrid: {
			platform: "android",
			container: {
				package: finalPkg || "",
				openApiActivity:
					e2eAppText.match(/WEBVIEW_ACTIVITY\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
					e2eAppText.match(/APP_ACTIVITY\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
					"",
				...(loginIds ? { loginResourceIds: loginIds } : {}),
			},
			webView,
			deepLink: {
				scheme: deepLink.scheme,
				openPath: "openapi",
				h5Action: "openWebview",
				requiredQuery: ["url"],
				forbiddenQueryOnColdOpen: ["token"],
			},
			cookie: { domainSuffix: inferCookieDomain(page.pageOrigin) },
			auth: {
				mode: "native",
				layers: ["native", "bridgeToken"],
				h5: {
					loginPathPatterns: ["/login", "passport", "signin"],
					unauthTextPatterns: ["请登录", "未登录", "token", "登录失效"],
				},
				api: {
					unauthHttpStatuses: [401, 403],
					unauthBodyCodes: [-100, "REQUEST_UNLOGIN"],
				},
			},
			network: {
				pageOrigin: page.pageOrigin,
				apiOrigin: api.apiOrigin,
				pageOriginConfidence: page.confidence,
				apiOriginConfidence: api.confidence,
				pageOriginCandidates: page.candidates,
			},
		},
		discover: detectDiscoverMeta(root),
		docs: {
			readme: "e2e-device/README.md",
			domainDoc: (pilotResolved ? findDomainDoc(root, pilotResolved) : undefined) ?? "",
			...(pilotResolved
				? {
						matrixDoc:
							findMatrixDoc(root, pilotResolved, domainResult.candidates) ||
							"",
					}
				: {}),
		},
		pilot: {
			domain: pilotResolved ?? domains[0] ?? "",
			routes: appRoutes,
			relatedRoutes: inferRelatedRoutes(
				pilotResolved ?? domains[0] ?? "",
				appRoutes,
				root,
			),
			domainCandidates: domainResult.candidates,
		},
		nativeHints: {
			deepLinkSchemeSource: deepLink.source,
			needsNativeConfirm: [...new Set(deepLink.needsNativeConfirm)],
			h5SchemeHints: deepLink.h5SchemeHints,
		},
		commands: detectCommands(root),
	};

	// Mock layer — keep routes without fixtures (L2 visibility); host fixtures under e2e-device/fixtures
	const requestLayer = discoverRequestLayer(pilotResolved);
	manifest.mock = {
		strategy: "inject",
		injectFlag: "__E2E_MOCK__",
		fixtureDir: "e2e-device/fixtures",
		hasBmock: requestLayer.hasBmock,
		routes: requestLayer.routes.map((r) => ({
			id: r.id,
			match: r.match,
			method: r.method,
			source: r.source,
			...(r.fixture ? { fixture: r.fixture } : {}),
			...(r.matchQuery ? { matchQuery: r.matchQuery } : {}),
		})),
		...(requestLayer.profileRouteMap ? { profileRouteMap: requestLayer.profileRouteMap } : {}),
		...(requestLayer.pageApiGraph ? { pageApiGraph: requestLayer.pageApiGraph } : {}),
		...(requestLayer.mockStates
			? {
					mockStates: {
						gateParam: requestLayer.mockStates.gateParam,
						states: requestLayer.mockStates.states,
					},
				}
			: {}),
	};

	// e2e-shared routes
	if (pilotResolved) {
		const sharedRoutes = path.join(root, "e2e-shared", `${pilotResolved}.routes.ts`);
		if (fs.existsSync(sharedRoutes)) {
			const rt = readText(sharedRoutes);
			const routeMatches = rt.matchAll(/(\w+)\s*:\s*['"]([^'"]+)['"]/g);
			for (const m of routeMatches) {
				manifest.pilot!.routes[m[1]] = m[2];
			}
		}
	}

	// ── NEW v2: Write manifest to E2E_HOME cache, NOT project directory ──
	const cachePath = manifestCachePath();
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2), "utf-8");
	console.log(`[discover-project] Manifest written to: ${cachePath}`);

	// Also save via the project config API for backward compat
	saveProjectConfig(manifest as unknown as Record<string, unknown>);

	// Write YAML sidecar
	const yaml = renderYaml(manifest);
	const yamlPath = path.join(path.dirname(cachePath), "manifest.yaml");
	fs.writeFileSync(yamlPath, yaml, "utf-8");

	return manifest;
}

/**
 * List preconfig candidates for Agent AskQuestion (pageOrigin / appPackage / domain).
 * Does not require user confirmation; read-only discovery.
 */
export function listPreconfig(opts?: { domainHint?: string }): Record<string, unknown> {
	const root = repoRoot();
	const domains = discoverPageDirs(root);
	const page = detectPageOrigin(root);
	const domainResult = collectDomainCandidates(root, domains);

	if (opts?.domainHint) {
		bumpDomainForHint(domainResult, opts.domainHint);
	}

	const configPkg = readAppPackage(root);
	const envPkg = process.env.E2E_APP_PACKAGE?.trim() || "";
	const appPackageCandidates = collectAppPackageCandidates(root, configPkg, envPkg);

	const preferredPkg =
		envPkg ||
		configPkg ||
		appPackageCandidates.find((c) => c.debuggable)?.package ||
		appPackageCandidates[0]?.package ||
		"";
	const deepLink = detectDeepLinkSchemeDetailed(root, preferredPkg);

	const envPage = !!(process.env.E2E_PAGE_ORIGIN || process.env.E2E_H5_ORIGIN);
	const envApp = !!process.env.E2E_APP_PACKAGE;
	const envDomain = !!(process.env.E2E_DOMAIN || process.env.E2E_PILOT_DOMAIN);

	const quickPath = evaluateQuickPathEligible({
		root,
		envPage,
		envApp,
		envDomain,
		envPageOrigin: process.env.E2E_PAGE_ORIGIN || process.env.E2E_H5_ORIGIN || "",
		envAppPackage: process.env.E2E_APP_PACKAGE || "",
		envDomainValue: process.env.E2E_DOMAIN || process.env.E2E_PILOT_DOMAIN || "",
	});

	return {
		project: root,
		pageOriginCandidates: page.candidates,
		pageOriginRecommended: page.pageOrigin || null,
		domainCandidates: domainResult.candidates,
		domainRecommended: domainResult.recommended || opts?.domainHint || null,
		appPackageCandidates,
		appPackageRecommended: preferredPkg || null,
		nativeHints: {
			deepLinkSchemeSource: deepLink.source,
			deepLinkScheme: deepLink.scheme || null,
			h5SchemeHints: deepLink.h5SchemeHints,
			needsNativeConfirm: [...new Set(deepLink.needsNativeConfirm)],
		},
		envPresent: {
			E2E_PAGE_ORIGIN: envPage,
			E2E_APP_PACKAGE: envApp,
			E2E_DOMAIN: envDomain,
		},
		quickPathEligible: quickPath.eligible,
		quickPathReasons: quickPath.reasons,
		instruction: quickPath.eligible
			? "Quick Path: 三项 env 已齐且与上次确认一致 — 跳过 AskQuestion，摘要展示 effective 后直接 --plan-only"
			: "AskQuestion 确认 pageOrigin / appPackage / domain 后 export E2E_PAGE_ORIGIN E2E_APP_PACKAGE E2E_DOMAIN，再执行 run.sh --plan-only",
	};
}

function evaluateQuickPathEligible(input: {
	root: string;
	envPage: boolean;
	envApp: boolean;
	envDomain: boolean;
	envPageOrigin: string;
	envAppPackage: string;
	envDomainValue: string;
}): { eligible: boolean; reasons: string[] } {
	const reasons: string[] = [];
	if (!input.envPage || !input.envApp || !input.envDomain) {
		reasons.push("missing_env_triad");
		return { eligible: false, reasons };
	}

	try {
		const cachePath = manifestCachePath();
		if (!fs.existsSync(cachePath)) {
			reasons.push("no_manifest");
			return { eligible: false, reasons };
		}
		const manifest = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as {
			userConfirmed?: { pageOrigin?: string; appPackage?: string; domain?: string };
			lastRun?: { branch?: string; deviceSerial?: string };
		};
		const uc = manifest.userConfirmed;
		if (!uc?.pageOrigin || !uc?.appPackage || !uc?.domain) {
			reasons.push("no_userConfirmed");
			return { eligible: false, reasons };
		}
		if (uc.pageOrigin !== input.envPageOrigin) reasons.push("pageOrigin_changed");
		if (uc.appPackage !== input.envAppPackage) reasons.push("appPackage_changed");
		if (uc.domain !== input.envDomainValue) reasons.push("domain_changed");

		const branch = (() => {
			try {
				return execFileSync("git", ["-C", input.root, "rev-parse", "--abbrev-ref", "HEAD"], {
					encoding: "utf-8",
				}).trim();
			} catch {
				return "";
			}
		})();
		if (manifest.lastRun?.branch && branch && manifest.lastRun.branch !== branch) {
			reasons.push("branch_changed");
		}
		const serial = process.env.ANDROID_UDID || process.env.E2E_DEVICE_SERIAL || "";
		if (manifest.lastRun?.deviceSerial && serial && manifest.lastRun.deviceSerial !== serial) {
			reasons.push("device_changed");
		}

		if (reasons.length > 0) return { eligible: false, reasons };
		return { eligible: true, reasons: ["env_matches_userConfirmed"] };
	} catch {
		reasons.push("manifest_read_error");
		return { eligible: false, reasons };
	}
}

function bumpDomainForHint(
	domainResult: { candidates: DomainCandidate[]; recommended: string | undefined },
	hint: string,
): void {
	const existing = domainResult.candidates.find((c) => c.domain === hint);
	if (existing) {
		existing.score += 25;
		if (!existing.sources.includes("cli:--domain")) existing.sources.push("cli:--domain");
		domainResult.candidates.sort((a, b) => b.score - a.score);
	} else {
		domainResult.candidates.unshift({
			domain: hint,
			score: 25,
			sources: ["cli:--domain"],
			changedFiles: [],
		});
	}
	domainResult.recommended = hint;
}

function collectAppPackageCandidates(
	_root: string,
	configPkg: string,
	envPkg: string,
): Array<{ package: string; source: string; debuggable?: boolean }> {
	const out: Array<{ package: string; source: string; debuggable?: boolean }> = [];
	const seen = new Set<string>();
	const add = (pkg: string, source: string, debuggable?: boolean) => {
		if (!pkg || seen.has(pkg)) return;
		seen.add(pkg);
		out.push({ package: pkg, source, ...(debuggable !== undefined ? { debuggable } : {}) });
	};
	if (envPkg) add(envPkg, "env:E2E_APP_PACKAGE");
	if (configPkg) add(configPkg, "e2e-device/config");

	try {
		const pkgs = execFileSync("adb", ["shell", "pm", "list", "packages", "-3"], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const line of pkgs.split("\n")) {
			const pkg = line.replace("package:", "").trim().replace(/\r/g, "");
			if (!pkg) continue;
			const filter = process.env.E2E_APP_PACKAGE_FILTER?.trim();
			if (filter) {
				try {
					if (!new RegExp(filter, "i").test(pkg)) continue;
				} catch {
					continue;
				}
			}
			let debuggable: boolean | undefined;
			try {
				const dump = execFileSync("adb", ["shell", "dumpsys", "package", pkg], {
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				debuggable = /DEBUGGABLE|debuggable.*true/i.test(dump);
			} catch {
				debuggable = undefined;
			}
			add(pkg, "adb:pm-list", debuggable);
		}
	} catch { /* adb unavailable */ }

	return out;
}

// ─── YAML Rendering ─────────────────────────────────────────────────────────

function yamlEscape(v: string): string {
	if (!v) return '""';
	if (v.includes("\n")) return "|\n" + v.split("\n").map((l) => "    " + l).join("\n");
	if (/[:#&*!%@`{}[\],|>"'\n]/.test(v) || v.trim() !== v) {
		return `"${v.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	}
	return v;
}

function renderYaml(m: ProjectManifest): string {
	const v = yamlEscape;
	const lines = [
		`id: ${v(m.id)}`,
		`projectState: ${m.projectState ? v(m.projectState) : "unknown"}`,
		"hybrid:",
		`  platform: ${v(m.hybrid.platform)}`,
		"  container:",
		`    package: ${v(m.hybrid.container.package)}`,
		`    openApiActivity: ${v(m.hybrid.container.openApiActivity)}`,
		"  webView:",
		`    routingMode: ${v(m.hybrid.webView.routingMode)}`,
		`    pathPrefix: ${v(m.hybrid.webView.pathPrefix)}`,
		`    hashPrefix: ${v(m.hybrid.webView.hashPrefix)}`,
		`    webViewUrlAnchor: ${v(m.hybrid.webView.webViewUrlAnchor)}`,
		"  deepLink:",
		`    scheme: ${v(m.hybrid.deepLink.scheme)}`,
		`    openPath: ${v(m.hybrid.deepLink.openPath)}`,
		"discover:",
		`  pagesGlob: ${v(m.discover.pagesGlob)}`,
		`  envFile: ${v(m.discover.envFile)}`,
		`  routeFile: ${v(m.discover.routeFile)}`,
	];
	if (m.pilot?.domain) {
		lines.push("pilot:", `  domain: ${v(m.pilot.domain)}`);
	}
	if (m.docs?.domainDoc) {
		lines.push("docs:", `  domainDoc: ${v(m.docs.domainDoc)}`);
	}
	return lines.join("\n") + "\n";
}
