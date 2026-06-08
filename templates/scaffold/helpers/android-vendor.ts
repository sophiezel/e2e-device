import { execFileSync } from "node:child_process";
import type { DiagnosticSnapshot } from "../resilience/types";

// ===== Vendor Detection =====

export interface VendorInfo {
	manufacturer: string;
	model: string;
	androidVersion: string;
	sdkInt: number;
	/** Package name of the WebView implementation (e.g., com.google.android.webview) */
	webViewPackage: string;
	/** Version of the WebView implementation */
	webViewVersion: string;
}

function adbShell(cmd: string): string {
	try {
		return execFileSync("adb", ["shell", cmd], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 5000,
		}).trim();
	} catch {
		return "";
	}
}

function adbShellGetProp(key: string): string {
	try {
		return execFileSync("adb", ["shell", "getprop", key], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
		}).trim();
	} catch {
		return "";
	}
}

/**
 * Detect device vendor, model, Android version, and WebView details.
 */
export function detectVendor(): VendorInfo {
	const manufacturer = adbShellGetProp("ro.product.manufacturer") || "unknown";
	const model = adbShellGetProp("ro.product.model") || "unknown";
	const androidVersion = adbShellGetProp("ro.build.version.release") || "0";
	const sdkInt = parseInt(adbShellGetProp("ro.build.version.sdk") || "0", 10);

	// Detect WebView package (varies by vendor and Android version)
	let webViewPackage = "";
	let webViewVersion = "";

	// Try common WebView packages
	const pkgCandidates = [
		"com.google.android.webview",       // Standard Chrome WebView
		"com.android.webview",              // AOSP WebView
		"com.huawei.webview",               // Huawei EMUI
		"com.android.chrome",               // Chrome-as-WebView (Android 7+)
	];

	for (const pkg of pkgCandidates) {
		const info = adbShell(`dumpsys package ${pkg} 2>/dev/null | grep -E 'versionName|versionCode' | head -1`);
		if (info) {
			webViewPackage = pkg;
			const vMatch = info.match(/versionName=([^\s]+)/);
			if (vMatch) {
				webViewVersion = vMatch[1];
			}
			break;
		}
	}

	// Fallback: try `adb shell pm list packages` for webview
	if (!webViewPackage) {
		const pkgs = adbShell("pm list packages webview");
		const first = pkgs.split("\n")[0] || "";
		const pkgName = first.replace("package:", "").trim();
		if (pkgName) {
			webViewPackage = pkgName;
		}
	}

	return {
		manufacturer,
		model,
		androidVersion,
		sdkInt,
		webViewPackage,
		webViewVersion,
	};
}

// ===== Vendor Classification =====

/** Known vendors with potential WebView quirks requiring workarounds. */
type KnownVendor = "samsung" | "huawei" | "xiaomi" | "oppo" | "vivo" | "google" | "unknown";

export function classifyVendor(info: VendorInfo): KnownVendor {
	const m = info.manufacturer.toLowerCase();
	if (m.includes("samsung") || m.includes("sm-")) return "samsung";
	if (m.includes("huawei") || m.includes("honor") || m.includes("hw")) return "huawei";
	if (m.includes("xiaomi") || m.includes("redmi") || m.includes("poco")) return "xiaomi";
	if (m.includes("oppo") || m.includes("realme") || m.includes("oneplus")) return "oppo";
	if (m.includes("vivo")) return "vivo";
	if (m.includes("google")) return "google";
	return "unknown";
}

/** Workarounds for vendor-specific WebView quirks. */
export interface VendorWorkarounds {
	/** Additional wait between WebView context detection polls (ms) */
	webViewContextPollExtraMs: number;
	/** Whether to force NATIVE_APP switch before re-entering WebView */
	forceNativeReset: boolean;
	/** Additional timeout factor for DOM ready (multiplier, default 1.0) */
	domReadyTimeoutFactor: number;
	/** Whether to avoid CDP-based operations entirely */
	avoidCdp: boolean;
}

/**
 * Get recommended workarounds for a specific vendor.
 * These are based on known quirks in popular Android skins.
 */
export function getVendorWorkarounds(vendor: KnownVendor): VendorWorkarounds {
	switch (vendor) {
		case "huawei":
			// EMUI WebView engine may need more time for context switching
			return {
				webViewContextPollExtraMs: 1500,
				forceNativeReset: true,
				domReadyTimeoutFactor: 1.5,
				avoidCdp: true, // Huawei often uses custom WebView without full CDP
			};
		case "xiaomi":
			// MIUI aggressive process management may kill WebView renderer
			return {
				webViewContextPollExtraMs: 1000,
				forceNativeReset: false,
				domReadyTimeoutFactor: 1.2,
				avoidCdp: false,
			};
		case "samsung":
			// Samsung Internet WebView may have different context naming
			return {
				webViewContextPollExtraMs: 500,
				forceNativeReset: false,
				domReadyTimeoutFactor: 1.1,
				avoidCdp: false,
			};
		case "oppo":
		case "vivo":
			// ColorOS / FuntouchOS may restrict background WebView
			return {
				webViewContextPollExtraMs: 1000,
				forceNativeReset: true,
				domReadyTimeoutFactor: 1.2,
				avoidCdp: true,
			};
		default:
			return {
				webViewContextPollExtraMs: 0,
				forceNativeReset: false,
				domReadyTimeoutFactor: 1.0,
				avoidCdp: false,
			};
	}
}

/**
 * Apply vendor workarounds to environment.
 * Sets process-scoped variables used by webview-context.ts and session helpers.
 */
export function applyVendorWorkarounds(workarounds: VendorWorkarounds): void {
	process.env.E2E_VENDOR_WEBVIEW_POLL_EXTRA_MS = String(workarounds.webViewContextPollExtraMs);
	process.env.E2E_VENDOR_FORCE_NATIVE_RESET = workarounds.forceNativeReset ? "1" : "0";
	process.env.E2E_VENDOR_DOM_READY_FACTOR = String(workarounds.domReadyTimeoutFactor);
	process.env.E2E_VENDOR_AVOID_CDP = workarounds.avoidCdp ? "1" : "0";
}

/**
 * Build vendor snapshot for inclusion in DiagnosticSnapshot and preflight output.
 */
export function buildVendorSnapshot(): NonNullable<DiagnosticSnapshot["vendorInfo"]> {
	const info = detectVendor();
	return {
		manufacturer: info.manufacturer,
		model: info.model,
		androidVersion: info.androidVersion,
		webViewPackage: info.webViewPackage || undefined,
		webViewVersion: info.webViewVersion || undefined,
	};
}
