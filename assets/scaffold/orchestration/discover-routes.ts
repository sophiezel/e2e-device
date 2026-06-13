import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import { repoRoot } from "./paths";

export interface RouteEntry {
	name: string;
	path: string;
	source: string;
}

export function discoverRoutes(domain?: string): RouteEntry[] {
	const manifest = loadProjectManifest();
	const d = domain || manifest.pilot?.domain || "app";
	const routes: RouteEntry[] = [];

	if (manifest.pilot?.routes) {
		for (const [name, p] of Object.entries(manifest.pilot.routes)) {
			routes.push({ name, path: p, source: "manifest" });
		}
	}

	const shared = path.join(repoRoot(), "e2e-shared", `${d}.routes.ts`);
	if (fs.existsSync(shared)) {
		const text = fs.readFileSync(shared, "utf-8");
		for (const m of text.matchAll(/(\w+)\s*:\s*['"]([^'"]+)['"]/g)) {
			if (!routes.find((r) => r.name === m[1])) {
				routes.push({ name: m[1], path: m[2], source: "e2e-shared" });
			}
		}
	}

	const appTsx = path.join(repoRoot(), "src", "App.tsx");
	if (fs.existsSync(appTsx)) {
		const text = fs.readFileSync(appTsx, "utf-8");
		const re = new RegExp(`path=['"]([^'"]*${d}[^'"]*)['"]`, "gi");
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const p = m[1];
			if (!routes.find((r) => r.path === p)) {
				routes.push({ name: p.split("/").pop() || p, path: p, source: "App.tsx" });
			}
		}
	}

	return routes;
}
