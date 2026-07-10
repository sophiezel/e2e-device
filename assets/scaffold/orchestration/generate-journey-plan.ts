import fs from "node:fs";
import path from "node:path";
import { sandboxDir } from "./paths";
import { BOOTSTRAP_CASE_ID } from "./constants";
import type { CaseEntry } from "./discover-cases";
import type { RunProfile } from "../config/run-profile";

/** Journey segment IDs aligned with expert testing paths. */
export const JOURNEY_SEGMENTS = ["env", "list", "form", "infra", "chaos"] as const;
export type JourneySegment = (typeof JOURNEY_SEGMENTS)[number];

export interface JourneyPlanSegment {
	segment: JourneySegment;
	specFile: string;
	specPath: string;
	caseIds: string[];
	caseCount: number;
	estimatedMs: number;
}

export interface JourneyPlan {
	domain: string;
	profile: RunProfile;
	segments: JourneyPlanSegment[];
	generatedAt: string;
	totalCases: number;
}

interface RegistryEntry {
	id: string;
	spec: string;
	tags?: string[];
	source?: string;
	metadata?: Record<string, unknown>;
}

interface CaseRegistry {
	domain?: string;
	profile?: RunProfile;
	cases?: RegistryEntry[];
}

function loadRegistry(): CaseRegistry {
	const file = path.join(sandboxDir(), "case-registry.json");
	if (!fs.existsSync(file)) return { cases: [] };
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as CaseRegistry;
	} catch {
		return { cases: [] };
	}
}

function resolveSpecPath(spec: string): string {
	if (path.isAbsolute(spec)) return spec;
	const sb = sandboxDir();
	const candidates = [
		path.join(sb, spec),
		path.join(sb, "specs", spec),
		path.join(sb, "chaos", path.basename(spec)),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return path.join(sb, "specs", path.basename(spec));
}

function specImportPath(specPath: string): string {
	const sb = sandboxDir();
	const rel = path.relative(path.join(sb, "specs"), specPath).replace(/\\/g, "/");
	if (!rel.startsWith("..")) {
		return rel.startsWith(".") ? rel : `./${rel}`;
	}
	if (specPath.includes(`${path.sep}chaos${path.sep}`)) {
		return `../chaos/${path.basename(specPath)}`;
	}
	return `./${path.basename(specPath)}`;
}

/** Classify a registry case into a journey segment. */
export function classifyJourneySegment(
	entry: RegistryEntry,
	domain: string,
): JourneySegment | null {
	const tags = entry.tags || [];
	const spec = entry.spec || "";
	const meta = entry.metadata || {};
	const pageModule = String(meta.pageModule || "");

	if (
		tags.some((t) => /chaos|framework-chaos|chaos-matrix/.test(t)) ||
		spec.includes("/chaos/") ||
		entry.id.includes(".chaos.")
	) {
		return "chaos";
	}

	if (
		entry.id === BOOTSTRAP_CASE_ID ||
		entry.id === "infra.app-launch" ||
		entry.id === "app-launch" ||
		spec.includes("app-launch")
	) {
		return "env";
	}

	if (tags.includes("infra") && !tags.includes("hybrid")) {
		return "env";
	}

	if (tags.includes("hybrid") || spec.includes("hybrid")) {
		return "infra";
	}

	if (entry.id.match(/\.L\d+$/) || tags.includes("list-journey")) {
		return "list";
	}

	if (pageModule && pageModule === domain) {
		return "list";
	}

	if (
		pageModule &&
		pageModule !== domain &&
		(tags.includes("biz") || tags.includes("matrix") || entry.source?.includes("matrix"))
	) {
		return "form";
	}

	if (entry.id.match(/\.C\d+$/)) {
		return pageModule && pageModule !== domain ? "form" : "form";
	}

	if (tags.includes("biz") || tags.includes("matrix")) {
		return pageModule === domain ? "list" : "form";
	}

	return null;
}

function groupAndSortForm(cases: RegistryEntry[]): RegistryEntry[] {
	return [...cases].sort(
		(a, b) =>
			(a.metadata?.navigationDepth as number | undefined ?? 0) -
			(b.metadata?.navigationDepth as number | undefined ?? 0),
	);
}

function filterCaseForProfile(entry: RegistryEntry, profile: RunProfile, segment: JourneySegment): boolean {
	if (segment === "list" && profile === "quick") {
		const id = entry.id;
		return /L0[1-2]$/.test(id) || tagsInclude(entry, "smoke");
	}
	if (segment === "form" && profile === "quick") {
		const m = entry.id.match(/\.C(\d+)$/);
		if (m) return parseInt(m[1], 10) <= 3;
		return tagsInclude(entry, "smoke") || tagsInclude(entry, "p0");
	}
	if (segment === "infra" && profile === "standard") {
		if (entry.spec.includes("performance") || entry.spec.includes("lifecycle")) {
			return false;
		}
	}
	if (segment === "infra" && profile === "quick") {
		return false;
	}
	if (segment === "chaos" && profile !== "resilience") {
		return false;
	}
	return true;
}

function tagsInclude(entry: RegistryEntry, tag: string): boolean {
	return (entry.tags || []).includes(tag);
}

function estimateMs(segment: JourneySegment, count: number): number {
	const perCase: Record<JourneySegment, number> = {
		env: 120_000,
		list: 45_000,
		form: 25_000,
		infra: 60_000,
		chaos: 45_000,
	};
	return perCase[segment] * Math.max(count, 1);
}

function segmentsForProfile(profile: RunProfile): JourneySegment[] {
	switch (profile) {
		case "quick":
			return ["env", "list", "form"];
		case "resilience":
			return ["env", "list", "form", "infra", "chaos"];
		default:
			return ["env", "list", "form", "infra"];
	}
}

/** Build journey plan from sandbox case-registry.json. */
export function generateJourneyPlan(opts?: {
	domain?: string;
	profile?: RunProfile;
}): JourneyPlan {
	const registry = loadRegistry();
	const domain = opts?.domain || registry.domain || process.env.E2E_DOMAIN || "unknown";
	const profile = opts?.profile || registry.profile || (process.env.E2E_RUN_PROFILE as RunProfile) || "standard";

	const buckets = new Map<JourneySegment, RegistryEntry[]>();
	for (const seg of JOURNEY_SEGMENTS) buckets.set(seg, []);

	for (const entry of registry.cases || []) {
		const segment = classifyJourneySegment(entry, domain);
		if (!segment) continue;
		if (!filterCaseForProfile(entry, profile, segment)) continue;
		buckets.get(segment)!.push(entry);
	}

	if ((buckets.get("form") || []).length > 1) {
		buckets.set("form", groupAndSortForm(buckets.get("form")!));
	}

	const allowed = segmentsForProfile(profile);
	const segments: JourneyPlanSegment[] = [];

	for (const segment of allowed) {
		const cases = buckets.get(segment) || [];
		if (cases.length === 0) continue;

		const specFile = `__journey_${segment}__.spec.ts`;
		const specPath = path.join(sandboxDir(), "specs", specFile);
		segments.push({
			segment,
			specFile,
			specPath,
			caseIds: cases.map((c) => c.id),
			caseCount: cases.length,
			estimatedMs: estimateMs(segment, cases.length),
		});
	}

	const plan: JourneyPlan = {
		domain,
		profile,
		segments,
		generatedAt: new Date().toISOString(),
		totalCases: segments.reduce((n, s) => n + s.caseCount, 0),
	};

	writeJourneyArtifacts(plan, buckets, allowed);
	return plan;
}

/** Write plan.json + __journey_*.spec.ts side-effect import entrypoints. */
export function writeJourneyArtifacts(
	plan: JourneyPlan,
	buckets: Map<JourneySegment, RegistryEntry[]>,
	allowed: JourneySegment[],
): void {
	const sb = sandboxDir();
	const journeysDir = path.join(sb, "journeys");
	fs.mkdirSync(journeysDir, { recursive: true });
	fs.mkdirSync(path.join(sb, "specs"), { recursive: true });

	fs.writeFileSync(path.join(journeysDir, "plan.json"), JSON.stringify(plan, null, 2), "utf-8");

	for (const segment of allowed) {
		const cases = buckets.get(segment) || [];
		if (cases.length === 0) continue;

		const imports: string[] = [
			"// @ts-nocheck",
			`// Journey segment: ${segment} — side-effect imports (${cases.length} specs, 1 session)`,
			"",
		];

		const seen = new Set<string>();
		for (const entry of cases) {
			const specPath = resolveSpecPath(entry.spec);
			if (seen.has(specPath)) continue;
			seen.add(specPath);
			if (!fs.existsSync(specPath)) {
				console.warn(`[journey-plan] spec missing, skip import: ${specPath}`);
				continue;
			}
			imports.push(`import "${specImportPath(specPath)}";`);
		}

		const specFile = `__journey_${segment}__.spec.ts`;
		fs.writeFileSync(path.join(sb, "specs", specFile), imports.join("\n") + "\n", "utf-8");
	}

	console.log(
		`[journey-plan] ${plan.segments.length} segment(s), ${plan.totalCases} case(s) → ${journeysDir}/plan.json`,
	);
}
