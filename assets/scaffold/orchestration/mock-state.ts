/**
 * Host-agnostic mock state model.
 * Business values (clue ids, API paths) live in host e2e-device/fixtures/{domain}/states.json.
 */
import fs from "node:fs";
import path from "node:path";

export type MockState = {
	id: string;
	query?: Record<string, string>;
	profile: string;
	routes: string[];
	source?: "matrix" | "playwright" | "manual" | "host";
};

export type DomainStatesFile = {
	/** Default query key used when matrix implies a required gate param (e.g. clueId). */
	gateParam?: string;
	states: MockState[];
	/** Optional: map matrix keyword → state id */
	matrixKeywords?: Record<string, string>;
};

/** Built-in Chinese precondition → state id heuristics (no business values). */
const BUILTIN_KEYWORD_RULES: Array<{ re: RegExp; stateId: string }> = [
	{
		re: /无\s*[`']?\w*[Ii]d[`']?\s*query|缺少\s*[`']?\w*[Ii]d|无\s*clueId|缺少\s*clueId/i,
		stateId: "NO_CLUE",
	},
	{ re: /info\s*失败|接口失败|加载失败/i, stateId: "INFO_FAIL" },
	{ re: /下架失败|confirmRecycle\s*失败/i, stateId: "DELIST_FAIL" },
	{ re: /提交失败|submit\s*失败/i, stateId: "SUBMIT_FAIL" },
	{ re: /info\s*成功|GET\s*info\s*成功|getPriceInfo|收车价格/i, stateId: "INFO_OK" },
];

export function inferStateIdFromPreconditions(
	preconditions: string,
	hostKeywords?: Record<string, string>,
): string | undefined {
	const text = (preconditions || "").trim();
	if (!text) return undefined;
	if (hostKeywords) {
		for (const [kw, stateId] of Object.entries(hostKeywords)) {
			if (text.includes(kw)) return stateId;
		}
	}
	for (const rule of BUILTIN_KEYWORD_RULES) {
		if (rule.re.test(text)) return rule.stateId;
	}
	return undefined;
}

export function loadDomainStates(
	fixtureRoot: string,
	domain: string,
): DomainStatesFile | undefined {
	const fp = path.join(fixtureRoot, domain, "states.json");
	if (!fs.existsSync(fp)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(fp, "utf-8")) as DomainStatesFile;
	} catch {
		return undefined;
	}
}

export function buildProfileRouteMap(
	states: MockState[],
): Record<string, string[]> {
	const map: Record<string, string[]> = {};
	for (const s of states) {
		map[s.id] = s.routes;
		if (s.profile && s.profile !== s.id) {
			map[s.profile] = s.routes;
		}
	}
	return map;
}
