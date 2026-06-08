import fs from "node:fs";
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
				"未发现 H5 页面 CDN 域名。请输入要测试的 pageOrigin（如 https://xrk-c2b.guazi-cloud.com）",
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

	return finalizeProbe(blockers, questions, snapshot);
}

function finalizeProbe(
	blockers: ProbeBlocker[],
	questions: ProbeResult["questions"],
	snapshot: Record<string, unknown>,
): ProbeResult {
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
