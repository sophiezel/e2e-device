import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot, e2eDeviceRoot, e2eHome } from "./paths";
import { readLocalConfig, writeLocalConfig } from "../config/local-config";
import { loadProjectManifest } from "../config/project-manifest";
import { detectVendor, classifyVendor } from "../helpers/android-vendor";
import {
	tryExec,
	sdkHasRequiredLayout,
	resolveAndroidSdkRoot,
	checkNodeVersionCompat,
	checkTsNodeAvailable,
	checkWdioAvailable,
} from "./env-checks";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CheckItem {
	id: string;
	name: string;
	category: "system" | "skill" | "project" | "device";
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
	exitCode: number;
	userActions: Array<{
		checkId: string;
		type: "confirm_install" | "provide_path" | "manual_fix";
		prompt: string;
		command?: string;
	}>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function skillRoot(): string {
	return (
		process.env.E2E_DEVICE_SKILL_ROOT ||
		path.join(process.env.HOME || "", ".agents", "skills", "e2e-device")
	);
}

function getPageOrigin(): string {
	const local = readLocalConfig();
	return process.env.E2E_PAGE_ORIGIN || process.env.E2E_H5_ORIGIN ||
		local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin || "";
}

function getAppPackage(): string {
	const local = readLocalConfig();
	return local?.app?.android?.appPackage || process.env.E2E_APP_PACKAGE || "";
}

// ─── Layer 1: System Checks ──────────────────────────────────────────────────

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
		autoFixCommand:
			"brew install --cask android-commandlinetools && bash e2e-device/scripts/install-android-sdk.sh",
	};
}

// ─── Shared Binary Check Helper ──────────────────────────────────────────────

type PreflightCheck = CheckItem;

function checkBin(options: {
	name: string;
	label: string;
	projectRoot: string;
	skillRoot: string;
}): PreflightCheck {
	const projectBin = path.join(options.projectRoot, "node_modules", ".bin", options.name);
	const skillBin = path.join(options.skillRoot, "node_modules", ".bin", options.name);

	if (fs.existsSync(projectBin)) {
		try {
			const version = execFileSync(projectBin, ["--version"], { encoding: "utf-8" }).trim();
			return {
				id: options.name,
				name: options.label,
				category: "skill",
				status: "pass",
				message: `${options.label} ${version} (project)`,
				value: `${version} (project)`,
			};
		} catch {
			return {
				id: options.name,
				name: options.label,
				category: "skill",
				status: "warn",
				message: `${options.label} found but version check failed`,
			};
		}
	}
	if (fs.existsSync(skillBin)) {
		try {
			const version = execFileSync(skillBin, ["--version"], { encoding: "utf-8" }).trim();
			return {
				id: options.name,
				name: options.label,
				category: "skill",
				status: "pass",
				message: `${options.label} ${version} (skill)`,
				value: `${version} (skill)`,
			};
		} catch {
			return {
				id: options.name,
				name: options.label,
				category: "skill",
				status: "warn",
				message: `${options.label} found but version check failed`,
			};
		}
	}
	return {
		id: options.name,
		name: options.label,
		category: "skill",
		status: "fail",
		message: `${options.label} not found in project or skill`,
	};
}

// ─── Layer 2: Skill Checks ───────────────────────────────────────────────────

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
	const appiumHomeDriver = path.join(home, ".appium", "node_modules", "appium-uiautomator2-driver");
	if (fs.existsSync(appiumHomeDriver)) {
		try {
			const pkgJson = JSON.parse(
				fs.readFileSync(path.join(appiumHomeDriver, "package.json"), "utf-8"),
			);
			return {
				id: "appium_driver",
				name: "Appium Driver (uiautomator2)",
				category: "skill",
				status: validateAppiumDriverCompat(pkgJson.version || "0"),
				value: `${pkgJson.version || "installed"} (~/.appium)`,
				...(validateAppiumDriverCompat(pkgJson.version || "0") === "warn"
					? {
							message: `uiautomator2-driver ${pkgJson.version} may be incompatible with Appium`,
							resolution:
								"npx appium driver uninstall uiautomator2 && npx appium driver install uiautomator2",
							autoFixable: true,
							autoFixCommand:
								"npx appium driver uninstall uiautomator2 && npx appium driver install uiautomator2",
						}
					: {}),
			};
		} catch {
			return {
				id: "appium_driver",
				name: "Appium Driver (uiautomator2)",
				category: "skill",
				status: "pass",
				value: "installed (~/.appium)",
			};
		}
	}

	const appiumBinCandidates = [
		path.join(repoRoot(), "node_modules", ".bin", "appium"),
		path.join(skillRoot(), "node_modules", ".bin", "appium"),
	];
	for (const appiumBin of appiumBinCandidates) {
		if (!fs.existsSync(appiumBin)) continue;
		try {
			const output = execFileSync(appiumBin, ["driver", "list", "--installed"], {
				encoding: "utf-8",
				timeout: 15000,
			});
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

// ─── NEW: Layer 1.5 Device-Level Checks ──────────────────────────────────────

/**
 * NEW v2: Probe if WEBVIEW contexts are available on the device.
 * Checks that the device's WebView implementation supports remote debugging
 * and that Appium can detect WEBVIEW contexts.
 */
function checkWebViewDebug(): CheckItem {
	// Check 1: Can we list contexts via a adb-level probe?
	// Use `adb shell cat /proc/net/unix` to detect chrome_devtools_remote socket
	try {
		const socketCheck = execFileSync("adb", [
			"shell",
			"cat",
			"/proc/net/unix",
		], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const hasDevtoolsSocket = /chrome_devtools_remote/.test(socketCheck);

		// Check 2: Does the Chrome/WebView package exist?
		const pkgCheck = tryExec(
			"adb shell pm list packages | grep -E 'webview|chrome'",
		);
		const webviewPkgs = pkgCheck.ok
			? pkgCheck.out.trim().split("\n").filter(Boolean)
			: [];

		if (!hasDevtoolsSocket && webviewPkgs.length === 0) {
			return {
				id: "webview_debug",
				name: "WebView Debug",
				category: "device",
				status: "fail",
				message: "No WebView debug socket or WebView/Chrome package detected. Hybrid testing requires a debuggable WebView.",
				resolution:
					"Enable Developer Options > WebView implementation > Chrome/Android System WebView, or install 'Android System WebView DevTools'.",
			};
		}

		if (!hasDevtoolsSocket && webviewPkgs.length > 0) {
			return {
				id: "webview_debug",
				name: "WebView Debug",
				category: "device",
				status: "warn",
				value: webviewPkgs.slice(0, 3).join(", "),
				message: "WebView packages found but no active debug socket. Contexts may not appear until a WebView is loaded by the app.",
				resolution: "Start the app and open a WebView, then re-run preflight.",
			};
		}

		return {
			id: "webview_debug",
			name: "WebView Debug",
			category: "device",
			status: "pass",
			value: `debug socket detected, packages: ${webviewPkgs.slice(0, 2).join(", ") || "n/a"}`,
		};
	} catch {
		return {
			id: "webview_debug",
			name: "WebView Debug",
			category: "device",
			status: "warn",
			message: "Could not check WebView debug capability (device may not be connected)",
			resolution: "Ensure device is connected via USB debugging.",
		};
	}
}

/**
 * NEW v2: Verify pageOrigin is reachable from the device itself
 * using `adb shell curl`. This catches firewall/VPN/network issues
 * before test execution.
 */
function checkPageOriginReachability(): CheckItem {
	const origin = getPageOrigin();
	if (!origin) {
		return {
			id: "page_origin_reachable",
			name: "Page Origin Reachable (Device)",
			category: "device",
			status: "warn",
			message: "No pageOrigin configured — cannot verify device reachability. Set E2E_PAGE_ORIGIN.",
			resolution: "`export E2E_PAGE_ORIGIN=https://your-h5-origin` or run probe-env.",
		};
	}

	try {
		// Use adb shell curl to probe the origin from the device network
		const result = execFileSync("adb", [
			"shell",
			"curl",
			"-s",
			"-o", "/dev/null",
			"-w", "%{http_code}",
			"--max-time", "10",
			"--head",
			origin,
		], {
			encoding: "utf-8",
			timeout: 15000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const code = result.trim();

		if (/^[23]\d{2}$/.test(code)) {
			return {
				id: "page_origin_reachable",
				name: "Page Origin Reachable (Device)",
				category: "device",
				status: "pass",
				value: `${origin} → HTTP ${code}`,
			};
		}

		return {
			id: "page_origin_reachable",
			name: "Page Origin Reachable (Device)",
			category: "device",
			status: "warn",
			value: `${origin} → HTTP ${code}`,
			message: `Device received HTTP ${code} for pageOrigin.`,
			resolution: "Ensure the device is on the correct network/VPN to reach the H5 origin.",
		};
	} catch (e) {
		return {
			id: "page_origin_reachable",
			name: "Page Origin Reachable (Device)",
			category: "device",
			status: "fail",
			value: origin,
			message: `adb shell curl failed: ${e instanceof Error ? e.message : String(e)}`,
			resolution: "Ensure device is connected and has network access (WiFi or mobile data).",
		};
	}
}

/**
 * NEW v2: Pre-grant common Android permissions so tests don't hit
 * permission dialogs. Uses `adb shell pm grant` for each permission.
 * Auto-fixable: retries if permissions aren't granted.
 */
function checkPermissions(): CheckItem {
	const pkg = getAppPackage();
	if (!pkg) {
		return {
			id: "permissions",
			name: "App Permissions",
			category: "device",
			status: "warn",
			message: "No app package configured — cannot pre-grant permissions.",
			resolution: "Run probe-env or configure appPackage in .e2e-local.json.",
		};
	}

	const requiredPermissions = [
		"android.permission.INTERNET",
		"android.permission.ACCESS_NETWORK_STATE",
		"android.permission.CAMERA",
		"android.permission.WRITE_EXTERNAL_STORAGE",
		"android.permission.READ_EXTERNAL_STORAGE",
		"android.permission.ACCESS_FINE_LOCATION",
		"android.permission.ACCESS_COARSE_LOCATION",
	];

	const granted: string[] = [];
	const failed: string[] = [];

	for (const perm of requiredPermissions) {
		try {
			execFileSync("adb", ["shell", "pm", "grant", pkg, perm], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			granted.push(perm.split(".").pop()!);
		} catch {
			// Permission may not be declared in manifest — skip
			failed.push(perm.split(".").pop()!);
		}
	}

	if (granted.length === 0) {
		return {
			id: "permissions",
			name: "App Permissions",
			category: "device",
			status: "fail",
			message: "Could not grant any permissions. Is the app installed?",
			resolution: `Install the app on the device: adb install -r <apk>`,
		};
	}

	if (failed.length > 0 && failed.length === requiredPermissions.length) {
		return {
			id: "permissions",
			name: "App Permissions",
			category: "device",
			status: "warn",
			value: `granted: [${granted.join(", ")}] / failed: [${failed.join(", ")}]`,
			message: `Pre-granted ${granted.length}/${requiredPermissions.length} permissions.`,
		};
	}

	return {
		id: "permissions",
		name: "App Permissions",
		category: "device",
		status: "pass",
		value: `granted ${granted.length}/${requiredPermissions.length}`,
	};
}

// ─── Layer 2.5: Vendor & Chromedriver Matching ───────────────────────────────

/**
 * NEW v2: Dedicated chromedriver version match check.
 * Extracted from the old monolithic checkVendorAndWebView into its own
 * focused check with clear auto-fix behavior.
 */
function checkChromedriverMatch(): CheckItem {
	try {
		const vendor = detectVendor();
		if (!vendor.webViewVersion) {
			return {
				id: "chromedriver_match",
				name: "Chromedriver ↔ WebView Version",
				category: "device",
				status: "warn",
				message: "Cannot detect device WebView version — chromedriver match cannot be verified.",
				resolution: "Connect a device with a recognizable WebView implementation.",
			};
		}

		const webViewMajor = parseInt(vendor.webViewVersion.split(".")[0], 10);
		if (!webViewMajor) {
			return {
				id: "chromedriver_match",
				name: "Chromedriver ↔ WebView Version",
				category: "device",
				status: "warn",
				value: vendor.webViewVersion,
				message: "Unable to parse WebView major version.",
			};
		}

		let cdMajor = 0;
		let cdPath = "";

		// Priority 1: E2E_CHROMEDRIVER_PATH env var
		const explicitPath = process.env.E2E_CHROMEDRIVER_PATH;
		if (explicitPath && fs.existsSync(explicitPath)) {
			try {
				const cdOut = execFileSync(explicitPath, ["--version"], {
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				const cdMatch = cdOut.match(/ChromeDriver (\d+)/);
				cdMajor = cdMatch ? parseInt(cdMatch[1], 10) : 0;
				cdPath = explicitPath;
			} catch {
				// explicit path invalid
			}
		}

		// Priority 2: $E2E_HOME/chromedriver/ cache directory
		if (!cdMajor) {
			const cdDir = path.join(e2eHome(), "chromedriver");
			if (fs.existsSync(cdDir)) {
				const entries = fs.readdirSync(cdDir).filter((e) => e.startsWith("chromedriver"));
				for (const e of entries) {
					const bin = path.join(cdDir, e, "chromedriver-mac-arm64", "chromedriver");
					const binAlt = path.join(cdDir, e, "chromedriver");
					const actualBin = fs.existsSync(bin) ? bin : fs.existsSync(binAlt) ? binAlt : null;
					if (!actualBin) continue;
					try {
						const cdOut = execFileSync(actualBin, ["--version"], {
							encoding: "utf-8",
							timeout: 5000,
							stdio: ["pipe", "pipe", "pipe"],
						});
						const cdMatch = cdOut.match(/ChromeDriver (\d+)/);
						const major = cdMatch ? parseInt(cdMatch[1], 10) : 0;
						if (major === webViewMajor) {
							cdMajor = major;
							cdPath = actualBin;
							process.env.E2E_CHROMEDRIVER_PATH = actualBin;
							try { writeLocalConfig({ env: { E2E_CHROMEDRIVER_PATH: actualBin } }); } catch { /* best-effort */ }
							saveChromedriverMeta(actualBin, webViewMajor, vendor.model);
							cleanOldChromedrivers(5);
							break;
						}
					} catch { /* skip invalid */ }
				}
			}
		}

		// Priority 3: system PATH
		if (!cdMajor) {
			try {
				const cdOut = execFileSync("chromedriver", ["--version"], {
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["pipe", "pipe", "pipe"],
				});
				const cdMatch = cdOut.match(/ChromeDriver (\d+)/);
				cdMajor = cdMatch ? parseInt(cdMatch[1], 10) : 0;
				if (cdMajor === webViewMajor) {
					cdPath = "system";
				}
			} catch {
				// not in PATH
			}
		}

		// Priority 4: Auto-download
		if (cdMajor !== webViewMajor) {
			const autoResult = autoDownloadChromedriver(webViewMajor);
			if (autoResult) {
				cdMajor = webViewMajor;
				cdPath = autoResult;
				return {
					id: "chromedriver_match",
					name: "Chromedriver ↔ WebView Version",
					category: "device",
					status: "auto_fixed",
					value: `${vendor.webViewVersion} ↔ chromedriver ${cdMajor}`,
					message: `Auto-downloaded matching chromedriver v${cdMajor} to ${autoResult}`,
				};
			}

			const cdInfo = cdMajor ? `${cdMajor} (${cdPath || "system"})` : "none";
			return {
				id: "chromedriver_match",
				name: "Chromedriver ↔ WebView Version",
				category: "device",
				status: "fail",
				value: `WebView ${webViewMajor} ≠ chromedriver ${cdInfo}`,
				message: `chromedriver version mismatch. Auto-download failed.`,
				resolution:
					`Download matching chromedriver from https://googlechromelabs.github.io/chrome-for-testing/`,
				autoFixable: false,
			};
		}

		return {
			id: "chromedriver_match",
			name: "Chromedriver ↔ WebView Version",
			category: "device",
			status: "pass",
			value: `WebView ${webViewMajor} = chromedriver ${cdMajor} (${cdPath || "system"})`,
		};
	} catch {
		return {
			id: "chromedriver_match",
			name: "Chromedriver ↔ WebView Version",
			category: "device",
			status: "warn",
			message: "Could not verify chromedriver version match (no device connected?)",
		};
	}
}

// ─── Layer 3: Project Checks ─────────────────────────────────────────────────

function checkAppConfig(): CheckItem {
	const local = readLocalConfig();
	const pkg = local?.app?.android?.appPackage;
	if (pkg) {
		return {
			id: "app_config",
			name: "App 配置",
			category: "project",
			status: "pass",
			value: pkg,
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
	const origin = getPageOrigin();

	if (!origin) {
		return {
			id: "page_origin",
			name: "页面 origin",
			category: "project",
			status: "warn",
			message: "未配置页面 origin",
			resolution: "运行 probe-env 或手动配置 .e2e-local.json",
		};
	}

	// Verify URL from host machine
	let fullUrl = origin;
	try {
		const m = loadProjectManifest();
		const pilotDomain = m.pilot?.domain || "";
		const routes = m.pilot?.routes || {};
		const routePath = routes[pilotDomain] || pilotDomain;
		if (routePath) {
			fullUrl = `${origin}/${routePath.replace(/^\//, "")}`;
		}
	} catch { /* manifest optional */ }

	try {
		const out = execFileSync("curl", [
			"-s", "-o", "/dev/null", "-w", "%{http_code}",
			"--max-time", "10", "--head", fullUrl,
		], { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });
		const statusCode = out.trim();

		if (/^[23]\d{2}$/.test(statusCode)) {
			return { id: "page_origin", name: "页面 origin", category: "project", status: "pass", value: origin };
		}
		if (statusCode === "404") {
			return {
				id: "page_origin", name: "页面 origin", category: "project", status: "fail",
				value: origin, message: `URL 返回 404: ${fullUrl}`,
				resolution: "确认正确的 H5 部署地址。",
			};
		}
		return {
			id: "page_origin", name: "页面 origin", category: "project", status: "warn",
			value: origin, message: `URL 返回 ${statusCode}: ${fullUrl}`,
			resolution: "确认 URL 是否正确，H5 应用是否已部署。",
		};
	} catch (e) {
		return {
			id: "page_origin", name: "页面 origin", category: "project", status: "fail",
			value: origin, message: `无法访问 URL: ${fullUrl} (${e instanceof Error ? e.message : String(e)})`,
			resolution: "检查网络连接和 E2E_PAGE_ORIGIN 值。",
		};
	}
}

function checkAppVersion(): CheckItem {
	const local = readLocalConfig();
	const pkg = local?.app?.android?.appPackage || process.env.E2E_APP_PACKAGE || "";
	if (!pkg) {
		return {
			id: "app_version", name: "App 版本匹配", category: "project", status: "warn",
			message: "App 包名未配置，无法检测版本",
		};
	}

	let installedVersion = "";
	try {
		const dumpsys = execFileSync("adb", ["shell", "dumpsys", "package", pkg], {
			encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000,
		});
		const vMatch = dumpsys.match(/versionName=([^\s]+)/);
		if (vMatch) installedVersion = vMatch[1];
	} catch { /* device not connected */ }

	if (!installedVersion) {
		return {
			id: "app_version", name: "App 版本匹配", category: "project", status: "warn",
			message: "未检测到已安装的 App，请确保设备上已安装最新 Debug 构建",
			resolution: "在 Android Studio 中运行 app 或执行 ./gradlew assembleDebug && adb install",
		};
	}

	let gradleVersion = "";
	const root = repoRoot();
	const gradleFiles = ["app/build.gradle", "app/build.gradle.kts", "build.gradle", "build.gradle.kts"];
	for (const gf of gradleFiles) {
		const gfPath = path.join(root, gf);
		if (fs.existsSync(gfPath)) {
			const content = fs.readFileSync(gfPath, "utf-8");
			const vMatch = content.match(/versionName\s+"([^"]+)"/);
			if (vMatch) { gradleVersion = vMatch[1]; break; }
		}
	}

	if (!gradleVersion) {
		return {
			id: "app_version", name: "App 版本匹配", category: "project", status: "pass",
			value: `已安装: ${installedVersion}`, message: "未找到 build.gradle versionName，无法比对",
		};
	}

	if (installedVersion === gradleVersion) {
		return {
			id: "app_version", name: "App 版本匹配", category: "project", status: "pass",
			value: `${installedVersion} (匹配)`,
		};
	}

	return {
		id: "app_version", name: "App 版本匹配", category: "project", status: "warn",
		value: `已安装: ${installedVersion} ≠ 项目: ${gradleVersion}`,
		message: "设备上安装的 App 版本与项目不一致，E2E 结果可能不准确",
		resolution: `./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`,
	};
}

// ─── Main Function ───────────────────────────────────────────────────────────

export function preflightCheck(): PreflightResult {
	const checks: CheckItem[] = [];

	// Layer 1: System
	checks.push(checkNodeVersion());
	checks.push(checkAdb());
	checks.push(checkAndroidSdk());

	// Layer 1.5: Device-level (v2 additions)
	checks.push(checkWebViewDebug());
	checks.push(checkChromedriverMatch());
	checks.push(checkPermissions());
	checks.push(checkPageOriginReachability());

	// Layer 2: Skill
	checks.push(checkTsNode());
	checks.push(checkWdio());
	checks.push(checkAppium());
	checks.push(checkAppiumDriver());

	// Layer 3: Project
	checks.push(checkAppConfig());
	checks.push(checkPageOrigin());
	checks.push(checkAppVersion());

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

	// Compute exit code: 0 = clean, 1 = has failures, 2 = blockers only
	const exitCode = summary.fail > 0 ? 1 : summary.warn > 0 ? 0 : 0;

	return {
		checks,
		summary,
		canProceed: summary.fail === 0,
		needsUserAction: userActions.length > 0,
		exitCode,
		userActions,
	};
}

export function formatPreflightResult(result: PreflightResult): string {
	const lines: string[] = [];

	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push("  E2E 真机测试环境预检 (v2)");
	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push("");

	const categories = [
		{ key: "system", name: "Layer 1: 系统级" },
		{ key: "device", name: "Layer 1.5: 设备级 (v2 new)" },
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
			if (item.message) lines.push(`     └─ ${item.message}`);
			if (item.resolution && item.status !== "pass") lines.push(`     └─ 修复: ${item.resolution}`);
		}
		lines.push("");
	}

	lines.push("═══════════════════════════════════════════════════════════════");
	lines.push(
		`  结果: ${result.summary.pass}/${result.summary.total} 通过 | ${result.summary.fail} 失败 | ${result.summary.warn} 警告 | exit=${result.exitCode}`,
	);
	lines.push("═══════════════════════════════════════════════════════════════");

	if (result.needsUserAction) {
		lines.push("");
		lines.push("  需要用户操作：");
		lines.push("  ─────────────────────────────────────────────────────────────");
		for (const action of result.userActions) {
			const icon = action.type === "confirm_install" ? "🔧" : action.type === "provide_path" ? "📁" : "📝";
			lines.push(`  ${icon} ${action.prompt}`);
			if (action.command) lines.push(`     命令: ${action.command}`);
		}
	}

	return lines.join("\n");
}

/**
 * NEW v2: Output preflight result as structured JSON.
 * Used by Agent for programmatic decision-making.
 */
export function preflightCheckJson(): string {
	const result = preflightCheck();
	return JSON.stringify(result, null, 2);
}

/**
 * NEW v2: Exit process with appropriate status code.
 * Call as the last step in a CLI preflight script.
 */
export function exitWithPreflightStatus(): never {
	const result = preflightCheck();
	process.exit(result.exitCode);
}

// ─── Auto Fix Functions ──────────────────────────────────────────────────────

export function executeAutoFix(checkId: string): { ok: boolean; message: string } {
	const result = preflightCheck();
	const check = result.checks.find((c) => c.id === checkId);

	if (!check) return { ok: false, message: `检查项 ${checkId} 不存在` };
	if (!check.autoFixable || !check.autoFixCommand) {
		return { ok: false, message: `${check.name} 不支持自动修复` };
	}

	try {
		execSync(check.autoFixCommand, { encoding: "utf-8", stdio: "inherit" });
		return { ok: true, message: `${check.name} 安装成功` };
	} catch (e: unknown) {
		const err = e as { message?: string };
		return { ok: false, message: `安装失败: ${err.message}` };
	}
}

export function saveAndroidSdkPath(sdkPath: string): { ok: boolean; message: string } {
	if (!fs.existsSync(sdkPath)) return { ok: false, message: `路径不存在: ${sdkPath}` };
	if (!sdkHasRequiredLayout(sdkPath)) return { ok: false, message: `SDK 目录不完整（缺少 platforms 或 build-tools）` };
	writeLocalConfig({ env: { ANDROID_HOME: sdkPath, ANDROID_SDK_ROOT: sdkPath } });
	process.env.ANDROID_HOME = sdkPath;
	process.env.ANDROID_SDK_ROOT = sdkPath;
	return { ok: true, message: `Android SDK 路径已保存: ${sdkPath}` };
}

// ─── Chromedriver Multi-Version Governance ───────────────────────────────────

interface ChromedriverMeta {
	versions: Record<string, { path: string; webViewMajor: number; deviceModel: string; lastUsed: string }>;
}

function saveChromedriverMeta(binPath: string, webViewMajor: number, deviceModel: string): void {
	try {
		const metaDir = path.join(e2eHome(), "chromedriver");
		const metaFile = path.join(metaDir, "versions.json");
		const existing: ChromedriverMeta = fs.existsSync(metaFile)
			? JSON.parse(fs.readFileSync(metaFile, "utf-8"))
			: { versions: {} };
		const versionKey = path.basename(path.dirname(path.dirname(binPath)));
		existing.versions[versionKey] = { path: binPath, webViewMajor, deviceModel, lastUsed: new Date().toISOString() };
		fs.mkdirSync(metaDir, { recursive: true });
		fs.writeFileSync(metaFile, JSON.stringify(existing, null, 2), "utf-8");
	} catch { /* non-critical */ }
}

function cleanOldChromedrivers(keepCount: number): void {
	try {
		const metaDir = path.join(e2eHome(), "chromedriver");
		const metaFile = path.join(metaDir, "versions.json");
		if (!fs.existsSync(metaFile)) return;
		const meta: ChromedriverMeta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
		const sorted = Object.entries(meta.versions).sort(
			(a, b) => new Date(b[1].lastUsed).getTime() - new Date(a[1].lastUsed).getTime(),
		);
		if (sorted.length <= keepCount) return;
		const toRemove = sorted.slice(keepCount);
		for (const [versionKey] of toRemove) {
			const dir = path.join(metaDir, versionKey);
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true, force: true });
				console.log(`[preflight] 清理旧 chromedriver: ${versionKey}`);
			}
			delete meta.versions[versionKey];
		}
		fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), "utf-8");
	} catch { /* non-critical */ }
}

/**
 * Auto-download the correct chromedriver version for a given Chrome major.
 * Returns the binary path on success, null on failure.
 */
function autoDownloadChromedriver(webViewMajor: number): string | null {
	try {
		const url = `https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone.json`;
		const resp = execFileSync("curl", ["-sL", url], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const milestones = JSON.parse(resp).milestones || {};
		const milestone = milestones[String(webViewMajor)];
		const exactVersion = milestone?.version;
		if (!exactVersion) return null;

		const downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${exactVersion}/mac-arm64/chromedriver-mac-arm64.zip`;
		const cdDir = path.join(e2eHome(), "chromedriver", `chromedriver-${exactVersion}`);
		const binPath = path.join(cdDir, "chromedriver-mac-arm64", "chromedriver");

		if (fs.existsSync(binPath)) return binPath;

		fs.mkdirSync(cdDir, { recursive: true });
		const zipPath = path.join(cdDir, `chromedriver-${exactVersion}.zip`);
		execFileSync("curl", ["-sL", downloadUrl, "-o", zipPath], {
			encoding: "utf-8",
			timeout: 60000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		execFileSync("unzip", ["-o", zipPath, "-d", cdDir], {
			encoding: "utf-8",
			timeout: 15000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		try { fs.unlinkSync(zipPath); } catch { /* cleanup */ }

		if (fs.existsSync(binPath)) {
			fs.chmodSync(binPath, 0o755);
			process.env.E2E_CHROMEDRIVER_PATH = binPath;
			try { writeLocalConfig({ env: { E2E_CHROMEDRIVER_PATH: binPath } }); } catch { /* best-effort */ }
			saveChromedriverMeta(binPath, webViewMajor, "auto-detected");
			cleanOldChromedrivers(5);
			return binPath;
		}
		return null;
	} catch {
		return null;
	}
}

// ─── Appium ↔ Driver Version Compatibility ───────────────────────────────────

const APPIUM_DRIVER_COMPAT: Record<string, { minDriver: number; maxDriver: number }> = {
	"3": { minDriver: 7, maxDriver: 8 },
};

function validateAppiumDriverCompat(driverVersion: string): CheckItem["status"] {
	try {
		const appiumBin = path.join(skillRoot(), "node_modules", ".bin", "appium");
		if (!fs.existsSync(appiumBin)) return "pass";
		const appiumOut = execFileSync(appiumBin, ["--version"], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const appiumMajor = parseInt(appiumOut.split(".")[0], 10);
		const compat = APPIUM_DRIVER_COMPAT[String(appiumMajor)];
		if (!compat) return "pass";
		const driverMajor = parseInt(driverVersion.split(".")[0], 10);
		if (driverMajor >= compat.minDriver && driverMajor < compat.maxDriver) return "pass";
		return "warn";
	} catch {
		return "pass";
	}
}

export function getVersionSummary(): Record<string, string> {
	const s: Record<string, string> = {};
	try {
		const bin = path.join(skillRoot(), "node_modules", ".bin", "appium");
		if (fs.existsSync(bin))
			s.appium = execFileSync(bin, ["--version"], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
	} catch {}
	try {
		const pkg = path.join(
			process.env.HOME || "",
			".appium",
			"node_modules",
			"appium-uiautomator2-driver",
			"package.json",
		);
		if (fs.existsSync(pkg)) s["uiautomator2-driver"] = JSON.parse(fs.readFileSync(pkg, "utf-8")).version || "?";
	} catch {}
	try {
		const bin = path.join(skillRoot(), "node_modules", ".bin", "wdio");
		if (fs.existsSync(bin))
			s.wdio = execFileSync(bin, ["--version"], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
	} catch {}
	s.node = process.version;
	return s;
}
