import fs from "node:fs";
import path from "node:path";
import { discoverIntent } from "./discover-intent";
import { discoverRoutes } from "./discover-routes";
import { e2eDeviceRoot, paths, repoRoot } from "./paths";

export interface CaseEntry {
	id: string;
	spec: string;
	tags: string[];
	source: string;
}

function specExists(spec: string): boolean {
	return fs.existsSync(path.join(repoRoot(), spec));
}

export function filterCasesWithExistingSpecs(cases: CaseEntry[]): CaseEntry[] {
	return cases.filter((c) => specExists(c.spec));
}

function existingSpecs(): CaseEntry[] {
	const specsDir = path.join(e2eDeviceRoot(), "specs");
	if (!fs.existsSync(specsDir)) {
		return [];
	}
	return fs
		.readdirSync(specsDir)
		.filter((f) => f.endsWith(".spec.ts"))
		.map((f) => ({
			id: f.replace(".spec.ts", ""),
			spec: `e2e-device/specs/${f}`,
			tags: ["existing"],
			source: "specs-dir",
		}));
}

function matrixCases(domain: string, routes: ReturnType<typeof discoverRoutes>): CaseEntry[] {
	const cases: CaseEntry[] = [];
	const bootstrap = "e2e-device/specs/app-launch.spec.ts";
	if (specExists(bootstrap)) {
		cases.push({
			id: "app-launch",
			spec: bootstrap,
			tags: ["bootstrap", "smoke"],
			source: "matrix",
		});
	}
	const smokeSpec = `e2e-device/specs/${domain}.smoke.spec.ts`;
	if (!specExists(smokeSpec)) {
		return cases;
	}
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

function diffCases(): CaseEntry[] {
	const file = paths.diffInferred();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: CaseEntry[];
	};
	return filterCasesWithExistingSpecs(
		(data.cases || []).map((c) => ({ ...c, source: c.source || "diff" })),
	);
}

function chaosCases(): CaseEntry[] {
	const file = paths.chaosRegistry();
	if (!fs.existsSync(file)) {
		return [];
	}
	const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
		cases?: CaseEntry[];
	};
	return filterCasesWithExistingSpecs(
		(data.cases || []).map((c) => ({
			...c,
			tags: [...(c.tags || []), "chaos"],
			source: "chaos",
		})),
	);
}

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
				});
			}
		}
	}
	return [...map.values()];
}

export function discoverCases(opts: { union?: boolean; domain?: string } = {}): CaseEntry[] {
	const intent = discoverIntent();
	const domain = opts.domain || intent.domain;
	const routes = discoverRoutes(domain);

	const matrix = matrixCases(domain, routes);
	const existing = existingSpecs();
	const diff = diffCases();
	const chaos = chaosCases();

	const lists = opts.union
		? [matrix, existing, diff, chaos]
		: [matrix, diff, chaos];

	const cases = filterCasesWithExistingSpecs(unionById(lists));
	fs.writeFileSync(paths.caseRegistry(), JSON.stringify({ domain, cases }, null, 2));
	return cases;
}
