/**
 * ADB device assertions
 */

import { execFileSync } from "node:child_process";

export function assertDeviceOnline(): void {
	const udid = process.env.ANDROID_UDID || process.env.E2E_DEVICE_SERIAL;
	const args = udid ? ["-s", udid, "get-state"] : ["get-state"];

	try {
		const state = execFileSync("adb", args, { encoding: "utf-8" }).trim();
		if (state !== "device") {
			throw new Error(`Device not ready: ${state}`);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`ADB device not available: ${msg}`);
	}
}
