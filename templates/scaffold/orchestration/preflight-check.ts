import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot, e2eDeviceRoot } from "./paths";
import { readLocalConfig, writeLocalConfig } from "../config/local-config";
import { detectVendor, classifyVendor } from "../helpers/android-vendor";
import {
	tryExec,
	sdkHasRequiredLayout,
	resolveAndroidSdkRoot,
	checkNodeVersionCompat,
	checkTsNodeAvailable,
	checkWdioAvailable,
} from "./env-checks";

export interface CheckItem {
	id: string;
	name: string;
	category: "system" | "skill" | "project";
	status: "pass" | "fail" | "warn" | "auto_fixed";
	value?: string;
	message?: string;
	resolution?: string;
	autoFixable?: boolean;
	autoFixCommand?: string;
	needsUserInput?: boolean;
	inputPrompt?: string;
}

export interface PreflightResult {
	checks: CheckItem[];
	summary: {
		total: number;
		pass: number;
		fail: number;
		warn: number;
		autoFixed: number;
	};
	canProceed: boolean;
	needsUserAction: boolean;
	userActions: Array<{
		checkId: string;
		type: "confirm_install" | "provide_path" | "manual_fix";
		prompt: string;
		command?: string;
	}>;
}

function skillRoot(): string {
	return (
		process.env.E2E_DEVICE_SKILL_ROOT ||
		path.join(process.env.HOME || "", ".agents", "skills", "e2e-device")
	);
}

// ============ Layer 1: System Checks ============

function checkNodeVersion(): CheckItem {
	const result = checkNodeVersionCompat();
	if (!result.ok && result.version === "unknown") {
		return {
			id: "node",
			name: "Node.js",
			category: "system",
			status: "fail",
			message: "Node.js 未安装",
			resolution: "安装 Node.js: https://nodejs.org/",
		};
	}

	return {
		id: "node",
		name: "Node.js",
		category: "system",
		status: result.ok ? "pass" : "warn",
		value: result.version,
		message: result.ok ? undefined : `版本可能与 Appium 3.x 不兼容`,
		resolution: result.ok ? undefined : "fnm install 22.19.0 && fnm use 22.19.0",
	};
}

function checkAdb(): CheckItem {
	const result = tryExec("command -v adb");
	if (!result.ok) {
		return {
			id: "adb",
			name: "adb",
			category: "system",
			status: "fail",
			message: "adb 未安装",
			resolution: "brew install android-platform-tools",
			autoFixable: true,
			autoFixCommand: "brew install android-platform-tools",
		};
	}

	const devices = tryExec("adb devices");
	const lines = devices.out.split("\n").filter((l) => l.includes("\tdevice"));
	if (lines.length === 0) {
		return {
			id: "adb",
			name: "adb",
			category: "system",
			status: "warn",
			value: result.out.split("\n")[0],
			message: "未检测到已连接设备",
			resolution: "插入真机并开启 USB 调试",
		};
	}

	return {
		id: "adb",
		name: "adb",
		category: "system",
		status: "pass",
		value: `${result.out.split("\n")[0]} (${lines.length} device)`,
	};
}

function checkAndroidSdk(): CheckItem {
	const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
	const home = process.env.HOME || "";
	const candidates = [
		sdkRoot,
		path.join(home, "Library", "Android", "sdk"),
		path.join(home, "Android", "Sdk"),
		"/opt/homebrew/share/android-commandlinetools",
	].filter(Boolean);

	let foundRoot: string | null = null;
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && sdkHasRequiredLayout(candidate)) {
			foundRoot = candidate;
			break;
		}
	}

	if (foundRoot) {
		return {
			id: "android_sdk",
			name: "Android SDK",
			category: "system",
			status: "pass",
			value: foundRoot,
		};
	}

	const installedButIncomplete = candidates.find((c) => fs.existsSync(c));
	if (installedButIncomplete) {
		return {
			id: "android_sdk",
			name: "Android SDK",
			category: "system",
			status: "warn",
			value: installedButIncomplete,
			message: "SDK 目录存在但不完整（缺少 platforms 或 build-tools）",
			resolution: `export ANDROID_HOME="${installedButIncomplete}" && bash e2e-device/scripts/install-android-sdk.sh`,
			needsUserInput: true,
			inputPrompt: `检测到 SDK 目录 ${installedButIncomplete}，是否使用此路径？`,
		};
	}

	return {
		id: "android_sdk",
		name: "Android SDK",
		category: "system",
		status: "fail",
		message: "Android SDK 未安装",
		resolution: "brew install --cask android-commandlinetools",
		autoFixable: true,
		autoFixCommand: "brew install --cask android-commandlinetools && bash e2e-device/scripts/install-android-sdk.sh",
	};
}

// Re-export resolveAndroidSdkRoot for saveAndroidSdkPath
const resolveAndroidSdkRootFn = resolveAndroidSdkRoot;
const sdkHasRequiredLayoutFn = sdkHasRequiredLayout;

// ============ Shared Binary Check Helper ============

type PreflightCheck = CheckItem;

function checkBin(options: { name: string; label: string; projectRoot: string; skillRoot: string }): PreflightCheck {
	// Priority: project bin > skill bin > not found
	const projectBin = path.join(options.projectRoot, "node_modules", ".bin", options.name);
	const skillBin = path.join(options.skillRoot, "node_modules", ".bin", options.name);

	if (fs.existsSync(projectBin)) {
		try {
			const version = execFileSync(projectBin, ["--version"], { encoding: "utf-8" }).trim();
			return { id: options.name, name: options.label, category: "skill", status: "pass", message: `${options.label} ${version} (project)`, value: `${version} (project)` };
		} catch {
			return { id: options.name, name: options.label, category: "skill", status: "warn", message: `${options.label} found but version check failed` };
		}
	}
	if (fs.existsSync(skillBin)) {
		try {
			const version = execFileSync(skillBin, ["--version"], { encoding: "utf-8" }).trim();
			return { id: options.name, name: options.label, category: "skill", status: "pass", message: `${options.label} ${version} (skill)`, value: `${version} (skill)` };
		} catch {
			return { id: options.name, name: options.label, category: "skill", status: "warn", message: `${options.label} found but version check failed` };
		}
	}
	return { id: options.name, name: options.label, category: "skill", status: "fail", message: `${options.label} not found in project or skill` };
}

// ============ Layer 2: Skill Checks ============

function checkTsNode(): CheckItem {
	const root = skillRoot();
	const bin = path.join(root, "node_modules", ".bin", "ts-node");

	if (!fs.existsSync(bin)) {
		return {
			id: "ts_node",
			name: "ts-node",
			category: "skill",
			status: "fail",
			message: "ts-node 未安装",
			resolution: `cd "${root}" && npm install`,
			autoFixable: true,
			autoFixCommand: `cd "${root}" && npm install`,
		};
	}

	const version = tryExec(`${bin} --version`);
	return {
		id: "ts_node",
		name: "ts-node",
		category: "skill",
		status: "pass",
		value: version.ok ? version.out : "installed",
	};
}

function checkWdio(): CheckItem {
	return checkBin({ name: "wdio", label: "wdio", projectRoot: repoRoot(), skillRoot: skillRoot() });
}

function checkAppium(): CheckItem {
	return checkBin({ name: "appium", label: "appium", projectRoot: repoRoot(), skillRoot: skillRoot() });
}

function checkAppiumDriver(): CheckItem {
	const home = process.env.HOME || "";

	// Appium 2.x/3.x installs drivers to ~/.appium/node_modules/, NOT project .bin/
	const appiumHomeDriver = path.join(home, ".appium", "node_modules", "appium-uiautomator2-driver");
	if (fs.existsSync(appiumHomeDriver)) {
		try {
			const pkgJson = JSON.parse(fs.readFileSync(path.join(appiumHomeDriver, "package.json"), "utf-8"));
			return {
				id: "appium_driver",
				name: "Appium Driver (uiautomator2)",
				category: "skill",
				status: "pass",
				value: `${pkgJson.version || "installed"} (~/.appium)`,
			};
		} catch {
			return { id: "appium_driver", name: "Appium Driver (uiautomator2)", category: "skill", status: "pass", value: "installed (~/.appium)" };
		}
	}

	// Fallback: run `appium driver list --installed` via project or skill appium binary
	const appiumBinCandidates = [
		path.join(repoRoot(), "node_modules", ".bin", "appium"),
		path.join(skillRoot(), "node_modules", ".bin", "appium"),
	];
	for (const appiumBin of appiumBinCandidates) {
		if (!fs.existsSync(appiumBin)) continue;
		try {
			const output = execFileSync(appiumBin, ["driver", "list", "--installed"], { encoding: "utf-8", timeout: 15000 });
			if (/uiautomator2/i.test(output)) {
				const versionMatch = output.match(/uiautomator2@([\d.]+)/);
				return {
					id: "appium_driver",
					name: "Appium Driver (uiautomator2)",
					category: "skill",
					status: "pass",
					value: versionMatch ? `${versionMatch[1]} (appium)` : "installed (appium)",
				};
			}
		} catch {
			// try next candidate
		}
	}

	return {
		id: "appium_driver",
		name: "Appium Driver (uiautomator2)",
		category: "skill",
		status: "fail",
		message: "Appium Driver (uiautomator2) not found in ~/.appium or appium driver list",
		resolution: "npx appium driver install uiautomator2",
		autoFixable: true,
		autoFixCommand: "npx appium driver install uiautomator2",
	};
}

// ============ Layer 1.5: Vendor & WebView Compatibility ============

function checkVendorAndWebView(): CheckItem {
	try {
		const vendor = detectVendor();
		const clazz = classifyVendor(vendor);
		const webViewInfo = vendor.webViewVersion
			? `${vendor.webViewPackage || "unknown"}@${vendor.webViewVersion}`
			: vendor.webViewPackage || "not detected";

		// Known problematic vendors get a warning
		const problematicVendors = ["huawei", "oppo", "vivo"];
		const status = problematicVendors.includes(clazz) ? "warn" : "pass";

		return {
			id: "vendor_webview",
			name: "Device & WebView",
			category: "system",
			status,
			value: `${vendor.manufacturer}/${vendor.model} Android ${vendor.androidVersion} | WebView: ${webViewInfo}`,
			message: status === "warn"
				? `${vendor.manufacturer} devices may have custom WebView quirks. Vendor workarounds will be applied automatically.`
				: undefined,
		};
	} catch {
		return {
			id: "vendor_webview",
			name: "Device & WebView",
			category: "system",
			status: "warn",
			message: "Could not detect device vendor/WebView info (no device connected?)",
		};
	}
}

// ============ Layer 3: Project Checks ============

function checkAppConfig(): CheckItem {
	const local = readLocalConfig();
	if (local?.app?.android?.appPackage) {
		return {
			id: "app_config",
			name: "App 配置",
			category: "project",
			status: "pass",
			value: local.app.android.appPackage,
		};
	}

	return {
		id: "app_config",
		name: "App 配置",
		category: "project",
		status: "warn",
		message: "未配置 App 包名",
		resolution: "运行 probe-env 或手动配置 .e2e-local.json",
	};
}

function checkPageOrigin(): CheckItem {
	const local = readLocalConfig();
	const origin = local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin;
	if (origin) {
		return {
			id: "page_origin",
			name: "页面 origin",
			category: "project",
			status: "pass",
			value: origin,
		};
	}

	return {
		id: "page_origin",
		name: "页面 origin",
		category: "project",
		status: "warn",
		message: "未配置页面 origin",
		resolution: "运行 probe-env 或手动配置 .e2e-local.json",
	};
}

// ============ Main Function ============

export function preflightCheck(): PreflightResult {
	const checks: CheckItem[] = [];

	// Layer 1: System
	checks.push(checkNodeVersion());
	checks.push(checkAdb());
	checks.push(checkAndroidSdk());
	checks.push(checkVendorAndWebView());

	// Layer 2: Skill
	checks.push(checkTsNode());
	checks.push(checkWdio());
	checks.push(checkAppium());
	checks.push(checkAppiumDriver());

	// Layer 3: Project
	checks.push(checkAppConfig());
	checks.push(checkPageOrigin());

	// Summary
	const summary = {
		total: checks.length,
		pass: checks.filter((c) => c.status === "pass").length,
		fail: checks.filter((c) => c.status === "fail").length,
		warn: checks.filter((c) => c.status === "warn").length,
		autoFixed: checks.filter((c) => c.status === "auto_fixed").length,
	};

	// Collect user actions
	const userActions: PreflightResult["userActions"] = [];
	for (const check of checks) {
		if (check.status === "fail" || check.status === "warn") {
			if (check.autoFixable) {
				userActions.push({
					checkId: check.id,
					type: "confirm_install",
					prompt: `${check.name} 未安装，是否自动安装？`,
					command: check.autoFixCommand,
				});
			} else if (check.needsUserInput) {
				userActions.push({
					checkId: check.id,
					type: "provide_path",
					prompt: check.inputPrompt || `请提供 ${check.name} 的安装路径`,
				});
			} else {
				userActions.push({
					checkId: check.id,
					type: "manual_fix",
					prompt: check.resolution || `请手动修复 ${check.name}`,
				});
			}
		}
	}

	return {
		checks,
		summary,
		canProceed: summary.fail === 0,
		needsUserAction: userActions.length > 0,
		userActions,
	};
}

export function formatPreflightResult(result: PreflightResult): string {
	const lines: string[] = [];

	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push("  E2E 真机测试环境预检");
	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push("");

	// Group by category
	const categories = [
		{ key: "system", name: "Layer 1: 系统级" },
		{ key: "skill", name: "Layer 2: Skill 级（编排依赖）" },
		{ key: "project", name: "Layer 3: 项目级（业务配置）" },
	];

	for (const cat of categories) {
		const items = result.checks.filter((c) => c.category === cat.key);
		if (items.length === 0) continue;

		lines.push(`  ${cat.name}`);
		lines.push("  ─────────────────────────────────────────────────────────────");

		for (const item of items) {
			const icon =
				item.status === "pass"
					? "✅"
					: item.status === "warn"
						? "⚠️"
						: item.status === "auto_fixed"
							? "🔧"
							: "❌";
			const value = item.value ? `: ${item.value}` : "";
			lines.push(`  ${icon} ${item.name}${value}`);
			if (item.message) {
				lines.push(`     └─ ${item.message}`);
			}
			if (item.resolution && item.status !== "pass") {
				lines.push(`     └─ 修复: ${item.resolution}`);
			}
		}

		lines.push("");
	}

	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push(
		`  结果: ${result.summary.pass}/${result.summary.total} 通过 | ${result.summary.fail} 失败 | ${result.summary.warn} 警告`,
	);
	lines.push("═══════════════════════════════════════════════════════════════");

	// User actions
	if (result.needsUserAction) {
		lines.push("");
		lines.push("  需要用户操作：");
		lines.push("  ─────────────────────────────────────────────────────────────");
		for (const action of result.userActions) {
			const icon = action.type === "confirm_install" ? "🔧" : action.type === "provide_path" ? "📁" : "📝";
			lines.push(`  ${icon} ${action.prompt}`);
			if (action.command) {
				lines.push(`     命令: ${action.command}`);
			}
		}
	}

	return lines.join("\n");
}

// ============ Auto Fix Functions ============

export function executeAutoFix(checkId: string): { ok: boolean; message: string } {
	const result = preflightCheck();
	const check = result.checks.find((c) => c.id === checkId);

	if (!check) {
		return { ok: false, message: `检查项 ${checkId} 不存在` };
	}

	if (!check.autoFixable || !check.autoFixCommand) {
		return { ok: false, message: `${check.name} 不支持自动修复` };
	}

	try {
		execSync(check.autoFixCommand, {
			encoding: "utf-8",
			stdio: "inherit",
		});
		return { ok: true, message: `${check.name} 安装成功` };
	} catch (e: unknown) {
		const err = e as { message?: string };
		return { ok: false, message: `安装失败: ${err.message}` };
	}
}

export function saveAndroidSdkPath(sdkPath: string): { ok: boolean; message: string } {
	if (!fs.existsSync(sdkPath)) {
		return { ok: false, message: `路径不存在: ${sdkPath}` };
	}

	if (!sdkHasRequiredLayoutFn(sdkPath)) {
		return { ok: false, message: `SDK 目录不完整（缺少 platforms 或 build-tools）` };
	}

	writeLocalConfig({
		env: {
			ANDROID_HOME: sdkPath,
			ANDROID_SDK_ROOT: sdkPath,
		},
	});

	process.env.ANDROID_HOME = sdkPath;
	process.env.ANDROID_SDK_ROOT = sdkPath;

	return { ok: true, message: `Android SDK 路径已保存: ${sdkPath}` };
}
