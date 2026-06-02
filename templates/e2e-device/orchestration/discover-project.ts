import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildWebViewUrlAnchor } from "../config/project-manifest";
import type { ProjectManifest } from "../config/project-manifest";
import { discoverRequestLayer } from "./discover-request-layer";
import { e2eDeviceRoot, repoRoot, paths } from "./paths";

function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

function detectProjectState(root: string): "A" | "B" | "C" {
	const hasDevice = fs.existsSync(
		path.join(root, "e2e-device", "wdio.conf.ts"),
	);
	if (hasDevice) {
		return "C";
	}
	const hasPlaywright =
		fs.existsSync(path.join(root, "playwright.config.ts")) ||
		fs.existsSync(path.join(root, "e2e"));
	return hasPlaywright ? "B" : "A";
}

function parsePageOrigin(e2eEnvText: string): {
	pageOrigin: string;
	confidence: "high" | "low";
} {
	const h5 = e2eEnvText.match(/H5_HOST\s*=\s*['"]([^'"]+)['"]/);
	if (h5?.[1]) {
		return { pageOrigin: h5[1], confidence: "high" };
	}
	const react = e2eEnvText.match(
		/REACT_APP_[A-Z_]*ORIGIN\s*=\s*['"]([^'"]+)['"]/i,
	);
	if (react?.[1]) {
		return { pageOrigin: react[1], confidence: "high" };
	}
	return { pageOrigin: "", confidence: "low" };
}

function parseApiOrigin(envJsText: string): {
	apiOrigin: string;
	confidence: "high" | "low";
} {
	const direct = envJsText.match(/API_ORIGIN\s*=\s*['"]([^'"]+)['"]/);
	if (direct?.[1]) {
		return { apiOrigin: direct[1], confidence: "high" };
	}
	// Vue 等：src/service/index.js 中 `apiXxx = '//host'` 形式（如 apiJian、apiOrder）
	const serviceApi = envJsText.match(
		/\bapi[A-Za-z]+\s*=\s*['"](\/\/[^'"]+)['"]/,
	);
	if (serviceApi?.[1]) {
		const origin = serviceApi[1].replace(/^\/\//, "https://");
		return { apiOrigin: origin, confidence: "high" };
	}
	const jianJ = envJsText.match(/\[TEST\]:[\s\S]*?JIAN_J:\s*['"]([^'"]+)['"]/);
	if (jianJ?.[1]) {
		return { apiOrigin: jianJ[1], confidence: "high" };
	}
	const carsEval = envJsText.match(/CARS_EVALUATE:\s*['"]([^'"]+)['"]/);
	if (carsEval?.[1]) {
		return {
			apiOrigin: carsEval[1].replace(/\/cars-evaluate$/, ""),
			confidence: "low",
		};
	}
	const pick = (key: string) => {
		const m = envJsText.match(new RegExp(`${key}:\\s*['"]([^'"]+)['"]`));
		return m?.[1] || "";
	};
	const fallback = pick("TEST") || pick("STAGE") || pick("ONLINE");
	return { apiOrigin: fallback, confidence: fallback ? "low" : "low" };
}

function parsePathPrefix(envText: string): string {
	const m = envText.match(/H5_PATH_PREFIX\s*=\s*['"]([^'"]+)['"]/);
	if (m?.[1]) {
		return m[1];
	}
	const legacy = envText.match(/JIAN_H5_PREFIX\s*=\s*['"]([^'"]+)['"]/);
	return legacy?.[1] || "/v2";
}

function parseRoutingMode(appText: string): "history" | "hash" {
	if (
		/HashRouter|createHashRouter|hashRouter|mode:\s*['"]hash['"]/i.test(appText)
	) {
		return "hash";
	}
	return "history";
}

function listPageDomains(pagesDir: string): string[] {
	if (!fs.existsSync(pagesDir)) {
		return [];
	}
	return fs
		.readdirSync(pagesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.filter((name) => !name.startsWith("_") && name !== "index.ts");
}

function inferPilotFromGitDiff(root: string, domains: string[]): string | undefined {
	const bases = ["origin/main", "origin/master", "main", "master"];
	let diffFiles: string[] = [];

	for (const base of bases) {
		try {
			const out = execSync(`git diff --name-only ${base}...HEAD`, {
				cwd: root,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			diffFiles = out.split("\n").filter(Boolean);
			if (diffFiles.length) break;
		} catch {
			/* try next base */
		}
	}

	if (!diffFiles.length) return undefined;

	const diffDomains = new Set<string>();
	for (const f of diffFiles) {
		const m = f.match(/src\/pages\/([^/]+)\//);
		if (m && domains.includes(m[1])) {
			diffDomains.add(m[1]);
		}
	}

	if (diffDomains.size === 1) return [...diffDomains][0];
	return undefined; // 多个 domain 时不推断，交给下一个优先级
}

function inferPilotFromGuaziFlow(root: string, domains: string[]): string | undefined {
	const flowDir = path.join(root, "docs", "guazi-flow");
	if (!fs.existsSync(flowDir)) return undefined;

	const flowDirs = fs
		.readdirSync(flowDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort()
		.reverse(); // 最新日期在前

	for (const flowName of flowDirs) {
		for (const domain of domains) {
			if (flowName.includes(domain)) {
				return domain;
			}
		}
	}

	return undefined;
}

function inferPilotDomain(domains: string[], root: string): string | undefined {
	// 1. 环境变量
	const envDomain = process.env.E2E_PILOT_DOMAIN?.trim();
	if (envDomain) return envDomain;

	// 2. git-diff
	const diffDomain = inferPilotFromGitDiff(root, domains);
	if (diffDomain) return diffDomain;

	// 3. guazi-flow
	const flowDomain = inferPilotFromGuaziFlow(root, domains);
	if (flowDomain) return flowDomain;

	// 4. 无法推断
	return undefined;
}

function readAppPackage(appTs: string, e2eAppTs: string): string {
	const fromE2e = e2eAppTs.match(/APP_PACKAGE\s*=\s*['"]([^'"]+)['"]/);
	if (fromE2e?.[1]) {
		return fromE2e[1];
	}
	const m = appTs.match(/appPackage['"]?\s*:\s*['"]([^'"]+)['"]/);
	return m?.[1] || "";
}

function readLoginIds(
	e2eAppTs: string,
	pkg: string,
): ProjectManifest["hybrid"]["container"]["loginResourceIds"] | undefined {
	if (!pkg || !e2eAppTs.includes("LOGIN_IDS")) {
		return undefined;
	}
	const id = (key: string) => {
		const re = new RegExp(`${key}:\\s*[^:]*:id/([a-zA-Z0-9_]+)`);
		const m = e2eAppTs.match(re);
		return m ? `${pkg}:id/${m[1]}` : "";
	};
	const account = id("account");
	if (!account) {
		return undefined;
	}
	return { account, password: id("password"), loginBtn: id("loginBtn") };
}

function readDeepLinkScheme(appTs: string): string {
	const m = appTs.match(/scheme:\s*['"]([^'"]+)['"]/);
	return m?.[1] || "guazi";
}

function detectDiscoverMeta(root: string): ProjectManifest["discover"] {
	const routerJs = path.join(root, "src", "router", "index.js");
	const isVue = fs.existsSync(routerJs);
	const envJs = path.join(root, "src", "config", "env.js");
	const serviceJs = path.join(root, "src", "service", "index.js");
	return {
		docRoots: ["docs/guazi-flow", "docs/product-specs"],
		pagesGlob: isVue ? "src/page/**" : "src/pages/**/index.tsx",
		envFile: fs.existsSync(envJs)
			? "src/config/env.js"
			: fs.existsSync(serviceJs)
				? "src/service/index.js"
				: "src/config/env.js",
		routeFile: isVue ? "src/router/index.js" : "src/App.tsx",
	};
}

function detectCommands(root: string): ProjectManifest["commands"] {
	const pkgPath = path.join(root, "package.json");
	if (!fs.existsSync(pkgPath)) {
		return {
			run: "bash e2e-device/scripts/init.sh",
			prepare: "bash e2e-device/scripts/init.sh --plan-only",
		};
	}
	try {
		const pkg = JSON.parse(readText(pkgPath)) as {
			scripts?: Record<string, string>;
		};
		const scripts = pkg.scripts || {};
		if (scripts["test:e2e:device"]) {
			return {
				run: "yarn test:e2e:device",
				prepare:
					scripts["test:e2e:device:prepare"] ||
					"bash e2e-device/scripts/init.sh --plan-only",
			};
		}
	} catch {
		// ignore
	}
	return {
		run: "bash e2e-device/scripts/init.sh",
		prepare: "bash e2e-device/scripts/init.sh --plan-only",
	};
}

export function discoverProject(): ProjectManifest {
	const root = repoRoot();
	const envFile = path.join(root, "e2e-device", "config", "env.ts");
	const appConfig = path.join(root, "e2e-device", "config", "app.ts");
	const envJs = path.join(root, "src", "config", "env.js");
	const serviceJs = path.join(root, "src", "service", "index.js");
	const envSource = fs.existsSync(envJs) ? envJs : serviceJs;
	const appTsx = path.join(root, "src", "App.tsx");
	const routerJs = path.join(root, "src", "router", "index.js");
	const pagesDir = fs.existsSync(path.join(root, "src", "pages"))
		? path.join(root, "src", "pages")
		: path.join(root, "src", "page");

	const e2eEnvText = readText(envFile);
	const envJsText = readText(envSource);
	const e2eAppText = readText(appConfig);
	const appText = e2eAppText + readText(appTsx) + readText(routerJs);
	const domains = listPageDomains(pagesDir);
	const pathPrefix = parsePathPrefix(e2eEnvText + envJsText);
	const routingMode = parseRoutingMode(appText);
	const page = parsePageOrigin(e2eEnvText);
	const api = parseApiOrigin(envJsText);

	// Read existing skill.project.json to preserve pilot.domain / webViewUrlAnchor
	const existingManifestPath = path.join(
		root,
		"e2e-device",
		"skill.project.json",
	);
	try {
		JSON.parse(readText(existingManifestPath));
	} catch {
		// no existing manifest or invalid JSON
	}

	const webView = {
		routingMode,
		pathPrefix,
		hashPrefix: "/#/",
		webViewUrlAnchor: "",
	};

	const pilotResolved = inferPilotDomain(domains, root);
	if (!pilotResolved) {
		console.error("\n❌ Cannot auto-detect test requirement\n");
		console.error("Please specify via one of these methods:\n");
		console.error("1. Set environment variable:");
		console.error("   export E2E_PILOT_DOMAIN=" + (domains[0] || "<domain>") + "\n");
		console.error("2. Or set in skill.project.json:");
		console.error('   "pilot": { "domain": "your-domain" }\n');
		console.error("Available domains: " + domains.join(", "));
		process.exit(1);
	}
	webView.webViewUrlAnchor = buildWebViewUrlAnchor(webView, pilotResolved);

	const pkg =
		readAppPackage(appText, e2eAppText) || process.env.E2E_APP_PACKAGE || "";

	const loginIds = readLoginIds(e2eAppText, pkg);

	const manifest: ProjectManifest = {
		id: path.basename(root),
		projectState: detectProjectState(root),
		hybrid: {
			platform: "android",
			container: {
				package: pkg || "unknown",
				openApiActivity:
					e2eAppText.match(/WEBVIEW_ACTIVITY\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
					e2eAppText.match(/APP_ACTIVITY\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
					"",
				...(loginIds ? { loginResourceIds: loginIds } : {}),
			},
			webView,
			deepLink: {
				scheme: readDeepLinkScheme(appText),
				openPath: "openapi",
				requiredQuery: ["url"],
				forbiddenQueryOnColdOpen: ["token"],
			},
			cookie: { domainSuffix: ".guazi.com" },
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
			guaziFlow: (() => {
				const flowDir = path.join(root, "docs", "guazi-flow");
				if (!fs.existsSync(flowDir)) {
					return undefined;
				}
				const dirs = fs
					.readdirSync(flowDir, { withFileTypes: true })
					.filter((d) => d.isDirectory())
					.map((d) => d.name)
					.sort()
					.reverse();
				const match = pilotResolved
					? dirs.find((name) => name.includes(pilotResolved))
					: undefined;
				const picked = match ?? dirs[0];
				return picked ? `docs/guazi-flow/${picked}/index.md` : undefined;
			})(),
		},
		pilot: {
			domain: pilotResolved,
			routes: {},
		},
		commands: detectCommands(root),
	};

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
		...(requestLayer.profileRouteMap
			? { profileRouteMap: requestLayer.profileRouteMap }
			: {}),
	};

	const sharedRoutes = path.join(
		root,
		"e2e-shared",
		`${pilotResolved}.routes.ts`,
	);
	if (fs.existsSync(sharedRoutes)) {
		const rt = readText(sharedRoutes);
		const routeMatches = rt.matchAll(/(\w+)\s*:\s*['"]([^'"]+)['"]/g);
		for (const m of routeMatches) {
			manifest.pilot!.routes[m[1]] = m[2];
		}
	}

	fs.mkdirSync(e2eDeviceRoot(), { recursive: true });
	fs.writeFileSync(
		paths.projectJson(),
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);

	const yaml = renderYaml(manifest);
	fs.writeFileSync(paths.projectYaml(), yaml, "utf-8");

	return manifest;
}

function renderYaml(m: ProjectManifest): string {
	const lines = [
		`id: ${m.id}`,
		`projectState: ${m.projectState}`,
		"hybrid:",
		`  platform: ${m.hybrid.platform}`,
		"  container:",
		`    package: ${m.hybrid.container.package}`,
		`    openApiActivity: ${m.hybrid.container.openApiActivity}`,
		"  webView:",
		`    routingMode: ${m.hybrid.webView.routingMode}`,
		`    pathPrefix: ${m.hybrid.webView.pathPrefix}`,
		`    hashPrefix: ${m.hybrid.webView.hashPrefix}`,
		`    webViewUrlAnchor: ${m.hybrid.webView.webViewUrlAnchor}`,
		"  deepLink:",
		`    scheme: ${m.hybrid.deepLink.scheme}`,
		`    openPath: ${m.hybrid.deepLink.openPath}`,
		"discover:",
		`  pagesGlob: ${m.discover.pagesGlob}`,
		`  envFile: ${m.discover.envFile}`,
		`  routeFile: ${m.discover.routeFile}`,
	];
	if (m.pilot?.domain) {
		lines.push("pilot:", `  domain: ${m.pilot.domain}`);
	}
	return lines.join("\n") + "\n";
}
