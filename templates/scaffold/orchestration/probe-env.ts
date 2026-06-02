import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyCredentials, hasCredentials } from "../helpers/credentials";
import { writeLocalConfig, readLocalConfig } from "../config/local-config";
import { clearManifestCache, loadProjectManifest } from "../config/project-manifest";
import { checkL2Readiness } from "./l2-readiness";
import { paths, repoRoot } from "./paths";
import {
	checkAdbAvailable,
	detectForegroundApp,
	detectLaunchActivity,
	loadAppJson,
} from "../helpers/android-config";

export interface ProbeBlocker {
	id: string;
	severity: "blocker" | "warn";
	messageZh: string;
	resolution: string;
	waitPhrase: string | null;
}

export interface ProbeResult {
	ok: boolean;
	questions: Array<{ id: string; prompt: string; required: boolean }>;
	blockers: ProbeBlocker[];
	snapshot: Record<string, unknown>;
}

function tryExec(cmd: string): { ok: boolean; out: string } {
	try {
		const out = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		return { ok: true, out };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: err.stdout || err.stderr || err.message || "" };
	}
}

/** Check Node.js version compatibility with Appium 3.x */
function checkNodeVersionCompatibility(): { ok: boolean; version: string; required: string; message?: string } {
	const nodeVersion = tryExec("node -v");
	if (!nodeVersion.ok) {
		return { ok: false, version: "unknown", required: "^20.19.0 || ^22.12.0 || >=24.0.0", message: "Node.js 未安装" };
	}

	const version = nodeVersion.out.replace("v", "");
	const parts = version.split(".").map(Number);
	const major = parts[0];
	const minor = parts[1];

	// Appium 3.x 要求: ^20.19.0 || ^22.12.0 || >=24.0.0
	let compatible = false;
	let required = "^20.19.0 || ^22.12.0 || >=24.0.0";

	if (major === 20 && minor >= 19) {
		compatible = true;
	} else if (major === 22 && minor >= 12) {
		compatible = true;
	} else if (major >= 24) {
		compatible = true;
	}

	return {
		ok: compatible,
		version: `v${version}`,
		required,
		message: compatible ? undefined : `Node.js v${version} 与 Appium 3.x 不兼容，需要 ${required}`,
	};
}

/** Check if ts-node is available */
function checkTsNodeAvailable(): { ok: boolean; version?: string; message?: string } {
	// 检查项目本地 ts-node
	const localTsNode = tryExec("npx ts-node --version");
	if (localTsNode.ok) {
		return { ok: true, version: localTsNode.out };
	}

	// 检查全局 ts-node
	const globalTsNode = tryExec("ts-node --version");
	if (globalTsNode.ok) {
		return { ok: true, version: globalTsNode.out };
	}

	// 检查 skill 目录的 ts-node
	const home = process.env.HOME || "";
	const skillTsNode = tryExec(`${home}/.agents/skills/e2e-device/node_modules/.bin/ts-node --version`);
	if (skillTsNode.ok) {
		return { ok: true, version: skillTsNode.out };
	}

	return { ok: false, message: "ts-node 未安装，编排脚本依赖它" };
}

/** Check if wdio is available */
function checkWdioAvailable(): { ok: boolean; version?: string; message?: string } {
	// 检查项目本地 wdio
	const localWdio = tryExec("npx wdio --version");
	if (localWdio.ok) {
		return { ok: true, version: localWdio.out };
	}

	// 检查 node_modules/.bin/wdio
	const root = repoRoot();
	const binWdio = tryExec(`${root}/node_modules/.bin/wdio --version`);
	if (binWdio.ok) {
		return { ok: true, version: binWdio.out };
	}

	return { ok: false, message: "wdio 未安装，跑测依赖它" };
}

/** Check dependency version conflicts */
function checkDependencyConflicts(): Array<{ package: string; issue: string; resolution: string }> {
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

		// 检查 Appium 版本
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

		// 检查 wdio 版本
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

function hasProjectAppium(): boolean {
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

function appiumAvailable(): boolean {
	if (tryExec("yarn -s appium --version").ok) {
		return true;
	}
	if (tryExec("npx appium --version").ok) {
		return true;
	}
	return tryExec("appium --version").ok;
}

function resolveAndroidSdkRoot(): string | null {
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

function sdkHasRequiredLayout(sdkRoot: string): boolean {
	return (
		fs.existsSync(path.join(sdkRoot, "platforms")) &&
		fs.existsSync(path.join(sdkRoot, "build-tools"))
	);
}

export function probeEnv(opts: { adbOnly?: boolean } = {}): ProbeResult {
	const questions: ProbeResult["questions"] = [];
	const blockers: ProbeBlocker[] = [];
	const snapshot: Record<string, unknown> = {};

	const adbWhich = tryExec("command -v adb");
	if (!adbWhich.ok) {
		blockers.push({
			id: "adb_missing",
			severity: "blocker",
			messageZh: "未检测到 adb，无法执行真机 E2E",
			resolution: "安装 Android platform-tools 并加入 PATH",
			waitPhrase: null,
		});
	} else {
		snapshot.adbPath = adbWhich.out.split("\n")[0];
		const adb = tryExec("adb devices");
		snapshot.adb = adb.out;
		const lines = adb.out.split("\n").filter((l) => l.includes("\t"));
		const devices = lines.filter((l) => l.includes("\tdevice"));
		const unauthorized = lines.filter((l) => l.includes("unauthorized"));
		snapshot.deviceCount = devices.length;

		if (unauthorized.length > 0) {
			blockers.push({
				id: "adb_unauthorized",
				severity: "blocker",
				messageZh: "USB 设备未授权",
				resolution: "在手机上允许 USB 调试并确认 RSA 指纹",
				waitPhrase: "已连接",
			});
		} else if (devices.length === 0) {
			blockers.push({
				id: "adb_no_device",
				severity: "blocker",
				messageZh: "未检测到已连接的 USB 设备",
				resolution: "插入真机、开启 USB 调试后重试",
				waitPhrase: "已连接",
			});
		} else if (devices.length > 1) {
			questions.push({
				id: "E2E_DEVICE_SERIAL",
				prompt: "检测到多台 USB 设备，请输入要使用的设备序列号：",
				required: true,
			});
			snapshot.suggestedSerial = devices[0].split("\t")[0];
		} else {
			snapshot.suggestedSerial = devices[0].split("\t")[0];
		}
	}

	if (!opts.adbOnly) {
		const sdkRoot = resolveAndroidSdkRoot();
		snapshot.androidSdkRoot = sdkRoot || "missing";
		if (!sdkRoot) {
			blockers.push({
				id: "android_sdk_missing",
				severity: "blocker",
				messageZh:
					"未检测到 Android SDK（ANDROID_HOME）。Appium 真机 E2E 需要完整 SDK，仅 adb/platform-tools 不够",
				resolution:
					"运行 bash e2e-device/scripts/install-android-sdk.sh（macOS+Homebrew 可自动安装），或见 reference/android-sdk-setup.md 手动安装",
				waitPhrase: "SDK 已配置",
			});
		} else if (!sdkHasRequiredLayout(sdkRoot)) {
			blockers.push({
				id: "android_sdk_incomplete",
				severity: "blocker",
				messageZh: "Android SDK 目录不完整（缺少 platforms 或 build-tools）",
				resolution:
					"在 Android Studio SDK Manager 安装 Platform 与 Build-Tools，见 android-sdk-setup.md",
				waitPhrase: "SDK 已配置",
			});
		} else {
			process.env.ANDROID_HOME = process.env.ANDROID_HOME || sdkRoot;
			process.env.ANDROID_SDK_ROOT = process.env.ANDROID_SDK_ROOT || sdkRoot;
			snapshot.androidSdkConfigured = true;
		}

		const appiumOk = appiumAvailable();
		snapshot.appium = appiumOk
			? tryExec("npx appium --version 2>/dev/null || appium --version").out
			: "missing";
		snapshot.appiumInProject = hasProjectAppium();

		if (!appiumOk) {
			blockers.push({
				id: "appium_missing",
				severity: "blocker",
				messageZh: "未检测到 Appium",
				resolution: "运行 install-appium 或在本机安装 Appium 2",
				waitPhrase: "安装完毕",
			});
		}

		const node = tryExec("node -v");
		snapshot.node = node.out;

		// 检查 Node.js 版本兼容性
		const nodeCompat = checkNodeVersionCompatibility();
		snapshot.nodeVersion = nodeCompat.version;
		snapshot.nodeCompatible = nodeCompat.ok;
		if (!nodeCompat.ok) {
			blockers.push({
				id: "node_version_incompatible",
				severity: "blocker",
				messageZh: nodeCompat.message || "Node.js 版本不兼容",
				resolution: `升级 Node.js 到 ${nodeCompat.required}，或使用 nvm/fnm 切换版本`,
				waitPhrase: "版本已切换",
			});
		}

		// 检查 ts-node 可用性
		const tsNodeCheck = checkTsNodeAvailable();
		snapshot.tsNode = tsNodeCheck.ok ? tsNodeCheck.version : "missing";
		if (!tsNodeCheck.ok) {
			blockers.push({
				id: "ts_node_missing",
				severity: "blocker",
				messageZh: tsNodeCheck.message || "ts-node 未安装",
				resolution: "运行 yarn add -D ts-node 或 npm install -g ts-node",
				waitPhrase: "安装完毕",
			});
		}

		// 检查 wdio 可用性
		const wdioCheck = checkWdioAvailable();
		snapshot.wdio = wdioCheck.ok ? wdioCheck.version : "missing";
		if (!wdioCheck.ok) {
			blockers.push({
				id: "wdio_missing",
				severity: "blocker",
				messageZh: wdioCheck.message || "wdio 未安装",
				resolution: "运行 bash e2e-device/scripts/ensure-host-deps.sh wdio",
				waitPhrase: "安装完毕",
			});
		}

		// 检查依赖版本冲突
		const depConflicts = checkDependencyConflicts();
		snapshot.dependencyConflicts = depConflicts;
		for (const conflict of depConflicts) {
			blockers.push({
				id: `dep_conflict_${conflict.package.replace(/[@\/]/g, "_")}`,
				severity: "warn",
				messageZh: `${conflict.package}: ${conflict.issue}`,
				resolution: conflict.resolution,
				waitPhrase: "已更新",
			});
		}

		// Auto-detect app config
		const appJson = loadAppJson();
		if (!appJson) {
			const adbCheck = checkAdbAvailable();
			if (adbCheck.ok) {
				const foreground = detectForegroundApp();
				if (foreground) {
					const launchActivity = detectLaunchActivity(foreground.package);
					snapshot.detectedApp = {
						package: foreground.package,
						activity: launchActivity || foreground.activity,
					};
					blockers.push({
						id: "app_config_missing",
						severity: "blocker",
						messageZh: `检测到 App: ${foreground.package}，但未保存到配置`,
						resolution: "请确认后保存到 .e2e-local.json 的 app 字段",
						waitPhrase: "已配置",
					});
				} else {
					blockers.push({
						id: "app_config_missing",
						severity: "blocker",
						messageZh: "未检测到 App 配置，请在手机上打开 App",
						resolution: "在手机上打开 App 后重试，或手动设置 E2E_APP_PACKAGE/E2E_APP_ACTIVITY",
						waitPhrase: "App 已打开",
					});
				}
			} else {
				blockers.push({
					id: "app_config_missing",
					severity: "blocker",
					messageZh: adbCheck.error || "ADB 不可用",
					resolution: "请连接 USB 设备并开启调试，或手动设置 E2E_APP_PACKAGE/E2E_APP_ACTIVITY",
					waitPhrase: "已连接",
				});
			}
		}

		applyCredentials();
		clearManifestCache();
		let pageOrigin = process.env.E2E_H5_ORIGIN || process.env.E2E_PAGE_ORIGIN || "";
		let apiOrigin = process.env.E2E_API_ORIGIN || "";
		
		// 从 .e2e-local.json 读取配置
		const local = readLocalConfig();
		pageOrigin = pageOrigin || local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin || "";
		
		try {
			const m = loadProjectManifest();
			pageOrigin = pageOrigin || m.hybrid.network.pageOrigin || "";
			apiOrigin = apiOrigin || m.hybrid.network.apiOrigin || "";
			if (
				readLocalConfig()?.env?.E2E_H5_ORIGIN &&
				m.hybrid.network.pageOrigin &&
				readLocalConfig()!.env.E2E_H5_ORIGIN !== m.hybrid.network.pageOrigin
			) {
				blockers.push({
					id: "page_origin_stale",
					severity: "warn",
					messageZh: "本地 E2E_H5_ORIGIN 与 manifest 不一致",
					resolution: "重新 discover-project 或更新 .e2e-local.json",
					waitPhrase: null,
				});
			}
		} catch {
			// manifest optional during first probe
		}

		if (!pageOrigin) {
			questions.push({
				id: "E2E_PAGE_ORIGIN",
				prompt:
					"未发现 H5 页面 CDN 域名。请输入要测试的 pageOrigin（如 https://xrk-c2b.guazi-cloud.com）",
				required: true,
			});
		}

		if (
			!apiOrigin &&
			fs.existsSync(paths.projectJson())
		) {
			try {
				const m = loadProjectManifest();
				if (m.hybrid.network.apiOriginConfidence === "low") {
					questions.push({
						id: "E2E_API_ORIGIN",
						prompt: "API 域名置信度较低，可选填写 E2E_API_ORIGIN",
						required: false,
					});
				}
			} catch {
				// ignore
			}
		}

		if (!hasCredentials()) {
			questions.push({
				id: "E2E_CREDENTIALS",
				prompt:
					"缺少登录凭据。请设置 E2E_ACCOUNT/E2E_PASSWORD 或创建 e2e-device/config/credentials.ts",
				required: true,
			});
		}

		const l2 = checkL2Readiness({ runL2: false });
		for (const b of l2.blockers) {
			if (b.severity === "warn") {
				blockers.push({ ...b, waitPhrase: null });
			}
		}
	}

	// 首跑问卷顺序：先 pageOrigin 再凭据（Agent 侧约定；questions 数组已按此顺序 push）

	const requiredBlockers = blockers.filter((b) => b.severity === "blocker");
	const ok =
		requiredBlockers.length === 0 &&
		questions.filter((q) => q.required).length === 0;

	const probeEnvPatch: Record<string, string> = {};
	if (snapshot.suggestedSerial) {
		probeEnvPatch.E2E_DEVICE_SERIAL = String(snapshot.suggestedSerial);
	}
	const sdkForEnv = resolveAndroidSdkRoot();
	if (sdkForEnv && sdkHasRequiredLayout(sdkForEnv)) {
		probeEnvPatch.ANDROID_HOME = sdkForEnv;
		probeEnvPatch.ANDROID_SDK_ROOT = sdkForEnv;
	}

	writeLocalConfig({
		lastProbeAt: new Date().toISOString(),
		probeSnapshot: { ...snapshot, blockers: blockers.map((b) => b.id) },
		env: probeEnvPatch,
	});

	return { ok, questions, blockers, snapshot };
}
