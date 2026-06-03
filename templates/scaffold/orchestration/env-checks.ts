/**
 * Shared environment check functions used by both probe-env and preflight-check.
 * Centralizes tryExec, SDK detection, version compatibility, and dependency checks.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths";

export function tryExec(cmd: string): { ok: boolean; out: string } {
	try {
		const out = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		return { ok: true, out };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: err.stdout || err.stderr || err.message || "" };
	}
}

export function sdkHasRequiredLayout(sdkRoot: string): boolean {
	return (
		fs.existsSync(path.join(sdkRoot, "platforms")) &&
		fs.existsSync(path.join(sdkRoot, "build-tools"))
	);
}

export function resolveAndroidSdkRoot(): string | null {
	const fromEnv = (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "").trim();
	if (fromEnv && fs.existsSync(fromEnv)) {
		return fromEnv.replace(/\/$/, "");
	}
	const home = process.env.HOME || "";
	for (const candidate of [
		path.join(home, "Library", "Android", "sdk"),
		path.join(home, "Android", "Sdk"),
	]) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

/** Check Node.js version compatibility with Appium 3.x */
export function checkNodeVersionCompat(): {
	ok: boolean;
	version: string;
	required: string;
	message?: string;
} {
	const nodeVersion = tryExec("node -v");
	if (!nodeVersion.ok) {
		return {
			ok: false,
			version: "unknown",
			required: "^20.19.0 || ^22.12.0 || >=24.0.0",
			message: "Node.js 未安装",
		};
	}

	const version = nodeVersion.out.replace("v", "");
	const parts = version.split(".").map(Number);
	const major = parts[0];
	const minor = parts[1];

	let compatible = false;
	const required = "^20.19.0 || ^22.12.0 || >=24.0.0";

	if (major === 20 && minor >= 19) compatible = true;
	else if (major === 22 && minor >= 12) compatible = true;
	else if (major >= 24) compatible = true;

	return {
		ok: compatible,
		version: `v${version}`,
		required,
		message: compatible ? undefined : `Node.js v${version} 与 Appium 3.x 不兼容，需要 ${required}`,
	};
}

/** Check if ts-node is available */
export function checkTsNodeAvailable(): { ok: boolean; version?: string; message?: string } {
	const localTsNode = tryExec("npx ts-node --version");
	if (localTsNode.ok) {
		return { ok: true, version: localTsNode.out };
	}

	const globalTsNode = tryExec("ts-node --version");
	if (globalTsNode.ok) {
		return { ok: true, version: globalTsNode.out };
	}

	const home = process.env.HOME || "";
	const skillTsNode = tryExec(`${home}/.agents/skills/e2e-device/node_modules/.bin/ts-node --version`);
	if (skillTsNode.ok) {
		return { ok: true, version: skillTsNode.out };
	}

	return { ok: false, message: "ts-node 未安装，编排脚本依赖它" };
}

/** Check if wdio is available */
export function checkWdioAvailable(): { ok: boolean; version?: string; message?: string } {
	const localWdio = tryExec("npx wdio --version");
	if (localWdio.ok) {
		return { ok: true, version: localWdio.out };
	}

	const root = repoRoot();
	const binWdio = tryExec(`${root}/node_modules/.bin/wdio --version`);
	if (binWdio.ok) {
		return { ok: true, version: binWdio.out };
	}

	return { ok: false, message: "wdio 未安装，跑测依赖它" };
}

export function hasProjectAppium(): boolean {
	const pkg = path.join(repoRoot(), "package.json");
	if (!fs.existsSync(pkg)) {
		return false;
	}
	try {
		const json = JSON.parse(fs.readFileSync(pkg, "utf-8")) as {
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		return !!(json.devDependencies?.appium || json.dependencies?.appium);
	} catch {
		return false;
	}
}

export function appiumAvailable(): boolean {
	if (tryExec("yarn -s appium --version").ok) return true;
	if (tryExec("npx appium --version").ok) return true;
	return tryExec("appium --version").ok;
}

/** Check dependency version conflicts */
export function checkDependencyConflicts(): Array<{
	package: string;
	issue: string;
	resolution: string;
}> {
	const conflicts: Array<{ package: string; issue: string; resolution: string }> = [];
	const root = repoRoot();
	const pkgPath = path.join(root, "package.json");

	if (!fs.existsSync(pkgPath)) {
		return conflicts;
	}

	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

		if (allDeps.appium) {
			const appiumVersion = allDeps.appium.replace(/[\^~>=<]/, "");
			const major = parseInt(appiumVersion.split(".")[0]);
			if (major < 3) {
				conflicts.push({
					package: "appium",
					issue: `版本 ${allDeps.appium} 过低，Appium 3.x 要求 ^3.0.0`,
					resolution: "运行 yarn add -D appium@^3.4.2",
				});
			}
		}

		if (allDeps["@wdio/cli"]) {
			const wdioVersion = allDeps["@wdio/cli"].replace(/[\^~>=<]/, "");
			const major = parseInt(wdioVersion.split(".")[0]);
			if (major < 8) {
				conflicts.push({
					package: "@wdio/cli",
					issue: `版本 ${allDeps["@wdio/cli"]} 过低，wdio 8.x 要求 ^8.0.0`,
					resolution: "运行 yarn add -D @wdio/cli@^8.40.0",
				});
			}
		}
	} catch {
		// ignore parse errors
	}

	return conflicts;
}
