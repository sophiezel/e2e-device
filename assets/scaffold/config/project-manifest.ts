import fs from "node:fs";
import { paths } from "../orchestration/paths";
import { inferLaunchRoute } from "../helpers/route-resolver";

export type RoutingMode = "history" | "hash";
export type OriginConfidence = "high" | "medium" | "low";
export type AuthLayer = "native" | "bridgeToken" | "h5";

export interface ProjectManifest {
	id: string;
	projectState?: "A" | "B" | "C";
	hybrid: {
		platform: string;
		container: {
			package: string;
			openApiActivity: string;
			loginResourceIds?: {
				account: string;
				password: string;
				loginBtn: string;
			};
		};
		webView: {
			routingMode: RoutingMode;
			pathPrefix: string;
			hashPrefix: string;
			webViewUrlAnchor: string;
		};
		deepLink: {
			scheme: string;
			openPath: string;
			h5Action?: string;
			requiredQuery: string[];
			forbiddenQueryOnColdOpen: string[];
		};
		cookie: { domainSuffix: string };
		auth?: {
			mode?: "native" | "h5" | "both";
			layers?: AuthLayer[];
			h5?: {
				loginPathPatterns?: string[];
				unauthTextPatterns?: string[];
			};
			api?: {
				unauthHttpStatuses?: number[];
				unauthBodyCodes?: Array<string | number>;
			};
		};
		network: {
			pageOrigin: string;
			apiOrigin: string;
			pageOriginConfidence?: OriginConfidence;
			apiOriginConfidence?: OriginConfidence;
			pageOriginCandidates?: Array<{
				url: string;
				source: string;
				confidence: OriginConfidence;
			}>;
		};
	};
	discover: {
		docRoots: string[];
		pagesGlob: string;
		envFile: string;
		routeFile: string;
	};
	docs?: { readme?: string; matrixDoc?: string; domainDoc?: string };
	pilot?: {
		domain: string;
		/** Concrete vue-router name/path used for deeplink launch (may differ from domain folder). */
		launchRoute?: string;
		routes: Record<string, string>;
		/** Journey routing: list page vs form page modules */
		relatedRoutes?: Record<string, string>;
		domainCandidates?: Array<{
			domain: string;
			score: number;
			sources: string[];
			changedFiles?: string[];
			guaziFlowTask?: string;
		}>;
	};
	userConfirmed?: {
		pageOrigin?: string;
		appPackage?: string;
		domain?: string;
		confirmedAt?: string;
	};
	nativeHints?: {
		deepLinkSchemeSource?: string;
		needsNativeConfirm?: string[];
		h5SchemeHints?: string[];
	};
	/** Host-provided selector hints to extend default H5_TIERS (prepended, higher priority). */
	selectorHints?: {
		anchor?: string[];
		listRoot?: string[];
		search?: string[];
		interactive?: string[];
		tab?: string[];
		toast?: string[];
		error?: string[];
	};
	commands?: Record<string, string>;
	mock?: {
		strategy: string;
		injectFlag: string;
		fixtureDir: string;
		hasBmock?: boolean;
		routes: Array<{
			id: string;
			match: string;
			method: string;
			fixture?: string;
			source?: string;
			matchQuery?: string;
		}>;
		profileRouteMap?: Record<string, string[]>;
		pageApiGraph?: {
			domain: string;
			gateParams: string[];
			imports: string[];
			calls: Array<{
				fn: string;
				url?: string;
				method?: string;
				paramKeys: string[];
				source: string;
			}>;
		};
		mockStates?: {
			gateParam?: string;
			states: Array<{
				id: string;
				query?: Record<string, string>;
				profile: string;
				routes: string[];
				source?: string;
			}>;
		};
	};
	classifier?: {
		toastPatterns?: string[];
	};
}

let cached: ProjectManifest | null = null;

export function loadProjectManifest(): ProjectManifest {
	if (cached) {
		return cached;
	}
	const jsonPath = paths.projectJson();
	if (!fs.existsSync(jsonPath)) {
		throw new Error(
			`Missing ${jsonPath}. Run: bash ~/.agents/skills/e2e-device/scripts/run.sh --project . --plan-only`,
		);
	}
	cached = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProjectManifest;
	return cached;
}

export function getWebViewUrlAnchor(domain: string): string {
	const m = loadProjectManifest();
	const launchRoute =
		m.pilot?.launchRoute ||
		inferLaunchRoute(domain || m.pilot?.domain || "", {
			routes: m.pilot?.routes ?? {},
		});
	if (m.pilot?.domain && domain && m.pilot.domain !== domain) {
		return buildWebViewUrlAnchor(m.hybrid.webView, launchRoute);
	}
	if (m.hybrid.webView.webViewUrlAnchor && !domain) {
		return m.hybrid.webView.webViewUrlAnchor;
	}
	return buildWebViewUrlAnchor(
		m.hybrid.webView,
		launchRoute || domain || m.pilot?.domain || "",
	);
}

export function buildWebViewUrlAnchor(
	webView: ProjectManifest["hybrid"]["webView"],
	domain: string,
): string {
	if (!domain) {
		return webView.webViewUrlAnchor || "";
	}
	if (webView.routingMode === "hash") {
		const prefix = webView.hashPrefix || "/#/";
		return `${prefix.replace(/\/$/, "")}/${domain}`;
	}
	const prefix = webView.pathPrefix || "";
	const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	return base ? `${base}/${domain}` : `/${domain}`;
}

export function clearManifestCache(): void {
	cached = null;
}

/**
 * SSOT: URL substring for switchToWebViewContaining across suite-entry / expert-reset / deeplink.
 */
export function resolveWebViewNeedle(routeKeyOrDomain?: string): string {
	let domain = routeKeyOrDomain || process.env.E2E_DOMAIN || "";
	try {
		const m = loadProjectManifest();
		domain = domain || m.pilot?.domain || "";
		const launchRoute =
			m.pilot?.launchRoute ||
			inferLaunchRoute(domain, { routes: m.pilot?.routes ?? {} });
		const anchor = getWebViewUrlAnchor(launchRoute || domain);
		if (!anchor) {
			return domain.split("/").filter(Boolean).pop() || domain;
		}
		if (anchor.startsWith("#/")) {
			return anchor.slice(2);
		}
		if (anchor.startsWith("/#/")) {
			return anchor.slice(3);
		}
		const pathPart = anchor.replace(/^https?:\/\//i, "").split(/[?#]/)[0];
		const segments = pathPart.split("/").filter((s) => s && s !== "#");
		const last = segments[segments.length - 1];
		if (last && last.length >= 2) return last;
		return anchor.length <= 64 ? anchor : last || domain;
	} catch {
		return domain.split("/").filter(Boolean).pop() || domain;
	}
}
