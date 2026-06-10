/**
 * diagnostic-collector.ts
 * 诊断信息采集器 — L2 业务断言失败时收集问题栈，不自动修复，不阻断。
 *
 * 分层策略:
 *   L0 (Native容器): 登录过期/USB授权 → resilience 层 auto-fix 保留，修复后重试
 *   L1 (Hybrid通道): URL错/数据空/参数错 → resilience 层 auto-fix 保留，修复后重试
 *   L2 (业务H5): 键盘遮挡/弹窗穿透/表单丢失 → 本模块 recordFailure() 记录，不修不重试
 *
 * 采集内容：ProblemStack（错误栈） + ReproductionPath（复现路径） + SuggestedFix（修复建议）
 * 所有采集写入 artifacts/runs/<runId>/diagnostic-snapshots/<caseId>.json
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ProblemStack,
  ReproductionPath,
  SuggestedFix,
  CaseRecord,
} from "./types";

const artifactsRoot = path.resolve(
  process.env.E2E_ARTIFACTS_ROOT || path.join(__dirname, "../../e2e-device", "artifacts")
);

function getRunId(): string {
  return process.env.E2E_RUN_ID || `adhoc-${Date.now()}`;
}

function snapshotsDir(runId: string): string {
  const dir = path.join(artifactsRoot, "runs", runId, "diagnostic-snapshots");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function problemsLogPath(runId: string): string {
  const dir = path.join(artifactsRoot, "runs", runId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "problems-collected.jsonl");
}

// ==================== Suggested Fix 模板库 ====================
// 根据 rootCause 自动推荐修复方案

const FIX_TEMPLATES: Record<string, Omit<SuggestedFix, "caseId">> = {
  KEYBOARD_NOT_SHOWN: {
    approaches: [
      "检查 Appium driver 的 unicodeKeyboard / resetKeyboard 配置",
      "验证设备输入法未被第三方覆盖",
      "尝试 adb shell ime list -s 确认当前输入法",
    ],
    risk: "low",
    estimatedEffort: "30min",
    references: [
      "https://github.com/appium/appium/issues?q=keyboard+not+shown",
    ],
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
  FLICKER_DETECTED: {
    approaches: [
      "在输入框焦点切换时加入防抖/节流（debounce 100ms）",
      "使用 requestAnimationFrame 包裹 scrollIntoView 调用",
      "检查是否有多个 scroll 事件监听器冲突",
    ],
    risk: "low",
    estimatedEffort: "1h",
    references: [],
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
  MODAL_NOT_CLOSED: {
    approaches: [
      "检查 Android onBackPressed() 是否正确处理弹窗关闭",
      "验证弹窗组件是否监听了 popstate / hardwareBackPress 事件",
      "对于 React Navigation: 确保 modal 在 Stack 中正确配置",
    ],
    risk: "medium",
    estimatedEffort: "2h",
    references: ["https://reactnavigation.org/docs/navigation-events"],
  },
  DATA_LOST_ON_BACK: {
    approaches: [
      "将表单状态提升到父组件或全局 store（Redux/Zustand/Jotai）",
      "使用 FormProvider（react-hook-form）跨步骤共享表单实例",
      "实现 sessionStorage 自动保存 + pageshow event 恢复",
      "检查 bfcache 是否被禁用（Cache-Control: no-store / unload 事件）",
      "在 pageshow 中检查 event.persisted 并触发数据恢复",
    ],
    risk: "medium",
    estimatedEffort: "4h",
    references: [
      "https://web.dev/articles/bfcache",
      "https://auditbuffet.com/patterns/ab-002369",
    ],
  },
  DATA_LOST: {
    approaches: [
      "实现 dual-write 策略：同时写 sessionStorage + localStorage",
      "读取时 sessionStorage 优先，localStorage 做 fallback",
      "表单提交成功后立即清除对应草稿",
      "增加页面离开确认（beforeunload/pagehide 检查未保存数据）",
    ],
    risk: "medium",
    estimatedEffort: "3h",
    references: [
      "https://dev.to/forrestmiller/instagram-wipes-localstorage-on-navigation-8e0",
    ],
  },
  DATA_POLLUTED: {
    approaches: [
      "A 页面使用 ref/state 暂存数据，B 取消时不写入共享 store",
      "回传数据使用特定 channel/key，与 A 自身数据隔离",
      "B 取消时发送 { action: 'cancel' } 消息，A 忽略并保持原状态",
    ],
    risk: "low",
    estimatedEffort: "2h",
    references: [],
  },
  SENSITIVE_NOT_CLEARED: {
    approaches: [
      "登出时遍历清除所有 token/session 相关 LS key",
      "使用 key 前缀约定（如 auth:），批量清除",
      "登出后执行 location.reload() 确保内存状态同步清除",
    ],
    risk: "high",
    estimatedEffort: "1h",
    references: [],
  },
  DRAFT_NOT_CLEARED: {
    approaches: [
      "表单提交成功回调中执行 localStorage.removeItem(draftKey)",
      "使用 formId 作为 draft key，精确清除不误伤",
      "增加 TTL 过期自动清理机制",
    ],
    risk: "low",
    estimatedEffort: "1h",
    references: [],
  },
  LS_NOT_PERSISTED: {
    approaches: [
      "检查 WebView 是否设置了 domStorageEnabled=true",
      "Android API<19 需额外设置 setDatabasePath",
      "确保所有页面加载自同一 origin（file:// 不支持 LS 跨页）",
    ],
    risk: "medium",
    estimatedEffort: "2h",
    references: [
      "https://developer.android.com/reference/android/webkit/WebSettings#setDomStorageEnabled(boolean)",
    ],
  },
  LS_UNAVAILABLE: {
    approaches: [
      "所有 LS 操作包裹 try/catch，失败时降级到内存 Map",
      "检测隐私模式并使用 sessionStorage 或内存存储",
      "启动时检查 LS 可用性，不可用时提示用户（非崩溃）",
    ],
    risk: "medium",
    estimatedEffort: "2h",
    references: [],
  },
  NO_NATIVE_BRIDGE: {
    approaches: [
      "检查 Native 端是否正确注册了 JSBridge 接口",
      "Android: WebView.addJavascriptInterface 或 addWebMessageListener",
      "iOS: WKUserContentController.addScriptMessageHandler",
    ],
    risk: "medium",
    estimatedEffort: "3h",
    references: [
      "https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge",
    ],
  },
  SPECIAL_CHAR_FAIL: {
    approaches: [
      "Bridge 消息统一使用 JSON.stringify/parse，避免手动拼接",
      "对特殊字符做 encodeURIComponent 转义",
      "Native 端检查字符串编码处理（UTF-8）",
    ],
    risk: "medium",
    estimatedEffort: "1h",
    references: [],
  },
  NO_OPEN_MODAL: {
    approaches: [
      "此 case 需要在测试前确保页面存在可触发的弹窗",
      "在 preconditions 中明确：先点击某按钮触发弹窗再执行此 case",
    ],
    risk: "low",
    estimatedEffort: "15min",
    references: [],
  },
  BODY_STILL_LOCKED: {
    approaches: [
      "弹窗关闭时恢复 body overflow/position 为原始值",
      "使用 bodyScrollLock.clearBodyLocks() 统一清理",
      "在弹窗组件的 cleanup/useEffect return 中解除锁定",
    ],
    risk: "medium",
    estimatedEffort: "1h",
    references: ["https://www.npmjs.com/package/body-scroll-lock-upgrade"],
  },
  SHORT_MODAL_NO_LOCK: {
    approaches: [
      "弹窗（无论长短）打开时始终锁定 body 滚动",
      "使用 body:has(dialog[open]) { overflow: hidden } CSS 方案",
      "配合 position: fixed + scrollTop 恢复避免跳动",
    ],
    risk: "low",
    estimatedEffort: "2h",
    references: ["https://css-tricks.com/prevent-a-page-from-scrolling-while-a-dialog-is-open/"],
  },
  NO_FORM_FIELDS: {
    approaches: [
      "确认当前页面是否为表单页面，非表单页面跳过此 case",
      "在 preconditions 中明确定义需要测试的具体页面 URL",
    ],
    risk: "low",
    estimatedEffort: "15min",
    references: [],
  },
  FALLBACK_FAILED: {
    approaches: [
      "为低版本 Chrome（<144）实现 JS body-scroll-lock 降级方案",
      "使用 body-scroll-lock-upgrade npm 包统一处理",
      "检测 CSS.supports('overscroll-behavior', 'contain') 判断是否需降级",
    ],
    risk: "medium",
    estimatedEffort: "3h",
    references: ["https://www.npmjs.com/package/body-scroll-lock-upgrade"],
  },
  SKIP_NON_IOS: {
    approaches: ["此 case 需要 iOS 设备，标记跳过不视为失败"],
    risk: "low",
    estimatedEffort: "0",
    references: [],
  },
  SKIP_NON_ANDROID: {
    approaches: ["此 case 需要 Android 设备，标记跳过不视为失败"],
    risk: "low",
    estimatedEffort: "0",
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

// ==================== Public API ====================

/** 记录一次失败 — 收集问题栈、复现路径、修复建议 */
export function recordFailure(
  caseId: string,
  rootCause: string,
  message: string,
  extra?: Record<string, unknown>
): void {
  const runId = getRunId();
  const now = new Date().toISOString();

  // 构建 ProblemStack
  const problemStack: ProblemStack = {
    timestamp: now,
    errorType: rootCause.startsWith("SKIP_") ? "Skipped" : "Assertion Error",
    errorMessage: message,
    callStack: extra?.stack as string | undefined,
    screenshotPath: extra?.screenshotPath as string | undefined,
    domSnapshot: JSON.stringify(extra?.domSnapshot || {}).slice(0, 2000),
    networkLog: extra?.networkLog as any[] | undefined,
    extra: extra || {},
  };

  // 构建 ReproductionPath（从环境变量和设备信息推断）
  const reproductionPath: ReproductionPath = {
    deviceModel: process.env.E2E_DEVICE_MODEL || detectDeviceModel(),
    osVersion: process.env.E2E_DEVICE_OS || detectOsVersion(),
    webViewVersion: process.env.E2E_WEBVIEW_VERSION || "unknown",
    networkCondition: process.env.E2E_NETWORK_CONDITION || "wifi",
    stepsToReproduce: [
      `用例: ${caseId}`,
      `错误: ${rootCause}`,
      `详情: ${message}`,
      "查看 diagnostic-snapshots 目录中的完整截图和 DOM 快照",
    ],
    probability: "100%",
    extra: {
      runId,
      timestamp: now,
      platform: process.env.E2E_PLATFORM || "android",
    },
  };

  // 构建 SuggestedFix（从模板库查找）
  const fixTemplate = FIX_TEMPLATES[rootCause] || FIX_TEMPLATES["UNCAUGHT_ERROR"];
  const suggestedFixes: SuggestedFix[] = [
    {
      caseId,
      approaches: fixTemplate.approaches,
      risk: fixTemplate.risk,
      estimatedEffort: fixTemplate.estimatedEffort,
      references: fixTemplate.references,
    },
  ];

  // 写入快照
  const snapshot = {
    caseId,
    rootCause,
    message,
    problemStack,
    reproductionPath,
    suggestedFixes,
    recordedAt: now,
    extra,
  };

  const snapshotDir = snapshotsDir(runId);
  const snapshotFile = path.join(snapshotDir, `${caseId}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

  // 追加到 problems-collected.jsonl
  const logPath = problemsLogPath(runId);
  fs.appendFileSync(logPath, JSON.stringify(snapshot) + "\n");

  // 同时写入到 resilience issue ledger
  appendToIssueLedger(runId, caseId, rootCause, message, snapshotFile);

  // 终端输出
  console.log(
    `[diagnostic-collector] ❌ ${caseId} — ${rootCause}: ${message.slice(0, 100)}`
  );
  console.log(`    snapshot → ${snapshotFile}`);
}

/** 记录一次通过 */
export function recordPass(
  caseId: string,
  extra?: Record<string, unknown>
): void {
  const runId = getRunId();

  // 追加到 problems-collected.jsonl（标记 passed）
  const logPath = problemsLogPath(runId);
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      caseId,
      outcome: "passed",
      recordedAt: new Date().toISOString(),
      extra,
    }) + "\n"
  );

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
      if (row.outcome !== "passed" && row.rootCause) {
        problems.push(row);
      }
    } catch { /* skip */ }
  }
  return problems;
}

// ==================== Private helpers ====================

function detectDeviceModel(): string {
  try {
    const caps = (global as any).browser?.capabilities || {};
    return (
      caps.deviceModel ||
      caps.deviceName ||
      caps.model ||
      process.env.E2E_DEVICE_MODEL ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

function detectOsVersion(): string {
  try {
    const caps = (global as any).browser?.capabilities || {};
    return (
      caps.platformVersion ||
      caps.os_version ||
      process.env.E2E_DEVICE_OS ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

function appendToIssueLedger(
  runId: string,
  caseId: string,
  rootCause: string,
  message: string,
  snapshotFile: string
): void {
  try {
    const resilienceDir = path.join(
      artifactsRoot,
      "runs",
      runId
    );
    if (!fs.existsSync(resilienceDir)) {
      fs.mkdirSync(resilienceDir, { recursive: true });
    }
    const ledgerPath = path.join(resilienceDir, "cases-executed.jsonl");
    fs.appendFileSync(
      ledgerPath,
      JSON.stringify({
        caseId,
        outcome: "recorded_failure",
        rootCause,
        message: message.slice(0, 200),
        snapshotFile,
        at: new Date().toISOString(),
      }) + "\n"
    );
  } catch {
    // ledger write failure should not affect test flow
  }
}

// 导出类型供外部使用
export type { ProblemStack, ReproductionPath, SuggestedFix };
