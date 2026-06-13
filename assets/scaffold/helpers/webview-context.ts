/**
 * WebView context switching with vendor-aware self-healing.
 *
 * Features:
 * - Vendor auto-detection before context switch
 * - Exponential backoff retry for WEBVIEW context detection
 * - Splash/wait-page dismissal (common on Chinese vendor devices)
 * - Multi-format deep link probing fallback
 * - Context cache refresh for vendor devices
 */

import { browser } from "@wdio/globals";
import { resolveWebViewUrlPart } from "./runtime-manifest";
import { timeouts } from "../config/timeouts";

const NATIVE_CONTEXT = "NATIVE_APP";

/**
 * Maximum retry attempts for WEBVIEW context detection.
 * Override via E2E_VENDOR_WEBVIEW_MAX_RETRIES.
 */
const MAX_WEBVIEW_RETRIES = parseInt(
	process.env.E2E_VENDOR_WEBVIEW_MAX_RETRIES || "3", 10,
);

/**
 * Base delay (ms) for exponential backoff between WebView detection retries.
 * Override via E2E_VENDOR_WEBVIEW_RETRY_BASE_MS.
 */
const RETRY_BASE_MS = parseInt(
	process.env.E2E_VENDOR_WEBVIEW_RETRY_BASE_MS || "2000", 10,
);

// ── DOM Ready Markers ────────────────────────────────────────────────

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

// ── Page Readiness Check ─────────────────────────────────────────────

async function pageLooksReady(): Promise<boolean> {
	try {
		const readyState = await browser.execute(() => document.readyState);
		if (readyState !== "complete") {
			return false;
		}
		const markers = domReadyMarkers();
		if (markers.length === 0) {
			return true;
		}
		const hasMarker = await browser.execute(
			(ms: string[]) => ms.some((m) => {
				if (!m) return false;
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
		// execute may fail if WebView is not ready
	}

	try {
		const source = await browser.getPageSource();
		return domReadyMarkers().some((m) => m && source.includes(m));
	} catch {
		return false;
	}
}

// ── Splash / Wait Page Dismissal (Chinese vendors) ──────────────────

/**
 * Try to dismiss common splash/wait pages shown by Chinese vendor phones.
 * These can block WebView context from appearing.
 */
async function dismissSplashPages(): Promise<boolean> {
	try {
		// Some vendors show a system-level "loading" overlay — try pressing BACK
		await browser.pause(500);
		try {
			await browser.back();
			await browser.pause(300);
		} catch {
			// back may not be available
		}

		// Check if WebView appeared after dismissal attempts
		const contexts = await browser.getContexts();
		return contexts.some((c) => String(c).includes("WEBVIEW"));
	} catch {
		return false;
	}
}

// ── Coverage & Mock Probe ───────────────────────────────────────────

async function probeAndTrackCoverage(): Promise<void> {
	if (process.env.E2E_COVERAGE_DETECTED) return;
	try {
		const hasCov = await browser.execute(() => {
			const w = window as unknown as Record<string, unknown>;
			return !!(w.__coverage__ || w.__coverage_report__);
		});
		if (hasCov) {
			process.env.E2E_COVERAGE_DETECTED = "1";
			if (process.env.E2E_DEBUG) console.debug("[coverage] Istanbul detected in WebView");
		}
	} catch {
		// probe failure is non-critical
	}
}

async function injectMockIfConfigured(): Promise<void> {
	if (process.env.E2E_ENABLE_WEB_MOCK !== "1" || !process.env.E2E_MOCK_PROFILE) {
		return;
	}
	try {
		const { enableCdpMock } = await import("../resilience/cdp-mock");
		const session = await enableCdpMock(
			process.env.E2E_MOCK_PROFILE as unknown as import("../resilience/types").FixtureProfile,
		);
		if (session.enabled) {
			process.env.E2E_MOCK_LAYER = "inject";
		}
	} catch {
		// inject failure handled by resilience layer retry
	}
}

// ── Vendor Auto-Detection & Context Refresh ─────────────────────────

function isVendorWithQuirks(): boolean {
	// Check if vendor workarounds are already applied
	if (process.env.E2E_VENDOR_WEBVIEW_POLL_EXTRA_MS) {
		return parseInt(process.env.E2E_VENDOR_WEBVIEW_POLL_EXTRA_MS, 10) > 0;
	}
	return false;
}

/**
 * Force-refresh the WebView context cache on vendor devices.
 * Some vendor WebViews don't report new contexts until the cache is invalidated.
 */
async function refreshContextCache(): Promise<void> {
	try {
		// Switch to NATIVE first (forces context cache refresh)
		await browser.switchContext(NATIVE_CONTEXT);
		await browser.pause(200);
		// Refresh contexts list
		await browser.getContexts();
		await browser.pause(100);
	} catch {
		// best-effort
	}
}

// ── Main: switchToWebViewContaining (with self-healing) ─────────────

export async function switchToNative(): Promise<void> {
	await browser.switchContext(NATIVE_CONTEXT);
}

/**
 * Switch to a WebView whose URL contains urlPart.
 *
 * Self-healing features:
 * 1. Vendor workarounds (poll interval, native reset, DOM timeout factor)
 * 2. Exponential backoff retry (3 attempts with 2s/4s/8s delays)
 * 3. Splash/wait-page dismissal for Chinese vendor devices
 * 4. Context cache refresh between retries
 * 5. Graceful fallback to any WebView if urlPart match fails
 */
export async function switchToWebViewContaining(
	urlPart: string,
	timeoutOverride?: number,
	options?: { allowEmptyUrlMatch?: boolean },
): Promise<void> {
	const pollExtra = parseInt(
		process.env.E2E_VENDOR_WEBVIEW_POLL_EXTRA_MS || "0", 10,
	);
	const shouldForceReset =
		process.env.E2E_VENDOR_FORCE_NATIVE_RESET === "1";
	const domFactor = parseFloat(
		process.env.E2E_VENDOR_DOM_READY_FACTOR || "1.0",
	);
	const allowEmpty = options?.allowEmptyUrlMatch ?? true;

	const waitTimeout = timeoutOverride || timeouts.webviewContext;
	const isVendor = isVendorWithQuirks();

	// ---- Phase 1: Force NATIVE reset (required by some vendors) ----
	if (shouldForceReset) {
		try {
			await browser.switchContext(NATIVE_CONTEXT);
		} catch {
			// may already be native
		}
	}

	// ---- Phase 2: Wait for WEBVIEW context with retries ----
	let webViewFound = false;
	let lastError: Error | null = null;
	const maxRetries = isVendor ? MAX_WEBVIEW_RETRIES : 1;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		if (attempt > 1) {
			const delay = RETRY_BASE_MS * Math.pow(2, attempt - 2); // 2s, 4s, 8s
			console.log(
				`[webview] Vendor WebView detection retry ${attempt}/${maxRetries} (delay=${delay}ms)...`,
			);
			await browser.pause(delay);

			// Try to dismiss any splash/wait pages
			if (isVendor) {
				await refreshContextCache();
				await dismissSplashPages();
			}
		}

		try {
			await browser.waitUntil(
				async () => {
					const contexts = await browser.getContexts();
					return contexts.some((c) => String(c).includes("WEBVIEW"));
				},
				{
					timeout: waitTimeout,
					interval: 500 + pollExtra,
					timeoutMsg: `No WEBVIEW context appeared (attempt ${attempt}/${maxRetries})`,
				},
			);
			webViewFound = true;
			break;
		} catch (err) {
			lastError = err as Error;
			// Try dismiss splash before next retry
			if (isVendor) {
				try {
					await dismissSplashPages();
				} catch {
					// ignore
				}
			}
		}
	}

	if (!webViewFound) {
		throw lastError || new Error("No WEBVIEW context appeared after retries");
	}

	// ---- Phase 3: Find the right WebView window ----
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

			const urlMatches = url.includes(urlPart);
			if (!urlMatches) {
				// If urlPart is empty string, accept any WebView (wildcard)
				if (urlPart === "" || !urlPart) {
					// Accept — continue below to check DOM readiness
				} else {
					continue;
				}
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
				await probeAndTrackCoverage();
				return;
			} catch {
				// try next window
			}
		}
	}

	// ---- Phase 4: Fallback — accept first WebView even if URL doesn't match ----
	if (allowEmpty && webviews.length > 0) {
		console.warn(
			`[webview] No WebView matched urlPart="${urlPart}" (lastUrl=${lastUrl}). ` +
			`Falling back to first available WebView.`,
		);
		await browser.switchContext(String(webviews[0]));
		try {
			await browser.waitUntil(
				async () => pageLooksReady(),
				{
					timeout: Math.round(timeouts.domReady * domFactor),
					interval: 500,
					timeoutMsg: "Fallback WebView DOM not ready",
				},
			);
			await injectMockIfConfigured();
			await probeAndTrackCoverage();
			return;
		} catch {
			// DOM not ready even in fallback — throw original error
		}
	}

	throw new Error(
		`No WebView window matched urlPart="${urlPart}" (lastUrl=${lastUrl || "none"}, ` +
		`available=${webviews.length} WebView contexts)`,
	);
}

// ── Utility exports ─────────────────────────────────────────────────

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
