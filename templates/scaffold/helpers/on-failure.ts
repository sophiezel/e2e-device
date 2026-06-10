/**
 * Failure artifact capture
 */

import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { collectCoverageSnapshot } from "../orchestration/coverage";

export async function captureFailureArtifacts(testTitle: string): Promise<void> {
	const runId = process.env.E2E_RUN_ID || `run-${Date.now()}`;
	const artifactsDir = path.join("e2e-device", "artifacts", "runs", runId, "failures");

	if (!fs.existsSync(artifactsDir)) {
		fs.mkdirSync(artifactsDir, { recursive: true });
	}

	const safeName = testTitle.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
	const timestamp = Date.now();

	// Capture screenshot
	try {
		const screenshot = await browser.takeScreenshot();
		const screenshotPath = path.join(artifactsDir, `${safeName}_${timestamp}.png`);
		fs.writeFileSync(screenshotPath, screenshot, "base64");
		console.log(`[on-failure] Screenshot saved: ${screenshotPath}`);
	} catch (e) {
		console.log("[on-failure] Failed to capture screenshot:", e);
	}

	// Capture page source
	try {
		const source = await browser.getPageSource();
		const sourcePath = path.join(artifactsDir, `${safeName}_${timestamp}.xml`);
		fs.writeFileSync(sourcePath, source);
		console.log(`[on-failure] Page source saved: ${sourcePath}`);
	} catch (e) {
		console.log("[on-failure] Failed to capture page source:", e);
	}

	// Collect coverage snapshot on failure (partial coverage is still useful)
	if (process.env.E2E_COVERAGE_DETECTED === "1") {
		try {
			const covResult = await collectCoverageSnapshot(runId, `failure_${safeName}`);
			if (covResult.saved) {
				console.log(`[on-failure] Coverage snapshot saved: ${covResult.filesCount} files`);
			}
		} catch (e) {
			console.log("[on-failure] Failed to collect coverage snapshot:", e);
		}
	}
}
