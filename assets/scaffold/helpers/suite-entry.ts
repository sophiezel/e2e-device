/**
 * Suite entry — open pilot route and ensure WebView context appears.
 *
 * Self-healing features:
 * - Vendor auto-detection + workaround application before launch
 * - Chromedriver auto-download if WebView version mismatch
 * - Multi-format deep link probing (3 URL formats)
 * - Diagnostic output for Agent-guided resolution
 */
import { execFileSync } from "node:child_process";
import { loadProjectManifest, resolveWebViewNeedle } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";
import {
	openH5ViaAdb,
	probeDeepLinkFormats,
	ensureAppForeground,
	ensureChromedriver,
} from "./app-launcher";
import { detectVendor, classifyVendor, getVendorWorkarounds, applyVendorWorkarounds } from "./android-vendor";
import { switchToWebViewContaining } from "./webview-context";
import { cleanupAfterTest } from "./reset-session";

/**
 * Ensure device WebView compatibility before H5 route entry.
 * Auto-detects vendor, applies workarounds, ensures chromedriver.
 */
function ensureVendorCompatibility(): void {
	try {
		const v = detectVendor();
		const clazz = classifyVendor(v);
		const workarounds = getVendorWorkarounds(clazz);
		applyVendorWorkarounds(workarounds);
		console.log(
			`[vendor] ${v.manufacturer} ${v.model} (${clazz}) — ` +
			`WebView: ${v.webViewPackage} v${v.webViewVersion || "?"}`,
		);

		// Auto-download matching chromedriver for vendor devices
		if (v.webViewVersion) {
			const cdPath = ensureChromedriver(v.webViewVersion);
			if (cdPath) {
				console.log(`[vendor] Chromedriver ready: ${cdPath}`);
			}
		}
	} catch {
		console.warn("[vendor] Detection failed, using defaults");
	}
}

/**
 * 按 manifest.pilot.routes 打开试点入口页。
 * 先确保 App 在前台（冷启动时唤醒）；再发 deep link 打开 H5。
 * 若 WebView 未出现，自动试探多格式；仍失败则输出诊断引导 Agent 与用户交互。
 */
export interface PilotEntryOptions {
	/** Skip vendor/chromedriver re-detection (warm segment follow-up cases). */
	warm?: boolean;
	/** Force cold entry (infra/chaos segments). */
	force?: boolean;
}

export async function ensurePilotEntry(
	routeKey: string,
	opts?: PilotEntryOptions,
): Promise<void> {
	const m = loadProjectManifest();
	const routePath = m.pilot?.routes?.[routeKey];
	if (!routePath) {
		// 路由缺失：非致命，仅在非 prod 下 warning
		if (process.env.E2E_DEBUG) {
			console.warn(`[suite-entry] manifest.pilot.routes 缺少 key "${routeKey}"，将跳过路由导航。`);
		}
		// 优雅降级：不做路由导航，假设当前已在目标页面
		return;
	}

	const warm = opts?.warm || process.env.E2E_WARM_SESSION === "1";
	const force = opts?.force || process.env.E2E_JOURNEY_FORCE_ENTRY === "1";

	// Step 1: Vendor compatibility check (skip on warm unless forced cold)
	if (force || !warm) {
		ensureVendorCompatibility();
	}

	// Step 2: Wake/launch the app first (warm skips redundant foreground wake)
	if (force || !warm) {
		ensureAppForeground();
		await browser.pause(timeouts.deeplinkAppStart);
	}

	// Step 3: Deep link open H5
	openH5ViaAdb(routePath);
	await browser.pause(timeouts.deeplinkAppStart);

	const needle = resolveWebViewNeedle(routeKey);

	try {
		await switchToWebViewContaining(needle);
		return;
	} catch (primaryError) {
		// Step 4: Primary format failed → try probing alternative formats
		console.warn("[suite-entry] Primary deep link failed, probing alternative formats...");
		const probed = probeDeepLinkFormats(routePath);
		if (probed) {
			await browser.pause(timeouts.deeplinkAppStart);
			try {
				await switchToWebViewContaining(needle);
				return;
			} catch {
				// Both failed; surface detailed diagnostics
			}
		}

		// Step 5: Provide actionable diagnostics
		const scheme = m.hybrid?.deepLink?.scheme || "(none)";
		const openPath = m.hybrid?.deepLink?.openPath || "openapi";
		const h5Action = m.hybrid?.deepLink?.h5Action || "openWebview";
		const pageOrigin = m.hybrid?.network?.pageOrigin || "";

		throw new Error(
			`No WEBVIEW context appeared after trying multiple deep link formats.

Diagnostics:
  Scheme: ${scheme}
  Authority: ${openPath}
  Action:   ${h5Action}
  Constructed URL:  ${scheme}://${openPath}/${h5Action}?url=<encoded>
  Target:   ${pageOrigin}/${routePath}
  Device WebView: ${checkWebViewSockets()}

Agent: Please ask the user to verify the app can open this page manually.
If yes, the user should configure manifest.hybrid.deepLink.h5Action in skill.project.json
to match the app's internal routing format.
  Example: { "hybrid": { "deepLink": { "h5Action": "openWebview" } } }

Original error: ${(primaryError as Error).message}`,
		);
	}
}

/** Quick diagnostic: count available WebView debug sockets. */
function checkWebViewSockets(): string {
	try {
		const out = execFileSync("adb", ["shell", "cat", "/proc/net/unix"], {
			encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
		});
		const count = (out.match(/webview_devtools_remote/g) || []).length;
		return `${count} socket(s) found`;
	} catch {
		return "unavailable";
	}
}

export async function returnToPilotAnchor(routeKey: string): Promise<void> {
	await cleanupAfterTest();
	await ensurePilotEntry(routeKey);
}

/** Warm segment entry — reuses session, skips vendor/chromedriver cold path. */
export async function ensureWarmPilotEntry(routeKey: string): Promise<void> {
	await ensurePilotEntry(routeKey, { warm: true });
}
