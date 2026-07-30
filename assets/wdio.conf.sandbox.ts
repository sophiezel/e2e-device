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
const journeySpec = process.env.E2E_JOURNEY_SPEC;
const specsGlob = journeySpec && fs.existsSync(journeySpec)
  ? journeySpec
  : fs.existsSync(specsDir)
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
const journeySegment = process.env.E2E_JOURNEY_SEGMENT || "";
const isFormSegment =
  journeySegment === "form" || journeySegment.startsWith("form_");
const defaultResetInterval =
  isFormSegment || journeySegment === "list" ? 12 : 15;
const SESSION_RESET_INTERVAL = parseInt(
  process.env.E2E_SESSION_RESET_INTERVAL || String(defaultResetInterval),
  10,
);
const wdioLogLevel: Options.WebDriverLogTypes =
  process.env.E2E_DEBUG === "1" ? "info" : "warn";

let testCount = 0;
let journeyEntryPrepared = false;

export const config: Options.Testrunner = {
  runner: "local",
  specs: [specsGlob],

  beforeSession: async function () {
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

    if (journeySpec) {
      console.log(`[wdio] Journey segment=${journeySegment || "?"} spec=${path.basename(journeySpec)}`);
      if (!fs.existsSync(journeySpec)) {
        console.error(`[wdio] FATAL: E2E_JOURNEY_SPEC 不存在: ${journeySpec}`);
      }
      return;
    }

    const matched = walkDir(specsDir);
    if (matched.length === 0) {
      console.error(`[wdio] FATAL: 未匹配到任何 spec 文件`);
      console.error(`[wdio] specsDir: ${specsDir}`);
    } else {
      console.log(`[wdio] 匹配到 ${matched.length} 个 spec 文件`);
    }
  },

  before: async function () {
    if (process.env.E2E_SEQUENTIAL_INDIVIDUAL === "1") return;
    if (journeyEntryPrepared) return;

    const domain = process.env.E2E_DOMAIN || "";
    if (!domain || !journeySegment) return;

    const { prepareDeviceSession } = await import(
      path.join(sandboxRoot, "helpers", "session")
    );
    await prepareDeviceSession();

    const { ensurePilotEntry, ensureWarmPilotEntry } = await import(
      path.join(sandboxRoot, "helpers", "suite-entry")
    );

    if (journeySegment === "form" || journeySegment === "list") {
      const formModule = process.env.E2E_FORM_MODULE || domain;
      const entryRoute = journeySegment === "form" ? formModule : domain;
      await ensureWarmPilotEntry(entryRoute);
    } else if (journeySegment === "infra" || journeySegment === "chaos" || journeySegment === "env") {
      await ensurePilotEntry(domain, { force: true });
    }

    journeyEntryPrepared = true;
    console.log(`[wdio] Journey entry prepared: segment=${journeySegment} domain=${domain}`);
  },

  maxInstances: 1,
  capabilities: [getCapabilities()],
  logLevel: wdioLogLevel,
  bail: 0,
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
    timeout: parseInt(process.env.E2E_TIMEOUT_MOCHA_TEST || "45000", 10) || 45000,
  },
  reporters: ["spec"],

  afterTest: async function (test, context, result) {
    testCount++;
    const runId = process.env.E2E_RUN_ID || "unknown";
    let resetMs = 0;

    const executedFile = path.join(sandboxRoot, "artifacts", "runs", runId, "cases-executed.jsonl");
    fs.mkdirSync(path.dirname(executedFile), { recursive: true });
    const caseName = (context as { title?: string })?.title || (test as { title?: string })?.title || "";

    if (
      isFormSegment &&
      process.env.E2E_SEQUENTIAL_INDIVIDUAL !== "1"
    ) {
      const resetStart = Date.now();
      let resetFailed = false;
      try {
        const { expertResetBetweenCases } = await import(
          path.join(sandboxRoot, "helpers", "expert-reset")
        );
        const domain = process.env.E2E_DOMAIN || "";
        const formModule = process.env.E2E_FORM_MODULE || domain;
        const mockProfile = process.env.E2E_MOCK_PROFILE;
        resetMs = await expertResetBetweenCases({
          domain,
          pageModule: formModule,
          mockProfile: mockProfile || undefined,
          budgetMs: 4000,
        });
      } catch (e) {
        resetFailed = true;
        resetMs = Date.now() - resetStart;
        console.warn("[wdio] expertReset failed:", (e as Error).message);
        try {
          const { ensurePilotEntry } = await import(
            path.join(sandboxRoot, "helpers", "suite-entry")
          );
          await ensurePilotEntry(process.env.E2E_FORM_MODULE || process.env.E2E_DOMAIN || "", {
            force: true,
          });
          console.log("[wdio] expertReset → cold ensurePilotEntry once");
        } catch (e2) {
          console.warn("[wdio] cold entry after reset failed:", (e2 as Error).message);
        }
      }
      if (resetFailed) {
        // mark for cases-executed below via closure — appended in status object
        (globalThis as { __e2eLastResetFailed?: boolean }).__e2eLastResetFailed = true;
      } else {
        (globalThis as { __e2eLastResetFailed?: boolean }).__e2eLastResetFailed = false;
      }
    } else if (journeySegment === "list" && process.env.E2E_SEQUENTIAL_INDIVIDUAL !== "1") {
      const resetStart = Date.now();
      try {
        const { cleanupAfterTest } = await import(
          path.join(sandboxRoot, "helpers", "reset-session")
        );
        await cleanupAfterTest();
        const { ensureWarmPilotEntry } = await import(
          path.join(sandboxRoot, "helpers", "suite-entry")
        );
        await ensureWarmPilotEntry(process.env.E2E_DOMAIN || "");
        resetMs = Date.now() - resetStart;
      } catch (e) {
        resetMs = Date.now() - resetStart;
        console.warn("[wdio] list reset failed:", (e as Error).message);
        try {
          const { ensurePilotEntry } = await import(
            path.join(sandboxRoot, "helpers", "suite-entry")
          );
          await ensurePilotEntry(process.env.E2E_DOMAIN || "", { force: true });
        } catch (e2) {
          console.warn("[wdio] list cold entry failed:", (e2 as Error).message);
        }
      }
    }

    const outcome = result.error ? "failed" : "passed";
    fs.appendFileSync(executedFile, JSON.stringify({
      caseId: caseName,
      spec: (test as { file?: string })?.file || "",
      outcome,
      status: outcome, // backward compat for older readers
      durationMs: (result as { duration?: number })?.duration || 0,
      resetMs,
      resetFailed: !!(globalThis as { __e2eLastResetFailed?: boolean }).__e2eLastResetFailed,
      journeySegment: journeySegment || undefined,
      error: result.error ? String(result.error) : "",
      at: new Date().toISOString(),
    }) + "\n", "utf-8");

    if (result.error) {
      try {
        const wdioBrowser = (globalThis as Record<string, unknown>).browser as { saveScreenshot?: (p: string) => Promise<void> } | undefined;
        if (wdioBrowser?.saveScreenshot) {
          const ssDir = path.join(sandboxRoot, "artifacts", "runs", runId, "screenshots");
          fs.mkdirSync(ssDir, { recursive: true });
          const safeName = caseName.replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
          await wdioBrowser.saveScreenshot(path.join(ssDir, `${safeName}.png`));
        }
      } catch (e) {
        console.warn("[wdio] 截图失败:", (e as Error).message);
      }
    }

    const durationMs = (result as { duration?: number })?.duration || 0;
    try {
      const { recordCaseDuration } = await import(
        path.join(sandboxRoot, "helpers", "session-adaptive"),
      );
      recordCaseDuration(durationMs);
    } catch {
      /* optional helper */
    }

    if (process.env.E2E_SEQUENTIAL_INDIVIDUAL !== "1") {
      try {
        const {
          allowsPeriodicReload,
          shouldAdaptiveReload,
          reenterPilotAfterReload,
          clearSegmentHealPending,
        } = await import(path.join(sandboxRoot, "helpers", "session-adaptive"));
        const periodic =
          allowsPeriodicReload() && testCount > 0 && testCount % SESSION_RESET_INTERVAL === 0;
        const adaptive = !periodic && (await shouldAdaptiveReload());
        if (periodic || adaptive) {
          const reason = periodic ? "periodic" : "adaptive";
          console.log(`[wdio] Session reload (${reason}) after ${testCount} tests`);
          const { browser } = await import("@wdio/globals");
          await browser.reloadSession();
          journeyEntryPrepared = false;
          const { prepareDeviceSession } = await import(
            path.join(sandboxRoot, "helpers", "session"),
          );
          await prepareDeviceSession();
          await reenterPilotAfterReload(process.env.E2E_DOMAIN || "");
          journeyEntryPrepared = true;
          clearSegmentHealPending();
        }
      } catch (e) {
        console.warn("[wdio] Session reload failed:", (e as Error).message);
      }
    }
  },
};
