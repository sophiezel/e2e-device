// @ts-nocheck
/**
 * wdio.conf.ts — 沙箱模式模板
 * 
 * 所有路径通过环境变量解析:
 *   E2E_PROJECT_ROOT  — 项目根目录 (skill.project.json 所在)
 *   E2E_SANDBOX       — 沙箱目录 (specs/ artifacts/ 所在)
 *   E2E_DEVICE_SKILL_ROOT — Skill 根目录 (框架代码所在, 默认 ~/.agents/skills/e2e-device)
 */
import path from "node:path";
import fs from "node:fs";
import type { Options } from "@wdio/types";

const skillRoot = process.env.E2E_DEVICE_SKILL_ROOT ||
  path.join(process.env.HOME || "", ".agents", "skills", "e2e-device");
const sandboxRoot = process.env.E2E_SANDBOX || process.cwd();
const projectRoot = process.env.E2E_PROJECT_ROOT || process.cwd();

// ── 验证沙箱完整性 ──────────────────────────────
function assertSandboxDir(subdir: string): string {
  const p = path.join(sandboxRoot, subdir);
  if (!fs.existsSync(p)) {
    console.error(`[wdio] FATAL: sandbox/${subdir} 不存在: ${p}`);
  }
  return p;
}

// ── Specs ──────────────────────────────────────────
const specsDir = path.join(sandboxRoot, "specs");
const specsGlob = fs.existsSync(specsDir)
  ? path.join(specsDir, "**", "*.spec.ts")
  : path.join(projectRoot, "e2e-device", "specs", "**", "*.spec.ts");

// ── Appium binary ──────────────────────────────────
function resolveAppium(): string {
  const envBin = process.env.E2E_APPIUM_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;
  // Priority: skill node_modules > project node_modules > global
  for (const root of [skillRoot, projectRoot]) {
    const bin = path.join(root, "node_modules", ".bin", "appium");
    if (fs.existsSync(bin)) return bin;
  }
  return "appium";
}

// ── Capabilities — from sandbox config ─────────────
let getCapabilities = (): WebdriverIO.Capabilities => ({} as WebdriverIO.Capabilities);
try {
  // v3: 从沙箱读 config（sandbox/config/ 由 run.sh _setup_writable_dir 复制）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const appCfg = require(path.join(sandboxRoot, "config", "app"));
  if (typeof appCfg.getCapabilities === "function") {
    getCapabilities = appCfg.getCapabilities;
  } else {
    console.error("[wdio] FATAL: sandbox/config/app 未导出 getCapabilities");
  }
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[wdio] FATAL: 无法加载 sandbox/config/app: ${msg}`);
  console.error(`[wdio] 沙箱路径: ${sandboxRoot}`);
}

// ── Android SDK ────────────────────────────────────
function applyAndroidSdkEnv(): void {
  if (process.env.ANDROID_HOME && process.env.ANDROID_SDK_ROOT) return;
  try {
    // v3: 从沙箱读 helpers（sandbox/helpers/ 由 run.sh _setup_writable_dir 复制）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require(path.join(sandboxRoot, "helpers", "android-sdk"));
    if (typeof sdk.applyAndroidSdkEnv === "function") sdk.applyAndroidSdkEnv();
  } catch (e: unknown) {
    console.warn(`[wdio] android-sdk 不可用 (非致命): ${e instanceof Error ? e.message : String(e)}`);
  }
}
applyAndroidSdkEnv();

// ── Config ─────────────────────────────────────────
const appiumPort = parseInt(process.env.E2E_APPIUM_PORT || "4723", 10);
const SESSION_RESET_INTERVAL = parseInt(process.env.E2E_SESSION_RESET_INTERVAL || "15", 10);
const wdioLogLevel: Options.WebDriverLogTypes =
  process.env.E2E_DEBUG === "1" ? "info" : "warn";

let testCount = 0;

export const config: Options.Testrunner = {
  runner: "local",
  specs: [specsGlob],

  // ── v3: 预检 — specs glob 是否匹配到文件 ──────────
  beforeSession: async function () {
    // Walk specs directory with vanilla Node.js fs (no external dependencies)
    const walkDir = (dir: string): string[] => {
      const results: string[] = [];
      if (!fs.existsSync(dir)) return results;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...walkDir(p));
        else if (entry.name.endsWith(".spec.ts")) results.push(p);
      }
      return results;
    };
    const matched = walkDir(specsDir);
    if (matched.length === 0) {
      console.error(`[wdio] FATAL: 未匹配到任何 spec 文件`);
      console.error(`[wdio] specsDir: ${specsDir}`);
      console.error(`[wdio] specsDir 存在: ${fs.existsSync(specsDir)}`);
      if (fs.existsSync(specsDir)) {
        const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.ts'));
        console.error(`[wdio] specsDir 内容 (${files.length} 个 .ts 文件): ${files.slice(0,20).join(', ')}`);
      }
    } else {
      console.log(`[wdio] 匹配到 ${matched.length} 个 spec 文件`);
    }
  },
  maxInstances: 1,
  // v2 Appium capabilities: noReset, newCommandTimeout=120, skipDeviceInitialization, skipServerInstallation
  // Prefer Accessibility ID as default locator strategy for reliable element targeting.
  capabilities: [getCapabilities()],
  logLevel: wdioLogLevel,
  bail: 0,
  // v2: explicit waits only. 5000ms default waitforTimeout.
  // Longer waits use browser.waitUntil() with explicit timeout args.
  waitforTimeout: 5000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,
  port: appiumPort,

  ...(process.env.E2E_APPIUM_SKIP_SERVICE === "1" ? {} : {
    services: [[
      "appium",
      {
        command: resolveAppium(),
        args: {
          port: appiumPort,
          relaxedSecurity: process.env.E2E_APPIUM_RELAXED_SECURITY === "1",
          logLevel: "warn",
        },
      },
    ]],
  }),

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 45000,
  },
  reporters: ["spec"],

  // ── Session lifecycle ──────────────────────────
  afterTest: async function () {
    testCount++;
    if (process.env.E2E_SEQUENTIAL_INDIVIDUAL !== "1" && testCount % SESSION_RESET_INTERVAL === 0) {
      console.log(`[wdio] Session reset after ${testCount} tests (interval=${SESSION_RESET_INTERVAL})`);
      try {
        const { browser } = await import("@wdio/globals");
        await browser.reloadSession();
        const { prepareDeviceSession } = await import(
          path.join(sandboxRoot, "helpers", "session")
        );
        await prepareDeviceSession();
      } catch (e) {
        console.warn("[wdio] Session reset failed:", (e as Error).message);
      }
    }
  },
};
