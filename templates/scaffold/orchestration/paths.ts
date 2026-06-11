import fs from "node:fs";
import path from "node:path";

/**
 * 项目根路径——优先 E2E_PROJECT_ROOT 环境变量, 支持 /tmp 沙箱模式
 */
export function repoRoot(): string {
	if (process.env.E2E_PROJECT_ROOT && fs.existsSync(process.env.E2E_PROJECT_ROOT)) {
		return process.env.E2E_PROJECT_ROOT;
	}
	return path.resolve(__dirname, "../..");
}

export function e2eDeviceRoot(): string {
	return path.join(repoRoot(), "e2e-device");
}

/** 临时产物目录——优先 E2E_SANDBOX 环境变量 (沙箱模式) */
export function artifactsRoot(): string {
	if (process.env.E2E_SANDBOX && fs.existsSync(process.env.E2E_SANDBOX)) {
		return path.join(process.env.E2E_SANDBOX, "artifacts");
	}
	return path.join(e2eDeviceRoot(), "artifacts");
}

/** Skill 根目录 */
export function skillRoot(): string {
	return process.env.E2E_DEVICE_SKILL_ROOT ||
		path.join(process.env.HOME || "", ".agents", "skills", "e2e-device");
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

/**
 * 项目配置路径——持久化缓存优先, 项目文件兜底。
 * 1. $HOME/.cache/e2e-device/projects/{hash}.json
 * 2. $PROJECT/e2e-device/skill.project.json
 */
export function projectConfigPath(): string {
	const root = repoRoot();
	const cacheDir = path.join(
		process.env.HOME || process.env.USERPROFILE || "/tmp",
		".cache", "e2e-device", "projects"
	);
	const hash = Buffer.from(root).toString("base64").replace(/[/+=]/g, "_").slice(0, 32);
	const cacheFile = path.join(cacheDir, `${hash}.json`);
	if (fs.existsSync(cacheFile)) return cacheFile;
	const projectFile = path.join(e2eDeviceRoot(), "skill.project.json");
	if (fs.existsSync(projectFile)) return projectFile;
	return cacheFile;
}

export function saveProjectConfig(data: Record<string, unknown>): string {
	const dest = projectConfigPath();
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
	return dest;
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
	authRecovery: () => path.join(artifactsRoot(), "auth-recovery.json"),
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
