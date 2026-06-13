import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { discoverIntent } from "./discover-intent";
import { discoverRoutes } from "./discover-routes";
import { e2eDeviceRoot, paths, repoRoot, e2eHome, sandboxDir } from "./paths";
import { discoverMatrixDocCases, type MatrixCase } from "./discover-matrix-doc";
import { discoverHybridCases } from "./discover-hybrid";
import { discoverChaos } from "./discover-chaos";
import { autoGenerateCases, writeGeneratedSpecs } from "./auto-generate-cases";
import { crossValidate } from "./cross-validate";
import { type RunProfile } from "../config/run-profile";
import { deviceEdgeCases } from "./discover-device-edge";

/** Generic fallback directories for domain document discovery. Not project-specific. */
const DOMAIN_DOC_SEARCH_DIRS = ["domain-docs", "product-specs", "features"];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CaseEntry {
	id: string;
	spec: string;
	tags: string[];
	source: string;
	metadata?: Record<string, unknown>;
	executionMethod?: string;
	// device-edge extension fields
	category?: string;
	name?: string;
	description?: string;
	priority?: string;
	sentinel?: boolean;
	profileLevel?: string;
	averageDurationMs?: number;
	chaosFactors?: string[];
	preconditions?: string[];
	steps?: string[];
	expectedResult?: string;
	failureCriteria?: string[];
}

export interface DiscoverCasesOptions {
	/** Domain to test (e.g., "exampleDomain") */
	domain?: string;
	/** Git branch for cache key */
	branch?: string;
	/** Run profile: quick | standard | resilience */
	profile?: RunProfile;
	/** User intent string */
	userIntent?: string;
	/** Union all sources vs. only primary sources */
	union?: boolean;
}

// ─── Case Cache Integration ─────────────────────────────────────────────────

/**
 * Derive a stable project hash for cache paths.
 */
function projectHash(): string {
	const root = repoRoot();
	return Buffer.from(root).toString("base64").replace(/[/+=]/g, "_").slice(0, 32);
}

/**
 * Get the current git branch name.
 */
function gitBranch(): string {
	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: repoRoot(),
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return branch || "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * Path to the case-cache.sh script.
 */
function caseCacheScript(): string {
	return path.join(
		process.env.E2E_DEVICE_SKILL_ROOT ||
			path.join(process.env.HOME || "", ".agents", "skills", "e2e-device"),
		"scripts",
		"case-cache.sh",
	);
}

/**
 * Check if the case cache is valid for the given project/branch/domain.
 */
function caseCacheCheck(branch: string, domain: string): boolean {
	const script = caseCacheScript();
	if (!fs.existsSync(script)) {
		if (process.env.E2E_DEBUG) console.debug("[discover-cases] case-cache.sh not found, skipping cache");
		return false;
	}

	try {
		const cacheHash = projectHash();
		execFileSync("bash", [script, "check", cacheHash, branch, domain], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		// exit code 1 = cache miss or stale
		return false;
	}
}

/**
 * Load cases from the cache.
 */
function caseCacheLoad(branch: string, domain: string): CaseEntry[] | null {
	const script = caseCacheScript();
	if (!fs.existsSync(script)) return null;

	try {
		const cacheHash = projectHash();
		const raw = execFileSync("bash", [script, "load", cacheHash, branch, domain], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const cases = JSON.parse(raw) as CaseEntry[];
		if (process.env.E2E_DEBUG) console.debug(`[discover-cases] Loaded ${cases.length} cached cases`);
		return cases;
	} catch {
		return null;
	}
}

/**
 * Save cases to the cache.
 */
function caseCacheSave(branch: string, domain: string, cases: CaseEntry[]): void {
	const script = caseCacheScript();
	if (!fs.existsSync(script) || cases.length === 0) return;

	try {
		const cacheHash = projectHash();
		const child = execFileSync("bash", [script, "save", cacheHash, branch, domain, repoRoot()], {
			encoding: "utf-8",
			timeout: 15000,
			stdio: ["pipe", "pipe", "pipe"],
			input: JSON.stringify(cases),
		});
		if (process.env.E2E_DEBUG) console.debug(`[discover-cases] Cache save: ${child.trim()}`);
	} catch (e) {
		console.warn(`[discover-cases] Cache save failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ─── Infra Cases (Framework Templates) ──────────────────────────────────────

/**
 * Infra cases: always included from framework templates.
 * These cover bootstrap, app launch, and base infrastructure.
 */
function infraCases(): CaseEntry[] {
	const cases: CaseEntry[] = [];

	const bootstrap = "app-launch.spec.ts";
	const bootstrapPath = path.join(sandboxDir(), "specs", bootstrap);
	if (fs.existsSync(bootstrapPath)) {
		cases.push({
			id: "infra.app-launch",
			spec: bootstrap,
			tags: ["infra", "bootstrap", "smoke"],
			source: "framework-infra",
			metadata: { description: "App cold launch and basic WebView connectivity" },
		});
	}

	// WebView lifecycle spec
	const lifecycleSpec = "infra.webview-lifecycle.spec.ts";
	const lifecyclePath = path.join(sandboxDir(), "specs", lifecycleSpec);
	if (fs.existsSync(lifecyclePath)) {
		cases.push({
			id: "infra.webview-lifecycle",
			spec: lifecycleSpec,
			tags: ["infra", "lifecycle"],
			source: "framework-infra",
			metadata: { description: "WebView creation/destruction lifecycle" },
		});
	} else {
		// Even without a spec file, register it as a pending case
		cases.push({
			id: "infra.webview-lifecycle",
			spec: lifecycleSpec,
			tags: ["infra", "lifecycle", "pending"],
			source: "framework-infra",
			metadata: { description: "WebView creation/destruction lifecycle (spec not yet generated)" },
		});
	}

	return cases;
}

// ─── Biz Cases: Cache or Document Extraction ───────────────────────────────

/**
 * Extract business cases for a domain.
 * Check cache first; if valid, load from cache.
 * Otherwise, read domain docs for Agent-based extraction and save to cache.
 */
function bizCases(domain: string, branch: string): CaseEntry[] {
	// 1. Try cache first
	if (caseCacheCheck(branch, domain)) {
		const cached = caseCacheLoad(branch, domain);
		if (cached) return cached;
	}

	// 2. Cache miss: extract from domain documents
	let docCases = discoverMatrixDocCases(domain);
	if (docCases.length === 0) {
		// Also try scanning generic domain doc paths
		docCases = scanGenericDomainDocs(domain, repoRoot());
	}

	// 3. Auto-generate specs for extracted cases
	if (docCases.length > 0) {
		const matrixData = docCases
			.filter((c) => c.metadata)
			.map((c) => c.metadata as unknown as MatrixCase);
		const autoGenerated = autoGenerateCases(matrixData, domain);
		writeGeneratedSpecs(autoGenerated);

		// 4. Save to cache for future runs
		caseCacheSave(branch, domain, docCases);
	}

	return docCases;
}

/**
 * Generic domain document scanner (framework-agnostic).
 * Scans docs/domain-docs/, docs/product-specs/, docs/features/ for domain-specific markdown.
 */
function scanGenericDomainDocs(domain: string, root: string): CaseEntry[] {
	const cases: CaseEntry[] = [];
	const docDirs = DOMAIN_DOC_SEARCH_DIRS.map((dir) => `docs/${dir}`);

	for (const docDir of docDirs) {
		const fullDir = path.join(root, ...docDir.split("/"));
		if (!fs.existsSync(fullDir)) continue;

		try {
			const entries = fs.readdirSync(fullDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.name.includes(domain)) continue;
				const docPath = entry.isDirectory()
					? path.join(fullDir, entry.name, "index.md")
					: path.join(fullDir, entry.name);

				if (fs.existsSync(docPath)) {
					cases.push({
						id: `${domain}.doc.${entry.name}`,
						spec: `${domain}.${entry.name}.spec.ts`,
						tags: ["biz", "doc-extracted", domain],
						source: `docs:${docDir}/${entry.name}`,
						metadata: { docFile: docPath, domain, extractedAt: new Date().toISOString() },
					});
				}
			}
		} catch { /* ignore */ }
	}

	return cases;
}

// ─── Chaos Cases ────────────────────────────────────────────────────────────

/**
 * Chaos cases: always included from framework templates.
 */
function chaosCases(): CaseEntry[] {
	const file = paths.chaosRegistry();
	if (!fs.existsSync(file)) return [];

	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { cases?: CaseEntry[] };
		return (data.cases || []).map((c) => ({
			...c,
			tags: [...(c.tags || []), "chaos"],
			source: "framework-chaos",
		}));
	} catch {
		return [];
	}
}

// ─── Diffusion/Custom Cases ─────────────────────────────────────────────────

function diffCases(): CaseEntry[] {
	const file = paths.diffInferred();
	if (!fs.existsSync(file)) return [];

	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { cases?: CaseEntry[] };
		return (data.cases || []).map((c) => ({ ...c, source: c.source || "diff-inferred" }));
	} catch {
		return [];
	}
}

function existingSpecs(): CaseEntry[] {
	const specsDir = path.join(e2eDeviceRoot(), "specs");
	if (!fs.existsSync(specsDir)) return [];

	return fs
		.readdirSync(specsDir)
		.filter((f) => f.endsWith(".spec.ts"))
		.map((f) => ({
			id: f.replace(".spec.ts", ""),
			spec: `${f}`,
			tags: ["existing"],
			source: "specs-dir",
		}));
}

// ─── Matrix Cases ───────────────────────────────────────────────────────────

function matrixCases(domain: string, routes: ReturnType<typeof discoverRoutes>): CaseEntry[] {
	const cases: CaseEntry[] = [];

	const bootstrap = "app-launch.spec.ts";
	const bootstrapPath = path.join(sandboxDir(), "specs", bootstrap);
	if (fs.existsSync(bootstrapPath)) {
		cases.push({
			id: "app-launch",
			spec: bootstrap,
			tags: ["bootstrap", "smoke"],
			source: "matrix",
		});
	}

	const smokeSpec = `${domain}.smoke.spec.ts`;
	const smokePath = path.join(repoRoot(), ...smokeSpec.split("/"));
	if (!fs.existsSync(smokePath)) return cases;

	for (const r of routes) {
		cases.push({
			id: `${domain}.${r.name}.smoke`,
			spec: smokeSpec,
			tags: ["smoke", r.name],
			source: "matrix",
		});
	}
	return cases;
}

// ─── Union & Deduplication ──────────────────────────────────────────────────

function specExists(spec: string): boolean {
	return fs.existsSync(path.join(repoRoot(), spec));
}

export function filterCasesWithExistingSpecs(cases: CaseEntry[]): CaseEntry[] {
	return cases.filter((c) => specExists(c.spec));
}

/**
 * Union all case sources, deduplicate by case id.
 * Later sources' tags are merged with earlier ones.
 */
function unionById(lists: CaseEntry[][]): CaseEntry[] {
	const map = new Map<string, CaseEntry>();
	for (const list of lists) {
		for (const c of list) {
			const prev = map.get(c.id);
			if (!prev) {
				map.set(c.id, c);
			} else {
				map.set(c.id, {
					...prev,
					tags: [...new Set([...prev.tags, ...c.tags])],
					source: `${prev.source}+${c.source}`,
					metadata: prev.metadata || c.metadata,
					executionMethod: prev.executionMethod || c.executionMethod,
				});
			}
		}
	}
	return [...map.values()];
}

// ─── Profile Filtering ─────────────────────────────────────────────────────

function filterByProfile(cases: CaseEntry[], profile: RunProfile): CaseEntry[] {
	switch (profile) {
		case "quick":
			return cases.filter((c) => {
				if (c.tags.includes("chaos")) return false;
				if (c.tags.includes("device-edge") && c.tags.includes("p2")) return false;
				if (c.tags.includes("vendor-specific")) return false;
				return true;
			});

		case "standard":
			return cases.filter((c) => {
				if (c.tags.includes("chaos")) return false;
				if (c.tags.includes("device-edge") && c.tags.includes("p2")) return false;
				if (c.tags.includes("vendor-specific")) return false;
				return true;
			});

		case "resilience":
			return cases;

		default:
			return cases;
	}
}

// ─── Execution Method Mapping ───────────────────────────────────────────────

function parseExecutionMethod(cases: CaseEntry[]): Map<string, string> {
	const methodMap = new Map<string, string>();
	for (const c of cases) {
		if (c.metadata) {
			const meta = c.metadata as Record<string, unknown>;
			const caseId = meta.caseId as string | undefined;
			const method = meta.executionMethod as string | undefined;
			if (caseId && method) methodMap.set(caseId, method);
		}
	}
	return methodMap;
}

function setExecutionMethod(cases: CaseEntry[], methodMap: Map<string, string>): CaseEntry[] {
	return cases.map((c) => {
		const match = c.id.match(/\.C(\d+)$/);
		if (match) {
			const caseId = `C${match[1]}`;
			const method = methodMap.get(caseId);
			if (method) return { ...c, executionMethod: method };
		}
		return c;
	});
}

// ─── Case Registry Write ────────────────────────────────────────────────────

/**
 * Write case registry to sandbox directory, not project directory.
 */
function writeCaseRegistry(domain: string, cases: CaseEntry[], profile: RunProfile, validation?: unknown): void {
	const sandbox = process.env.E2E_SANDBOX || path.join(e2eHome(), "sandbox");
	const registryPath = path.join(sandbox, "case-registry.json");
	fs.mkdirSync(sandbox, { recursive: true });
	fs.writeFileSync(
		registryPath,
		JSON.stringify(
			{
				domain,
				cases,
				profile,
				generatedAt: new Date().toISOString(),
				caseCount: cases.length,
				validation: validation || {},
			},
			null,
			2,
		),
	);
	if (process.env.E2E_DEBUG) console.debug(`[discover-cases] Case registry written to: ${registryPath}`);
}

// ─── Main discoverCases ─────────────────────────────────────────────────────

export function discoverCases(opts: DiscoverCasesOptions = {}): CaseEntry[] {
	const intent = discoverIntent(opts.userIntent);
	const domain = opts.domain || intent.domain;
	const branch = opts.branch || gitBranch();
	const profile = opts.profile || intent.profile;

	// ── Infra cases: always included ─────────────────────────────────────
	const infra = infraCases();

	// ── Biz cases: cache-first, then document extraction ──────────────────
	const biz = bizCases(domain, branch);

	// ── Chaos cases: always included ─────────────────────────────────────
	const chaos = chaosCases();
	const chaosGenerated = discoverChaos(domain);

	// ── Hybrid cases ─────────────────────────────────────────────────────
	const hybrid = discoverHybridCases(domain);

	// ── Device edge cases ────────────────────────────────────────────────
	const deviceEdge = deviceEdgeCases();

	// ── Matrix & diffusion ───────────────────────────────────────────────
	const routes = discoverRoutes(domain);
	const matrix = matrixCases(domain, routes);
	const existing = existingSpecs();
	const diff = diffCases();

	// ── Union all sources, deduplicate ───────────────────────────────────
	const lists: CaseEntry[][] = opts.union
		? [infra, biz, chaos, chaosGenerated, hybrid, deviceEdge, matrix, existing, diff]
		: [infra, biz, chaos, chaosGenerated, hybrid, deviceEdge, matrix, diff];

	let cases = unionById(lists);

	// ── Filter to cases with existing spec files ─────────────────────────
	cases = filterCasesWithExistingSpecs(cases);

	// ── Execution method mapping from biz matrix ─────────────────────────
	const methodMap = parseExecutionMethod(biz);
	cases = setExecutionMethod(cases, methodMap);

	// ── Profile filtering ────────────────────────────────────────────────
	cases = filterByProfile(cases, profile);

	// ── Cross-validation ─────────────────────────────────────────────────
	const validation = crossValidate(cases);
	if (validation.gaps?.length) {
		console.warn(`[discover-cases] Cross-validation found ${validation.gaps.length} coverage gap(s)`);
		if (process.env.E2E_DEBUG) {
			console.debug("[discover-cases] Validation details:", JSON.stringify(validation, null, 2));
		}
	}

	// ── Write case registry to sandbox, NOT project ──────────────────────
	writeCaseRegistry(domain, cases, profile, validation);

	if (process.env.E2E_DEBUG) {
		const bySource: Record<string, number> = {};
		for (const c of cases) {
			const src = c.source.split("+")[0];
			bySource[src] = (bySource[src] || 0) + 1;
		}
		console.debug("[discover-cases] Case breakdown:", JSON.stringify(bySource));
		console.debug(`[discover-cases] Total: ${cases.length} cases for domain=${domain} branch=${branch} profile=${profile}`);
	}

	return cases;
}
