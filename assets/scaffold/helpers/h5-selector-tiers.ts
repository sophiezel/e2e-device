/**
 * Framework-agnostic H5 selector priority tiers.
 *
 * Single source of truth for all generated specs and helpers.
 * Priority: data-e2e > data-testid > ARIA roles > semantic HTML.
 *
 * UI-library class hints (.adm-*, .van-*, etc.) are NOT hardcoded here.
 * Hosts may extend tiers via `skill.project.json` → `selectorHints`.
 *
 * Contract: each tier is an ordered list of SINGLE selectors (no comma joins).
 * UiAutomator2 rejects comma-separated compound CSS selectors.
 */

/** Selector tier names used by generators and helpers. */
export type SelectorTier =
	| "anchor"
	| "listRoot"
	| "search"
	| "interactive"
	| "tab"
	| "toast"
	| "error";

/**
 * Default priority chains. Each entry is a single CSS selector.
 * Order matters: first match (displayed) wins.
 */
export const H5_TIERS: Record<SelectorTier, readonly string[]> = {
	/** Generic page anchor — used for "page rendered" assertions. */
	anchor: ["[data-e2e]", "[data-testid]", "main", "body"],
	/** List root container — L01 first-screen assertion. */
	listRoot: ['[data-e2e="list"]', '[data-testid="list"]', "main", "body"],
	/** Search input — L03 debounce check. */
	search: ['[data-e2e="search"]', '[data-testid="search"]', 'input[type="search"]'],
	/** Clickable card / list item — L04/L05 card interaction. */
	interactive: ['[data-e2e="card"]', '[data-testid="card"]', '[role="listitem"]', "li"],
	/** Tab elements — L02 tab switch. */
	tab: ["[role='tab']", '[data-e2e="tab"]', '[data-testid="tab"]'],
	/** Toast / alert — L04 toast assertion (presence only). */
	toast: ["[role='alert']", "[role='status']", '[data-e2e="toast"]', '[data-testid="toast"]'],
	/** Error hint — chaos spec error-state assertion. */
	error: ['[data-e2e="error"]', '[data-testid="error"]', "[role='alert']"],
};

/**
 * Host-provided selector hints from `skill.project.json`.
 * Values are PREPENDED to the default tier (higher priority).
 */
export interface SelectorHints {
	anchor?: string[];
	listRoot?: string[];
	search?: string[];
	interactive?: string[];
	tab?: string[];
	toast?: string[];
	error?: string[];
}

/**
 * Resolve a selector tier, merging host hints (prepended) with defaults.
 * Host hints take priority — they appear first in the returned array.
 */
export function resolveSelectorTier(
	tier: SelectorTier,
	hints?: SelectorHints | null,
): readonly string[] {
	const defaults = H5_TIERS[tier];
	const extra = hints?.[tier];
	if (!extra || extra.length === 0) return defaults;
	// Deduplicate: host hints first, then defaults not already included
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const s of [...extra, ...defaults]) {
		if (!seen.has(s)) {
			seen.add(s);
			merged.push(s);
		}
	}
	return merged;
}
