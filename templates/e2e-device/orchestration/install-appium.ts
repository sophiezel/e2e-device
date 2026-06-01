import { execSync } from "node:child_process";
import { repoRoot } from "./paths";

export interface InstallAppiumResult {
	ok: boolean;
	log: string;
	needsSudo: boolean;
	manualSteps: string[];
}

function run(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

export function installAppium(): InstallAppiumResult {
	const root = repoRoot();
	const log: string[] = [];
	const manualSteps: string[] = [];

	try {
		log.push(run("yarn install", root));
	} catch (e) {
		const msg = String(e);
		log.push(msg);
		if (/EACCES|permission denied|sudo/i.test(msg)) {
			return {
				ok: false,
				log: log.join("\n"),
				needsSudo: true,
				manualSteps: [
					"在本机终端执行：cd 项目根目录 && yarn install",
					"完成后回复：安装完毕",
				],
			};
		}
	}

	try {
		log.push(run("npx appium driver install uiautomator2", root));
	} catch (e) {
		log.push(String(e));
		manualSteps.push("npx appium driver install uiautomator2");
	}

	try {
		log.push(run("yarn appium:doctor 2>/dev/null || npx appium driver doctor uiautomator2", root));
	} catch (e) {
		log.push(String(e));
	}

	const verify = (() => {
		try {
			run("npx appium --version", root);
			return true;
		} catch {
			return false;
		}
	})();

	if (!verify && process.env.E2E_APPIUM_GLOBAL === "1") {
		try {
			log.push(run("npm i -g appium @appium/doctor", root));
			log.push(run("appium driver install uiautomator2", root));
		} catch (e) {
			const msg = String(e);
			log.push(msg);
			return {
				ok: false,
				log: log.join("\n"),
				needsSudo: /EACCES|permission/i.test(msg),
				manualSteps: [
					"npm i -g appium @appium/doctor",
					"appium driver install uiautomator2",
					"完成后回复：安装完毕",
				],
			};
		}
	}

	if (!verify) {
		return {
			ok: false,
			log: log.join("\n"),
			needsSudo: false,
			manualSteps: manualSteps.length
				? manualSteps
				: ["yarn install", "npx appium driver install uiautomator2"],
		};
	}

	return { ok: true, log: log.join("\n"), needsSudo: false, manualSteps: [] };
}
