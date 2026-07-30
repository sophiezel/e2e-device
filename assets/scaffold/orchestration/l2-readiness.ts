import fs from "node:fs";
import path from "node:path";
import { loadProjectManifest } from "../config/project-manifest";
import { readLocalConfig } from "../config/local-config";
import { loadMockRulesFromManifest } from "./manifest-mock-rules";
import { paths, repoRoot } from "./paths";
import { serializeRulesForProfile } from "./web-mock-rules";
import { specExists } from "./spec-resolver";

export interface L2Blocker {
	id: string;
	severity: "blocker" | "warn";
	messageZh: string;
	resolution: string;
}

function registryIsL1Only(cases: Array<{ id: string; spec: string; tags?: string[] }>): boolean {
	const business = cases.filter(
		(c) =>
			c.id !== "infra.app-launch" &&
			!(c.tags || []).includes("bootstrap"),
	);
	return business.length === 0;
}

export function checkL2Readiness(options?: {
	runL2?: boolean;
	profile?: string;
}): { ok: boolean; blockers: L2Blocker[] } {
	const blockers: L2Blocker[] = [];
	const runL2 = options?.runL2 !== false;

	let manifest;
	try {
		manifest = loadProjectManifest();
	} catch {
		blockers.push({
			id: "manifest_missing",
			severity: "blocker",
			messageZh: "缺少 skill.project.json",
			resolution: "运行 bash ~/.agents/skills/e2e-device/scripts/run.sh --project . --plan-only",
		});
		return { ok: false, blockers };
	}

	const registry = paths.caseRegistry();
	let registryCases: Array<{ id: string; spec: string; tags?: string[] }> = [];
	if (fs.existsSync(registry)) {
		const data = JSON.parse(fs.readFileSync(registry, "utf-8")) as {
			cases?: Array<{ id: string; spec: string; tags?: string[] }>;
		};
		registryCases = data.cases || [];
		const missing = registryCases.filter(
			(c) => !specExists(c.spec),
		);
		if (runL2 && missing.length > 0) {
			blockers.push({
				id: "business_specs_missing",
				severity: "blocker",
				messageZh: `缺少 ${missing.length} 个 spec 文件`,
				resolution: "补全 sandbox specs 或运行 discover-cases --union",
			});
		}
	}

	const l1Only =
		process.env.E2E_L1_ONLY === "1" ||
		(registryCases.length > 0 && registryIsL1Only(registryCases));

	const pageOrigin =
		process.env.E2E_H5_ORIGIN?.trim() ||
		manifest.hybrid.network.pageOrigin?.trim() ||
		"";
	if (runL2 && !pageOrigin) {
		blockers.push({
			id: "page_origin_unknown",
			severity: "blocker",
			messageZh: "未配置 H5 页面域名 pageOrigin",
			resolution: "运行 discover-project 或设置 E2E_PAGE_ORIGIN",
		});
	}

	const local = readLocalConfig();
	const discoveredPage = manifest.hybrid.network.pageOrigin?.trim();
	const localPage = local?.env?.E2E_H5_ORIGIN?.trim();
	if (
		discoveredPage &&
		localPage &&
		discoveredPage !== localPage
	) {
		blockers.push({
			id: "page_origin_stale",
			severity: "warn",
			messageZh: "本地 E2E_PAGE_ORIGIN 与 manifest 发现结果不一致",
			resolution: "重新 discover-project 或更新 env / manifest.userConfirmed 中的 pageOrigin",
		});
	}

	if (runL2 && !l1Only) {
		const routes = manifest.mock?.routes || [];
		if (routes.length === 0) {
			blockers.push({
				id: "mock_routes_empty",
				severity: "blocker",
				messageZh: "manifest.mock.routes 为空",
				resolution: "运行 discover-project 扫描 services API，或在 skill.project.json 手写 mock.routes",
			});
		}
		const fixtureDirRel =
			manifest.mock?.fixtureDir || "e2e-device/fixtures";
		const fixtureRoot = path.join(repoRoot(), fixtureDirRel);
		const domain = process.env.E2E_DOMAIN?.trim() || manifest.pilot?.domain;
		if (domain) {
			const domainDir = path.join(fixtureRoot, domain);
			if (!fs.existsSync(domainDir)) {
				blockers.push({
					id: "domain_fixtures_missing",
					severity: "blocker",
					messageZh: `缺少宿主 fixtures 目录: ${fixtureDirRel}/${domain}`,
					resolution: `在仓库创建 ${fixtureDirRel}/${domain}/（参考 Skill assets/scaffold/fixtures/_template/ 与 references/mock-strategies.md）`,
				});
			} else {
				const statesPath = path.join(domainDir, "states.json");
				if (!fs.existsSync(statesPath)) {
					blockers.push({
						id: "states_json_missing",
						severity: "warn",
						messageZh: `${domain} 缺少 states.json（多状态 mock 不可用）`,
						resolution: `补充 ${fixtureDirRel}/${domain}/states.json`,
					});
				}
			}
		}
		const requiredRouteIds = new Set<string>();
		const map = manifest.mock?.profileRouteMap || {};
		for (const ids of Object.values(map)) {
			for (const id of ids) {
				requiredRouteIds.add(id);
			}
		}
		for (const route of routes) {
			if (!route.fixture) {
				continue;
			}
			if (requiredRouteIds.size > 0 && !requiredRouteIds.has(route.id)) {
				continue;
			}
			const fp = path.join(fixtureRoot, route.fixture);
			if (!fs.existsSync(fp)) {
				blockers.push({
					id: "fixtures_missing",
					severity: "blocker",
					messageZh: `缺少 fixture: ${route.fixture}`,
					resolution: `在 ${fixtureDirRel} 下创建对应 JSON`,
				});
			}
		}

		const profile = (options?.profile ||
			process.env.E2E_MOCK_PROFILE ||
			"default") as import("../resilience/types").FixtureProfile;
		const serialized = serializeRulesForProfile(profile);
		const manifestRules = loadMockRulesFromManifest(profile);
		if (serialized.length === 0 && manifestRules.length === 0) {
			// NO_CLUE / empty profile routes are valid for gate-only cases
			const profileRoutes = map[String(profile)];
			if (profileRoutes && profileRoutes.length === 0) {
				// ok: intentional empty mock set
			} else {
				blockers.push({
					id: "inject_rules_not_bound",
					severity: "blocker",
					messageZh: "无法序列化 inject mock 规则",
					resolution: "检查 manifest.mock.profileRouteMap 与 fixture 路径",
				});
			}
		}
	}

	const requiredBlockers = blockers.filter((b) => b.severity === "blocker");
	return { ok: requiredBlockers.length === 0, blockers };
}
