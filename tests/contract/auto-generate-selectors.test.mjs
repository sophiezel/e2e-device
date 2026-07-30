/**
 * Contract test: auto-generated specs must conform to the Hybrid selector contract.
 *
 * RED phase: these assertions encode the DESIRED state after P0 fixes.
 * They will FAIL against the current (pre-fix) generator output because:
 *   - the generator emits comma-separated `$()` selectors (Unsupported by UiAutomator2)
 *   - the generator hardcodes UI-library classes (.adm-*, .van-*, .t-*)
 *   - the generator does not import waitForH5Selector / h5-selector-tiers
 *
 * After P0-1..P0-3 are implemented, all assertions should pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "../..");
const tsNode = path.join(skillRoot, "scripts/node_modules/.bin/ts-node");

function generateSnapshots() {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-gen-"));
	const r = spawnSync(
		tsNode,
		["--compiler-options", JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
		 path.join(__dirname, "helpers/gen-snapshot.ts")],
		{
			cwd: skillRoot,
			encoding: "utf-8",
			env: {
				...process.env,
				E2E_SANDBOX: sandbox,
				E2E_DOMAIN: "demoDomain",
				E2E_PROJECT_ROOT: sandbox,
			},
		},
	);
	fs.rmSync(sandbox, { recursive: true, force: true });
	assert.equal(r.status, 0, `gen-snapshot failed: ${r.stderr || r.stdout}`);
	return JSON.parse(r.stdout);
}

/**
 * Detects comma-separated compound CSS selectors inside `$()` or `$$()` calls.
 * Handles attribute selectors with nested quotes (e.g. $('[data-e2e="list"], body').
 * Whitelist: `input, textarea` (two distinct HTML tags as a union — valid in WebDriver).
 * Also whitelists `querySelectorAll('...')` inside browser.execute (runs in WebView DOM,
 * not via Appium driver — fully CSS-compliant).
 */
function findCommaSelectors(content) {
	const violations = [];
	// Match $(...) and $$(...) with single-quoted strings (may contain double quotes inside)
	const reSingle = /\$+\(\s*'([^']*)'\s*\)/g;
	// Match $(...) and $$(...) with double-quoted strings (may contain single quotes inside)
	const reDouble = /\$+\(\s*"([^"]*)"\s*\)/g;
	for (const re of [reSingle, reDouble]) {
		let match;
		const r = new RegExp(re);
		while ((match = r.exec(content)) !== null) {
			const inner = match[1];
			if (inner.includes(",") && !isWhitelistedComma(inner)) {
				violations.push(inner);
			}
		}
	}
	return violations;
}

function isWhitelistedComma(inner) {
	const trimmed = inner.replace(/\s+/g, " ").trim();
	return /^input\s*,\s*textarea/.test(trimmed) || /^textarea\s*,\s*input/.test(trimmed);
}

/**
 * Detects hardcoded UI-library class prefixes that should not appear in
 * a generic Skill's generated specs (framework-agnostic design).
 */
const UI_LIB_CLASS = /\.(adm-|van-|t-toast|t-|ant-|el-|mui-)/;

test("generated specs contain no comma-separated compound $() selectors", () => {
	const snapshots = generateSnapshots();
	assert.ok(snapshots.length >= 7, `expected >=7 specs, got ${snapshots.length}`);

	const violations = [];
	for (const snap of snapshots) {
		// Strip browser.execute(() => { ... }) blocks — querySelectorAll inside
		// WebView DOM is valid CSS, not subject to the Appium driver constraint.
		const stripped = snap.content.replace(/browser\.execute\(\(\)\s*=>\s*\{[\s\S]*?\}\)/g, "// exec-block");

		for (const sel of findCommaSelectors(stripped)) {
			violations.push(`${snap.id}: $("${sel}")`);
		}
	}
	assert.deepEqual(violations, [], `comma-separated $() selectors found (Unsupported by UiAutomator2):\n${violations.join("\n")}`);
});

test("generated specs contain no hardcoded UI-library class prefixes", () => {
	const snapshots = generateSnapshots();
	const violations = [];
	for (const snap of snapshots) {
		if (UI_LIB_CLASS.test(snap.content)) {
			violations.push(snap.id);
		}
	}
	assert.deepEqual(violations, [], `hardcoded UI-library classes found (violates framework-agnostic design):\n${violations.join(", ")}`);
});

test("generated specs import waitForH5Selector or h5-selector-tiers", () => {
	const snapshots = generateSnapshots();
	const violations = [];
	for (const snap of snapshots) {
		// Specs that only use $("body") or browser.getUrl() are exempt.
		const usesBodyOnly = !/\$\(\s*['"]\[[^'"]*['"]/.test(snap.content) && !/\$\$/.test(snap.content);
		if (usesBodyOnly) continue;

		const importsHelper = /waitForH5Selector|h5-selector-tiers|queryDisplayedH5/.test(snap.content);
		if (!importsHelper) {
			violations.push(snap.id);
		}
	}
	assert.deepEqual(violations, [], `specs with non-body selectors must import selector helpers:\n${violations.join(", ")}`);
});

test("preclassify maps invalid selector errors to L1_spec_invalid", () => {
	const r = spawnSync(
		tsNode,
		["--compiler-options", JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
		 path.join(__dirname, "helpers/preclassify-snapshot.ts")],
		{ cwd: skillRoot, encoding: "utf-8" },
	);
	assert.equal(r.status, 0, `preclassify-snapshot failed: ${r.stderr || r.stdout}`);
	const items = JSON.parse(r.stdout);

	const byId = Object.fromEntries(items.map((i) => [i.caseId, i]));

	// invalid selector errors must be L1, not L2_biz
	assert.equal(
		byId["contract.L01"].rootCause,
		"L1_spec_invalid",
		`invalid selector should be L1_spec_invalid, got ${byId["contract.L01"]?.rootCause}`,
	);
	assert.equal(byId["contract.L01"].layer, "L1");

	assert.equal(
		byId["contract.L02"].rootCause,
		"L1_spec_invalid",
		`Unsupported CSS selector should be L1_spec_invalid, got ${byId["contract.L02"]?.rootCause}`,
	);
	assert.equal(byId["contract.L02"].layer, "L1");

	// genuine business assertion stays L2_biz
	assert.equal(byId["contract.L03"].rootCause, "L2_biz");
	assert.equal(byId["contract.L03"].layer, "L2");
});
