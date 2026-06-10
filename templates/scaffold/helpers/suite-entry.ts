import { execFileSync } from "node:child_process";
import { loadProjectManifest } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";
import { openH5ViaAdb, probeDeepLinkFormats, ensureAppForeground } from "./app-launcher";
import { switchToWebViewContaining } from "./webview-context";
import { cleanupAfterTest } from "./reset-session";

/**
 * 按 manifest.pilot.routes 打开试点入口页。
 * 先确保 App 在前台（冷启动时唤醒）；再发 deep link 打开 H5。
 * 若 WebView 未出现，自动试探多格式；仍失败则输出诊断引导 Agent 与用户交互。
 */
export async function ensurePilotEntry(routeKey: string): Promise<void> {
	const m = loadProjectManifest();
	const routePath = m.pilot?.routes?.[routeKey];
	if (!routePath) {
		throw new Error(
			`manifest.pilot.routes missing key "${routeKey}". Run discover-project.`,
		);
	}
	// Wake/launch the app first (essential for cold-start scenarios)
	ensureAppForeground();
	await browser.pause(timeouts.deeplinkAppStart);
	openH5ViaAdb(routePath);
	await browser.pause(timeouts.deeplinkAppStart);
	const anchor = m.hybrid.webView.webViewUrlAnchor || m.pilot?.domain || "";
	const needle = anchor.split("/").filter(Boolean).pop() || anchor;

	try {
		await switchToWebViewContaining(needle);
		return;
	} catch (primaryError) {
		// Primary format failed → try probing alternative formats
		console.warn("[suite-entry] Primary deep link failed, probing alternative formats...");
		const probed = probeDeepLinkFormats(routePath);
		if (probed) {
			await browser.pause(timeouts.deeplinkAppStart);
			try {
				await switchToWebViewContaining(needle);
				return;
			} catch (probeError) {
				// Both failed; surface detailed diagnostics
			}
		}
		// Provide actionable diagnostics for the Agent to guide the user
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
