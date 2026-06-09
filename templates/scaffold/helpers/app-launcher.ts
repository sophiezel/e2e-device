/**
 * App launcher — open H5 pages via ADB deep link or activity launch.
 */
import { execFileSync } from "node:child_process";
import { browser } from "@wdio/globals";
import { resolvePageOrigin } from "./build-h5-url";
import { loadProjectManifest } from "../config/project-manifest";
import { timeouts } from "../config/timeouts";

/**
 * Open an H5 page via ADB deep link using the manifest's deep link scheme.
 * Falls back to a generic am start VIEW intent if no scheme is configured.
 */
export function openH5ViaAdb(routePath: string): void {
	const pageOrigin = resolvePageOrigin();
	if (!pageOrigin) {
		throw new Error(
			"pageOrigin missing. Set E2E_PAGE_ORIGIN or run discover-project.",
		);
	}

	const m = loadProjectManifest();
	const scheme = m.hybrid?.deepLink?.scheme || "";
	const targetUrl = `${pageOrigin}/${routePath.replace(/^\//, "")}`;

	if (scheme) {
		const openPath = m.hybrid?.deepLink?.openPath || "h5";
		const deepLinkUrl = `${scheme}://${openPath}?url=${encodeURIComponent(targetUrl)}`;
		execFileSync(
			"adb",
			["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", deepLinkUrl],
			{ encoding: "utf-8", timeout: 10000 },
		);
	} else {
		// Fallback: use generic VIEW intent with the full H5 URL
		execFileSync(
			"adb",
			["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", targetUrl],
			{ encoding: "utf-8", timeout: 10000 },
		);
	}
}

/**
 * Launch the app's main activity via ADB.
 */
export function launchMainActivity(): void {
	const m = loadProjectManifest();
	const pkg = m.hybrid?.container?.package || "";
	const activity = m.hybrid?.container?.openApiActivity || "";

	if (!pkg || !activity) {
		throw new Error(
			"App package/activity not configured. Run discover-project or set in skill.project.json.",
		);
	}

	const component = activity.includes("/")
		? activity
		: `${pkg}/${activity}`;

	execFileSync(
		"adb",
		["shell", "am", "start", "-n", component],
		{ encoding: "utf-8", timeout: 10000 },
	);
}
