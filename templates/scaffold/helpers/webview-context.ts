import { resolveWebViewUrlPart } from "./runtime-manifest";
import { timeouts } from "../config/timeouts";

const NATIVE_CONTEXT = "NATIVE_APP";

function domReadyMarkers(): string[] {
	const anchor = resolveWebViewUrlPart();
	const domain = anchor.split("/").filter(Boolean).pop() || "";
	const fromEnv = (process.env.E2E_DOM_READY_MARKERS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (fromEnv.length) {
		return fromEnv;
	}
	return [domain, "vconsole"].filter(Boolean);
}

async function pageLooksReady(): Promise<boolean> {
	// Prefer lightweight browser.execute over heavy getPageSource
	try {
		const readyState = await browser.execute(() => document.readyState);
		if (readyState !== "complete") {
			return false;
		}
		// Check if any marker element exists in the DOM
		const markers = domReadyMarkers();
		if (markers.length === 0) {
			return true;
		}
		const hasMarker = await browser.execute(
			(ms: string[]) => ms.some((m) => {
				if (!m) return false;
				// Check by element id, class, or text content
				return (
					!!document.getElementById(m) ||
					!!document.querySelector(`[data-testid="${m}"]`) ||
					document.body?.textContent?.includes(m) ||
					false
				);
			}),
			markers,
		);
		if (hasMarker) {
			return true;
		}
	} catch {
		// execute may fail if WebView is not ready; fallback to getPageSource
	}

	// Fallback: check page source for markers
	try {
		const source = await browser.getPageSource();
		return domReadyMarkers().some((m) => m && source.includes(m));
	} catch {
		return false;
	}
}

export async function switchToNative(): Promise<void> {
	await browser.switchContext(NATIVE_CONTEXT);
}

async function injectMockIfConfigured(): Promise<void> {
	if (
		process.env.E2E_ENABLE_WEB_MOCK !== "1" ||
		!process.env.E2E_MOCK_PROFILE
	) {
		return;
	}
	try {
		const { enableCdpMock } = await import("../resilience/cdp-mock");
		const session = await enableCdpMock(
			process.env.E2E_MOCK_PROFILE as import("../resilience/types").FixtureProfile,
		);
		if (session.enabled) {
			process.env.E2E_MOCK_LAYER = "inject";
		}
	} catch {
		// inject 失败时由韧性层 retry 路径处理
	}
}

export async function switchToWebViewContaining(urlPart: string, timeout?: number): Promise<void> {
	// Apply vendor workaround for poll interval
	const pollExtra = parseInt(process.env.E2E_VENDOR_WEBVIEW_POLL_EXTRA_MS || "0", 10);
	const shouldForceReset = process.env.E2E_VENDOR_FORCE_NATIVE_RESET === "1";
	const domFactor = parseFloat(process.env.E2E_VENDOR_DOM_READY_FACTOR || "1.0");

	const waitTimeout = timeout || timeouts.webviewContext;

	// Force NATIVE_APP reset for vendors that require it (e.g., Huawei, OPPO)
	if (shouldForceReset) {
		try { await browser.switchContext("NATIVE_APP"); } catch { /* may already be native */ }
	}

	await browser.waitUntil(
		async () => {
			const contexts = await browser.getContexts();
			return contexts.some((c) => String(c).includes("WEBVIEW"));
		},
		{ timeout: waitTimeout, interval: 500 + pollExtra, timeoutMsg: "No WEBVIEW context appeared" },
	);

	const contexts = await browser.getContexts();
	const webviews = contexts.filter((c) => String(c).includes("WEBVIEW"));
	let lastUrl = "";

	for (const ctx of webviews) {
		await browser.switchContext(String(ctx));
		const handles = await browser.getWindowHandles();

		for (const handle of handles) {
			await browser.switchToWindow(handle);
			let url = "";
			try {
				url = await browser.getUrl();
			} catch {
				continue;
			}
			lastUrl = url;
			if (!url.includes(urlPart)) {
				continue;
			}

			try {
				await browser.waitUntil(
					async () => pageLooksReady(),
					{
						timeout: Math.round(timeouts.domReady * domFactor),
						interval: Math.max(200, Math.round(1000 / domFactor)),
						timeoutMsg: `WebView URL matched (${url}) but H5 DOM not ready`,
					},
				);
				await injectMockIfConfigured();
				return;
			} catch {
				// try next window
			}
		}
	}

	throw new Error(
		`No WebView window matched urlPart="${urlPart}" (lastUrl=${lastUrl || "none"})`,
	);
}

export async function getCurrentWebUrl(): Promise<string> {
	return browser.getUrl();
}

export async function waitForH5Selector(
	selectors: string | readonly string[],
	timeout = 20000,
): Promise<ReturnType<typeof $>> {
	const list = Array.isArray(selectors) ? selectors : [selectors];
	let found: ReturnType<typeof $> | undefined;

	await browser.waitUntil(
		async () => {
			for (const sel of list) {
				const el = $(sel);
				try {
					if (await el.isDisplayed()) {
						found = el;
						return true;
					}
				} catch {
					// try next selector
				}
			}
			return false;
		},
		{
			timeout,
			timeoutMsg: `H5 selector not found: ${list.slice(0, 3).join(" | ")}`,
		},
	);

	if (!found) {
		throw new Error(`H5 selector not found: ${list.slice(0, 3).join(" | ")}`);
	}
	return found;
}
