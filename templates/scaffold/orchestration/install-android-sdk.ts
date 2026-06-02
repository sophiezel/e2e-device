import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeLocalConfig } from "../config/local-config";

export interface InstallAndroidSdkResult {
	ok: boolean;
	log: string;
	androidHome: string | null;
	needsUserAction: boolean;
	manualSteps: string[];
}

function run(cmd: string, cwd?: string): string {
	return execSync(cmd, {
		cwd: cwd || process.env.HOME || "/",
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, CI: "true" },
	});
}

function tryRun(cmd: string, cwd?: string): { ok: boolean; out: string } {
	try {
		return { ok: true, out: run(cmd, cwd) };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, out: err.stdout || err.stderr || err.message || String(e) };
	}
}

function sdkHasRequiredLayout(sdkRoot: string): boolean {
	return (
		fs.existsSync(path.join(sdkRoot, "platforms")) &&
		fs.existsSync(path.join(sdkRoot, "build-tools"))
	);
}

function resolveBrewAndroidSdkRoot(): string | null {
	const prefix = tryRun("brew --prefix").out.trim();
	if (!prefix) {
		return null;
	}
	const root = path.join(prefix, "share", "android-commandlinetools");
	return fs.existsSync(root) ? root : null;
}

function defaultStudioSdkRoot(): string {
	const home = process.env.HOME || "";
	return path.join(home, "Library", "Android", "sdk");
}

function findSdkmanager(sdkRoot: string): string | null {
	const candidates = [
		path.join(sdkRoot, "cmdline-tools", "latest", "bin", "sdkmanager"),
		path.join(sdkRoot, "tools", "bin", "sdkmanager"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return null;
}

function ensureJava(log: string[]): void {
	if (tryRun("java -version").ok) {
		return;
	}
	log.push("Java not found, installing temurin via brew...");
	log.push(run("brew install --cask temurin"));
}

function installPackages(sdkRoot: string, log: string[]): void {
	const sdkmanager = findSdkmanager(sdkRoot);
	if (!sdkmanager) {
		throw new Error(`sdkmanager not found under ${sdkRoot}`);
	}
	const apiLevel = process.env.E2E_ANDROID_API_LEVEL || "34";
	const buildTools = process.env.E2E_ANDROID_BUILD_TOOLS || "34.0.0";
	const env = {
		...process.env,
		ANDROID_HOME: sdkRoot,
		ANDROID_SDK_ROOT: sdkRoot,
	};
	const yes = "yes";
	const licenseCmd = `yes | "${sdkmanager}" --licenses`;
	log.push(
		execSync(licenseCmd, {
			encoding: "utf-8",
			env,
			shell: "/bin/bash",
			stdio: ["pipe", "pipe", "pipe"],
		}).slice(0, 500),
	);
	const installCmd = `"${sdkmanager}" "platform-tools" "platforms;android-${apiLevel}" "build-tools;${buildTools}"`;
	log.push(execSync(installCmd, { encoding: "utf-8", env, shell: "/bin/bash" }));
}

export function installAndroidSdk(): InstallAndroidSdkResult {
	const log: string[] = [];
	const manualSteps: string[] = [];

	const studioRoot = defaultStudioSdkRoot();
	if (fs.existsSync(studioRoot) && sdkHasRequiredLayout(studioRoot)) {
		writeLocalConfig({
			env: {
				ANDROID_HOME: studioRoot,
				ANDROID_SDK_ROOT: studioRoot,
			},
		});
		return {
			ok: true,
			log: `Using existing Android Studio SDK at ${studioRoot}`,
			androidHome: studioRoot,
			needsUserAction: false,
			manualSteps: [],
		};
	}

	if (process.platform !== "darwin") {
		return {
			ok: false,
			log: "Auto-install is macOS-only (Homebrew).",
			androidHome: null,
			needsUserAction: true,
			manualSteps: [
				"Install Android Studio or command-line tools for your OS",
				"Set ANDROID_HOME and install platforms + build-tools",
				"See reference/android-sdk-setup.md",
			],
		};
	}

	if (!tryRun("command -v brew").ok) {
		return {
			ok: false,
			log: "Homebrew not found.",
			androidHome: null,
			needsUserAction: true,
			manualSteps: [
				"Install Homebrew or Android Studio manually",
				"See reference/android-sdk-setup.md",
			],
		};
	}

	let sdkRoot = resolveBrewAndroidSdkRoot();
	if (!sdkRoot) {
		log.push("Installing android-commandlinetools via Homebrew...");
		try {
			log.push(run("brew install --cask android-commandlinetools"));
			sdkRoot = resolveBrewAndroidSdkRoot();
		} catch (e) {
			log.push(String(e));
			return {
				ok: false,
				log: log.join("\n"),
				androidHome: null,
				needsUserAction: true,
				manualSteps: [
					"brew install --cask android-commandlinetools",
					"brew install --cask temurin",
					"Then run: bash e2e-device/scripts/install-android-sdk.sh",
				],
			};
		}
	}

	if (!sdkRoot) {
		return {
			ok: false,
			log: log.join("\n"),
			androidHome: null,
			needsUserAction: true,
			manualSteps: ["brew install --cask android-commandlinetools"],
		};
	}

	try {
		ensureJava(log);
		if (!sdkHasRequiredLayout(sdkRoot)) {
			log.push(`Installing SDK packages into ${sdkRoot}...`);
			installPackages(sdkRoot, log);
		}
	} catch (e) {
		log.push(String(e));
		return {
			ok: false,
			log: log.join("\n"),
			androidHome: sdkRoot,
			needsUserAction: true,
			manualSteps: [
				`export ANDROID_HOME="${sdkRoot}"`,
				`export ANDROID_SDK_ROOT="$ANDROID_HOME"`,
				`"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-34" "build-tools;34.0.0"`,
			],
		};
	}

	if (!sdkHasRequiredLayout(sdkRoot)) {
		return {
			ok: false,
			log: log.join("\n"),
			androidHome: sdkRoot,
			needsUserAction: true,
			manualSteps: ["Re-run install-android-sdk or complete SDK packages in Android Studio"],
		};
	}

	process.env.ANDROID_HOME = sdkRoot;
	process.env.ANDROID_SDK_ROOT = sdkRoot;
	writeLocalConfig({
		env: {
			ANDROID_HOME: sdkRoot,
			ANDROID_SDK_ROOT: sdkRoot,
		},
	});

	return {
		ok: true,
		log: log.join("\n"),
		androidHome: sdkRoot,
		needsUserAction: false,
		manualSteps: [],
	};
}
