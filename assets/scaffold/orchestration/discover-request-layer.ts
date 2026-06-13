import fs from "node:fs";
import path from "node:path";
import { repoRoot, sandboxDir } from "./paths";

export interface MockRouteEntry {
	id: string;
	match: string;
	method: string;
	fixture?: string;
	source: string;
}

function findSourceRecursive(dir: string, exts: string[]): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			out.push(...findSourceRecursive(p, exts));
		} else if (exts.some((e) => ent.name.endsWith(e))) {
			out.push(p);
		}
	}
	return out;
}

function collectServiceFiles(root: string, pilotDomain?: string): string[] {
	const out = new Set<string>();
	const serviceRoots = [
		path.join(root, "src", "services"),
		path.join(root, "src", "service"),
	];
	for (const base of serviceRoots) {
		if (pilotDomain) {
			for (const ext of [".ts", ".js"]) {
				const pilotFile = path.join(base, `${pilotDomain}${ext}`);
				if (fs.existsSync(pilotFile)) {
					out.add(pilotFile);
				}
			}
		}
		for (const f of findSourceRecursive(base, [".ts", ".js"])) {
			out.add(f);
		}
	}
	const pagesDir = path.join(root, "src", "pages");
	const pageDir = path.join(root, "src", "page");
	for (const dir of [pagesDir, pageDir]) {
		if (!fs.existsSync(dir)) {
			continue;
		}
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isDirectory()) {
				continue;
			}
			const sub = path.join(dir, ent.name);
			for (const f of findSourceRecursive(sub, [".ts", ".js"])) {
				if (/service/i.test(path.basename(f)) || /api/i.test(f)) {
					out.add(f);
				}
			}
		}
	}
	return [...out];
}

function attachFixturesFromDir(
	routes: MockRouteEntry[],
	fixtureDir: string,
): void {
	if (!fs.existsSync(fixtureDir)) {
		return;
	}
	const jsonFiles: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(p, prefix ? `${prefix}/${ent.name}` : ent.name);
			} else if (ent.name.endsWith(".json")) {
				jsonFiles.push(prefix ? `${prefix}/${ent.name}` : ent.name);
			}
		}
	};
	walk(fixtureDir, "");

	for (const route of routes) {
		if (route.fixture) {
			continue;
		}
		const seg = route.match.split("/").filter(Boolean).pop() || "";
		const hit = jsonFiles.find((f) => f.includes(seg));
		if (!hit) {
			continue;
		}
		const rel = hit.replace(/\\/g, "/");
		const fp = path.join(fixtureDir, rel);
		if (fs.existsSync(fp)) {
			route.fixture = rel;
		}
	}
}

export function discoverRequestLayer(pilotDomain?: string): {
	strategy: string;
	hasBmock: boolean;
	routes: MockRouteEntry[];
	profileRouteMap?: Record<string, string[]>;
} {
	const root = repoRoot();
	const routes: MockRouteEntry[] = [];
	const seen = new Set<string>();
	const hasBmock = fs.existsSync(
		path.join(root, "src", "utils", "bmock", "index.js"),
	);

	for (const file of collectServiceFiles(root, pilotDomain)) {
		const text = fs.readFileSync(file, "utf-8");
		for (const m of text.matchAll(/["'](\/[a-zA-Z0-9_/-]+)["']/g)) {
			const matchPath = m[1];
			if (!matchPath.startsWith("/") || matchPath.length < 4) {
				continue;
			}
			if (!/^\/[a-zA-Z0-9]/.test(matchPath)) {
				continue;
			}
			if (seen.has(matchPath)) {
				continue;
			}
			seen.add(matchPath);
			const method = /method:\s*['"]POST['"]/i.test(text) ? "POST" : "GET";
			const id = matchPath.replace(/\//g, "_").replace(/^_/, "");
			routes.push({
				id,
				match: matchPath,
				method,
				source: path.relative(root, file),
			});
		}
	}

	const fixtureDir = path.join(sandboxDir(), "fixtures");
	attachFixturesFromDir(routes, fixtureDir);

	return {
		strategy: hasBmock ? "inject+bmock-optional" : "inject",
		hasBmock,
		routes,
	};
}
