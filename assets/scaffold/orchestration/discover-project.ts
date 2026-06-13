import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildWebViewUrlAnchor } from "../config/project-manifest";
import type { ProjectManifest } from "../config/project-manifest";
import { discoverRequestLayer } from "./discover-request-layer";
import { e2eDeviceRoot, repoRoot, paths, e2eHome, projectsDir, saveProjectConfig } from "./paths";
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

/** Derive a stable project hash for E2E_HOME/projects/{hash}/ paths. */
function projectHash(): string {
	const root = repoRoot();
	return Buffer.from(root).toString("base64").replace(/[/+=]/g, "_").slice(0, 32);
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

/**
 * Extract page origin candidates from project config/env files.
 * Scans multiple sources with confidence levels:
 * - Env files (high confidence)
 * - Project config (high confidence)
 * - Existing manifest/local config (low confidence)
 */
function detectPageOrigin(root: string): {
	pageOrigin: string;
	confidence: "high" | "medium" | "low";
} {
	// Source 1: e2e-device/config/env.ts
	const e2eEnv = path.join(root, "e2e-device", "config", "env.ts");
	if (fs.existsSync(e2eEnv)) {
		const text = readText(e2eEnv);
		const m = text.match(/(?:H5_HOST|H5_ORIGIN|PAGE_ORIGIN)\s*=\s*['"]([^'"]+)['"]/);
		if (m?.[1]) return { pageOrigin: m[1], confidence: "high" };
		const react = text.match(/REACT_APP_[A-Z_]*ORIGIN\s*=\s*['"]([^'"]+)['"]/i);
		if (react?.[1]) return { pageOrigin: react[1], confidence: "high" };
	}

	// Source 2: Common env/config files (pattern-based, framework-agnostic)
	const envCandidates = [
		"src/config/env.ts", "src/config/env.js", "src/config/env.tsx",
		"src/config/index.ts", "src/config/index.js",
		"src/service/index.js", "src/service/index.ts",
		"src/utils/config.ts", "src/utils/config.js",
		"config/env.js", "config/env.ts",
		".env", ".env.local", ".env.development",
	];
	for (const rel of envCandidates) {
		const fp = path.join(root, ...rel.split("/"));
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);
		let m = text.match(/(?:H5_ORIGIN|H5_HOST|PAGE_ORIGIN|CDN_URL|CDN_BASE|PUBLIC_URL)\s*[:=]\s*['"]([^'"]+)['"]/i);
		if (m?.[1]) return { pageOrigin: m[1], confidence: "high" };

		// React .env: REACT_APP_*_ORIGIN
		m = text.match(/REACT_APP_[A-Z_]*ORIGIN\s*=\s*(\S+)/);
		if (m?.[1]) return { pageOrigin: m[1], confidence: "high" };

		// Vite .env: VITE_*_ORIGIN
		m = text.match(/VITE_[A-Z_]*ORIGIN\s*=\s*(\S+)/);
		if (m?.[1]) return { pageOrigin: m[1], confidence: "high" };

		// Generic: API_ORIGIN or apiOrigin
		m = text.match(/(?:API_ORIGIN|apiOrigin|api_origin)\s*[:=]\s*['"]([^'"]+)['"]/);
		if (m?.[1]) return { pageOrigin: m[1], confidence: "high" };

		// Vue env.js: `[TEST]: { ... HOST: 'xxx' }`
		m = text.match(/(?:HOST|ORIGIN|BASE_URL)\s*:\s*['"]([^'"]+)['"]/);
		if (m?.[1] && /^https?:\/\//.test(m[1])) return { pageOrigin: m[1], confidence: "medium" };
	}

	// Source 3: Existing manifest cache
	try {
		const manifestPath = manifestCachePath();
		if (fs.existsSync(manifestPath)) {
			const existing = JSON.parse(readText(manifestPath)) as ProjectManifest;
			if (existing?.hybrid?.network?.pageOrigin) {
				return { pageOrigin: existing.hybrid.network.pageOrigin, confidence: "low" };
			}
		}
	} catch { /* ignore */ }

	// Source 4: Legacy skill.project.json
	try {
		const legacy = path.join(root, "e2e-device", "skill.project.json");
		if (fs.existsSync(legacy)) {
			const existing = JSON.parse(readText(legacy)) as { hybrid?: { network?: { pageOrigin?: string } } };
			if (existing?.hybrid?.network?.pageOrigin) {
				return { pageOrigin: existing.hybrid.network.pageOrigin, confidence: "low" };
			}
		}
	} catch { /* ignore */ }

	// Source 5: .e2e-local.json
	try {
		const local = readLocalConfig();
		const fromLocal = local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin;
		if (fromLocal) return { pageOrigin: fromLocal, confidence: "low" };
	} catch { /* ignore */ }

	return { pageOrigin: "", confidence: "low" };
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

/**
 * Infer the primary test domain from git diff.
 */
function inferDomainFromGitDiff(root: string, domains: string[]): string | undefined {
	const bases = ["origin/main", "origin/master", "main", "master"];
	let diffFiles: string[] = [];

	for (const base of bases) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
				cwd: root,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			diffFiles = out.split("\n").filter(Boolean);
			if (diffFiles.length) break;
		} catch { /* try next base */ }
	}

	if (!diffFiles.length) return undefined;

	const diffDomains = new Set<string>();
	for (const f of diffFiles) {
		// Framework-agnostic: match any page/view/routes directory structure
		for (const pattern of ["src/pages/", "src/page/", "src/views/", "src/routes/", "src/screens/"]) {
			const m = f.match(new RegExp(pattern.replace("/", "\\/") + "([^/]+)/"));
			if (m && domains.includes(m[1])) {
				diffDomains.add(m[1]);
			}
		}
	}

	if (diffDomains.size === 1) return [...diffDomains][0];
	return undefined;
}

/**
 * Infer the primary test domain from domain documentation directories.
 * Generic replacement for inferPilotFromMatrixDoc.
 */
function inferDomainFromDocs(root: string, domains: string[]): string | undefined {
	// Scan common documentation directories
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

/**
 * Infer the pilot/test domain from all available signals.
 * Priority: env var > git diff > domain docs > first available domain
 */
function inferPilotDomain(root: string, domains: string[]): string | undefined {
	// 1. Environment variable
	const envDomain = process.env.E2E_PILOT_DOMAIN?.trim();
	if (envDomain) return envDomain;

	// 2. git-diff
	const diffDomain = inferDomainFromGitDiff(root, domains);
	if (diffDomain) return diffDomain;

	// 3. Domain docs
	const docsDomain = inferDomainFromDocs(root, domains);
	if (docsDomain) return docsDomain;

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

/**
 * Detect deep link scheme from project config and device.
 */
function detectDeepLinkScheme(root: string, pkg: string): string {
	// Source 1: e2e-device/config/app.ts
	const e2eAppTs = path.join(root, "e2e-device", "config", "app.ts");
	if (fs.existsSync(e2eAppTs)) {
		const text = readText(e2eAppTs);
		const m = text.match(/scheme:\s*['"]([^'"]+)['"]/);
		if (m?.[1]) return m[1];
	}

	// Source 2: AndroidManifest.xml or build.gradle
	const manifestFiles = [
		"android/app/src/main/AndroidManifest.xml",
		"app/src/main/AndroidManifest.xml",
	];
	for (const rel of manifestFiles) {
		const fp = path.join(root, ...rel.split("/"));
		if (!fs.existsSync(fp)) continue;
		const text = readText(fp);
		const m = text.match(/<data\s+android:scheme="([^"]+)"/);
		if (m?.[1]) return m[1];
	}

	// Source 3: Device dumpsys
	if (pkg && pkg !== "unknown") {
		return detectDeepLinkSchemeFromDevice(pkg);
	}

	return "";
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
			run: "bash e2e-device/scripts/init.sh",
			prepare: "bash e2e-device/scripts/init.sh --plan-only",
		};
	}
	try {
		const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
		const scripts = pkg.scripts || {};
		if (scripts["test:e2e:device"]) {
			return {
				run: "yarn test:e2e:device",
				prepare: scripts["test:e2e:device:prepare"] || "bash e2e-device/scripts/init.sh --plan-only",
			};
		}
	} catch { /* ignore */ }
	return {
		run: "bash e2e-device/scripts/init.sh",
		prepare: "bash e2e-device/scripts/init.sh --plan-only",
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
	const appTsx = path.join(root, "src", "App.tsx");
	const appVue = path.join(root, "src", "App.vue");

	const e2eEnvText = (() => {
		const fp = path.join(root, "e2e-device", "config", "env.ts");
		return fs.existsSync(fp) ? readText(fp) : "";
	})();

	const e2eAppText = (() => {
		const fp = path.join(root, "e2e-device", "config", "app.ts");
		return fs.existsSync(fp) ? readText(fp) : "";
	})();

	const domains = discoverPageDirs(root);
	const routingMode = detectRoutingMode(root);
	const pathPrefix = detectPathPrefix(root);
	const page = detectPageOrigin(root);
	const api = detectApiOrigin(root);

	// WebView config
	const webView = {
		routingMode,
		pathPrefix,
		hashPrefix: routingMode === "hash" ? "#/" : "",
		webViewUrlAnchor: "",
	};

	const pilotResolved = inferPilotDomain(root, domains);
	if (pilotResolved) {
		webView.webViewUrlAnchor = buildWebViewUrlAnchor(webView, pilotResolved);
	} else if (domains.length > 0) {
		console.warn(`[discover] 无法推断 pilot domain, 默认使用: ${domains[0]}`);
		console.warn(`[discover] 可修改: E2E_PILOT_DOMAIN=${domains[0]} 或在配置中设置 pilot.domain`);
		webView.webViewUrlAnchor = buildWebViewUrlAnchor(webView, domains[0]);
	} else {
		throw new PilotDomainError(
			`Cannot auto-detect test requirement. No routes found in project. ` +
				`Set E2E_PILOT_DOMAIN or configure pilot.domain in skill.project.json.`,
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

	// Build manifest
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
				scheme: detectDeepLinkScheme(root, finalPkg),
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
			},
		},
		discover: detectDiscoverMeta(root),
		docs: {
			readme: "e2e-device/README.md",
			// Generic domain doc discovery (replaces hardcoded matrixDoc)
			domainDoc: pilotResolved ? findDomainDoc(root, pilotResolved) : undefined,
		},
		pilot: {
			domain: pilotResolved,
			routes: discoverRoutesFromApp(root),
		},
		commands: detectCommands(root),
	};

	// Mock layer
	const requestLayer = discoverRequestLayer(pilotResolved);
	manifest.mock = {
		strategy: "inject",
		injectFlag: "__E2E_MOCK__",
		fixtureDir: "e2e-device/fixtures",
		hasBmock: requestLayer.hasBmock,
		routes: requestLayer.routes
			.filter((r) => r.fixture)
			.map((r) => ({
				id: r.id,
				match: r.match,
				method: r.method,
				source: r.source,
				fixture: r.fixture,
			})),
		...(requestLayer.profileRouteMap ? { profileRouteMap: requestLayer.profileRouteMap } : {}),
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
