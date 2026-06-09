import { loadProjectManifest } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";
import { openH5ViaAdb, ensureAppForeground } from "./app-launcher";
import { switchToWebViewContaining } from "./webview-context";
import { cleanupAfterTest } from "./reset-session";

/**
 * 按 manifest.pilot.routes 打开试点入口页。
 * 先确保 App 在前台（冷启动时唤醒）；再发 deep link 打开 H5。
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
	await switchToWebViewContaining(needle);
}

export async function returnToPilotAnchor(routeKey: string): Promise<void> {
	await cleanupAfterTest();
	await ensurePilotEntry(routeKey);
}
