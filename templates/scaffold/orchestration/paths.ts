import fs from "node:fs";
import path from "node:path";

/** E2E 产物统一起点 */
export function e2eHome(): string {
	return process.env.E2E_HOME ||
		path.join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".e2e-device");
}
export function projectsDir(): string { return path.join(e2eHome(), "projects"); }
export function sandboxDir(): string { return path.join(e2eHome(), "sandbox"); }
export function logsDir(): string { return path.join(e2eHome(), "logs"); }

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

/** 临时产物目录——优先沙箱, 兜底 E2E_HOME (不落项目) */
export function artifactsRoot(): string {
	if (process.env.E2E_SANDBOX) {
		return path.join(process.env.E2E_SANDBOX, "artifacts");
	}
	return path.join(e2eHome(), "artifacts");
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
 * 项目配置路径——仅 $E2E_HOME/projects/{hash}.json
 * 不再是项目文件，由 discover-project 自动探测后写入缓存。
 */
export function projectConfigPath(): string {
	const root = repoRoot();
	const dir = projectsDir();
	const hash = Buffer.from(root).toString("base64").replace(/[/+=]/g, "_").slice(0, 32);
	return path.join(dir, `${hash}.json`);
}

export function saveProjectConfig(data: Record<string, unknown>): string {
	const dest = projectConfigPath();
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, JSON.stringify(data, null, 2), "utf-8");
	return dest;
}

/** 文件路径——沙箱模式优先, 兜底项目目录 */
function sandboxOrProject(subPath: string): string {
	if (process.env.E2E_SANDBOX) return path.join(process.env.E2E_SANDBOX, subPath);
	return path.join(e2eDeviceRoot(), subPath);
}

export const paths = {
	projectJson: () => projectConfigPath(),
	projectYaml: () => sandboxOrProject("skill.project.yaml"),
	localJson: () => sandboxOrProject(".e2e-local.json"),
	runJson: () => sandboxOrProject(".e2e-run.json"),
	caseRegistry: () => sandboxOrProject("case-registry.json"),
	chaosRegistry: () => sandboxOrProject(path.join("chaos", "chaos-case-registry.json")),
	diffInferred: () => sandboxOrProject("diff-inferred-cases.json"),
	scaffoldVersion: () => sandboxOrProject(".e2e-scaffold-version"),
	authRecovery: () => sandboxOrProject(path.join("artifacts", "auth-recovery.json")),
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
