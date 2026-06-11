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
				status: validateAppiumDriverCompat(pkgJson.version || "0"),
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

		let status: CheckItem["status"] = "pass";
		const messages: string[] = [];

		// Known problematic vendors get a warning
		const problematicVendors = ["huawei", "oppo", "vivo"];
		if (problematicVendors.includes(clazz)) {
			status = "warn";
			messages.push(`${vendor.manufacturer} devices may have custom WebView quirks. Vendor workarounds applied.`);
		}

		// Check chromedriver version against WebView Chrome version
		if (vendor.webViewVersion) {
			const webViewMajor = parseInt(vendor.webViewVersion.split(".")[0], 10);
			if (webViewMajor) {
				let cdMajor = 0;
				let cdPath = "";

				// Priority 1: E2E_CHROMEDRIVER_PATH env var
				const explicitPath = process.env.E2E_CHROMEDRIVER_PATH;
				if (explicitPath && fs.existsSync(explicitPath)) {
					try {
						const cdOut = execFileSync(explicitPath, ["--version"], {
							encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
						});
						const cdMatch = cdOut.match(/ChromeDriver (\d+)/);
						cdMajor = cdMatch ? parseInt(cdMatch[1], 10) : 0;
						cdPath = explicitPath;
					} catch {
						messages.push(`E2E_CHROMEDRIVER_PATH 指向无效二进制: ${explicitPath}`);
					}
				}

				// Priority 2: $E2E_HOME/chromedriver/ directory
				if (!cdMajor) {
					const cdDir = path.join(e2eHome(), "chromedriver");
					if (fs.existsSync(cdDir)) {
						const entries = fs.readdirSync(cdDir).filter(e => e.startsWith("chromedriver"));
						for (const e of entries) {
							const bin = path.join(cdDir, e, "chromedriver-mac-arm64", "chromedriver");
							const binAlt = path.join(cdDir, e, "chromedriver");
							const actualBin = fs.existsSync(bin) ? bin : fs.existsSync(binAlt) ? binAlt : null;
							if (!actualBin) continue;
							try {
								const cdOut = execFileSync(actualBin, ["--version"], {
									encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
								});
								const cdMatch = cdOut.match(/ChromeDriver (\d+)/);
								const major = cdMatch ? parseInt(cdMatch[1], 10) : 0;
								if (major === webViewMajor) {
									cdMajor = major;
									cdPath = actualBin;
									process.env.E2E_CHROMEDRIVER_PATH = actualBin;
									// Persist for subsequent runs (Appium needs the path in env/.e2e-local.json)
									try { writeLocalConfig({ env: { E2E_CHROMEDRIVER_PATH: actualBin } }); } catch { /* best-effort */ }
						saveChromedriverMeta(actualBin, webViewMajor, vendor.model);
						cleanOldChromedrivers(5);
									break;
								}
							} catch { /* skip invalid binaries */ }
						}
					}
				}

				// Priority 3: system PATH chromedriver
				if (!cdMajor) {
					try {
						const cdOut = execFileSync("chromedriver", ["--version"], {
							encoding: "utf-8",
							stdio: ["pipe", "pipe", "pipe"],
							timeout: 5000,
						});
						const cdMatch = cdOut.match(/ChromeDriver (\d+)/);
						cdMajor = cdMatch ? parseInt(cdMatch[1], 10) : 0;
						if (cdMajor === webViewMajor) {
							cdPath = "system";
							// Persist for subsequent runs
							try { writeLocalConfig({ env: { E2E_CHROMEDRIVER_PATH: "" } }); } catch { /* best-effort */ }
						}
					} catch {
						// chromedriver not in PATH
					}
				}

				if (cdMajor !== webViewMajor) {
					status = "fail";
					const cdInfo = cdMajor ? `${cdMajor} (${cdPath || "system"})` : "none";
					messages.push(
						`chromedriver ${cdInfo} ≠ WebView Chrome ${webViewMajor}. Auto-downloading...`,
					);
					// Auto-download matching chromedriver (to both appium dir + sdk dir)
					try {
						// Get stable version for this milestone
						const url = `https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone.json`;
						const resp = execFileSync("curl", ["-sL", url], {
							encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
						});
						const milestones = JSON.parse(resp).milestones || {};
						const milestone = milestones[String(webViewMajor)];
						const exactVersion = milestone?.version;
						if (exactVersion) {
							const downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${exactVersion}/mac-arm64/chromedriver-mac-arm64.zip`;
							
							// Download to $E2E_HOME/chromedriver/
							const cdDir = path.join(e2eHome(), "chromedriver", `chromedriver-${exactVersion}`);
							const binPath = path.join(cdDir, "chromedriver-mac-arm64", "chromedriver");
							// Also download to sdk dir as fallback
							const sdkDir = resolveAndroidSdkRoot() || "/tmp";
							const sdkCdDir = path.join(sdkDir, "chromedriver");
							const sdkBinPath = path.join(sdkCdDir, "chromedriver-mac-arm64/chromedriver");

							let downloaded = false;
							for (const [targetDir, binPath] of [[cdDir, binPath], [sdkCdDir, sdkBinPath]]) {
								if (fs.existsSync(binPath)) {
									downloaded = true;
									continue;
								}
								fs.mkdirSync(targetDir, { recursive: true });
								const zipPath = path.join(targetDir, `chromedriver-${exactVersion}.zip`);
								execFileSync("curl", ["-sL", downloadUrl, "-o", zipPath], {
									encoding: "utf-8", timeout: 60000, stdio: ["pipe", "pipe", "pipe"],
								});
								execFileSync("unzip", ["-o", zipPath, "-d", targetDir], {
									encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
								});
								try { fs.unlinkSync(zipPath); } catch { /* cleanup */ }
								if (fs.existsSync(binPath)) {
									fs.chmodSync(binPath, 0o755);
									downloaded = true;
								}
							}

							if (downloaded) {
								const firstBin = binPath;  // 使用循环外的 binPath
								process.env.E2E_CHROMEDRIVER_PATH = firstBin;
								try { writeLocalConfig({ env: { E2E_CHROMEDRIVER_PATH: firstBin } }); } catch { /* best-effort */ }
						saveChromedriverMeta(firstBin, webViewMajor, vendor.model);
						cleanOldChromedrivers(5);
								status = "pass";
								messages.push(`chromedriver ${exactVersion} downloaded to ${firstBin}`);
							}
						}
					} catch (dlErr) {
						status = "warn";
						messages.push(`Auto-download failed: ${dlErr instanceof Error ? dlErr.message : String(dlErr)}`);
					}
				}
			}
		}

		return {
			id: "vendor_webview",
			name: "Device & WebView",
			category: "system",
			status,
			value: `${vendor.manufacturer}/${vendor.model} Android ${vendor.androidVersion} | WebView: ${webViewInfo}`,
			message: messages.length > 0 ? messages.join("; ") : undefined,
			resolution: undefined,
			autoFixable: false,
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
	const origin = process.env.E2E_PAGE_ORIGIN || process.env.E2E_H5_ORIGIN ||
		local?.env?.E2E_PAGE_ORIGIN || local?.app?.h5?.pageOrigin || "";

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

	// Verify URL is reachable (not 404, not auth-blocked)
	// Also check the pilot route to form a full URL
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
			"--max-time", "10",
			"--head",
			fullUrl,
		], { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] });

		const statusCode = out.trim();

		if (/^[23]\d{2}$/.test(statusCode)) {
			return {
				id: "page_origin",
				name: "页面 origin",
				category: "project",
				status: "pass",
				value: origin,
			};
		}

		if (statusCode === "404") {
			return {
				id: "page_origin",
				name: "页面 origin",
				category: "project",
				status: "fail",
				value: origin,
				message: `URL 返回 404: ${fullUrl}`,
				resolution: "确认正确的 H5 部署地址。当前 E2E_PAGE_ORIGIN 可能错误或页面尚未部署到该环境。",
			};
		}

		if (statusCode === "401" || statusCode === "403") {
			return {
				id: "page_origin",
				name: "页面 origin",
				category: "project",
				status: "warn",
				value: origin,
				message: `URL 需要认证 (${statusCode}): ${fullUrl}`,
				resolution: "确保设备已登录，或使用不需要认证的测试环境。",
			};
		}

		return {
			id: "page_origin",
			name: "页面 origin",
			category: "project",
			status: "warn",
			value: origin,
			message: `URL 返回 ${statusCode}: ${fullUrl}`,
			resolution: "确认 URL 是否正确，H5 应用是否已部署。",
		};
	} catch (e) {
		return {
			id: "page_origin",
			name: "页面 origin",
			category: "project",
			status: "fail",
			value: origin,
			message: `无法访问 URL: ${fullUrl} (${e instanceof Error ? e.message : String(e)})`,
			resolution: "检查网络连接和 E2E_PAGE_ORIGIN 值。",
		};
	}
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

/** Check if the installed app version matches the project's build.gradle version. */
function checkAppVersion(): CheckItem {
	const local = readLocalConfig();
	const pkg = local?.app?.android?.appPackage || process.env.E2E_APP_PACKAGE || "";
	if (!pkg) {
		return {
			id: "app_version",
			name: "App 版本匹配",
			category: "project",
			status: "warn",
			message: "App 包名未配置，无法检测版本",
		};
	}

	// Get installed version from device
	let installedVersion = "";
	try {
		const dumpsys = execFileSync("adb", ["shell", "dumpsys", "package", pkg], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10000,
		});
		const vMatch = dumpsys.match(/versionName=([^\s]+)/);
		if (vMatch) {
			installedVersion = vMatch[1];
		}
	} catch {
		// Device not connected or package not installed
	}

	if (!installedVersion) {
		return {
			id: "app_version",
			name: "App 版本匹配",
			category: "project",
			status: "warn",
			message: "未检测到已安装的 App，请确保设备上已安装最新 Debug 构建",
			resolution: "在 Android Studio 中运行 app 或执行 ./gradlew assembleDebug && adb install",
		};
	}

	// Look for build.gradle to find project version
	let gradleVersion = "";
	const root = repoRoot();
	const gradleFiles = [
		"app/build.gradle",
		"app/build.gradle.kts",
		"build.gradle",
		"build.gradle.kts",
	];
	for (const gf of gradleFiles) {
		const gfPath = path.join(root, gf);
		if (fs.existsSync(gfPath)) {
			const content = fs.readFileSync(gfPath, "utf-8");
			const vMatch = content.match(/versionName\s+"([^"]+)"/);
			if (vMatch) {
				gradleVersion = vMatch[1];
				break;
			}
		}
	}

	if (!gradleVersion) {
		return {
			id: "app_version",
			name: "App 版本匹配",
			category: "project",
			status: "pass",
			value: `已安装: ${installedVersion}`,
			message: "未找到 build.gradle versionName，无法比对",
		};
	}

	if (installedVersion === gradleVersion) {
		return {
			id: "app_version",
			name: "App 版本匹配",
			category: "project",
			status: "pass",
			value: `${installedVersion} (匹配)`,
		};
	}

	return {
		id: "app_version",
		name: "App 版本匹配",
		category: "project",
		status: "warn",
		value: `已安装: ${installedVersion} ≠ 项目: ${gradleVersion}`,
		message: "设备上安装的 App 版本与项目不一致，E2E 结果可能不准确",
		resolution: `./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`,
	};
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

// ─── Chromedriver 多版本治理 ───

interface ChromedriverMeta {
	versions: Record<string, { path: string; webViewMajor: number; deviceModel: string; lastUsed: string }>;
}

/** 记录 chromedriver 版本使用元数据 */
function saveChromedriverMeta(binPath: string, webViewMajor: number, deviceModel: string): void {
	try {
		const metaDir = path.join(e2eHome(), "chromedriver");
		const metaFile = path.join(metaDir, "versions.json");
		const existing: ChromedriverMeta = fs.existsSync(metaFile)
			? JSON.parse(fs.readFileSync(metaFile, "utf-8"))
			: { versions: {} };
		const versionKey = path.basename(path.dirname(path.dirname(binPath)));
		existing.versions[versionKey] = {
			path: binPath,
			webViewMajor,
			deviceModel,
			lastUsed: new Date().toISOString(),
		};
		fs.mkdirSync(metaDir, { recursive: true });
		fs.writeFileSync(metaFile, JSON.stringify(existing, null, 2), "utf-8");
	} catch { /* non-critical */ }
}

/** 清理旧版本, 保留最近 N 个 (按 lastUsed 排序) */
function cleanOldChromedrivers(keepCount: number): void {
	try {
		const metaDir = path.join(e2eHome(), "chromedriver");
		const metaFile = path.join(metaDir, "versions.json");
		if (!fs.existsSync(metaFile)) return;
		const meta: ChromedriverMeta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
		const sorted = Object.entries(meta.versions)
			.sort((a, b) => new Date(b[1].lastUsed).getTime() - new Date(a[1].lastUsed).getTime());
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
	} catch { /* chromedriver cleanup non-critical */ }
}

// ─── Appium ↔ Driver 版本兼容性 ───

const APPIUM_DRIVER_COMPAT: Record<string, { minDriver: number; maxDriver: number }> = {
	"3": { minDriver: 7, maxDriver: 8 },  // Appium 3.x requires uiautomator2-driver 7.x
};

function validateAppiumDriverCompat(driverVersion: string): CheckItem["status"] {
	try {
		const appiumBin = path.join(skillRoot(), "node_modules", ".bin", "appium");
		if (!fs.existsSync(appiumBin)) return "pass";
		const appiumOut = execFileSync(appiumBin, ["--version"], {
			encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		const appiumMajor = parseInt(appiumOut.split(".")[0], 10);
		const compat = APPIUM_DRIVER_COMPAT[String(appiumMajor)];
		if (!compat) return "pass";
		const driverMajor = parseInt(driverVersion.split(".")[0], 10);
		if (driverMajor >= compat.minDriver && driverMajor < compat.maxDriver) return "pass";
		return "warn";
	} catch { return "pass"; }
}

export function getVersionSummary(): Record<string, string> {
	const s: Record<string, string> = {};
	try {
		const bin = path.join(skillRoot(), "node_modules", ".bin", "appium");
		if (fs.existsSync(bin)) s.appium = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000, stdio: ["pipe","pipe","pipe"] }).trim();
	} catch {}
	try {
		const pkg = path.join(process.env.HOME || "", ".appium", "node_modules", "appium-uiautomator2-driver", "package.json");
		if (fs.existsSync(pkg)) s["uiautomator2-driver"] = JSON.parse(fs.readFileSync(pkg, "utf-8")).version || "?";
	} catch {}
	try {
		const bin = path.join(skillRoot(), "node_modules", ".bin", "wdio");
		if (fs.existsSync(bin)) s.wdio = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000, stdio: ["pipe","pipe","pipe"] }).trim();
	} catch {}
	s.node = process.version;
	return s;
}
