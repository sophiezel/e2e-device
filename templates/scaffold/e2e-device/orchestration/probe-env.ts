import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { applyCredentials, hasCredentials } from "../helpers/credentials";
import { readLocalConfig, writeLocalConfig } from "../config/local-config";
import { clearManifestCache, loadProjectManifest } from "../config/project-manifest";
import { checkL2Readiness } from "./l2-readiness";
import { paths } from "./paths";
import {
	loadAppJson,
	detectForegroundApp,
	detectLaunchActivity,
	saveAppJson,
} from "../helpers/android-config";
import {
	tryExec,
	resolveAndroidSdkRoot,
	sdkHasRequiredLayout,
} from "./env-checks";
import { preflightCheck } from "./preflight-check";
import { detectRunMode } from "./is-first-run";

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

/**
 * Map preflight check items to probe blockers.
 * Reuses the comprehensive checks from preflight-check.ts instead of duplicating.
 */
function preflightToBlockers(
	preflight: ReturnType<typeof preflightCheck>,
): { blockers: ProbeBlocker[]; snapshot: Record<string, unknown> } {
	const blockers: ProbeBlocker[] = [];
	const snapshot: Record<string, unknown> = {};

	for (const check of preflight.checks) {
		if (check.status === "pass") {
			snapshot[check.id] = check.value || "ok";
			continue;
		}

		// Map preflight status to blocker
		const severity = check.status === "fail" ? "blocker" : "warn";
		const waitPhraseMap: Record<string, string | null> = {
			node: "版本已切换",
			adb: "已连接",
			android_sdk: "SDK 已配置",
			ts_node: "安装完毕",
			wdio: "安装完毕",
			appium: "安装完毕",
			appium_driver: "安装完毕",
			app_config: "已配置",
			page_origin: null,
		};

		const CHECK_TO_BLOCKER: Record<string, string> = {
			android_sdk: "android_sdk_missing",
			appium: "appium_missing",
			appium_driver: "appium_missing",
			node: "node_version_incompatible",
			ts_node: "ts_node_missing",
			wdio: "wdio_missing",
			app_config: "app_config_missing",
			page_origin: "preflight_page_origin",
		};

		let blockerId: string;
		if (check.id === "adb" && check.message?.includes("未检测到已连接")) {
			blockerId = "adb_no_device";
		} else if (check.id === "adb" && check.message?.includes("未授权")) {
			blockerId = "adb_unauthorized";
		} else if (check.id === "android_sdk" && check.message?.includes("不完整")) {
			blockerId = "android_sdk_incomplete";
		} else {
			blockerId = CHECK_TO_BLOCKER[check.id] ?? `preflight_${check.id}`;
		}

		blockers.push({
			id: blockerId,
			severity,
			messageZh: check.message || `${check.name} 检查未通过`,
			resolution: check.resolution || `请修复 ${check.name}`,
			waitPhrase: waitPhraseMap[check.id] ?? null,
		});
	}

	// Extract snapshot values from preflight
	const adbCheck = preflight.checks.find((c) => c.id === "adb");
	if (adbCheck?.value) {
		const deviceMatch = adbCheck.value.match(/\((\d+) device\)/);
		snapshot.deviceCount = deviceMatch ? parseInt(deviceMatch[1]) : 0;
	}

	return { blockers, snapshot };
}

export function probeEnv(opts: { adbOnly?: boolean } = {}): ProbeResult {
	const questions: ProbeResult["questions"] = [];

	// --- Reuse preflight-check for all infrastructure checks ---
	const preflight = preflightCheck();
	const { blockers, snapshot } = preflightToBlockers(preflight);

	// Enrich snapshot with adb details
	const adbDevices = tryExec("adb devices");
	if (adbDevices.ok) {
		snapshot.adb = adbDevices.out;
		const lines = adbDevices.out.split("\n").filter((l) => l.includes("\t"));
		const devices = lines.filter((l) => l.includes("\tdevice"));
		snapshot.deviceCount = devices.length;
		if (devices.length > 0) {
			snapshot.suggestedSerial = devices[0].split("\t")[0];
		}
		if (devices.length > 1) {
			questions.push({
				id: "E2E_DEVICE_SERIAL",
				prompt: "检测到多台 USB 设备，请输入要使用的设备序列号：",
				required: true,
			});
		}
	}

	if (opts.adbOnly) {
		return finalizeProbe(blockers, questions, snapshot);
	}

	// --- Probe-specific: App auto-detect ---
	const appJson = loadAppJson();
	if (!appJson) {
		const adbCheck = tryExec("command -v adb");
		if (adbCheck.ok) {
			const foreground = detectForegroundApp();
			if (foreground) {
				const launchActivity = detectLaunchActivity(foreground.package);
				snapshot.detectedApp = {
					package: foreground.package,
					activity: launchActivity || foreground.activity,
				};
				// Auto-persist detected app config (skip known launcher packages)
				const isLauncher = /\.launcher/i.test(foreground.package);
				if (!isLauncher) {
					saveAppJson({
						package: foreground.package,
						activity: launchActivity || foreground.activity,
					});
				}
			}
		}
	}

	// --- Probe-specific: credentials, pageOrigin, apiOrigin ---
	applyCredentials();
	clearManifestCache();

	// Cache local config (read once)
	const local = readLocalConfig();
	let pageOrigin = process.env.E2E_H5_ORIGIN || process.env.E2E_PAGE_ORIGIN || "";
	let apiOrigin = process.env.E2E_API_ORIGIN || "";
	pageOrigin = pageOrigin || local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin || "";

	try {
		const m = loadProjectManifest();
		pageOrigin = pageOrigin || m.hybrid.network.pageOrigin || "";
		apiOrigin = apiOrigin || m.hybrid.network.apiOrigin || "";
		if (
			local?.env?.E2E_H5_ORIGIN &&
			m.hybrid.network.pageOrigin &&
			local.env.E2E_H5_ORIGIN !== m.hybrid.network.pageOrigin
		) {
			blockers.push({
				id: "page_origin_stale",
				severity: "warn",
				messageZh: "本地 E2E_H5_ORIGIN 与 manifest 不一致",
				resolution: "重新 discover-project 或更新 .e2e-local.json",
				waitPhrase: null,
			});
		}
	} catch (e) {
		// manifest optional during first probe
		if (process.env.E2E_DEBUG) console.debug("[probe] manifest load failed:", e);
	}

	if (!pageOrigin) {
		questions.push({
			id: "E2E_PAGE_ORIGIN",
			prompt:
				"未发现 H5 页面 CDN 域名。请输入要测试的 pageOrigin（如 https://h5.example.com）",
			required: true,
		});
	}

	if (!apiOrigin && fs.existsSync(paths.projectJson())) {
		try {
			const m = loadProjectManifest();
			if (m.hybrid.network.apiOriginConfidence === "low") {
				questions.push({
					id: "E2E_API_ORIGIN",
					prompt: "API 域名置信度较低，可选填写 E2E_API_ORIGIN",
					required: false,
				});
			}
		} catch (e) {
			if (process.env.E2E_DEBUG) console.debug("[probe] apiOrigin check failed:", e);
		}
	}

	// --- Credentials: 先探测设备登录态，再决定是否必填 ---
	if (!hasCredentials()) {
		const loginState = probeAppLoginState();
		snapshot.appLoginState = loginState;

		if (loginState === "login_screen") {
			// 设备明确在登录页 → 必须提供凭据
			questions.push({
				id: "E2E_CREDENTIALS",
				prompt:
					"设备当前在登录页，需要登录凭据才能继续测试。\n请设置 E2E_ACCOUNT/E2E_PASSWORD（仅存环境变量，不落盘）",
				required: true,
			});
		} else if (loginState === "likely_logged_in") {
			// App 不在登录页 → 业务 case 若遇鉴权失败再交互获取
			questions.push({
				id: "E2E_CREDENTIALS",
				prompt:
					"App 可能已登录，凭据非必须。若测试过程中遇到需要登录的 case 会提示你输入（30s 超时自动跳过该 case）。\n如需预先提供，请设置 E2E_ACCOUNT/E2E_PASSWORD",
				required: false,
			});
		} else {
			// 未检测到 App 或无法判断
			questions.push({
				id: "E2E_CREDENTIALS",
				prompt:
					"缺少登录凭据。如 App 已登录则可跳过；否则请设置 E2E_ACCOUNT/E2E_PASSWORD（仅存环境变量，不落盘）",
				required: false,
			});
		}
	}

	// Ask for device PIN if screen lock is likely
	if (!process.env.E2E_DEVICE_PIN) {
		questions.push({
			id: "E2E_DEVICE_PIN",
			prompt:
				"设备可能有锁屏密码。请输入锁屏 PIN（仅存环境变量，测试结束后即失效）：\n" +
				"（若为图案锁或无锁屏，请忽略此提示）",
			required: false,
		});
	}

	const l2 = checkL2Readiness({ runL2: false });
	for (const b of l2.blockers) {
		if (b.severity === "warn") {
			blockers.push({ ...b, waitPhrase: null });
		}
	}

	// --- Probe: 检查项目构建配置是否引入了 Istanbul 覆盖率插件 ---
	const coverageInfo = probeProjectCoverageConfig();
	if (coverageInfo.detected) {
		snapshot.coverageSupport = "detected";
		snapshot.coverageDetails = coverageInfo;
	} else {
		snapshot.coverageSupport = "not_detected";
	}

	return finalizeProbe(blockers, questions, snapshot);
}

/**
 * 探测项目构建配置中是否已引入 Istanbul 覆盖率插件。
 * 检查 package.json 的 devDependencies / dependencies 及构建配置文件。
 */
function probeProjectCoverageConfig(): {
	detected: boolean;
	plugin?: string;
	files?: string[];
} {
	const root = process.cwd();
	const detected: string[] = [];

	// 1. 检查 package.json 依赖
	try {
		const pkgPath = path.resolve(root, "package.json");
		if (fs.existsSync(pkgPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
			const deps = { ...(pkg.dependencies as Record<string, string> || {}), ...(pkg.devDependencies as Record<string, string> || {}) };
			const coverageDeps = ["babel-plugin-istanbul", "vite-plugin-istanbul", "nyc", "istanbul-lib-instrument", "@cypress/code-coverage"];
			for (const dep of coverageDeps) {
				if (deps[dep]) {
					detected.push(`package.json → ${dep}@${deps[dep]}`);
				}
			}
			// Check scripts for coverage-related commands
			const scripts = pkg.scripts as Record<string, string> || {};
			for (const [name, cmd] of Object.entries(scripts)) {
				if (typeof cmd === "string" && /\b(coverage|istanbul|nyc)\b/i.test(cmd)) {
					detected.push(`package.json → script "${name}": ${cmd.substring(0, 80)}`);
				}
			}
		}
	} catch { /* ignore */ }

	// 2. 检查 babel 配置
	const babelFiles = [".babelrc", ".babelrc.js", "babel.config.js", "babel.config.cjs", "babel.config.mjs"];
	for (const f of babelFiles) {
		try {
			const fp = path.resolve(root, f);
			if (fs.existsSync(fp)) {
				const content = fs.readFileSync(fp, "utf-8");
				if (/istanbul/i.test(content)) {
					detected.push(`${f} → contains "istanbul"`);
				}
			}
		} catch { /* ignore */ }
	}

	// 3. 检查 vite 配置
	const viteFiles = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];
	for (const f of viteFiles) {
		try {
			const fp = path.resolve(root, f);
			if (fs.existsSync(fp)) {
				const content = fs.readFileSync(fp, "utf-8");
				if (/istanbul/i.test(content)) {
					detected.push(`${f} → contains "istanbul"`);
				}
			}
		} catch { /* ignore */ }
	}

	// 4. 检查 webpack 配置
	const webpackFiles = ["webpack.config.js", "webpack.config.ts", ".webpackrc.js"];
	for (const f of webpackFiles) {
		try {
			const fp = path.resolve(root, f);
			if (fs.existsSync(fp)) {
				const content = fs.readFileSync(fp, "utf-8");
				if (/istanbul/i.test(content)) {
					detected.push(`${f} → contains "istanbul"`);
				}
			}
		} catch { /* ignore */ }
	}

	return {
		detected: detected.length > 0,
		plugin: detected[0] || undefined,
		files: detected.length > 0 ? detected : undefined,
	};
}

/**
 * 通过 adb 探测设备上 App 的登录态。
 * 不依赖 Appium/WebDriver session —— 纯 adb 命令。
 *
 * @returns "login_screen" | "likely_logged_in" | "unknown"
 */
function probeAppLoginState(): "login_screen" | "likely_logged_in" | "unknown" {
	try {
		// 1. 获取当前前台 Activity
		const dumpsys = execSync("adb shell dumpsys window windows 2>/dev/null", {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// 提取 mCurrentFocus 行: mCurrentFocus=Window{xxx com.example/.LoginActivity}
		const focusMatch = dumpsys.match(/mCurrentFocus=.*?\{.*?\s+(\S+)\}/);
		const currentFocus = focusMatch?.[1] || "";

		// 2. 匹配登录相关 Activity 关键词
		const loginActivityPatterns = [
			/\.LoginActivity/i,
			/\.LoginView/i,
			/\.SignInActivity/i,
			/\.AuthActivity/i,
			/\.PassportActivity/i,
			/\.AccountActivity/i,
			/login/i,
			/Login/i,
			/SignIn/i,
		];

		const isLoginActivity = loginActivityPatterns.some((p) =>
			p.test(currentFocus),
		);

		if (isLoginActivity) {
			return "login_screen";
		}

		// 3. 如果前台 Activity 不含登录特征，且有明确 App 包名 → 可能已登录
		if (currentFocus && !/launcher/i.test(currentFocus) && !/systemui/i.test(currentFocus)) {
			return "likely_logged_in";
		}

		// 4. 兜底：检查是否有 appPackage 配置
		const appJson = loadAppJson();
		if (appJson?.package) {
			// 检查 App 进程是否在运行
			const ps = execSync("adb shell pidof " + appJson.package + " 2>/dev/null", {
				encoding: "utf-8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (ps.trim()) {
				return "likely_logged_in"; // App 进程存在且不在登录页
			}
		}

		return "unknown";
	} catch {
		return "unknown";
	}
}

function finalizeProbe(
	blockers: ProbeBlocker[],
	questions: ProbeResult["questions"],
	snapshot: Record<string, unknown>,
): ProbeResult {
	// Second run: skip first-run-only questions (keep auth_recovery and page_origin)
	if (!detectRunMode().isFirstRun) {
		questions = questions.filter(
			(q) => q.id === "auth_recovery" || q.id === "page_origin_unknown",
		);
	}

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
	// Persist pageOrigin from env var or manifest for subsequent runs
	const pageOrigin = process.env.E2E_PAGE_ORIGIN || process.env.E2E_H5_ORIGIN || "";
	if (pageOrigin) {
		probeEnvPatch.E2E_PAGE_ORIGIN = pageOrigin;
	}

	writeLocalConfig({
		lastProbeAt: new Date().toISOString(),
		probeSnapshot: { ...snapshot, blockers: blockers.map((b) => b.id) },
		env: probeEnvPatch,
	});

	return { ok, questions, blockers, snapshot };
}
