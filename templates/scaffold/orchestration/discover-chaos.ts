import fs from "node:fs";
import path from "node:path";
import { discoverRoutes } from "./discover-routes";
import { discoverIntent } from "./discover-intent";
import { e2eDeviceRoot } from "./paths";
import type { CaseEntry } from "./discover-cases";

// 通用混沌场景
const CHAOS_SCENARIOS = [
	{ id: "network-offline", tag: "chaos-network" },
	{ id: "api-500", tag: "chaos-api" },
	{ id: "slow-3g", tag: "chaos-latency" },
	{ id: "empty-list", tag: "chaos-empty" },
	{ id: "stale-session", tag: "chaos-session" },
];

// Hybrid 专属混沌场景
const HYBRID_CHAOS_SCENARIOS = [
	{ id: "webview-crash", tag: "chaos-hybrid", description: "WebView 崩溃恢复" },
	{ id: "native-timeout", tag: "chaos-hybrid", description: "Native 操作超时" },
	{ id: "bridge-failure", tag: "chaos-hybrid", description: "Bridge 调用失败" },
	{ id: "memory-pressure", tag: "chaos-hybrid", description: "内存压力测试" },
	{ id: "context-switch-race", tag: "chaos-hybrid", description: "Context 切换竞争" },
];

export function discoverChaos(domain?: string): CaseEntry[] {
	const intent = discoverIntent();
	const d = domain || intent.domain;
	const routes = discoverRoutes(d);
	const chaosDir = process.env.E2E_SANDBOX
		? path.join(process.env.E2E_SANDBOX, "chaos")
		: path.join(e2eDeviceRoot(), "chaos");
	fs.mkdirSync(chaosDir, { recursive: true });

	const cases: CaseEntry[] = [];

	// 通用混沌场景
	for (const scenario of CHAOS_SCENARIOS) {
		cases.push({
			id: `${d}.chaos.${scenario.id}`,
			spec: `e2e-device/chaos/${d}.${scenario.id}.chaos.spec.ts`,
			tags: ["chaos", scenario.tag, "recovery"],
			source: "chaos-matrix",
		});
	}

	// Hybrid 专属混沌场景
	for (const scenario of HYBRID_CHAOS_SCENARIOS) {
		cases.push({
			id: `${d}.chaos.hybrid.${scenario.id}`,
			spec: `e2e-device/chaos/${d}.hybrid.${scenario.id}.chaos.spec.ts`,
			tags: ["chaos", "hybrid", scenario.tag, "recovery"],
			source: "chaos-hybrid",
			metadata: { description: scenario.description },
		});
	}

	// 路由级混沌场景
	for (const r of routes) {
		cases.push({
			id: `${d}.chaos.route.${r.name}`,
			spec: `e2e-device/chaos/${d}.${r.name}.chaos.spec.ts`,
			tags: ["chaos", "route", "recovery"],
			source: "chaos-routes",
		});
	}

	const registry = path.join(chaosDir, "chaos-case-registry.json");
	fs.writeFileSync(registry, JSON.stringify({ domain: d, cases }, null, 2), "utf-8");
	return cases;
}
