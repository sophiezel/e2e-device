import { loadProjectManifest } from "../config/project-manifest";
import { getE2eDataMode } from "../config/env";

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
 * - https://xr-c2b.guazi-cloud.com/v2
 * 
 * path 参数是相对路径，如：
 * - /followUpMark
 * - followUpMark
 * 
 * 最终 URL: origin + path + query params
 */
export function buildH5Url(path: string): string {
	const origin = resolvePageOrigin();
	if (!origin) {
		throw new Error(
			"pageOrigin missing. Set E2E_PAGE_ORIGIN or run discover-project / probe E2E_PAGE_ORIGIN.",
		);
	}

	// 规范化 path
	let normalized = path.startsWith("/") ? path : `/${path}`;

	// 检查是否需要添加 mock flag
	const sep = normalized.includes("?") ? "&" : "?";
	const mockFlag =
		process.env.E2E_ENABLE_WEB_MOCK === "1" || getE2eDataMode() === "mock"
			? "&__E2E_MOCK__=1"
			: "";

	return `${origin}${normalized}${sep}hideNativeTitlebar=1${mockFlag}`;
}
