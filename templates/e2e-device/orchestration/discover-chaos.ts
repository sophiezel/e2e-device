import fs from "node:fs";
import path from "node:path";
import { discoverRoutes } from "./discover-routes";
import { discoverIntent } from "./discover-intent";
import { e2eDeviceRoot } from "./paths";
import type { CaseEntry } from "./discover-cases";

const CHAOS_SCENARIOS = [
	{ id: "network-offline", tag: "chaos-network" },
	{ id: "api-500", tag: "chaos-api" },
	{ id: "slow-3g", tag: "chaos-latency" },
	{ id: "empty-list", tag: "chaos-empty" },
	{ id: "stale-session", tag: "chaos-session" },
];

export function discoverChaos(domain?: string): CaseEntry[] {
	const intent = discoverIntent();
	const d = domain || intent.domain;
	const routes = discoverRoutes(d);
	const chaosDir = path.join(e2eDeviceRoot(), "chaos");
	fs.mkdirSync(chaosDir, { recursive: true });

	const cases: CaseEntry[] = [];
	for (const scenario of CHAOS_SCENARIOS) {
		cases.push({
			id: `${d}.chaos.${scenario.id}`,
			spec: `e2e-device/chaos/${d}.${scenario.id}.chaos.spec.ts`,
			tags: ["chaos", scenario.tag],
			source: "chaos-matrix",
		});
	}
	for (const r of routes) {
		cases.push({
			id: `${d}.chaos.route.${r.name}`,
			spec: `e2e-device/chaos/${d}.${r.name}.chaos.spec.ts`,
			tags: ["chaos", "route"],
			source: "chaos-routes",
		});
	}

	const registry = path.join(chaosDir, "chaos-case-registry.json");
	fs.writeFileSync(registry, JSON.stringify({ domain: d, cases }, null, 2), "utf-8");
	return cases;
}
