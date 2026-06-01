import { resolveWebViewUrlPart } from "./runtime-manifest";

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
	try {
		const source = await browser.getPageSource();
		return domReadyMarkers().some((m) => m && source.includes(m));
	} catch {
		return false;
	}
}

export async function switchToNative(): Promise<void> {
	await driver.switchContext(NATIVE_CONTEXT);
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

export async function switchToWebViewContaining(urlPart: string): Promise<void> {
	await browser.waitUntil(
		async () => {
			const contexts = await driver.getContexts();
			return contexts.some((c) => String(c).includes("WEBVIEW"));
		},
		{ timeout: 25000, timeoutMsg: "No WEBVIEW context appeared" },
	);

	const contexts = await driver.getContexts();
	const webviews = contexts.filter((c) => String(c).includes("WEBVIEW"));
	let lastUrl = "";

	for (const ctx of webviews) {
		await driver.switchContext(String(ctx));
		const handles = await driver.getWindowHandles();

		for (const handle of handles) {
			await driver.switchToWindow(handle);
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
						timeout: 35000,
						interval: 1000,
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
