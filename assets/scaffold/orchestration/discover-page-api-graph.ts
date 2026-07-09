/**
 * Lightweight page → service → API dependency graph (no TS AST dependency).
 * Project-agnostic: only uses domain directory names and source patterns.
 */
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";

export type PageApiCall = {
	fn: string;
	url?: string;
	method?: string;
	paramKeys: string[];
	source: string;
};

export type PageApiGraph = {
	domain: string;
	gateParams: string[];
	imports: string[];
	calls: PageApiCall[];
};

function readText(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
}

function findFiles(dir: string, exts: string[], depth = 0): string[] {
	if (depth > 5 || !fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			out.push(...findFiles(p, exts, depth + 1));
		} else if (exts.some((e) => ent.name.endsWith(e))) {
			out.push(p);
		}
	}
	return out;
}

/** Extract named imports from services modules. */
function extractServiceImports(text: string): string[] {
	const names: string[] = [];
	const re =
		/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*services\/[^'"]+['"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		for (const part of m[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (name && /^[A-Za-z_]/.test(name)) names.push(name);
		}
	}
	return [...new Set(names)];
}

/** Map export const fn = request({ uri/url }) or arrow wrappers in a service file. */
function extractServiceExports(serviceText: string): Map<
	string,
	{ url?: string; method?: string; paramKeys: string[] }
> {
	const map = new Map<string, { url?: string; method?: string; paramKeys: string[] }>();

	// Pattern A: export const getX = someReq({ uri: '...', type: 'get' })
	const reqFactoryRe =
		/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*[A-Za-z0-9_]+\(\s*\{([^}]{0,400})\}/g;
	let m: RegExpExecArray | null;
	while ((m = reqFactoryRe.exec(serviceText)) !== null) {
		const name = m[1];
		const body = m[2];
		const urlM =
			body.match(/uri:\s*['"]([^'"]+)['"]/) ||
			body.match(/url:\s*['"]([^'"]+)['"]/);
		const typeM = body.match(/type:\s*['"](get|post|put|delete)['"]/i);
		const methodM = body.match(/method:\s*['"](GET|POST|PUT|DELETE)['"]/i);
		map.set(name, {
			url: urlM?.[1],
			method: (methodM?.[1] || typeM?.[1] || "GET").toUpperCase(),
			paramKeys: [],
		});
	}

	// Pattern B: export const getX = (params: { a?: string }) =>
	const exportRe =
		/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g;
	const indices: Array<{ name: string; params: string; start: number }> = [];
	while ((m = exportRe.exec(serviceText)) !== null) {
		indices.push({ name: m[1], params: m[2], start: m.index });
	}
	for (let i = 0; i < indices.length; i++) {
		const cur = indices[i];
		const nextExport = serviceText.indexOf("\nexport ", cur.start + 1);
		const end = Math.min(
			i + 1 < indices.length ? indices[i + 1].start : serviceText.length,
			nextExport > cur.start ? nextExport : serviceText.length,
			cur.start + 400,
		);
		const body = serviceText.slice(cur.start, end);
		const urlM =
			body.match(/uri:\s*['"]([^'"]+)['"]/) ||
			body.match(/url:\s*['"]([^'"]+)['"]/);
		const methodM = body.match(/method:\s*['"](GET|POST|PUT|DELETE)['"]/i);
		const typeM = body.match(/type:\s*['"](get|post|put|delete)['"]/i);
		const paramKeys: string[] = [];
		for (const pk of cur.params.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[?:]/g)) {
			if (!["params", "data", "options", "config"].includes(pk[1])) {
				paramKeys.push(pk[1]);
			}
		}
		for (const pk of cur.params.matchAll(/\{\s*([^}]*)\}/g)) {
			for (const part of pk[1].split(",")) {
				const key = part.trim().split(/[?:]/)[0]?.trim();
				if (key && /^[A-Za-z_]/.test(key)) paramKeys.push(key);
			}
		}
		const existing = map.get(cur.name);
		map.set(cur.name, {
			url: existing?.url || urlM?.[1],
			method:
				existing?.method ||
				(methodM?.[1] || typeM?.[1] || existing?.method || "GET").toUpperCase(),
			paramKeys: [...new Set([...(existing?.paramKeys || []), ...paramKeys])],
		});
	}

	// Pattern C: const getXRequest = someReq({ uri }) then export const getX = ...
	const aliasRe =
		/(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*[A-Za-z0-9_]+\(\s*\{([^}]{0,400})\}/g;
	const aliases = new Map<string, { url?: string; method?: string }>();
	while ((m = aliasRe.exec(serviceText)) !== null) {
		const body = m[2];
		const urlM =
			body.match(/uri:\s*['"]([^'"]+)['"]/) ||
			body.match(/url:\s*['"]([^'"]+)['"]/);
		const typeM = body.match(/type:\s*['"](get|post|put|delete)['"]/i);
		aliases.set(m[1], {
			url: urlM?.[1],
			method: (typeM?.[1] || "GET").toUpperCase(),
		});
	}
	for (const [name, meta] of map) {
		if (meta.url) continue;
		// look for getPriceInfoRequest usage in nearby export body — already handled loosely
		void name;
	}
	// Link wrappers that call alias: getPriceInfo = (params) => getPriceInfoRequest(...)
	for (const [alias, meta] of aliases) {
		const wrapperRe = new RegExp(
			`export\\s+const\\s+([A-Za-z0-9_]+)\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*${alias}\\s*\\(`,
		);
		const wm = serviceText.match(wrapperRe);
		if (wm) {
			const existing = map.get(wm[1]) || { paramKeys: [] as string[] };
			map.set(wm[1], {
				// Prefer alias URI — wrapper bodies often lack inline uri
				url: meta.url || existing.url,
				method: meta.method || existing.method,
				paramKeys: existing.paramKeys || [],
			});
		}
	}

	return map;
}

function detectGateParams(pageTexts: string[]): string[] {
	const gates = new Set<string>();
	const joined = pageTexts.join("\n");
	// if (!clueId) / if (!xxxFromQuery)
	for (const m of joined.matchAll(/if\s*\(\s*!\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) {
		const name = m[1];
		if (/FromQuery$/i.test(name) || /Id$/i.test(name) || /id$/i.test(name)) {
			const base = name.replace(/FromQuery$/i, "");
			gates.add(base.charAt(0).toLowerCase() + base.slice(1).replace(/^./, (c) => c));
			// normalize clueIdFromQuery → clueId
			if (/FromQuery$/i.test(name)) {
				gates.add(name.replace(/FromQuery$/i, "").replace(/^(.)/, (c) => c.toLowerCase()));
				const stripped = name.replace(/FromQuery$/i, "");
				gates.add(stripped.charAt(0).toLowerCase() + stripped.slice(1));
			} else {
				gates.add(name);
			}
		}
	}
	// search.get("clueId")
	for (const m of joined.matchAll(/search\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g)) {
		gates.add(m[1]);
	}
	return [...gates].filter(Boolean);
}

/**
 * Build page API graph for a domain under src/pages/{domain} + src/services/{domain}.ts
 */
export function discoverPageApiGraph(domain?: string): PageApiGraph | undefined {
	if (!domain) return undefined;
	const root = repoRoot();
	const pageDirs = [
		path.join(root, "src", "pages", domain),
		path.join(root, "src", "page", domain),
		path.join(root, "src", "views", domain),
	];
	const pageDir = pageDirs.find((d) => fs.existsSync(d));
	if (!pageDir) return undefined;

	const pageFiles = findFiles(pageDir, [".ts", ".tsx", ".js", ".jsx"]);
	const pageTexts = pageFiles.map(readText);
	const imports = [...new Set(pageTexts.flatMap(extractServiceImports))];

	const serviceCandidates = [
		path.join(root, "src", "services", `${domain}.ts`),
		path.join(root, "src", "services", `${domain}.js`),
		path.join(root, "src", "service", `${domain}.ts`),
	];
	const serviceFile = serviceCandidates.find((f) => fs.existsSync(f));
	const exportMap = serviceFile
		? extractServiceExports(readText(serviceFile))
		: new Map();

	const calls: PageApiCall[] = [];
	const joined = pageTexts.join("\n");
	for (const fn of imports) {
		if (!new RegExp(`\\b${fn}\\s*\\(`).test(joined)) continue;
		const meta = exportMap.get(fn) || {};
		calls.push({
			fn,
			url: meta.url,
			method: meta.method,
			paramKeys: meta.paramKeys || [],
			source: serviceFile
				? path.relative(root, serviceFile)
				: path.relative(root, pageDir),
		});
	}

	return {
		domain,
		gateParams: detectGateParams(pageTexts),
		imports,
		calls,
	};
}
