import { getCurrentWebUrl } from "./webview-context";
import { browser } from "@wdio/globals";

export type DetailListNavTab = "pending" | "audited";

/**
 * 通用 H5 导航上下文准备：确保在目标 domain 的 WebView 中且页面可交互。
 * 这是所有 spec 的 before hook 都会调用的基础函数。
 */
export async function ensureH5NavContext(domain: string): Promise<void> {
	try {
		const currentUrl = await browser.getUrl();
		if (!currentUrl.includes(domain)) {
			console.warn(`[ensureH5NavContext] 当前 URL 不包含 domain "${domain}": ${currentUrl}`);
		}
		await $("body").waitForExist({ timeout: 10000 });
	} catch (e: unknown) {
		console.warn(`[ensureH5NavContext] 导航上下文准备失败: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Patch detail URL query so H5 back navigation uses list fallback (E2E-only).
 */
export async function ensureDetailListNavInUrl(
	listTab: DetailListNavTab,
	id?: string,
): Promise<void> {
	let url = "";
	try {
		url = await getCurrentWebUrl();
	} catch {
		return;
	}

	if (!url.includes("/detail")) {
		return;
	}
	if (url.includes("from=list") && url.includes(`listTab=${listTab}`)) {
		return;
	}

	const idMatch = url.match(/[?&]id=([^&]+)/);
	const detailId = id || (idMatch?.[1] ? decodeURIComponent(idMatch[1]) : "");
	if (!detailId) {
		return;
	}

	await browser.execute(
		(tab: string, detailIdArg: string) => {
			const u = new URL(window.location.href);
			u.searchParams.set("from", "list");
			u.searchParams.set("listTab", tab);
			if (detailIdArg && !u.searchParams.get("id")) {
				u.searchParams.set("id", detailIdArg);
			}
			window.history.replaceState(
				window.history.state,
				"",
				`${u.pathname}${u.search}${u.hash}`,
			);
		},
		listTab,
		detailId,
	);
}
