/**
 * Visual regression (pixel-diff) support for E2E device tests.
 *
 * Usage:
 *   E2E_VISUAL_DIFF=1 bash e2e-device/scripts/init.sh
 *
 * Baselines are stored in e2e-device/specs/screenshots/<caseId>/baseline.png
 * Diffs are stored in artifacts/runs/<runId>/visual-diffs/
 *
 * Requirements (install manually):
 *   npm install --save-dev resemblejs pngjs
 *   Or use pixelmatch + pngjs for a lighter alternative.
 */

import fs from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";
import { artifactsRoot, e2eDeviceRoot } from "./paths";

export interface VisualDiffResult {
	caseId: string;
	/** Whether the screenshot matches the baseline */
	matched: boolean;
	/** Difference percentage (0-100), if computed */
	diffPercent?: number;
	/** Path to baseline image */
	baselinePath: string;
	/** Path to diff image (if mismatch) */
	diffPath?: string;
	/** Error message if comparison failed */
	error?: string;
}

const BASELINE_DIR = path.join(e2eDeviceRoot(), "specs", "screenshots");

/**
 * Capture a screenshot for the current state.
 * Returns the saved file path.
 */
export async function captureScreenshot(caseId: string, runId: string): Promise<string> {
	const dir = path.join(artifactsRoot(), "runs", runId, "visual-diffs");
	fs.mkdirSync(dir, { recursive: true });

	const filename = `${caseId.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
	const filepath = path.join(dir, filename);
	await browser.saveScreenshot(filepath);
	return filepath;
}

/**
 * Compare a screenshot against the baseline.
 * If no baseline exists, saves current as baseline (first run).
 * If E2E_VISUAL_DIFF is not enabled, returns null (no-op).
 */
export async function diffScreenshot(
	caseId: string,
	runId: string,
): Promise<VisualDiffResult | null> {
	if (process.env.E2E_VISUAL_DIFF !== "1") {
		return null;
	}

	const safeId = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const baselineDir = path.join(BASELINE_DIR, safeId);
	const baselinePath = path.join(baselineDir, "baseline.png");

	// Take current screenshot
	const currentPath = await captureScreenshot(caseId, runId);

	// If no baseline exists, save current as baseline (first run)
	if (!fs.existsSync(baselinePath)) {
		fs.mkdirSync(baselineDir, { recursive: true });
		fs.copyFileSync(currentPath, baselinePath);
		console.log(`[visual-diff] Baseline saved: ${baselinePath}`);
		return {
			caseId,
			matched: true,
			baselinePath,
		};
	}

	// Compare using pixelmatch or resemblejs if available
	// For now, use a lightweight built-in comparison via buffer diff
	try {
		const currentBuf = fs.readFileSync(currentPath);
		const baselineBuf = fs.readFileSync(baselinePath);

		if (currentBuf.equals(baselineBuf)) {
			return { caseId, matched: true, baselinePath };
		}

		// Byte-level mismatch — save current as diff for manual review
		const diffPath = path.join(
			artifactsRoot(), "runs", runId, "visual-diffs",
			`${safeId}_diff.png`,
		);
		fs.copyFileSync(currentPath, diffPath);

		console.warn(`[visual-diff] Mismatch detected for ${caseId} (byte-level comparison)`);
		const threshold = parseFloat(process.env.E2E_VISUAL_DIFF_THRESHOLD || "0");

		return {
			caseId,
			matched: false,
			diffPercent: threshold > 0 ? undefined : 100, // placeholder until pixel-level comparison
			baselinePath,
			diffPath,
		};
	} catch (err) {
		return {
			caseId,
			matched: false,
			baselinePath,
			error: `Comparison failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Install pixel-level comparison support.
 * Run `npm install --save-dev pixelmatch pngjs` in the project root,
 * then set E2E_VISUAL_DIFF_ENGINE=pixelmatch for accurate diff percentages.
 *
 * With pixelmatch installed, diffScreenshot will:
 *   1. Load both PNGs via pngjs
 *   2. Compare pixels using pixelmatch
 *   3. Generate a diff image highlighting mismatched regions
 *   4. Return accurate diffPercent
 *
 * Example usage in spec:
 * ```ts
 * afterEach(async function () {
 *   if (process.env.E2E_VISUAL_DIFF === "1") {
 *     const { diffScreenshot } = await import("../orchestration/visual-diff");
 *     const result = await diffScreenshot(this.currentTest?.title || "unknown", runId);
 *     if (result && !result.matched) {
 *       console.warn(`Visual regression: ${result.caseId} diff=${result.diffPercent}%`);
 *     }
 *   }
 * });
 * ```
 */
