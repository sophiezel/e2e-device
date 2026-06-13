import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { filterCasesWithExistingSpecs, type CaseEntry } from "./discover-cases";
import { paths, repoRoot, sandboxDir } from "./paths";

function changedFiles(): string[] {
	const bases = ["origin/main", "origin/master", "main", "master"];
	for (const base of bases) {
		try {
			const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
				cwd: repoRoot(),
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const files = out.split("\n").filter(Boolean);
			if (files.length) {
				return files;
			}
		} catch {
			// try next base
		}
	}
	return [];
}

function domainFromPath(file: string): string | undefined {
	const react = file.match(/src\/pages\/([^/]+)\//);
	if (react) {
		return react[1];
	}
	const vue = file.match(/src\/page\/([^/]+)\//);
	if (vue) {
		return vue[1];
	}
	return undefined;
}

export function discoverFromDiff(_base = "origin/main"): CaseEntry[] {
	const files = changedFiles();
	const sb = sandboxDir();
	const domains = new Set<string>();
	for (const f of files) {
		const d = domainFromPath(f);
		if (d) {
			domains.add(d);
		}
	}

	const cases: CaseEntry[] = [];
	for (const domain of domains) {
		const smoke = path.join(sb, "specs", `${domain}.smoke.spec.ts`);
		if (fs.existsSync(smoke)) {
			cases.push({
				id: `${domain}.diff.smoke`,
				spec: smoke,
				tags: ["diff", "smoke"],
				source: "git-diff",
			});
		}
		const nav = path.join(sb, "specs", `${domain}.nav.spec.ts`);
		if (
			fs.existsSync(nav) &&
			files.some((f) => f.includes(`${domain}/list`) || f.includes(`${domain}/`))
		) {
			cases.push({
				id: `${domain}.diff.nav`,
				spec: nav,
				tags: ["diff", "nav"],
				source: "git-diff",
			});
		}
	}

	const filtered = filterCasesWithExistingSpecs(cases);
	fs.mkdirSync(path.dirname(paths.diffInferred()), { recursive: true });
	fs.writeFileSync(
		paths.diffInferred(),
		JSON.stringify({ files, cases: filtered }, null, 2),
		"utf-8",
	);
	return filtered;
}
