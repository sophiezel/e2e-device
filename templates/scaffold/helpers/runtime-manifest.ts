import fs from "node:fs";
import path from "node:path";

export interface RuntimeManifest {
	hybrid?: {
		webView?: {
			webViewUrlAnchor?: string;
			pathPrefix?: string;
			routingMode?: string;
		};
	};
	pilot?: { domain?: string };
}

let cached: RuntimeManifest | null = null;

export function loadRuntimeManifest(): RuntimeManifest | null {
	if (cached) {
		return cached;
	}
	const jsonPath = path.join(process.cwd(), "e2e-device", "skill.project.json");
	if (!fs.existsSync(jsonPath)) {
		return null;
	}
	try {
		cached = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as RuntimeManifest;
		return cached;
	} catch {
		return null;
	}
}

export function resolveWebViewUrlPart(domain?: string): string {
	const envAnchor = process.env.E2E_WEBVIEW_URL_ANCHOR;
	if (envAnchor) {
		return envAnchor;
	}
	const m = loadRuntimeManifest();
	if (m?.hybrid?.webView?.webViewUrlAnchor) {
		return m.hybrid.webView.webViewUrlAnchor;
	}
	const d = domain || m?.pilot?.domain || process.env.E2E_PILOT_DOMAIN || "";
	const prefix = m?.hybrid?.webView?.pathPrefix || process.env.E2E_H5_PATH_PREFIX || "";
	if (m?.hybrid?.webView?.routingMode === "hash") {
		return `/#/${d}`;
	}
	if (prefix && d) {
		const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
		return `${base}/${d}`;
	}
	return d || "";
}
