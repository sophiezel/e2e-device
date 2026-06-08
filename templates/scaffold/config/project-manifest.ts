import fs from "node:fs";
import { paths } from "../orchestration/paths";

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
		};
	};
	discover: {
		docRoots: string[];
		pagesGlob: string;
		envFile: string;
		routeFile: string;
	};
	docs?: { readme?: string; guaziFlow?: string };
	pilot?: {
		domain: string;
		routes: Record<string, string>;
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
		}>;
		profileRouteMap?: Record<string, string[]>;
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
			`Missing ${jsonPath}. Run: bash e2e-device/scripts/init.sh --plan-only`,
		);
	}
	cached = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as ProjectManifest;
	return cached;
}

export function getWebViewUrlAnchor(domain: string): string {
	const m = loadProjectManifest();
	if (m.pilot?.domain && domain && m.pilot.domain !== domain) {
		return buildWebViewUrlAnchor(m.hybrid.webView, domain);
	}
	if (m.hybrid.webView.webViewUrlAnchor) {
		return m.hybrid.webView.webViewUrlAnchor;
	}
	return buildWebViewUrlAnchor(m.hybrid.webView, domain || m.pilot?.domain || "");
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
