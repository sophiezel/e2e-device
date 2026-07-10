import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
import { detectVendor } from "../helpers/android-vendor";
import {
	tryExec,
	resolveAndroidSdkRoot,
	sdkHasRequiredLayout,
} from "./env-checks";
import { preflightCheck } from "./preflight-check";
import { detectRunMode } from "./is-first-run";

// ─── Types ───────────────────────────────────────────────────────────────────

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
 * NEW v2: Login state enum derived from foreground Activity analysis.
 */
export type LoginState =
	| "no_device"
	| "launcher"
	| "unknown_app"
	| "login_screen"
	| "main_screen"
	| "webview_active"
	| "app_background";

// ─── Preflight → Blockers Mapping ────────────────────────────────────────────

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
			webview_debug: "WebView 已启用调试",
			permissions: "权限已授予",
			chromedriver_match: "Chromedriver 已匹配",
			page_origin_reachable: "页面可达",
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
			webview_debug: "webview_debug_missing",
			permissions: "permissions_incomplete",
			chromedriver_match: "chromedriver_mismatch",
			page_origin_reachable: "page_origin_unreachable",
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

	const adbCheck = preflight.checks.find((c) => c.id === "adb");
	if (adbCheck?.value) {
		const deviceMatch = adbCheck.value.match(/\((\d+) device\)/);
		snapshot.deviceCount = deviceMatch ? parseInt(deviceMatch[1]) : 0;
	}

	return { blockers, snapshot };
}

// ─── NEW v2: Device Info Detection ──────────────────────────────────────────

/**
 * Detect comprehensive device information: manufacturer, model,
 * Android version, WebView version, SDK level.
 */
function detectDeviceInfo(): Record<string, unknown> {
	try {
		const vendor = detectVendor();
		return {
			manufacturer: vendor.manufacturer,
			model: vendor.model,
			androidVersion: vendor.androidVersion,
			sdkInt: vendor.sdkInt,
			webViewPackage: vendor.webViewPackage,
			webViewVersion: vendor.webViewVersion,
		};
	} catch {
		return { error: "Device not connected" };
	}
}

// ─── NEW v2: Login State Detection ──────────────────────────────────────────

/**
 * Analyze the foreground Activity on the device to determine login state.
 * This is used to decide whether to prompt for credentials.
 */
function detectLoginState(pkg: string): LoginState {
	if (!pkg) return "no_device";

	const tryAdb = (args: string[]): string => {
		try {
			return execFileSync("adb", ["shell", ...args], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		} catch {
			return "";
		}
	};

	// Get current foreground activity
	const focus = tryAdb(["dumpsys", "window", "windows"]);
	const focusMatch = focus.match(/mCurrentFocus=.*\{[^}]*\s+([\w.]+\/[\w.]+)/);
	if (!focusMatch) {
		// Try alternative: activity stack top
		const task = tryAdb(["dumpsys", "activity", "activities"]);
		const taskMatch = task.match(/topResumedActivity=.*\{[^}]*\s+([\w.]+\/[\w.]+)/) ||
			task.match(/ResumedActivity:\s*\{\S+\s+\S+\s+([\w.]+\/[\w.]+)/);
		if (!taskMatch) return "app_background";
		const activity = taskMatch[1];
		return analyzeActivity(activity, pkg);
	}

	const activity = focusMatch[1];
	return analyzeActivity(activity, pkg);
}

/**
 * Classify the foreground Activity string into a login state.
 */
function analyzeActivity(activity: string, targetPkg: string): LoginState {
	if (activity.includes("com.android.launcher")) return "launcher";
	if (!activity.startsWith(targetPkg)) return "unknown_app";

	// Login screen patterns (language-agnostic)
	const loginPatterns = /login|signin|passport|auth|verify|credential|登[录陸]|验证/gi;
	if (loginPatterns.test(activity)) return "login_screen";

	// WebView active patterns
	if (/webview|WebView/i.test(activity)) return "webview_active";

	// Main / home screen patterns
	const mainPatterns = /main|home|launch|splash|portal/gi;
	if (mainPatterns.test(activity)) return "main_screen";

	return "main_screen";
}

// ─── NEW v2: Chromedriver Version Match ─────────────────────────────────────

/**
 * Check if chromedriver major version matches the device WebView version.
 */
function detectChromedriverMatch(vendorInfo: Record<string, unknown>): {
	matched: boolean;
	webViewMajor?: number;
	cdMajor?: number;
	cdPath?: string;
} {
	const webViewVersion = vendorInfo.webViewVersion as string | undefined;
	if (!webViewVersion) return { matched: true }; // can't verify, assume ok

	const webViewMajor = parseInt(webViewVersion.split(".")[0], 10);
	if (!webViewMajor) return { matched: true };

	const cdEnv = process.env.E2E_CHROMEDRIVER_PATH;
	if (cdEnv && fs.existsSync(cdEnv)) {
		try {
			const out = execFileSync(cdEnv, ["--version"], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const m = out.match(/ChromeDriver (\d+)/);
			if (m) {
				return { matched: parseInt(m[1], 10) === webViewMajor, webViewMajor, cdMajor: parseInt(m[1], 10), cdPath: cdEnv };
			}
		} catch { /* skip */ }
	}

	// Check system chromedriver
	try {
		const out = execFileSync("chromedriver", ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const m = out.match(/ChromeDriver (\d+)/);
		if (m) {
			return { matched: parseInt(m[1], 10) === webViewMajor, webViewMajor, cdMajor: parseInt(m[1], 10), cdPath: "system" };
		}
	} catch { /* not in PATH */ }

	return { matched: false, webViewMajor };
}

// ─── Main Probe Function ────────────────────────────────────────────────────

export function probeEnv(opts: { adbOnly?: boolean } = {}): ProbeResult {
	const questions: ProbeResult["questions"] = [];

	// Reuse preflight-check for infrastructure checks
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

	// ── NEW v2: Device info snapshot ───────────────────────────────────────
	const deviceInfo = detectDeviceInfo();
	snapshot.deviceInfo = deviceInfo;

	// ── NEW v2: Chromedriver match detection ───────────────────────────────
	const cdMatch = detectChromedriverMatch(deviceInfo);
	snapshot.chromedriverMatch = cdMatch;
	if (!cdMatch.matched) {
		blockers.push({
			id: "chromedriver_mismatch",
			severity: "warn",
			messageZh: `chromedriver 与设备 WebView (Chrome ${cdMatch.webViewMajor}) 版本不匹配`,
			resolution:
				"preflight-check 将自动下载匹配的 chromedriver，或手动设置 E2E_CHROMEDRIVER_PATH",
			waitPhrase: null,
		});
	}

	// ── App auto-detect ───────────────────────────────────────────────────
	const appJson = loadAppJson();
	let detectedPkg = "";
	if (!appJson) {
		const adbCheck = tryExec("command -v adb");
		if (adbCheck.ok) {
			const foreground = detectForegroundApp();
			if (foreground) {
				const launchActivity = detectLaunchActivity(foreground.package);
				detectedPkg = foreground.package;
				snapshot.detectedApp = {
					package: foreground.package,
					activity: launchActivity || foreground.activity,
				};
				const isLauncher = /\.launcher/i.test(foreground.package);
				if (!isLauncher) {
					saveAppJson({
						package: foreground.package,
						activity: launchActivity || foreground.activity,
					});
				}
			}
		}
	} else {
		detectedPkg = appJson.package || "";
	}
	const activePkg = detectedPkg || readLocalConfig()?.app?.android?.appPackage || "";

	// ── NEW v2: Login state detection ─────────────────────────────────────
	const loginState = detectLoginState(activePkg);
	snapshot.loginState = loginState;
	snapshot.loginStateLastChecked = new Date().toISOString();

	// ── Credentials, pageOrigin, apiOrigin ────────────────────────────────
	applyCredentials();
	clearManifestCache();

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
		if (process.env.E2E_DEBUG) console.debug("[probe] manifest load failed:", e);
	}

	// ── NEW v2: Questions based on detected state (no hardcoded domains) ──

	if (!pageOrigin) {
		questions.push({
			id: "E2E_PAGE_ORIGIN",
			prompt:
				"未发现 H5 页面 CDN 域名。请输入要测试的 pageOrigin（如 https://h5.example.com）",
			required: true,
		});
	}

	// v2: Credentials question only when device shows login_screen or unknown_app
	if (!hasCredentials() && (loginState === "login_screen" || loginState === "unknown_app" || loginState === "no_device")) {
		questions.push({
			id: "E2E_CREDENTIALS",
			prompt:
				"缺少登录凭据（设备可能处于登录页面）。请设置 E2E_ACCOUNT/E2E_PASSWORD 或创建 e2e-device/config/credentials.ts",
			required: loginState === "login_screen",
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

	// ── NEW v2: Device PIN question (ask if device may have lock screen) ──
	if (!process.env.E2E_DEVICE_PIN) {
		// Check if device has lock screen (dumpsys trust)
		try {
			const trust = execFileSync("adb", ["shell", "dumpsys", "trust"], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const hasLockScreen = !/deviceLocked=false/i.test(trust) && /hasPin|hasPattern|hasPassword/i.test(trust);
			snapshot.deviceHasLockScreen = hasLockScreen;

			if (hasLockScreen) {
				questions.push({
					id: "E2E_DEVICE_PIN",
					prompt:
						"设备可能设置了锁屏密码/PIN/图案。请输入锁屏 PIN（仅存环境变量，测试结束后即失效）：\n" +
						"（若无锁屏或已解锁，请忽略此提示）",
					required: false,
				});
			}
		} catch {
			// Fallback: always ask (non-intrusive)
			questions.push({
				id: "E2E_DEVICE_PIN",
				prompt:
					"设备可能有锁屏密码。请输入锁屏 PIN（仅存环境变量，测试结束后即失效）：\n" +
					"（若为图案锁或无锁屏，请忽略此提示）",
				required: false,
			});
		}
	}

	const l2 = checkL2Readiness({ runL2: false });
	for (const b of l2.blockers) {
		if (b.severity === "warn") {
			blockers.push({ ...b, waitPhrase: null });
		}
	}

	// ── Coverage config probe ─────────────────────────────────────────────
	const coverageInfo = probeProjectCoverageConfig();
	snapshot.coverageSupport = coverageInfo.detected ? "detected" : "not_detected";
	if (coverageInfo.detected) snapshot.coverageDetails = coverageInfo;
	if (!coverageInfo.detected) {
		blockers.push({
			id: "coverage-not-detected",
			severity: "warn",
			messageZh:
				"未检测到 Istanbul 覆盖率注入（ONLINE H5 通常无 window.__coverage__）。" +
				"报告将省略 coverage-raw.json 路径。",
			resolution:
				"如需覆盖率：使用非 ONLINE 构建（如 TEST/STAGE）或启用 babel-plugin-istanbul / vite-plugin-istanbul。",
			waitPhrase: null,
		});
	}

	return finalizeProbe(blockers, questions, snapshot);
}

// ─── Coverage Config Detection ───────────────────────────────────────────────

function probeProjectCoverageConfig(): {
	detected: boolean;
	plugin?: string;
	files?: string[];
} {
	const root = process.cwd();
	const detected: string[] = [];

	try {
		const pkgPath = path.resolve(root, "package.json");
		if (fs.existsSync(pkgPath)) {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
			const deps = {
				...(pkg.dependencies as Record<string, string> || {}),
				...(pkg.devDependencies as Record<string, string> || {}),
			};
			const coverageDeps = [
				"babel-plugin-istanbul", "vite-plugin-istanbul", "nyc",
				"istanbul-lib-instrument", "@cypress/code-coverage",
			];
			for (const dep of coverageDeps) {
				if (deps[dep]) detected.push(`package.json → ${dep}@${deps[dep]}`);
			}
			const scripts = pkg.scripts as Record<string, string> || {};
			for (const [name, cmd] of Object.entries(scripts)) {
				if (typeof cmd === "string" && /\b(coverage|istanbul|nyc)\b/i.test(cmd)) {
					detected.push(`package.json → script "${name}": ${cmd.substring(0, 80)}`);
				}
			}
		}
	} catch { /* ignore */ }

	const babelFiles = [".babelrc", ".babelrc.js", "babel.config.js", "babel.config.cjs", "babel.config.mjs"];
	for (const f of babelFiles) {
		try {
			const fp = path.resolve(root, f);
			if (fs.existsSync(fp) && /istanbul/i.test(fs.readFileSync(fp, "utf-8"))) {
				detected.push(`${f} → contains "istanbul"`);
			}
		} catch { /* ignore */ }
	}

	const viteFiles = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];
	for (const f of viteFiles) {
		try {
			const fp = path.resolve(root, f);
			if (fs.existsSync(fp) && /istanbul/i.test(fs.readFileSync(fp, "utf-8"))) {
				detected.push(`${f} → contains "istanbul"`);
			}
		} catch { /* ignore */ }
	}

	const webpackFiles = ["webpack.config.js", "webpack.config.ts", ".webpackrc.js"];
	for (const f of webpackFiles) {
		try {
			const fp = path.resolve(root, f);
			if (fs.existsSync(fp) && /istanbul/i.test(fs.readFileSync(fp, "utf-8"))) {
				detected.push(`${f} → contains "istanbul"`);
			}
		} catch { /* ignore */ }
	}

	return {
		detected: detected.length > 0,
		plugin: detected[0] || undefined,
		files: detected.length > 0 ? detected : undefined,
	};
}

// ─── Finalization ────────────────────────────────────────────────────────────

function finalizeProbe(
	blockers: ProbeBlocker[],
	questions: ProbeResult["questions"],
	snapshot: Record<string, unknown>,
): ProbeResult {
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

/**
 * NEW v2: Output probe result as structured JSON for Agent consumption.
 */
export function probeEnvJson(opts: { adbOnly?: boolean } = {}): string {
	const result = probeEnv(opts);
	return JSON.stringify(result, null, 2);
}

export { detectDeviceInfo, detectLoginState, detectChromedriverMatch };
export type { LoginState as ProbeLoginState };
