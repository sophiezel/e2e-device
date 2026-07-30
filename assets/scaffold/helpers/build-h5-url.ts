import {
	buildWebViewUrlAnchor,
	loadProjectManifest,
	type ProjectManifest,
} from "../config/project-manifest";
import { getE2eDataMode } from "../config/env";
import { inferLaunchRoute } from "./route-resolver";

/**
 * Resolve page origin (full base URL including path prefix).
 * Priority: E2E_H5_ORIGIN > E2E_PAGE_ORIGIN > manifest.pageOrigin
 */
export function resolvePageOrigin(): string {
	// 优先使用 E2E_H5_ORIGIN（向后兼容）
	const fromH5Origin = process.env.E2E_H5_ORIGIN?.trim();
	if (fromH5Origin) {
		return fromH5Origin.replace(/\/$/, "");
	}

	// 使用 E2E_PAGE_ORIGIN（新标准）
	const fromPageOrigin = process.env.E2E_PAGE_ORIGIN?.trim();
	if (fromPageOrigin) {
		return fromPageOrigin.replace(/\/$/, "");
	}

	// 从 manifest 获取
	try {
		const m = loadProjectManifest();
		return (m.hybrid.network.pageOrigin || "").replace(/\/$/, "");
	} catch {
		return "";
	}
}

export function resolveApiOrigin(): string {
	const fromEnv = process.env.E2E_API_ORIGIN?.trim();
	if (fromEnv) {
		return fromEnv.replace(/\/$/, "");
	}
	try {
		const m = loadProjectManifest();
		return (m.hybrid.network.apiOrigin || "").replace(/\/$/, "");
	} catch {
		return "";
	}
}

/**
 * Build full H5 URL for DeepLink.
 * 
 * E2E_PAGE_ORIGIN 现在存储完整的基础 URL（含前缀），如：
 * - https://h5.example.com/app
 * 
 * path 参数是相对路径，如：
 * - /exampleRoute
 * - exampleRoute
 * 
 * 最终 URL: origin + path + query params
 */
/**
 * Extra page query from env (e.g. clueId=702485526) or explicit override.
 * Host/case supplies values; Skill stays project-agnostic.
 */
export function resolvePageQuery(extra?: Record<string, string>): string {
	const parts: string[] = [];
	const fromEnv = (process.env.E2E_PAGE_QUERY || "").trim().replace(/^\?/, "");
	if (fromEnv) parts.push(fromEnv);
	if (extra) {
		for (const [k, v] of Object.entries(extra)) {
			if (v == null || v === "") continue;
			parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
		}
	}
	return parts.join("&");
}

function resolveWebViewConfig(): ProjectManifest["hybrid"]["webView"] | null {
	try {
		return loadProjectManifest().hybrid.webView;
	} catch {
		return null;
	}
}

export function buildH5Url(
	path: string,
	opts?: { query?: Record<string, string> },
): string {
	const origin = resolvePageOrigin();
	if (!origin) {
		throw new Error(
			"pageOrigin missing. Set E2E_PAGE_ORIGIN or run discover-project / probe E2E_PAGE_ORIGIN.",
		);
	}

	const manifestRoutes = (() => {
		try {
			return loadProjectManifest().pilot?.routes ?? {};
		} catch {
			return {};
		}
	})();
	const routeKey = inferLaunchRoute(path, { routes: manifestRoutes });
	const webView = resolveWebViewConfig();
	const routePath = buildWebViewUrlAnchor(
		webView ?? { routingMode: "history", pathPrefix: "", hashPrefix: "", webViewUrlAnchor: "" },
		routeKey,
	);
	let normalized: string;
	if (webView?.routingMode === "hash") {
		const hashPart = routePath.startsWith("/#")
			? routePath
			: routePath.startsWith("#")
				? `/${routePath}`
				: `/#/${routeKey}`;
		normalized = hashPart;
	} else {
		normalized = routePath.startsWith("/") ? routePath : `/${routePath}`;
	}

	const pageQuery = resolvePageQuery(opts?.query);
	const sep = normalized.includes("?") ? "&" : "?";
	const mockFlag =
		process.env.E2E_ENABLE_WEB_MOCK === "1" || getE2eDataMode() === "mock"
			? "&__E2E_MOCK__=1"
			: "";
	const queryPart = pageQuery ? `&${pageQuery}` : "";

	return `${origin}${normalized}${sep}hideNativeTitlebar=1${mockFlag}${queryPart}`;
}
