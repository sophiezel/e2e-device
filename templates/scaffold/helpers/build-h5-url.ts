import { loadProjectManifest } from "../config/project-manifest";
import { getE2eDataMode } from "../config/env";

export function resolvePageOrigin(): string {
	const fromEnv = process.env.E2E_H5_ORIGIN?.trim();
	if (fromEnv) {
		return fromEnv.replace(/\/$/, "");
	}
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
 * Build full H5 URL for DeepLink (history or hash routing from manifest).
 */
export function buildH5Url(path: string): string {
	const origin = resolvePageOrigin();
	if (!origin) {
		throw new Error(
			"pageOrigin missing. Set E2E_H5_ORIGIN or run discover-project / probe E2E_PAGE_ORIGIN.",
		);
	}

	let manifest;
	try {
		manifest = loadProjectManifest();
	} catch {
		manifest = null;
	}

	const webView = manifest?.hybrid.webView;
	const pathPrefix = webView?.pathPrefix || process.env.E2E_H5_PATH_PREFIX || "/v2";
	const routingMode = webView?.routingMode || "history";

	let normalized = path;
	if (routingMode === "history") {
		if (!normalized.startsWith(pathPrefix) && normalized.startsWith("/")) {
			normalized = `${pathPrefix.replace(/\/$/, "")}${normalized}`;
		} else if (!normalized.startsWith("/")) {
			normalized = `${pathPrefix.replace(/\/$/, "")}/${normalized}`;
		}
	} else {
		const hashPrefix = (webView?.hashPrefix || "/#/").replace(/\/$/, "");
		const segment = normalized.startsWith("/") ? normalized.slice(1) : normalized;
		normalized = `${hashPrefix}/${segment}`;
	}

	const sep = normalized.includes("?") ? "&" : "?";
	const mockFlag =
		process.env.E2E_ENABLE_WEB_MOCK === "1" || getE2eDataMode() === "mock"
			? "&__E2E_MOCK__=1"
			: "";

	return `${origin}${normalized}${sep}hideNativeTitlebar=1${mockFlag}`;
}
