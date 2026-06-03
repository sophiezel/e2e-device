/**
 * Platform detection for E2E device testing.
 * Currently only Android is fully supported; iOS is a placeholder for future expansion.
 */

export type TargetPlatform = "android" | "ios";

/** Resolve target platform from env or manifest */
export function resolveTargetPlatform(): TargetPlatform {
	const envPlatform = (process.env.E2E_PLATFORM || "").toLowerCase();
	if (envPlatform === "ios") return "ios";
	return "android";
}

/** Check if current run targets iOS */
export function isIOS(): boolean {
	return resolveTargetPlatform() === "ios";
}

/** Check if current run targets Android */
export function isAndroid(): boolean {
	return resolveTargetPlatform() === "android";
}
