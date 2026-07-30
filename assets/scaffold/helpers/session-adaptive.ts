/**
 * Adaptive mid-segment session policy (standard/quick: no blind periodic reload).
 */
import path from "node:path";
import { browser } from "@wdio/globals";

export interface SessionAdaptiveState {
	expertResetTimeouts: number;
	recentDurationsMs: number[];
	segmentHealPending: boolean;
}

function state(): SessionAdaptiveState {
	const g = globalThis as { __e2eSessionAdaptive?: SessionAdaptiveState };
	if (!g.__e2eSessionAdaptive) {
		g.__e2eSessionAdaptive = {
			expertResetTimeouts: 0,
			recentDurationsMs: [],
			segmentHealPending: false,
		};
	}
	return g.__e2eSessionAdaptive;
}

export function recordCaseDuration(ms: number): void {
	const s = state();
	s.recentDurationsMs.push(ms);
	if (s.recentDurationsMs.length > 12) {
		s.recentDurationsMs.shift();
	}
}

export function recordExpertResetTimeout(): void {
	state().expertResetTimeouts += 1;
}

export function markSegmentHealPending(): void {
	state().segmentHealPending = true;
}

export function clearSegmentHealPending(): void {
	state().segmentHealPending = false;
}

export function allowsPeriodicReload(): boolean {
	if (process.env.E2E_ALLOW_MID_SEGMENT_RELOAD === "1") return true;
	const profile = process.env.E2E_RUN_PROFILE || "standard";
	return profile === "resilience";
}

export async function countWebViewContexts(): Promise<number> {
	try {
		const contexts = await browser.getContexts();
		return contexts.filter((c) => String(c).startsWith("WEBVIEW")).length;
	} catch {
		return 0;
	}
}

/** Whether a one-off reloadSession is warranted (adaptive triggers). */
export async function shouldAdaptiveReload(): Promise<boolean> {
	const s = state();
	if (s.expertResetTimeouts >= 2) return true;
	if (s.segmentHealPending) return true;
	if ((await countWebViewContexts()) > 2) return true;
	const d = s.recentDurationsMs;
	if (d.length >= 6) {
		const prev3 = d.slice(-6, -3);
		const last3 = d.slice(-3);
		const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
		if (avg(last3) > avg(prev3) * 2) return true;
	}
	return false;
}

export function resetAdaptiveState(): void {
	const g = globalThis as { __e2eSessionAdaptive?: SessionAdaptiveState };
	delete g.__e2eSessionAdaptive;
}

export async function reenterPilotAfterReload(domain: string): Promise<void> {
	const sandboxRoot = process.env.E2E_SANDBOX || process.cwd();
	const { ensurePilotEntry } = await import(path.join(sandboxRoot, "helpers", "suite-entry"));
	const routeKey = process.env.E2E_FORM_MODULE || domain;
	await ensurePilotEntry(routeKey, { force: true });
}
