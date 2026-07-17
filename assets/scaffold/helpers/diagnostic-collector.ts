/**
 * diagnostic-collector.ts
 * 诊断信息采集器 — L2 业务断言失败时收集问题栈，不自动修复，不阻断。
 *
 * 分层策略:
 *   L0 (Native容器): 登录过期/USB授权 → resilience 层 auto-fix 保留
 *   L1 (Hybrid通道): URL错/数据空/参数错 → resilience 层 auto-fix 保留
 *   L2 (业务H5): 键盘遮挡/弹窗穿透/表单丢失 → recordFailure() 记录
 *   FRAMEWORK: WDIO session 创建失败/TS编译错误 → recordFrameworkFailure() 记录
 *
 * 所有采集写入 artifacts/runs/<runId>/diagnostic-snapshots/<caseId>.json
 * 以及 artifacts/runs/<runId>/problems-collected.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ProblemStack,
  ReproductionPath,
  SuggestedFix,
  CaseRecord,
} from "./types";

function getRunId(): string {
  return process.env.E2E_RUN_ID || `adhoc-${Date.now()}`;
}

/** Resolve run artifacts dir (sandbox/artifacts/runs/{runId}). */
function runArtifactsDir(runId?: string): string {
  const id = runId || getRunId();
  if (process.env.E2E_ARTIFACTS_ROOT) {
    return path.resolve(process.env.E2E_ARTIFACTS_ROOT, "runs", id);
  }
  const sandbox = process.env.E2E_SANDBOX;
  if (sandbox) {
    return path.join(path.resolve(sandbox), "artifacts", "runs", id);
  }
  return path.resolve(__dirname, "../../e2e-device", "artifacts", "runs", id);
}

// ── 已知错误模式 → 根因分类 ───────────────────────────────

const KNOWN_ERROR_PATTERNS: Array<{ pattern: RegExp; rootCause: string; fix: string[] }> = [
  {
    pattern: /ANDROID_HOME|ANDROID_SDK_ROOT/,
    rootCause: "ANDROID_HOME_NOT_SET",
    fix: [
      "设置 ANDROID_HOME 环境变量指向 Android SDK 路径",
      "确保 .e2e-local.json 中已自动检测到 SDK 路径",
      "如未安装 SDK，运行 bash e2e-device/scripts/install-android-sdk.sh",
    ],
  },
  {
    pattern: /chromedriver.*not found|chromedriver.*version|ChromeDriver.*mismatch/,
    rootCause: "CHROMEDRIVER_MISMATCH",
    fix: [
      "预检已尝试自动下载匹配 chromedriver，检查 ~/.appium/chromedriver/ 目录",
      "手动设置 export E2E_CHROMEDRIVER_PATH=<path>",
      "确认设备 WebView 版本与 chromedriver 版本一致",
    ],
  },
  {
    pattern: /Unable to compile TypeScript|TSError/,
    rootCause: "SPEC_TS_COMPILE_ERROR",
    fix: [
      "模板生成的 spec 文件有 TypeScript 类型错误",
      "运行 e2e-device/scripts/scaffold.sh --sync-missing 同步最新模板",
      "或在与仓库匹配的 skill 版本中运行 ensure-skill-runtime.sh",
    ],
  },
  {
    pattern: /No WEBVIEW context|WEBVIEW.*not.*appear/,
    rootCause: "WEBVIEW_NOT_FOUND",
    fix: [
      "确认手机已打开 H5 页面（深链是否正确）",
      "检查 manifest.hybrid.deepLink.h5Action 配置是否匹配 App 实际路由",
      "vivo/OPPO 设备尝试手动打开 App 后重试",
      "检查 `adb shell cat /proc/net/unix | grep webview` 确认 WebView 调试端口",
    ],
  },
  {
    pattern: /Failed to create session|session not created/,
    rootCause: "APPIUM_SESSION_FAILED",
    fix: [
      "检查 Appium 是否在运行：curl http://127.0.0.1:4723/status",
      "重启 Appium 服务并重试",
      "检查 udid 是否正确：adb devices",
      "确认 App 未崩溃",
    ],
  },
  {
    pattern: /Neither ANDROID_HOME|Failed to create session/,
    rootCause: "ANDROID_SDK_MISCONFIGURED",
    fix: [
      "设置 ANDROID_HOME 和 ANDROID_SDK_ROOT 环境变量",
      "检查 Android SDK 是否包含 platforms 和 build-tools 目录",
      "运行 bash e2e-device/scripts/install-android-sdk.sh",
    ],
  },
  {
    pattern: /timeout|Timeout/,
    rootCause: "OPERATION_TIMEOUT",
    fix: [
      "增加对应操作超时时间（见 config/timeouts.ts）",
      "检查设备网络连接是否稳定",
      "低性能设备需要更长的等待时间",
    ],
  },
  {
    pattern: /Cannot find module|Module not found/,
    rootCause: "MODULE_NOT_FOUND",
    fix: [
      "运行 ensure-host-deps.sh wdio 重新安装依赖",
      "检查 e2e-device/node_modules 是否完整",
      "确认所有 imports 路径正确",
    ],
  },
  {
    pattern: /platformName|RemoteCapability/,
    rootCause: "TYPE_ERROR_PLATFORM_NAME",
    fix: [
      "browser.capabilities 在 TypeScript 中类型为 RemoteCapability",
      "使用 (browser.capabilities as WebdriverIO.Capabilities).platformName",
      "已在最新模板中添加 // @ts-nocheck 跳过类型检查",
    ],
  },
];

function classifyError(errorMessage: string): { rootCause: string; fix: string[] } {
  for (const entry of KNOWN_ERROR_PATTERNS) {
    if (entry.pattern.test(errorMessage)) {
      return { rootCause: entry.rootCause, fix: entry.fix };
    }
  }
  return {
    rootCause: "UNCAUGHT_ERROR",
    fix: ["查看完整调用栈定位问题", "在对应位置增加 try/catch", "检查边界条件"],
  };
}

// ── 路径 / 目录工具 ────────────────────────────────────────

function snapshotsDir(runId: string): string {
  const dir = path.join(runArtifactsDir(runId), "diagnostic-snapshots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function problemsLogPath(runId: string): string {
  const dir = runArtifactsDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "problems-collected.jsonl");
}

// ── 修复建议模板库 ──────────────────────────────────────────

const FIX_TEMPLATES: Record<string, Omit<SuggestedFix, "caseId">> = {
  KEYBOARD_NOT_SHOWN: {
    approaches: [
      "检查 Appium driver 的 unicodeKeyboard / resetKeyboard 配置",
      "验证设备输入法未被第三方覆盖",
      "尝试 adb shell ime list -s 确认当前输入法",
    ],
    risk: "low",
    estimatedEffort: "30min",
    references: ["https://github.com/appium/appium/issues?q=keyboard+not+shown"],
  },
  INPUT_OCCLUDED: {
    approaches: [
      "设置 viewport meta: <meta name='viewport' content='... interactive-widget=resizes-content'>",
      "使用 visualViewport API 监听键盘高度变化并调整布局",
      "给表单底部加 padding-bottom: env(keyboard-inset-height, 300px)（CSS env 降级）",
      "若仅 iOS 问题：检查 font-size >= 16px，避免触发 iOS 自动缩放",
    ],
    risk: "low",
    estimatedEffort: "2h",
    references: [
      "https://developer.chrome.com/docs/web-platform/virtual-keyboard",
      "https://loke.dev/blog/stop-using-dvh-interactive-widget-mobile-keyboard",
    ],
  },
  NO_INPUT_FOUND: {
    approaches: [
      "确认页面是否正确渲染，input 是否在 DOM 中",
      "检查是否有延迟渲染（Suspense/Lazy）导致元素尚未挂载",
      "增加等待超时时间适应慢网络/低性能设备",
    ],
    risk: "low",
    estimatedEffort: "30min",
    references: [],
  },
  DATA_LOST_ON_BACK: {
    approaches: [
      "将表单状态提升到父组件或全局 store",
      "使用 sessionStorage 自动保存 + pageshow event 恢复",
      "检查 bfcache 是否被禁用（Cache-Control: no-store / unload 事件）",
      "在 pageshow 中检查 event.persisted 并触发数据恢复",
    ],
    risk: "medium",
    estimatedEffort: "4h",
    references: ["https://web.dev/articles/bfcache"],
  },
  ANDROID_HOME_NOT_SET: {
    approaches: [
      "设置 export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools",
      "检查 .e2e-local.json 中 env.ANDROID_HOME 是否已自动检测",
      "运行 bash e2e-device/scripts/install-android-sdk.sh 安装 SDK",
    ],
    risk: "high",
    estimatedEffort: "10min",
    references: [],
  },
  CHROMEDRIVER_MISMATCH: {
    approaches: [
      "预检已自动下载匹配 chromedriver，检查 ~/.appium/chromedriver/",
      "手动设置 export E2E_CHROMEDRIVER_PATH=<path>",
      "查看当前设备 WebView 版本并下载对应 chromedriver",
    ],
    risk: "medium",
    estimatedEffort: "15min",
    references: [],
  },
  SPEC_TS_COMPILE_ERROR: {
    approaches: [
      "运行 e2e-device/scripts/scaffold.sh --sync-missing 更新模板",
      "已添加 // @ts-nocheck 到模板 spec 文件头部跳过类型检查",
      "或更新 ~/.agents/skills/e2e-device 到最新版本",
    ],
    risk: "low",
    estimatedEffort: "5min",
    references: [],
  },
  WEBVIEW_NOT_FOUND: {
    approaches: [
      "确认手机已通过深链打开 H5 页面",
      "检查 manifest.hybrid.deepLink 配置",
      "vivo/OPPO 设备重试前先手动打开 App",
      "用 adb shell cat /proc/net/unix | grep webview 查看 WebView 调试端口",
    ],
    risk: "high",
    estimatedEffort: "30min",
    references: [],
  },
  APPIUM_SESSION_FAILED: {
    approaches: [
      "重启 Appium 服务并重试",
      "检查 udid 是否正确：adb devices",
      "确认 App 未崩溃",
    ],
    risk: "medium",
    estimatedEffort: "10min",
    references: [],
  },
  ANDROID_SDK_MISCONFIGURED: {
    approaches: androidSdkFixApproaches(),
    risk: "high",
    estimatedEffort: "20min",
    references: [],
  },
  OPERATION_TIMEOUT: {
    approaches: [
      "增加对应超时时间（通过 E2E_TIMEOUT_* 环境变量）",
      "检查设备网络连接是否稳定",
      "低性能设备需要更长等待时间",
    ],
    risk: "low",
    estimatedEffort: "5min",
    references: [],
  },
  TYPE_ERROR_PLATFORM_NAME: {
    approaches: [
      "browser.capabilities 类型为 RemoteCapability，platformName 是可选属性",
      "使用类型断言：(browser.capabilities as WebdriverIO.Capabilities).platformName",
      "已添加 // @ts-nocheck 跳过类型检查",
    ],
    risk: "low",
    estimatedEffort: "5min",
    references: [],
  },
  UNCAUGHT_ERROR: {
    approaches: [
      "查看完整 stack trace 定位代码位置",
      "在对应位置增加 try/catch 和错误日志",
      "考虑边界条件处理",
    ],
    risk: "unknown",
    estimatedEffort: "待评估",
    references: [],
  },
};

function androidSdkFixApproaches(): string[] {
  return [
    "设置 ANDROID_HOME 和 ANDROID_SDK_ROOT 环境变量",
    "检查 SDK 路径：ls /opt/homebrew/share/android-commandlinetools/platforms/",
    "运行 bash e2e-device/scripts/install-android-sdk.sh 安装 SDK",
  ];
}

// ── 设备检测 ────────────────────────────────────────────────

function detectDeviceModel(): string {
  try {
    const caps = (globalThis as { browser?: { capabilities?: Record<string, unknown> } }).browser?.capabilities || {};
    return (caps.deviceModel || caps.deviceName || caps.model || process.env.E2E_DEVICE_MODEL || "unknown") as string;
  } catch {
    return "unknown";
  }
}

function detectOsVersion(): string {
  try {
    const caps = (globalThis as { browser?: { capabilities?: Record<string, unknown> } }).browser?.capabilities || {};
    return (caps.platformVersion || caps.os_version || process.env.E2E_DEVICE_OS || "unknown") as string;
  } catch {
    return "unknown";
  }
}

// ── 写入 Issue Ledger ──────────────────────────────────────

function appendToIssueLedger(runId: string, caseId: string, rootCause: string, message: string, snapshotFile: string): void {
  try {
    const ledgerPath = path.join(runArtifactsDir(runId), "cases-executed.jsonl");
    fs.appendFileSync(ledgerPath, JSON.stringify({
      caseId, outcome: "recorded_failure", rootCause, message: message.slice(0, 200),
      snapshotFile, at: new Date().toISOString(),
    }) + "\n");
  } catch { /* ignore */ }
}

// ════════════════════════════════════════════════════════════
//  Public API
// ════════════════════════════════════════════════════════════

/** 记录一次框架级失败（WDIO session 创建失败/TS 编译错误等，spec 未运行时） */
export function recordFrameworkFailure(
  caseId: string,
  errorMessage: string,
  specPath?: string,
  wdioOutput?: string,
): void {
  const runId = getRunId();
  const now = new Date().toISOString();
  const { rootCause, fix } = classifyError(errorMessage);

  const problemStack: ProblemStack = {
    timestamp: now,
    errorType: "Framework Error",
    errorMessage: wdioOutput ? `${errorMessage}\n\n${wdioOutput.slice(0, 3000)}` : errorMessage,
    callStack: errorMessage,
    extra: { specPath, frameworkError: true },
  };

  const reproductionPath: ReproductionPath = {
    deviceModel: detectDeviceModel(),
    osVersion: detectOsVersion(),
    webViewVersion: process.env.E2E_WEBVIEW_VERSION || "unknown",
    networkCondition: process.env.E2E_NETWORK_CONDITION || "wifi",
    stepsToReproduce: [
      `Case: ${caseId}`,
      `Spec: ${specPath || "N/A"}`,
      `Error: ${rootCause}`,
      `详情: ${errorMessage.slice(0, 200)}`,
      "查看以下修复建议进行排查",
    ],
    probability: "100%",
    extra: { runId, timestamp: now, platform: process.env.E2E_PLATFORM || "android", frameworkError: true },
  };

  const suggestedFixes: SuggestedFix[] = [
    {
      caseId,
      approaches: fix,
      risk: "medium",
      estimatedEffort: "30min",
      references: [],
    },
  ];

  // 写入快照
  const snapshotDir = snapshotsDir(runId);
  const snapshotFile = path.join(snapshotDir, `${caseId}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify({
    caseId, rootCause, message: errorMessage.slice(0, 500),
    problemStack, reproductionPath, suggestedFixes, recordedAt: now,
  }, null, 2));

  // 追加到 problems-collected.jsonl
  const logPath = problemsLogPath(runId);
  fs.appendFileSync(logPath, JSON.stringify({
    caseId, outcome: "recorded_failure", rootCause, message: errorMessage.slice(0, 500),
    problemStack, reproductionPath, suggestedFixes, recordedAt: now,
  }) + "\n");

  appendToIssueLedger(runId, caseId, rootCause, errorMessage.slice(0, 200), snapshotFile);

  console.log(`[diagnostic-collector] ❌ ${caseId} — ${rootCause}: ${errorMessage.slice(0, 100)}`);
  console.log(`    snapshot → ${snapshotFile}`);
}

/** 记录一次 L2 业务断言失败 */
export function recordFailure(
  caseId: string,
  rootCause: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const runId = getRunId();
  const now = new Date().toISOString();
  const fixTemplate = FIX_TEMPLATES[rootCause] || FIX_TEMPLATES["UNCAUGHT_ERROR"];

  const problemStack: ProblemStack = {
    timestamp: now,
    errorType: rootCause.startsWith("SKIP_") ? "Skipped" : "Assertion Error",
    errorMessage: message,
    callStack: extra?.stack as string | undefined,
    screenshotPath: extra?.screenshotPath as string | undefined,
    domSnapshot: JSON.stringify(extra?.domSnapshot || {}).slice(0, 2000),
    networkLog: extra?.networkLog as unknown[] | undefined,
    extra: extra || {},
  };

  const reproductionPath: ReproductionPath = {
    deviceModel: detectDeviceModel(),
    osVersion: detectOsVersion(),
    webViewVersion: process.env.E2E_WEBVIEW_VERSION || "unknown",
    networkCondition: process.env.E2E_NETWORK_CONDITION || "wifi",
    stepsToReproduce: [
      `用例: ${caseId}`,
      `错误: ${rootCause}`,
      `详情: ${message}`,
      "查看 diagnostic-snapshots 目录中的完整截图和 DOM 快照",
    ],
    probability: "100%",
    extra: { runId, timestamp: now, platform: process.env.E2E_PLATFORM || "android" },
  };

  const suggestedFixes: SuggestedFix[] = [
    {
      caseId,
      approaches: fixTemplate.approaches,
      risk: fixTemplate.risk,
      estimatedEffort: fixTemplate.estimatedEffort,
      references: fixTemplate.references,
    },
  ];

  const snapshot = { caseId, rootCause, message, problemStack, reproductionPath, suggestedFixes, recordedAt: now, extra };
  const snapshotDir = snapshotsDir(runId);
  const snapshotFile = path.join(snapshotDir, `${caseId}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

  const logPath = problemsLogPath(runId);
  fs.appendFileSync(logPath, JSON.stringify(snapshot) + "\n");

  appendToIssueLedger(runId, caseId, rootCause, message, snapshotFile);

  console.log(`[diagnostic-collector] ❌ ${caseId} — ${rootCause}: ${message.slice(0, 100)}`);
  console.log(`    snapshot → ${snapshotFile}`);
}

/** 记录一次通过 */
export function recordPass(caseId: string, extra?: Record<string, unknown>): void {
  const runId = getRunId();
  const logPath = problemsLogPath(runId);
  fs.appendFileSync(logPath, JSON.stringify({ caseId, outcome: "passed", recordedAt: new Date().toISOString(), extra }) + "\n");
  console.log(`[diagnostic-collector] ✅ ${caseId} — passed`);
}

/** 获取指定 runId 下所有已采集的问题 */
export function getCollectedProblems(runId?: string): Array<{
  caseId: string;
  rootCause: string;
  message: string;
  problemStack: ProblemStack;
  reproductionPath: ReproductionPath;
  suggestedFixes: SuggestedFix[];
  snapshotFile: string;
}> {
  const id = runId || getRunId();
  const logPath = problemsLogPath(id);
  if (!fs.existsSync(logPath)) return [];

  const problems: any[] = [];
  for (const line of fs.readFileSync(logPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.outcome !== "passed" && row.rootCause) problems.push(row);
    } catch { /* skip */ }
  }
  return problems;
}

export type { ProblemStack, ReproductionPath, SuggestedFix };
