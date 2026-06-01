import { getCurrentWebUrl } from "./webview-context";

export type DetailListNavTab = "pending" | "audited";

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
