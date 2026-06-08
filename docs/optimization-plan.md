## e2e-device Skill 优化计划（v2）

**基线**：2026-06-03 深度分析报告（22 项问题 + 3 项架构建议 + 4 项设计观察）  
**v2 更新**：2026-06-08 多维专家评审（测试专家·前端专家·全栈专家）新增 11 项 + 重新定级 6 项  
**目标**：分 5 个阶段实施全部 46 个优化项 + 架构改进，使 Skill 达到生产级质量

---

### 评审概要

| 评审视角 | 新增 Issue | 关键发现 |
|----------|-----------|---------|
| 测试专家 | #36~#39 | JS错误盲区、数据生命周期缺失、弱网无模拟、Flaky无检测 |
| 前端专家 | #40~#43 | JSBridge盲区、性能度量缺失、WebView版本无感知、视觉回归无覆盖 |
| 全栈专家 | #44~#47 | 厂商碎片化未覆盖、会话泄漏、构建集成断裂、SSL pinning策略缺失 |

---

### 总体策略

按依赖关系和影响面将 46 个优化项拆为 **5 个实施阶段**，每个阶段内部按逻辑顺序排列。

```
Phase 1    消除运行时崩溃 + 安全漏洞 + 数据错误     (P0 + P1 安全/正确性)
Phase 2    代码质量 + 可观测性 + 一致性              (P2 全部)
Phase 2.5  真机测试核心能力补全                       (高优先级新增项)
Phase 3    打磨 + 可维护性提升 + 基础可测试性         (P3 + 前置的架构项)
Phase 4    架构演进                                   (剩余架构项 + 高级能力)
```

---

### Phase 1：消除运行时崩溃 + 安全漏洞 + 数据正确性

本阶段目标：让 scaffold 模板的每一个代码路径都能正常运行，不存在必定崩溃的 import、不存在 shell 注入风险、不存在产物路径分裂、不存在报告数据失真。

---

#### Issue #1 — 补全缺失模块引用 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P0 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | 3 处 import 引用了 scaffold 中不存在的模块 |
| **实施结果** | `config/env.ts`、`helpers/app-launcher.ts`、`resilience/cdp-mock.ts` 已创建 |

---

#### Issue #2 — 统一路径解析 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P0 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `issue-ledger.ts` 硬编码路径与 `paths.ts` 不一致 |
| **实施结果** | 移除硬编码，统一导入 `artifactsRoot()` 和 `e2eDeviceRoot()` |

---

#### Issue #3 — 清除试点域名残留 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P0 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `"damageMisApply"`、`"/v2"` 硬编码在通用模板中 |
| **实施结果** | fallback 从 manifest 读取；spec 断言动态生成 |

---

#### Issue #4 — 修复 Shell 注入风险 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `execSync` + 字符串拼接构造 shell 命令 |
| **实施结果** | 全部替换为 `execFileSync(command, [args...])` 模式 |

---

#### Issue #5 — 消除两个 common.sh 共存 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `scripts/common.sh` 与 `scripts/lib/common.sh` 行为分歧 |
| **实施结果** | legacy 版重定向到规范版 |

---

#### Issue #6 — 修复 bash 3.2 兼容性 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `lib/common.sh` 的 `${!env_var}` 在 bash 3.2 下报错 |
| **实施结果** | 改用兼容写法 |

---

#### Issue #7 — 提取 WebView 共享工具函数 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | WebView wait-and-switch 逻辑在 4 处重复 |
| **实施结果** | `deeplink.ts`、`app-launch.spec.ts` 改为调用 `switchToWebViewContaining` |

---

#### Issue #8 — CLI 边界输入校验 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **状态** | ✅ 已完成 |
| **问题** | `cli.ts` 的 `JSON.parse` 调用无 try/catch，args 数组无长度校验，类型断言无运行时检查 |
| **涉及文件** | `orchestration/cli.ts` |
| **实施方案** | 为所有 `JSON.parse` 添加 try/catch 并输出友好错误信息；为需要参数的 command 添加 `args.length` 校验；`args[0] as "passed" | "failed" | "partial"` 替换为运行时检查 |
| **验收标准** | 传入非法 JSON、空参数、无效 status 时输出清晰错误信息而非裸 stack trace；exit code 非 0 |
| **依赖** | 无前置依赖 |

---

#### Issue #9 — 修复韧性报告指标始终为零 ✅ 已完成 (原P1→升级P0)

| 维度 | 内容 |
|------|------|
| **优先级** | ~~P1~~ → **P0**（报告核心数据源始终为假数据） |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `aggregateFromRunDir()` 中 passedLive / passedWithMock / errors 始终为 0 |
| **实施结果** | 已根据 JSONL 行数据实际计算，扩展 schema 含 `mockLayer`/`autoFixed` |

---

#### Issue #10 — 修复 write-archive.ts 的类型安全 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **状态** | ✅ 已完成 |
| **问题** | `updateSection()` 使用 `as never` 绕过类型检查 |
| **涉及文件** | `orchestration/write-archive.ts` |
| **实施方案** | 将 `as never` 替换为类型安全的深合并：定义 `SectionKey` 类型，使用 `Partial<RunArchive["sections"][K]>` 泛型约束 data 参数 |
| **验收标准** | TypeScript 编译无 `as never` 类型逃逸 |
| **依赖** | 无前置依赖 |

---

#### Issue #17 — run-sequential.ts 竞态条件 + 退出码保留 ★从P2升级 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | ~~P2~~ → **P1**（并发执行错 case 属于数据正确性问题） |
| **状态** | ✅ 已完成 |
| **问题** | `runNextCase()` 读 JSONL 判断下一个 case 无文件锁；所有非零退出码被统一映射为 1 |
| **涉及文件** | `orchestration/run-sequential.ts` |
| **实施方案** | 添加 `E2E_SEQUENTIAL_LOCK` 环境变量控制并发禁止；退出码保留原始 `wdio.status`，signal 终止时记录 signal 名 |
| **验收标准** | 两个并发 `orch_cli run-next-case` 不会执行同一 case；wdio 超时 kill 时 JSONL 记录 signal 信息 |
| **依赖** | 无前置依赖 |

---

#### Issue #23 — 实现 reset-session.ts + 清理死代码 ★从P3升级 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | ~~P3~~ → **P1**（空实现被调用导致测试隔离性幻觉） |
| **状态** | ✅ 已完成 |
| **问题** | `reset-session.ts` 是空实现但仍被调用；spec 间状态泄漏可能产生 false positive/negative |
| **涉及文件** | `helpers/reset-session.ts`、`helpers/login.ts`、`helpers/android-sdk.ts` |
| **实施方案** | 实现基础清理：`browser.deleteAllCookies()` + `localStorage.clear()` + `sessionStorage.clear()`。移除 `login.ts` 中 `loggedInIndicators` 死代码。`android-sdk.ts` 空值时添加 warning |
| **验收标准** | 两个 spec 顺序跑，第二个不继承第一个的 localStorage；无空函数体被调用 |
| **依赖** | 无前置依赖 |

---

#### Issue #29 — write-archive.ts archives Map 磁盘持久化 ★从P2升级 ✅ 已完成

| 维度 | 内容 |
|------|------|
| **优先级** | ~~P2~~ → **P1**（跨 CLI 进程状态不可靠） |
| **状态** | ✅ 已完成 |
| **问题** | `archives` Map 是模块级可变状态，但每次 `orch_cli` 是独立进程，`latestArchive()` 回退逻辑在 CLI 多次调用场景下不可靠 |
| **涉及文件** | `orchestration/write-archive.ts` |
| **实施方案** | `startRunArchive()` 写入磁盘 `archive.json`；`getRunArchive()` / `latestArchive()` 从磁盘读取；移除 `finishRunArchive()` 中的 `archives.delete()` |
| **验收标准** | 两个独立 `orch_cli` 进程中第二个能读取第一个写入的 archive |
| **依赖** | 依赖 #2（路径统一）和 #10（类型安全） |

---

### Phase 2：代码质量 + 可观测性 + 一致性

本阶段目标：消除静默错误吞没、统一超时管理、统一 API 调用风格、修复 mock 缺陷、消除竞态、修复跨进程状态问题、去除代码重复。

---

#### Issue #11 — 消除静默错误吞没

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | 6+ 文件的 try/catch 捕获异常后不做任何处理 |
| **涉及文件** | `orchestration/probe-env.ts`、`orchestration/discover-project.ts`、`orchestration/publish-reports.ts`、`resilience/issue-ledger.ts`、`resilience/runtime-session.ts`、`config/local-config.ts` |
| **实施方案** | 每个 catch 块增加 `E2E_DEBUG` 条件日志；`readLocalConfig()` 区分文件不存在/JSON 损坏 |
| **验收标准** | `E2E_DEBUG=1` 下可看到被吞没的错误日志 |
| **依赖** | Phase 1 完成后 |

---

#### Issue #12 — 统一使用集中式 timeouts

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | `browser.pause()` 6 处调用中仍有硬编码 |
| **涉及文件** | `helpers/login.ts`（pause→waitUntil）、`deeplink.ts`（保留 timeouts 引用）、`session.ts`、`suite-entry.ts` |
| **实施方案** | 将 `browser.pause(timeouts.xxx)` 改为 `await browser.waitUntil(...)` 形式（登录场景）；或确认已是 timeouts 引用 |
| **验收标准** | `browser.pause(N)` 硬编码数字形式为零 |
| **依赖** | 依赖 #7 |

---

#### Issue #13 — 统一 browser/driver 全局变量

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | `webview-context.ts` 混用 `browser.*` 和 `driver.*` |
| **涉及文件** | `helpers/webview-context.ts` |
| **实施方案** | 统一为 `browser.*`；显式 import `{ browser } from "@wdio/globals"` |
| **验收标准** | `driver.` 使用仅限 import 语句 |

---

#### Issue #14 — 修复 XHR Mock double-open 缺陷

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | passthrough 路径真实 XHR 未被 `open()`；缺少 responseType/状态码支持 |
| **涉及文件** | `inject/web-request-mock.js` |
| **实施方案** | 修复 passthrough：先 `xhr.open()` 再 `xhr.send()`；支持 `responseType: "json"`、fixture `status` 字段 |
| **验收标准** | passthrough 不再报 InvalidStateError；`"status": 404` 时返回 404 |
| **依赖** | 无前置依赖 |

---

#### Issue #15 — discover-hybrid.ts 输入校验

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | domain 名称直接插值到生成的 TypeScript 代码中 |
| **涉及文件** | `orchestration/discover-hybrid.ts` |
| **实施方案** | `const safeDomain = domain.replace(/[^a-zA-Z0-9_-]/g, "")` |
| **验收标准** | 含特殊字符的 domain 不在生成 spec 中产生可执行代码 |

---

#### Issue #16 — wdio.conf.template.ts relaxedSecurity 可配置

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | Appium `relaxedSecurity` 无条件 true |
| **涉及文件** | `templates/scaffold/wdio.conf.template.ts` |
| **实施方案** | `relaxedSecurity: process.env.E2E_APPIUM_RELAXED_SECURITY === "1"` |
| **验收标准** | 默认关闭，`E2E_APPIUM_RELAXED_SECURITY=1` 时启用 |

---

#### Issue #25 — validate-skill-dry-run.sh 增强 ★从P3升级

| 维度 | 内容 |
|------|------|
| **优先级** | ~~P3~~ → **P2**（校验脚本是防止回归的第一道防线） |
| **状态** | ⚠️ 待实施 |
| **问题** | 禁止词列表需更新覆盖新发现的残留问题、新增硬编码数字检测 |
| **涉及文件** | `scripts/validate-skill-dry-run.sh` |
| **实施方案** | 新增 `"damageMisApply"`、`"/v2/"` 扫描；增加 `browser.pause(` + 数字检测；增加 `as never`/`as any` 检测；增加 `// TODO` 计数 |
| **验收标准** | 能检测到所有 P0 级残留问题 |
| **依赖** | 依赖 #3、#4、#12 |

---

#### Issue #30 — preflight-check.ts 代码去重

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **状态** | ⚠️ 待实施 |
| **问题** | 三个 check 函数结构几乎完全相同；`sdkHasRequiredLayout` 重复定义 |
| **涉及文件** | `orchestration/preflight-check.ts`、`orchestration/env-checks.ts` |
| **实施方案** | 提取 `checkBin()` 通用函数；`sdkHasRequiredLayout` 移入单一文件 |
| **验收标准** | 三个 check 函数行数减少 60%+；无重复定义 |

---

### Phase 2.5：真机测试核心能力补全 🆕

本阶段目标：从测试专家、前端专家、全栈专家视角补全真机 E2E 测试中缺失的关键能力。这些能力直接影响测试的可信度和问题定位效率。

---

#### Issue #36 🆕 — WebView JS 错误捕获与 Console 监控 [测试专家·T1]

| 维度 | 内容 |
|------|------|
| **优先级** | P1（生产环境测试盲区，H5 错误完全不可见） |
| **对应陷阱** | pit-007（console 错误忽略）、pit-009（WebView 调试不可靠） |
| **问题** | 测试执行过程中 WebView 内的 `console.error`、`unhandledrejection`、JS 运行时错误完全未被采集。`DiagnosticSnapshot` 类型无 `jsErrors` 字段 |
| **涉及文件** | `inject/web-request-mock.js`、`resilience/types.ts`、`resilience/runtime-session.ts`、`orchestration/diagnose-run.ts` |
| **实施方案** | 1. 在 `web-request-mock.js` 的 IIFE 中新增 `window.onerror` / `addEventListener('unhandledrejection')` 捕获器，推入 `__E2E_REQUEST_MOCK__.errors[]`。2. 扩展 `DiagnosticSnapshot` 类型增加 `jsErrors: Array<{message:string; source:string; lineno:number; colno:number; timestamp:number}>`。3. 在 `runtime-session.ts` 中新增 `collectJsErrors()` 函数，通过 `browser.execute` 拉取并清空错误缓冲区。4. `diagnose-run.ts` 在诊断时包含 JS 错误分析 |
| **验收标准** | 已知会抛 JS 错误的页面上跑 spec，`resilience-report.json` 包含 `jsErrors` 字段；`diagnose-run` 输出 JS 错误摘要 |
| **依赖** | 无前置依赖 |

---

#### Issue #37 🆕 — 测试数据生命周期管理 [测试专家·T2]

| 维度 | 内容 |
|------|------|
| **优先级** | P1（测试隔离性幻觉，与 #23 协同） |
| **对应陷阱** | pit-008（测试数据污染） |
| **问题** | `reset-session.ts` 空实现，#23 已提升为 P1。本 Issue 扩展为完整的数据生命周期：LocalStorage / SessionStorage / Cookies / SharedPreferences 全覆盖 |
| **涉及文件** | `helpers/reset-session.ts`、`helpers/suite-entry.ts` |
| **实施方案** | 实现 `cleanupAfterTest()`：① `browser.execute(() => { localStorage.clear(); sessionStorage.clear(); })` ② `browser.deleteAllCookies()` ③ 可选通过 adb 清理 SharedPreferences（`adb shell rm -rf /data/data/<pkg>/shared_prefs/*.xml`，需通过 manifest 获取 pkg）。在 `suite-entry.ts` 的 afterEach 中执行 |
| **验收标准** | 两个 spec 顺序跑，第二个不继承第一个的 localStorage/Cookie 数据 |
| **依赖** | 与 #23 一并实施 |

---

#### Issue #38 🆕 — JSBridge / postMessage 双向通信测试 [前端专家·F1]

| 维度 | 内容 |
|------|------|
| **优先级** | P1（Hybrid 应用核心能力无覆盖） |
| **对应陷阱** | pit-020（postMessage 通信失败） |
| **问题** | 整个 scaffold 中没有任何 JSBridge 拦截、mock、验证机制。Native↔H5 通信完全在盲区 |
| **涉及文件** | 新建 `inject/web-bridge-mock.js`、`resilience/types.ts` |
| **实施方案** | 1. 新建 `inject/web-bridge-mock.js`：在 `window.__E2E_REQUEST_MOCK__` 中注册 JSBridge handler 拦截（如 `WebViewJavascriptBridge.callHandler`），支持 record/replay 模式。2. 扩展 `DiagnosticSnapshot.bridgeEvents: Array<{direction:string; method:string; data?:unknown; timestamp:number}>`。3. 在 `runtime-session.ts` 中新增 `collectBridgeEvents()` |
| **验收标准** | `callHandler('getUserInfo')` 调用能被拦截并返回 fixture 数据；报告包含 bridge 调用统计 |
| **依赖** | 无前置依赖 |

---

#### Issue #39 🆕 — Android 厂商碎片化 WebView 适配 [全栈专家·S1]

| 维度 | 内容 |
|------|------|
| **优先级** | P1（国产手机 WebView 行为差异巨大，同一套脚本在 Pixel 通过、华为/小米失败） |
| **对应陷阱** | pit-007（厂商 WebView 兼容性）、pit-011（厂商定制系统级差异） |
| **问题** | 无厂商检测；`switchToWebViewContaining` 等待策略对所有设备一致；chromedriver 版本匹配完全依赖宿主自行处理 |
| **涉及文件** | `orchestration/preflight-check.ts`、`helpers/webview-context.ts`、新建 `helpers/android-vendor.ts` |
| **实施方案** | 1. 在 `probe-env` 中增加厂商检测：`adb shell getprop ro.product.manufacturer` + `ro.product.model` + `ro.build.version.release`。2. 新建 `helpers/android-vendor.ts`：为华为（EMUI WebView 引擎）、小米（MIUI WebView 进程管理）、OPPO/VIVO（后台限制）提供设备特定 workaround。3. preflight-check 增加 `checkWebViewCompat`：检测 chromedriver 与 WebView Chrome 主版本匹配 |
| **验收标准** | preflight-check 输出厂商 + 型号 + Android 版本 + WebView 版本 + chromedriver 匹配状态；华为设备自动应用额外轮询间隔 |
| **依赖** | 无前置依赖 |

---

#### Issue #40 🆕 — Appium 会话生命周期管理 [全栈专家·S2]

| 维度 | 内容 |
|------|------|
| **优先级** | P1（长时间运行导致资源泄漏、chromedriver 僵尸进程） |
| **对应陷阱** | pit-008（session 泄漏）、pit-017（进程/资源泄漏） |
| **问题** | `E2E_SEQUENTIAL_BATCH=1` 模式下单 wdio 进程跑所有 spec，session 保持活跃无清理；chromedriver 端口累积；WebView 调试端口不释放 |
| **涉及文件** | `templates/scaffold/wdio.conf.template.ts`、`orchestration/run-sequential.ts` |
| **实施方案** | 1. 在 `wdio.conf.template.ts` 的 `afterTest` 钩子中增加 session 健康检查。2. 在 batch 模式下每 N 个 spec 后主动 `browser.reloadSession()`。3. 增加 `E2E_SESSION_RESET_INTERVAL` 环境变量控制间隔（默认 5） |
| **验收标准** | batch 模式跑 30 个 spec 后 Appium 进程内存不显著增长 |
| **依赖** | 无前置依赖 |

---

### Phase 3：打磨 + 可维护性提升 + 基础可测试性

本阶段目标：消除散落常量、简化复杂表达式、修复序列化安全、引入基础可测试性改造。

---

#### Issue #18 — 提取共享常量

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `"00-bootstrap"` 在 4 处出现、`.e2e-run-id` 在 3 处出现 |
| **涉及文件** | `orchestration/run-sequential.ts`、`orchestration/write-archive.ts`、`orchestration/publish-reports.ts`、`orchestration/discover-cases.ts`、`resilience/issue-ledger.ts` |
| **实施方案** | 在 `orchestration/constants.ts` 中统一定义，所有引用处替换 |

---

#### Issue #19 — 简化 probe-env.ts 嵌套三元表达式

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | 8 层深度嵌套三元表达式 |
| **涉及文件** | `orchestration/probe-env.ts` |
| **实施方案** | 替换为 `CHECK_TO_BLOCKER: Record<string, string>` 查找表 |

---

#### Issue #20 — discover-project.ts YAML 序列化安全

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `renderYaml()` 手工字符串拼接，特殊字符导致无效输出 |
| **涉及文件** | `orchestration/discover-project.ts` |
| **实施方案** | 引入 `yaml` npm 包 → `yaml.stringify(manifest)` |

---

#### Issue #21 — 消除 require()/import 混用

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `probe-env.ts`、`local-config.ts`、`credentials.ts` 混用 `require()` |
| **涉及文件** | 上述三个文件 |
| **实施方案** | 全部替换为 ES import；动态 JSON 加载改 `fs.readFileSync` + `JSON.parse` |

---

#### Issue #22 — scaffold.sh ROOT 解析 + platform 静默降级

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `scaffold.sh` 使用 `$(pwd)` 非绝对路径；`platform.ts` 未知值静默默认 |
| **涉及文件** | `scripts/scaffold.sh`、`config/platform.ts` |
| **实施方案** | `ROOT="$(cd "$(dirname "$0")/../.." && pwd)"`；platform 未知值加 warning |

---

#### Issue #24 — ensure-host-deps.sh 版本号外部化

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **文件** | `templates/scaffold/scripts/ensure-host-deps.sh` |
| **实施方案** | 从 `.dep-versions` 文件读取版本号 |

---

#### Issue #27 — 可测试性改造（基础层）★从Phase4前置

| 维度 | 内容 |
|------|------|
| **优先级** | ~~Phase 4~~ → **P3**（核心编排函数不可测试是架构债务） |
| **状态** | ⚠️ 待实施 |
| **问题** | 同步 I/O、模块级可变状态、`process.env` 直接修改使单元测试极其困难 |
| **涉及文件** | 所有 `orchestration/*.ts` |
| **实施方案** | 基础层（不在 Phase 3 做完整 adapter 重构）：为 3 个核心函数（probe-env、discover-project、run-sequential）的参数增加可选的依赖注入接口；不改变默认行为。完整 adapter 层留到 Phase 4 |
| **验收标准** | 3 个核心函数有对应的单元测试文件，可以不依赖真实文件系统运行 |

---

#### Issue #31 — 改进 login.ts isLoggedIn() 启发式判断

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | 仅通过 WebView context 是否存在判断登录状态 |
| **实施结果** | 已改为多层判断：Native 控件检查 + URL 模式检查 + auth-detect 信号复用 |

---

#### Issue #32 — 修复 discover-project.ts 无意义三元表达式

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `confidence: fallback ? "low" : "low"` 无论条件都返回 `"low"` |
| **涉及文件** | `orchestration/discover-project.ts` |
| **实施方案** | 根据提取来源返回对应置信度 |

---

#### Issue #33 — AUTH_RECOVERY exitCode=42 副作用修正

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `process.exitCode = 42` 错误被处理时仍保留，产生虚假失败信号 |
| **涉及文件** | `helpers/auth-recovery.ts`、`orchestration/cli.ts` |
| **实施方案** | 改为 Error 对象附加 `exitCode` 属性，由 `cli.ts` 顶层 catch 统一处理 |
| **依赖** | 依赖 #8 |

---

#### Issue #34 — crossValidate() 结果日志输出

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ⚠️ 待实施 |
| **问题** | `crossValidate` 结果从不被检查或 log |
| **涉及文件** | `orchestration/discover-cases.ts`、`orchestration/present-test-plan.ts` |
| **实施方案** | 添加 warning 日志；test-plan.md 中包含警告信息 |

---

#### Issue #35 — Mock 注入安全边界加固

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **状态** | ✅ 已完成 (commit 351c291) |
| **问题** | `window.__E2E_REQUEST_MOCK__` 全局可写 |
| **实施结果** | 已使用 `Object.defineProperty` 设置 `configurable: false, writable: false` |

---

#### Issue #41 🆕 — 网络条件模拟能力 [测试专家·T3]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（弱网是移动端 H5 核心风险区） |
| **对应陷阱** | pit-005（超时误报）、pit-018（弱网环境差异） |
| **问题** | `web-request-mock.js` 同步 mock 瞬间返回，不支持延迟/超时/断网模拟 |
| **涉及文件** | `inject/web-request-mock.js`、`resilience/types.ts` |
| **实施方案** | 在 `jsonResponse()` 前增加可选延迟：读 `window.__E2E_REQUEST_MOCK__.latency`（毫秒）；新增环境变量 `E2E_NETWORK_LATENCY_MS` |
| **验收标准** | 设置 3s 延迟后 mock 返回延迟 3s；H5 loading skeleton 可被截图捕获 |

---

#### Issue #42 🆕 — H5 渲染性能度量 [前端专家·F2]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（性能劣化无法在 E2E 中被发现） |
| **对应陷阱** | pit-001（渲染性能死循环） |
| **问题** | spec 中无 FCP / LCP / TTI 采集；`DiagnosticSnapshot` 无 `performanceMetrics` |
| **涉及文件** | `helpers/webview-context.ts`、`resilience/types.ts`、`resilience/issue-ledger.ts` |
| **实施方案** | `pageLooksReady()` 完成后读取 `performance.getEntriesByType('navigation' | 'paint')`；`DiagnosticSnapshot` 增加 `performance` 字段；report 增加性能章节 |
| **验收标准** | report 包含 `fcp` 毫秒值；超过 `E2E_PERF_THRESHOLD_FCP_MS` 阈值标注 ⚠️ |

---

#### Issue #43 🆕 — WebView Chrome 版本感知 [前端专家·F3]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（不同设备 WebView 行为差异，与 #39 协同） |
| **问题** | `probe-env` 不采集设备 WebView 版本号；chromedriver 匹配完全依赖宿主 |
| **涉及文件** | `orchestration/probe-env.ts`、`orchestration/preflight-check.ts` |
| **实施方案** | `adb shell dumpsys package com.google.android.webview` 获取版本号；preflight 增加 `checkWebViewCompat` |
| **验收标准** | preflight 输出设备型号、Android 版本、WebView 版本、chromedriver 匹配状态 |
| **依赖** | 与 #39 厂商检测协同 |

---

#### Issue #44 🆕 — gradle/Android 构建集成 [全栈专家·S3]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（CI 集成流程断裂） |
| **对应陷阱** | pit-013（CI 环境差异） |
| **问题** | 无 App 版本匹配检测；无自动构建安装流程 |
| **涉及文件** | `orchestration/preflight-check.ts`、`templates/scaffold/scripts/init.sh` |
| **实施方案** | 增加 `checkAppVersion`：`adb shell dumpsys package` 对比 `build.gradle` versionName；`init.sh` 增加 `--build-app` 参数 |
| **验收标准** | 版本不匹配时 preflight 输出 warn；`--build-app` 自动构建安装并确认版本 |

---

### Phase 4：架构演进 + 高级能力

本阶段目标：降低 Skill 的 context window 消耗、完善可测试性、iOS 扩展、Flaky 检测、视觉回归。

---

#### Issue #26 — Skill Context Window 优化

| 维度 | 内容 |
|------|------|
| **优先级** | 架构 |
| **状态** | 待实施 |
| **实施方案** | 拆分 `architecture-and-guide.md`；为 reference 文件添加 `触发条件` 元数据；合并低频文档 |

---

#### Issue #28 — iOS 扩展预留

| 维度 | 内容 |
|------|------|
| **优先级** | 架构 |
| **状态** | 待实施 |
| **实施方案** | 引入 DeviceBridge 接口；实现 AndroidBridge / IOSBridge stub |

---

#### Issue #45 🆕 — Flaky Test 检测与隔离机制 [测试专家·T4]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（反复发生的随机失败消耗排查时间） |
| **对应陷阱** | pit-001、pit-003、pit-015（Flaky 检测） |
| **问题** | 无跨 run 对比分析；无「重跑 n 次验证稳定性」命令 |
| **涉及文件** | `resilience/issue-ledger.ts`、`orchestration/cli.ts` |
| **实施方案** | `detectFlakyCases()` 读取最近 N 个 run 统计 pass-rate；新增 `orch_cli verify-flaky <caseId> --retries=5` |
| **验收标准** | 5 次重跑 3 pass 2 fail → 标记 `flaky: true (passRate: 60%)` |

---

#### Issue #46 🆕 — CSS/视觉回归测试 [前端专家·F4]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（低频但高价值） |
| **对应陷阱** | pit-007（CSS 布局差异） |
| **问题** | 完全没有 screenshot diff 能力 |
| **涉及文件** | 新建 `orchestration/visual-diff.ts`、`specs/screenshots/` 基线目录 |
| **实施方案** | 利用 `browser.saveScreenshot()` + Resemble.js pixel diff；`E2E_VISUAL_DIFF=1` 开关 |

---

#### Issue #47 🆕 — 证书/SSL Pinning 绕过策略文档 [全栈专家·S4]

| 维度 | 内容 |
|------|------|
| **优先级** | P3（文档 + warn 级别，不需要代码实现） |
| **对应陷阱** | pit-011（SSL 证书问题） |
| **问题** | 无 HTTPS 拦截方案文档；inject mock 对 Native HTTP Client 无效 |
| **涉及文件** | `reference/mock-strategies.md`、`orchestration/preflight-check.ts` |
| **实施方案** | 文档增加「Native HTTP 场景」章节；preflight 检测到 `okhttp`/`retrofit` 时输出 mock 范围提示 |

---

### 实施依赖图（v2）

```
Phase 1 (P0 + P1 安全/正确性): ✅ 全部完成
  [#1✅] [#2✅] [#3✅] [#4✅] [#5✅] [#6✅] [#7✅] [#8✅] [#9✅]
  [#10✅ archive类型安全]  [#17✅ 竞态修复]  [#23✅ 清理死代码]  [#29✅ Map→磁盘]

Phase 2 (P2 代码质量):
  [#11 静默错误] [#12 timeouts] [#13 browser统一] [#14 XHR修复]
  [#15 模板注入] [#16 relaxedSecurity] [#25 validate增强 ★P2] [#30 preflight去重]

Phase 2.5 🆕 (真机核心能力补全):
  [#36 JS错误捕获]    [#37 数据生命周期]   [#38 JSBridge测试]
  [#39 厂商碎片化]    [#40 会话生命周期]

Phase 3 (P3 打磨 + 基础可测试性):
  [#18~#22] [#24] [#27 基础可测试性 ★前置] [#31✅]
  [#32 三元修复] [#33 exitCode] [#34 crossValidate] [#35✅]
  [#41 网络模拟] [#42 性能度量] [#43 WebView感知] [#44 构建集成]

Phase 4 (架构演进 + 高级能力):
  [#26 ContextWindow] [#28 iOS扩展]
  [#45 Flaky检测] [#46 视觉回归] [#47 SSL策略]
```

---

### 验收自检清单（更新版）

```bash
# 1. Skill 校验
bash ~/.agents/skills/e2e-device/scripts/validate-skill-dry-run.sh

# 2. 全 scaffold TS 编译
cd <host-repo> && npx tsc --noEmit -p e2e-device/tsconfig.json

# 3. plan-only 全流程
bash e2e-device/scripts/init.sh --plan-only

# 4. 真机跑测
bash e2e-device/scripts/init.sh --sequential

# 5. 报告完整性
cat artifacts/resilience-report.md | grep -E 'passedLive|passedWithMock|jsErrors'

# 6. 安全性 grep (全零)
grep -rn 'execSync.*\${' templates/scaffold/ --include='*.ts'
grep -rn 'damageMisApply\|"/v2"' templates/scaffold/ --include='*.ts' --include='*.js'
grep -rn 'browser\.pause([0-9]' templates/scaffold/ --include='*.ts'
grep -rn 'require(' templates/scaffold/ --include='*.ts' | grep -v node_modules | grep -v '// '

# 7. 架构检查 (全零)
grep -rn 'as never\|as any' templates/scaffold/ --include='*.ts'
grep -rn 'driver\.' templates/scaffold/ --include='*.ts' | grep -v 'import '
grep -rn 'process\.exitCode' templates/scaffold/ --include='*.ts' | grep -v 'cli.ts'

# 8. 死代码检查 (≤3)
grep -rn '// TODO' templates/scaffold/ --include='*.ts' | grep -v node_modules

# 9. 新能力检查
grep -rn 'jsErrors\|bridgeEvents\|vendorInfo\|performance' templates/scaffold/resilience/types.ts
```

---

*本计划为 v2 完整优化路线图，共 47 个 Issue。建议按 Phase 分批提交 PR，每个 Phase 一个 PR。Phase 2.5 为核心新增阶段，建议优先于 Phase 2 的部分低风险项。*
