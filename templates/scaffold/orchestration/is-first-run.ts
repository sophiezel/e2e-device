import fs from "node:fs";
import { paths } from "./paths";
import { readLocalConfig } from "../config/local-config";

export interface RunMode {
	/** True when .e2e-local.json doesn't exist or initialized !== true */
	isFirstRun: boolean;
	/** True when artifacts/auth-recovery.json exists (needs AUTH_RECOVERY) */
	isRecoveryRun: boolean;
	/** True when initialized === true and no blockers */
	isSubsequentRun: boolean;
}

/**
 * Determine the current run mode by inspecting .e2e-local.json and auth-recovery.json.
 * Centralizes the "first run vs subsequent run" logic that was previously
 * scattered across init.sh, questionnaire-first-run.md, agent-gates.md, and probe-env.ts.
 */
export function detectRunMode(): RunMode {
	const local = readLocalConfig();
	const initialized = local?.initialized === true;

	const authRecoveryPath = paths.authRecovery();
	const isRecoveryRun = fs.existsSync(authRecoveryPath);

	return {
		isFirstRun: !initialized,
		isRecoveryRun,
		isSubsequentRun: initialized && !isRecoveryRun,
	};
}

/**
 * Check if first-run questionnaire should be shown.
 * Per SKILL.md rule 8: only show when initialized !== true AND probe has required questions.
 */
export function shouldShowFirstRunQuestions(mode: RunMode): boolean {
	return mode.isFirstRun;
}

/**
 * Check if AUTH_RECOVERY flow should be triggered.
 * Per SKILL.md rule 8: allowed even on subsequent runs when auth-recovery.json exists.
 */
export function shouldTriggerAuthRecovery(mode: RunMode): boolean {
	return mode.isRecoveryRun;
}
