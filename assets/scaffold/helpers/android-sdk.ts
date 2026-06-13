/**
 * Android SDK environment setup
 * Auto-detects ANDROID_HOME from env, .e2e-local.json, and common paths.
 */

export function applyAndroidSdkEnv(): void {
	let sdkRoot =
		process.env.ANDROID_HOME ||
		process.env.ANDROID_SDK_ROOT ||
		"";
	if (!sdkRoot) {
		// Fallback 1: load from .e2e-local.json (同步 require 在 Node 上下文中正常运作)
		try {
			const localFile = __dirname + "/../.e2e-local.json";
			const fs = require("node:fs");
			if (fs.existsSync(localFile)) {
				const cfg = JSON.parse(fs.readFileSync(localFile, "utf-8"));
				const h = cfg?.env?.ANDROID_HOME || cfg?.env?.ANDROID_SDK_ROOT || "";
				if (h && fs.existsSync(h)) {
					sdkRoot = h;
					console.log("[android-sdk] Loaded from .e2e-local.json:", h);
				}
			}
		} catch {
			// silent
		}
	}
	if (!sdkRoot) {
		// Fallback 2: scan common SDK paths
		try {
			const fs = require("node:fs");
			const candidates = [
				process.env.HOME ? `${process.env.HOME}/Library/Android/sdk` : "",
				process.env.HOME ? `${process.env.HOME}/Android/Sdk` : "",
				"/usr/local/lib/android/sdk",
				"/opt/android-sdk",
				"/opt/homebrew/share/android-commandlinetools",
			].filter(Boolean);
			for (const dir of candidates) {
				try {
					if (fs.existsSync(`${dir}/platforms`) && fs.existsSync(`${dir}/build-tools`)) {
						sdkRoot = dir;
						console.log("[android-sdk] Auto-detected SDK at:", dir);
						break;
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}
	if (sdkRoot) {
		process.env.ANDROID_HOME = sdkRoot;
		process.env.ANDROID_SDK_ROOT = sdkRoot;
	} else {
		console.warn("[android-sdk] ANDROID_HOME and ANDROID_SDK_ROOT not set");
	}
}
