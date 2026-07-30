import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { clearManifestCache } from "../../../assets/scaffold/config/project-manifest";
import { buildH5Url } from "../../../assets/scaffold/helpers/build-h5-url";
import {
	discoverRouteGraph,
	inferLaunchRoute,
} from "../../../assets/scaffold/helpers/route-resolver";

function runBuildH5UrlTest(): void {
	const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-h5-host-"));
	const manifest = {
		hybrid: {
			webView: {
				routingMode: "hash",
				pathPrefix: "",
				hashPrefix: "#/",
				webViewUrlAnchor: "#/billing-list",
			},
			network: {
				pageOrigin: "https://h5.example.com",
				apiOrigin: "",
			},
		},
		pilot: {
			domain: "billing",
			launchRoute: "billing-list",
			routes: { "billing-list": "billing/list" },
		},
	};
	fs.mkdirSync(path.join(hostRoot, "e2e-device"), { recursive: true });
	fs.writeFileSync(
		path.join(hostRoot, "e2e-device", "skill.project.json"),
		JSON.stringify(manifest),
	);

	const prevRoot = process.env.E2E_PROJECT_ROOT;
	const prevOrigin = process.env.E2E_PAGE_ORIGIN;
	const prevRoute = process.env.E2E_ROUTE;
	process.env.E2E_PROJECT_ROOT = hostRoot;
	process.env.E2E_PAGE_ORIGIN = "https://h5.example.com";
	delete process.env.E2E_ROUTE;
	delete process.env.E2E_PILOT_ROUTE;
	clearManifestCache();

	const url = buildH5Url("billing");
	assert.match(url, /^https:\/\/h5\.example\.com\/#\/billing-list\?/);

	if (prevRoot === undefined) delete process.env.E2E_PROJECT_ROOT;
	else process.env.E2E_PROJECT_ROOT = prevRoot;
	if (prevOrigin === undefined) delete process.env.E2E_PAGE_ORIGIN;
	else process.env.E2E_PAGE_ORIGIN = prevOrigin;
	if (prevRoute === undefined) delete process.env.E2E_ROUTE;
	else process.env.E2E_ROUTE = prevRoute;
	clearManifestCache();
}

function runRouteGraphFixtureTest(): void {
	const prevRoute = process.env.E2E_ROUTE;
	const prevPilotRoute = process.env.E2E_PILOT_ROUTE;
	delete process.env.E2E_ROUTE;
	delete process.env.E2E_PILOT_ROUTE;
	clearManifestCache();

	const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-route-fix-"));
	const routerDir = path.join(fixtureRoot, "src", "router");
	fs.mkdirSync(routerDir, { recursive: true });
	fs.writeFileSync(
		path.join(routerDir, "index.js"),
		`
import Detail from '@/pages/billing/detail.vue'
import List from '@/pages/billing/list.vue'
export default [
  {
    path: '/billing/list',
    name: 'billing-list',
    component: List
  },
  {
    path: '/billing/detail/:id',
    name: 'billing-detail',
    component: Detail
  }
]
`,
	);

	const { pageFileToRoutes, routes } = discoverRouteGraph(fixtureRoot);
	assert.deepEqual(pageFileToRoutes["billing/detail"], ["billing-detail"]);
	assert.ok(routes["billing-list"]);

	const fromChange = inferLaunchRoute("billing", {
		routes,
		pageFileToRoutes,
		changedFiles: ["src/pages/billing/detail.vue"],
	});
	assert.equal(fromChange, "billing-detail");

	const defaultList = inferLaunchRoute("billing", {
		routes,
		pageFileToRoutes,
	});
	assert.equal(defaultList, "billing-list");

	if (prevRoute === undefined) delete process.env.E2E_ROUTE;
	else process.env.E2E_ROUTE = prevRoute;
	if (prevPilotRoute === undefined) delete process.env.E2E_PILOT_ROUTE;
	else process.env.E2E_PILOT_ROUTE = prevPilotRoute;
	clearManifestCache();
}

runBuildH5UrlTest();
runRouteGraphFixtureTest();
console.log("build-h5-url contract: ok");
