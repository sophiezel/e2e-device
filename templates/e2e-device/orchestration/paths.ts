import fs from "node:fs";
import path from "node:path";

export function repoRoot(): string {
	return path.resolve(__dirname, "../..");
}

export function e2eDeviceRoot(): string {
	return path.join(repoRoot(), "e2e-device");
}

export function artifactsRoot(): string {
	return path.join(e2eDeviceRoot(), "artifacts");
}

export function runDir(runId?: string): string {
	let id = runId || process.env.E2E_RUN_ID || "";
	if (!id) {
		const idFile = path.join(e2eDeviceRoot(), ".e2e-run-id");
		if (fs.existsSync(idFile)) {
			id = fs.readFileSync(idFile, "utf-8").trim();
		}
	}
	if (!id) {
		id = `run-${Date.now()}`;
	}
	return path.join(artifactsRoot(), "runs", id);
}

export const paths = {
	projectJson: () => path.join(e2eDeviceRoot(), "skill.project.json"),
	projectYaml: () => path.join(e2eDeviceRoot(), "skill.project.yaml"),
	localJson: () => path.join(e2eDeviceRoot(), ".e2e-local.json"),
	runJson: () => path.join(e2eDeviceRoot(), ".e2e-run.json"),
	caseRegistry: () => path.join(e2eDeviceRoot(), "case-registry.json"),
	chaosRegistry: () => path.join(e2eDeviceRoot(), "chaos", "chaos-case-registry.json"),
	diffInferred: () => path.join(e2eDeviceRoot(), "diff-inferred-cases.json"),
	scaffoldVersion: () => path.join(e2eDeviceRoot(), ".e2e-scaffold-version"),
};

export function skillTemplatesRoot(): string {
	const fromEnv =
		process.env.E2E_DEVICE_SKILL_ROOT ||
		process.env.DEVICE_E2E_SKILL_TEMPLATES;
	if (fromEnv && fs.existsSync(fromEnv)) {
		const scaffold = path.join(fromEnv, "templates", "scaffold");
		if (fs.existsSync(scaffold)) {
			return scaffold;
		}
		if (fs.existsSync(fromEnv)) {
			return fromEnv;
		}
	}
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const scaffold = path.join(home, ".agents", "skills", "e2e-device", "templates", "scaffold");
	if (fs.existsSync(scaffold)) {
		return scaffold;
	}
	const legacy = path.join(home, ".agents", "skills", "device-e2e", "templates", "e2e-device");
	if (fs.existsSync(legacy)) {
		return legacy;
	}
	return path.join(e2eDeviceRoot(), "templates");
}

export function injectScriptPath(): string {
	return path.join(e2eDeviceRoot(), "inject", "web-request-mock.js");
}
