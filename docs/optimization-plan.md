## e2e-device Skill 优化计划

**基线**：2026-06-03 深度分析报告（22 项问题 + 3 项架构建议 + 4 项设计观察）
**目标**：分 4 个阶段实施全部 P0-P3 优化 + 架构改进，使 Skill 达到生产级质量

---

### 总体策略

按依赖关系和影响面将 35 个优化项拆为 **4 个实施阶段**，每个阶段内部按逻辑顺序排列。前置阶段完成后，后续阶段的改动才有稳固的基础。

```
Phase 1  消除运行时崩溃 + 安全漏洞 + 数据错误     (P0 + P1 安全/正确性)
Phase 2  代码质量 + 可观测性 + 一致性              (P2 全部)
Phase 3  打磨 + 可维护性提升                       (P3 全部)
Phase 4  架构演进                                 (Skill context / 可测试性 / iOS)
```

---

### Phase 1：消除运行时崩溃 + 安全漏洞 + 数据正确性

本阶段目标：让 scaffold 模板的每一个代码路径都能正常运行，不存在必定崩溃的 import、不存在 shell 注入风险、不存在产物路径分裂、不存在报告数据失真。

---

#### Issue #1 — 补全缺失模块引用

| 维度 | 内容 |
|------|------|
| **优先级** | P0 |
| **问题** | 3 处 import 引用了 scaffold 中不存在的模块，执行到对应路径时直接 module-not-found |
| **涉及文件** | `helpers/build-h5-url.ts`（第 2 行 `../config/env`）、`helpers/suite-entry.ts`（第 2 行 `./app-launcher`）、`helpers/webview-context.ts`（动态 import `../resilience/cdp-mock`） |
| **实施方案** | **方案 A**（推荐）：在 scaffold 中补全 3 个模块的 stub 实现——`config/env.ts` 导出 `getE2eDataMode()` 函数（读 `process.env.E2E_DATA_MODE`，默认 `"test"`）；`helpers/app-launcher.ts` 导出 `openH5ViaAdb()` 函数（复用 `deeplink.ts` 中已有的 deepLink 逻辑）；`resilience/cdp-mock.ts` 导出 `enableCdpMock()` 函数（内部调用已有的 inject mock 路径，因为文档已说明 CDP mock 在真机场景不可靠）。**方案 B**：移除缺失 import，在调用方增加 graceful fallback（如 `try { require(...) } catch { /* 降级到 inject mock */ }`）。 |
| **验收标准** | `bash e2e-device/scripts/init.sh --plan-only` 全流程无 module-not-found 错误；`ts-node` 对所有 scaffold TS 文件的类型检查通过 |
| **依赖** | 无前置依赖 |

---

#### Issue #2 — 统一路径解析

| 维度 | 内容 |
|------|------|
| **优先级** | P0 |
| **问题** | `issue-ledger.ts` 使用硬编码相对路径 `"e2e-device/artifacts/runs"`，而其他模块使用 `paths.ts` 的 `artifactsRoot()`，CWD 不等于 repoRoot 时产物写入不同位置 |
| **涉及文件** | `resilience/issue-ledger.ts`（第 5 行 `ARTIFACTS_DIR` 常量） |
| **实施方案** | 移除 `issue-ledger.ts` 中的 `ARTIFACTS_DIR` 硬编码常量，改为从 `../orchestration/paths.ts` 导入 `artifactsRoot()` 函数。修改 `aggregateFromRunDir()` 和 `writeResilienceReports()` 中所有使用 `ARTIFACTS_DIR` 的路径拼接，统一使用 `path.join(artifactsRoot(), "runs", ...)` 模式。 |
| **验收标准** | 从非 repoRoot 目录调用 `orch_cli` 时，issue-ledger 的产物与 write-archive 写入同一 `artifacts/runs/<runId>/` 目录；`publish-reports` 能正确找到韧性报告 |
| **依赖** | 无前置依赖 |

---

#### Issue #3 — 清除试点域名残留

| 维度 | 内容 |
|------|------|
| **优先级** | P0 |
| **问题** | `"damageMisApply"` 作为 fallback 硬编码在通用模板中，`/v2` 路径出现在 spec 断言和生成的测试代码中，违反 SKILL.md 铁律 G1 |
| **涉及文件** | `helpers/runtime-manifest.ts`（第 51 行 fallback `"damageMisapply"`）、`specs/app-launch.spec.ts`（`expect(currentUrl).toContain("/v2")`）、`orchestration/discover-hybrid.ts`（生成 spec 中的 `/v2` 断言） |
| **实施方案** | `runtime-manifest.ts` 的 fallback 改为从 `skill.project.json` 的 `pilot.domain` 读取，若无则返回空字符串并在调用方处理；`app-launch.spec.ts` 的断言改为从 manifest 读取 `pathPrefix` 动态生成（如 `expect(currentUrl).toContain(manifest.hybrid.webView.pathPrefix || "")`）；`discover-hybrid.ts` 生成 spec 时使用 manifest 中的 `pathPrefix` 变量替换硬编码的 `/v2`。 |
| **验收标准** | `validate-skill-dry-run.sh` 新增对 `"damageMisApply"`、`"/v2"` 的扫描规则并通过；所有 scaffold 文件中无项目特定域名/路径 |
| **依赖** | 建议在 Issue #1 完成后实施（确保 manifest 加载路径可用） |

---

#### Issue #4 — 修复 Shell 注入风险

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | `adb.ts`、`install-android-sdk.ts`、`android-config.ts` 使用 `execSync` + 字符串拼接构造 shell 命令，UDID/package name 等外部输入可被注入 |
| **涉及文件** | `helpers/adb.ts`（第 9 行 `adb -s ${udid} get-state`）、`orchestration/install-android-sdk.ts`（第 87-97 行 `sdkmanager` 命令拼接）、`helpers/android-config.ts`（第 63 行 `detectLaunchActivity`） |
| **实施方案** | 统一将 `execSync(command_string)` 替换为 `execFileSync(command, [args...])` 模式，参考 `deeplink.ts` 和 `session.ts` 中已有的正确实践。`adb.ts` 改为 `execFileSync("adb", ["-s", udid, "get-state"])`；`install-android-sdk.ts` 改为 `execFileSync(sdkmanagerBin, ["platform-tools", \`platforms;android-${apiLevel}\`, \`build-tools;${buildTools}\`], { env: { ...process.env, ANDROID_HOME: sdkRoot } })`；`android-config.ts` 改为 `execFileSync("adb", ["shell", "dumpsys", "activity", "activities"])` 后在 JS 层用 regex 解析。 |
| **验收标准** | 用包含 shell 元字符的 UDID（如 `"; echo pwned; "`）测试 `adb.ts`，确认不会被执行；代码中不再出现 `execSync` 拼接外部变量的模式 |
| **依赖** | 无前置依赖 |

---

#### Issue #5 — 消除两个 common.sh 共存

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | `scripts/common.sh`（遗留版，用 `yarn -s ts-node`）与 `scripts/lib/common.sh`（规范版，从 Skill 目录解析 ts-node）行为分歧，source 了错误版本会导致 `orch_cli` 调用失败 |
| **涉及文件** | `scripts/common.sh`（遗留版） |
| **实施方案** | 将 `scripts/common.sh` 的内容替换为单行重定向：`source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"`。这样任何 source 了遗留路径的脚本都会自动获得规范版的功能。同时在文件头部添加 deprecation 注释。 |
| **验收标准** | 任何脚本无论 source 哪个 common.sh 都获得相同的 `orch_cli`、`resolve_bin`、`run_wdio` 函数；`init.sh --plan-only` 正常工作 |
| **依赖** | 无前置依赖 |

---

#### Issue #6 — 修复 bash 3.2 兼容性

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | `lib/common.sh` 的 `resolve_bin()` 使用 `${!env_var}` 间接变量展开，macOS 默认 bash 3.2 不支持 |
| **涉及文件** | `scripts/lib/common.sh`（第 31 行） |
| **实施方案** | 将 `local env_var="E2E_$(echo "$name" | tr '[:lower:]' '[:upper:]')_BIN"` 和 `${!env_var:-}` 替换为兼容 bash 3.2 的写法：使用 `eval` 或 `printf -v` 模式。推荐方案：`local env_var="E2E_$(echo "$name" | tr '[:lower:]' '[:upper:]')_BIN"; local bin_path; eval "bin_path=\${${env_var}:-}"; if [[ -n "$bin_path" ]]; then echo "$bin_path"; return 0; fi`。同时将 `echo | tr` 子进程替换为 bash 内置的 `${name^^}`（bash 4+）或保留 tr 作为兼容降级。 |
| **验收标准** | 在 macOS 默认 `/bin/bash`（3.2）下执行 `source lib/common.sh && resolve_bin ts-node` 不报 `bad substitution`；CI 中 macOS runner 测试通过 |
| **依赖** | 建议在 Issue #5 之后（确保所有脚本都 source 了规范版） |

---

#### Issue #7 — 提取 WebView 共享工具函数

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | WebView wait-and-switch 逻辑在 4 处重复约 90 行近乎相同的代码 |
| **涉及文件** | `helpers/deeplink.ts`（第 48-71 行、第 110-135 行）、`specs/app-launch.spec.ts`（第 26-47 行）、`helpers/webview-context.ts`（第 84-134 行） |
| **实施方案** | 在 `helpers/webview-context.ts` 中新增导出函数 `waitForAndSwitchToWebView(options?: { urlPart?: string; timeout?: number; domReadyMarkers?: string[] })`，封装：等待 WebView context 出现 → 切换 context → 等待 URL 匹配（如果指定 urlPart）→ 等待 DOM ready 信号。然后 `deeplink.ts`、`app-launch.spec.ts` 中的所有重复代码块改为调用此函数。`webview-context.ts` 内部的 `switchToWebViewContaining` 保留但内部调用新的 `waitForAndSwitchToWebView`。 |
| **验收标准** | WebView 切换逻辑只在一处维护；`deeplink.ts` 和 `app-launch.spec.ts` 中不再有 `getContexts` → `switchContext` → `waitUntil` DOM ready 的重复代码链；真机跑 bootstrap spec 通过 |
| **依赖** | 建议在 Issue #1 完成后实施（确保 webview-context.ts 的所有 import 可用） |

---

#### Issue #8 — CLI 边界输入校验

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | `cli.ts` 的 `JSON.parse` 调用无 try/catch，args 数组无长度校验，类型断言无运行时检查 |
| **涉及文件** | `orchestration/cli.ts`（第 134 行 save-local-config 的 JSON.parse、第 150 行 archive-start 的 JSON.parse、第 159 行 archive-finish 的类型断言） |
| **实施方案** | 为所有 `JSON.parse` 添加 try/catch 并输出 `Invalid JSON for <command>: ${err.message}` 的友好错误信息；为需要参数的 command 添加 `if (args.length < N) { console.error("Usage: ..."); process.exit(1); }` 校验；将 `args[0] as "passed" | "failed" | "partial"` 替换为运行时检查 `const validStatuses = ["passed", "failed", "partial"] as const; if (!validStatuses.includes(args[0] as any)) { ... }`。 |
| **验收标准** | 传入非法 JSON、空参数、无效 status 时输出清晰的错误信息而非裸 stack trace；exit code 非 0 |
| **依赖** | 无前置依赖 |

---

#### Issue #9 — 修复韧性报告指标始终为零

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | `issue-ledger.ts` 的 `aggregateFromRunDir()` 中 `passedLive`、`passedWithMock`、`passedAfterAutofix`、`errors`、`autoFixCount` 始终为 0，从未从 JSONL 数据中实际计算 |
| **涉及文件** | `resilience/issue-ledger.ts`（第 108-112 行） |
| **实施方案** | 在 `aggregateFromRunDir()` 的 JSONL 遍历循环中，根据每行的 `outcome` 字段分类累加：`passed` + `mockLayer === "inject"` → `passedWithMock++`；`passed` + `autoFixed` → `passedAfterAutofix++`；`passed` 且无 mock/autofix → `passedLive++`；`failed` / `error` → `errors++`；统计 `autoFixAttempted` 为 true 的行数 → `autoFixCount++`。同时需要扩展 JSONL 行的 schema 以包含 `mockLayer` 和 `autoFixed` 字段（在 `run-sequential.ts` 写入 JSONL 时补充）。 |
| **验收标准** | 跑完一轮 sequential 后，`resilience-report.md` 中的 passedLive / passedWithMock / passedAfterAutofix / errors 数值反映实际执行情况 |
| **依赖** | 建议在 Issue #2 之后（确保 issue-ledger 的路径与 run-sequential 一致） |

---

#### Issue #10 — 修复 write-archive.ts 的类型安全

| 维度 | 内容 |
|------|------|
| **优先级** | P1 |
| **问题** | `updateSection()` 使用 `as never` 绕过类型检查，允许写入与 section schema 不匹配的数据 |
| **涉及文件** | `orchestration/write-archive.ts`（第 77 行） |
| **实施方案** | 将 `archive.sections[key] = { ...archive.sections[key], ...data } as never` 替换为类型安全的深合并：定义 `SectionKey` 类型，为每个 section 定义具体的 merge 签名，或使用 `Partial<RunArchive["sections"][K]>` 泛型约束 data 参数。 |
| **验收标准** | TypeScript 编译无 `as never` / `as any` 类型逃逸；传入结构不匹配的 section data 时编译报错 |
| **依赖** | 无前置依赖 |

---

### Phase 2：代码质量 + 可观测性 + 一致性

本阶段目标：消除静默错误吞没、统一超时管理、统一 API 调用风格、修复 mock 缺陷、消除竞态、修复跨进程状态问题、去除代码重复。

---

#### Issue #11 — 消除静默错误吞没

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | 6+ 文件的 try/catch 捕获异常后不做任何处理，排查问题时无法获取任何线索 |
| **涉及文件** | `orchestration/probe-env.ts`（第 174、198 行）、`orchestration/discover-project.ts`（第 300-303 行）、`orchestration/publish-reports.ts`（第 36、146 行）、`resilience/issue-ledger.ts`（第 64、94 行）、`resilience/runtime-session.ts`（第 34 行）、`config/local-config.ts`（JSON parse 错误） |
| **实施方案** | 统一模式：每个 catch 块中增加 `if (process.env.E2E_DEBUG) { logger.debug("...", err) }` 条件日志。对于 `local-config.ts` 的 `readLocalConfig()`，区分「文件不存在」和「JSON 损坏」两种情况——前者返回 null，后者抛错或至少 log warning。对于 `runtime-session.ts`，在 catch 中增加注释说明 WebView 可能不可用属于预期情况。 |
| **验收标准** | `E2E_DEBUG=1` 下跑 `init.sh --plan-only` 可以看到之前被吞没的所有错误日志；`local-config.ts` 能区分文件缺失和 JSON 损坏 |
| **依赖** | 建议在 Phase 1 完成后实施 |

---

#### Issue #12 — 统一使用集中式 timeouts

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | `config/timeouts.ts` 已定义完善的超时配置，但 3 个文件仍在使用硬编码 `browser.pause()` |
| **涉及文件** | `helpers/login.ts`（第 103、139 行 `browser.pause(2000/3000)`）、`helpers/suite-entry.ts`（第 18 行 `browser.pause(5000)`）、`specs/app-launch.spec.ts`（第 36 行 `120000`） |
| **实施方案** | `login.ts`：将 `browser.pause(2000)` 替换为 `await browser.waitUntil(() => isLoginFieldVisible(), { timeout: timeouts.loginPageReady })`；将 `browser.pause(3000)` 替换为 `await browser.waitUntil(() => !isLoginFieldVisible(), { timeout: timeouts.loginComplete })`。`suite-entry.ts`：将 `browser.pause(5000)` 替换为 `await waitForAndSwitchToWebView({ timeout: timeouts.webViewNormal })`（依赖 Issue #7）。`app-launch.spec.ts`：将 `120000` 替换为 `timeouts.webViewNormal`。 |
| **验收标准** | 全项目 grep `browser.pause` 结果为零（或仅剩注释中的说明）；慢速设备上通过 timeout 环境变量调整即可跑通 |
| **依赖** | Issue #7（suite-entry.ts 依赖 waitForAndSwitchToWebView） |

---

#### Issue #13 — 统一 browser/driver 全局变量

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | `webview-context.ts` 混用 `browser.*` 和 `driver.*`，降低可读性 |
| **涉及文件** | `helpers/webview-context.ts`（`driver.switchContext` vs `browser.getUrl`） |
| **实施方案** | 全文件将 `driver.*` 调用统一替换为 `browser.*`（`driver.switchContext` → `browser.switchContext`、`driver.getContexts` → `browser.getContexts`）。同步为 `helpers/ensure-h5-nav-context.ts` 添加 `import { browser } from "@wdio/globals"` 显式导入。 |
| **验收标准** | 全 scaffold 中 `driver.` 的使用仅限于 `@wdio/globals` 的 import 语句（如有），实际调用统一使用 `browser.` |
| **依赖** | 无前置依赖 |

---

#### Issue #14 — 修复 XHR Mock double-open 缺陷

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | `web-request-mock.js` 中 mock→passthrough 切换时真实 XHR 未被 `open()`，`send()` 抛 InvalidStateError；缺少 responseType、非 200 状态码等能力 |
| **涉及文件** | `inject/web-request-mock.js` |
| **实施方案** | 修复 passthrough 路径：在 `shouldMock()` 返回 false 时，确保先调用 `xhr.open(_method, _url)` 再调用 `xhr.send()`，并正确转发所有 `send()` 参数。增强 mock 能力：为 MockXHR 添加 `responseType` 属性支持（默认 `"text"`，支持 `"json"` 时自动 `JSON.stringify` fixture body）；允许 fixture 定义 `status` 字段（默认 200），在 mock 响应中使用该值；添加 `timeout` 属性的基本支持（触发 `ontimeout` 回调）。 |
| **验收标准** | passthrough 请求不再报 InvalidStateError；fixture 中定义 `"status": 404` 时 mock 返回 404 状态码；`responseType: "json"` 的 XHR 能正确获取 JSON 响应 |
| **依赖** | 无前置依赖 |

---

#### Issue #15 — discover-hybrid.ts 输入校验

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | domain 名称直接插值到生成的 TypeScript 代码中，存在模板注入风险 |
| **涉及文件** | `orchestration/discover-hybrid.ts` |
| **实施方案** | 在插值前对 domain 进行校验：`const safeDomain = domain.replace(/[^a-zA-Z0-9_-]/g, "");` 或 `if (!/^[a-zA-Z0-9_-]+$/.test(domain)) throw new Error("Invalid domain")`。同时对生成的 spec 中的 URL 路径做相同处理。 |
| **验收标准** | 传入含特殊字符的 domain（如 `test"; process.exit(1)//"`）不会在生成的 spec 中产生可执行代码 |
| **依赖** | 无前置依赖 |

---

#### Issue #16 — wdio.conf.template.ts relaxedSecurity 可配置

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | Appium `relaxedSecurity` 无条件设为 true，无 opt-in 机制 |
| **涉及文件** | `templates/scaffold/wdio.conf.template.ts`（第 63 行） |
| **实施方案** | 改为 `relaxedSecurity: process.env.E2E_APPIUM_RELAXED_SECURITY === "1"`，默认关闭。在 `wdio.conf.template.ts` 上方添加注释说明何时需要开启。同时在 `SKILL.md` 或 `host-setup.md` 中补充文档说明 relaxedSecurity 的用途和风险。 |
| **验收标准** | 默认 `E2E_APPIUM_RELAXED_SECURITY` 未设置时 relaxedSecurity 为 false；设为 `"1"` 时为 true |
| **依赖** | 无前置依赖 |

---

#### Issue #17 — run-sequential.ts 竞态条件 + 退出码保留

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | `runNextCase()` 读 JSONL 判断下一个 case 无文件锁；所有非零退出码被统一映射为 1 |
| **涉及文件** | `orchestration/run-sequential.ts` |
| **实施方案** | 竞态：在 `runNextCase()` 开头添加文件锁（使用 `lockfile` 库或 `flock` shell 命令），或在 `runSequentialCases` 层面禁止并发调用（添加 `E2E_SEQUENTIAL_LOCK` 环境变量控制）。退出码：将 `exitCode: wdio.status !== 0 ? 1 : 0` 改为 `exitCode: wdio.status ?? 1`，保留原始退出码；当 `wdio.status` 为 null（信号终止）时，从 `wdio.signal` 获取信号名并记录到 JSONL。 |
| **验收标准** | 两个并发的 `orch_cli run-next-case` 不会执行同一个 case；wdio 因超时被 kill 时 JSONL 中记录了 signal 信息而非统一 exitCode=1 |
| **依赖** | 无前置依赖 |

---

#### Issue #29 — write-archive.ts 模块级 archives Map 跨进程不共享

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | `write-archive.ts` 的 `const archives = new Map<string, RunArchive>()` 是模块级可变状态，但每次 `orch_cli` 调用是独立 node 进程，Map 在进程间不共享，`latestArchive()` 回退逻辑在 CLI 多次调用场景下不可靠 |
| **涉及文件** | `orchestration/write-archive.ts`（第 32 行 `archives` Map、第 88 行 `archives.delete`） |
| **实施方案** | 将 archives Map 改为磁盘持久化方案：每次 `startRunArchive()` 将 archive 写入 `artifacts/runs/<runId>/archive.json`，`getRunArchive()` 和 `latestArchive()` 从磁盘读取而非内存 Map。移除 `finishRunArchive()` 中的 `archives.delete()` 调用。这与 Issue #27（可测试性改造）中的 adapter 化方向一致，但本 Issue 聚焦运行时正确性，可先行实施。 |
| **验收标准** | 在两个独立的 `orch_cli` 进程中，第二个进程能通过 `latestArchive()` 正确读取第一个进程写入的 archive；`finishRunArchive()` 后仍可读取已完成的 archive |
| **依赖** | 建议在 Issue #2（路径统一）和 Issue #10（类型安全）之后实施 |

---

#### Issue #30 — preflight-check.ts 代码去重

| 维度 | 内容 |
|------|------|
| **优先级** | P2 |
| **问题** | `checkWdio()`、`checkAppium()`、`checkAppiumDriver()` 三个函数结构几乎完全相同（检查项目 bin → 检查 Skill bin → 返回结果）；`sdkHasRequiredLayout` 在 `env-checks.ts` 中重复定义 |
| **涉及文件** | `orchestration/preflight-check.ts`（第 207-342 行）、`orchestration/env-checks.ts`（`sdkHasRequiredLayout`） |
| **实施方案** | 提取通用函数 `checkBin(options: { name: string; projectRoot: string; skillRoot: string; binPath?: string }): CheckResult`，`checkWdio`、`checkAppium`、`checkAppiumDriver` 改为调用该函数。将 `sdkHasRequiredLayout` 移至 `orchestration/paths.ts`（或新建 `orchestration/utils.ts`），`preflight-check.ts` 和 `env-checks.ts` 统一引用。同时补全 `formatPreflightResult()` 中缺失的 `auto_fixed` 图标映射。 |
| **验收标准** | `preflight-check.ts` 中三个 check 函数的行数减少 60% 以上；`sdkHasRequiredLayout` 只有一处定义 |
| **依赖** | 无前置依赖 |

---

### Phase 3：打磨 + 可维护性提升

本阶段目标：消除散落常量、简化复杂表达式、修复序列化安全、提升脚手架健壮性、改进登录判断、修正设计缺陷、加固 mock 安全边界。

---

#### Issue #18 — 提取共享常量

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `"00-bootstrap"` 在 4 处出现、`.e2e-run-id` 在 3 处出现、`ARTIFACTS_DIR` 路径散落各处 |
| **涉及文件** | `orchestration/run-sequential.ts`、`orchestration/write-archive.ts`、`orchestration/publish-reports.ts`、`orchestration/discover-cases.ts`、`resilience/issue-ledger.ts` |
| **实施方案** | 在 `orchestration/paths.ts`（或新建 `orchestration/constants.ts`）中定义共享常量：`export const BOOTSTRAP_CASE_ID = "00-bootstrap"`、`export const RUN_ID_FILE = ".e2e-run-id"`、`export const CASES_EXECUTED_FILE = "cases-executed.jsonl"`。所有引用处替换为常量 import。 |
| **验收标准** | 全项目 grep `"00-bootstrap"` / `".e2e-run-id"` / `"cases-executed.jsonl"` 仅在 constants 文件中出现 |
| **依赖** | 无前置依赖 |

---

#### Issue #19 — 简化 probe-env.ts 嵌套三元表达式

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | 8 层深度的三元表达式链映射 check ID 到 blocker ID，极难阅读 |
| **涉及文件** | `orchestration/probe-env.ts`（第 65-83 行） |
| **实施方案** | 替换为 `const CHECK_TO_BLOCKER: Record<string, string> = { androidSdkCheck: "android_sdk_missing", adbCheck: "adb_missing", appiumCheck: "appium_missing", ... };` 查找表 + 单行 `return CHECK_TO_BLOCKER[checkId] ?? checkId`。 |
| **验收标准** | 原 8 层三元表达式消失；新增映射时只需在 Record 中添加一行 |
| **依赖** | 无前置依赖 |

---

#### Issue #20 — discover-project.ts YAML 序列化安全

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `renderYaml()` 使用字符串拼接手工序列化 YAML，特殊字符会导致无效输出 |
| **涉及文件** | `orchestration/discover-project.ts`（第 442 行 `renderYaml()`） |
| **实施方案** | **方案 A**（推荐）：引入 `yaml` npm 包（已在 Skill 的 node_modules 依赖链中可用），使用 `yaml.stringify(manifest)` 替代手工序列化。**方案 B**：在手工序列化中为字符串值添加转义函数——将包含冒号、引号、换行符的值用双引号包裹并转义内部引号。 |
| **验收标准** | 当 manifest 的 `pageOrigin` 包含特殊字符（如 `https://api.example.com:8080`）时，生成的 YAML 可被标准 YAML 解析器正确读取 |
| **依赖** | 无前置依赖 |

---

#### Issue #21 — 消除 require()/import 混用

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `probe-env.ts` 第 227 行、`local-config.ts` 第 68 行、`credentials.ts` 第 10 行混用 `require()` 和 ES import |
| **涉及文件** | `orchestration/probe-env.ts`、`config/local-config.ts`、`helpers/credentials.ts` |
| **实施方案** | 将 `require()` 替换为对应的 ES import（`import { writeLocalConfig } from "../config/local-config"`、`import path from "node:path"`）。对于 `credentials.ts` 中对 `.e2e-local.json` 的动态加载，改用 `fs.readFileSync` + `JSON.parse` 替代 `require()`。 |
| **验收标准** | 全 scaffold TS 文件中不再有 `require()` 调用（注释除外）；ESM strict 模式下编译通过 |
| **依赖** | 无前置依赖 |

---

#### Issue #22 — 修复 scaffold.sh ROOT 解析 + platform 静默降级

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `scaffold.sh` 使用 `ROOT="$(pwd)"` 而非绝对路径解析；`config/platform.ts` 对未知平台值静默默认为 Android |
| **涉及文件** | `scripts/scaffold.sh`（第 4 行）、`config/platform.ts` |
| **实施方案** | `scaffold.sh` 第 4 行改为 `ROOT="$(cd "$(dirname "$0")/../.." && pwd)"`，与其他脚本保持一致。`platform.ts` 添加 warning：`if (!["android", "ios"].includes(platform)) { logger.warn("Unknown E2E_PLATFORM: ${platform}, defaulting to android") }`。 |
| **验收标准** | 从任意目录调用 `scaffold.sh` 都能正确解析模板路径；设置 `E2E_PLATFORM=typo` 时能看到 warning 日志 |
| **依赖** | 无前置依赖 |

---

#### Issue #23 — 移除/实现 reset-session.ts + 清理无用代码

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `reset-session.ts` 是空实现但仍被调用；`login.ts` 中 `loggedInIndicators` 数组始终为空且从未消费；`android-sdk.ts` 在变量未设置时静默跳过无 warning |
| **涉及文件** | `helpers/reset-session.ts`、`helpers/login.ts`、`helpers/android-sdk.ts` |
| **实施方案** | `reset-session.ts`：实现基础清理（调用 `browser.deleteAllCookies()`、清理 SharedPreferences via adb）或标记为 TODO 并在 `suite-entry.ts` 中移除调用。`login.ts`：移除 `loggedInIndicators` 死代码。`android-sdk.ts`：当 `sdkRoot` 为空时添加 `logger.warn("ANDROID_HOME and ANDROID_SDK_ROOT not set")` 而非静默跳过。 |
| **验收标准** | 全 scaffold 中无空函数体被调用；无死代码数组；SDK 未设置时能看到 warning 日志 |
| **依赖** | 无前置依赖 |

---

#### Issue #24 — ensure-host-deps.sh 版本号外部化

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `@wdio/cli@^8.40.0`、`appium@^3.4.2` 等版本号硬编码在脚本中 |
| **涉及文件** | `scripts/ensure-host-deps.sh`（第 11-18 行） |
| **实施方案** | 在 scaffold 中新增 `scripts/.dep-versions` 文件（或复用 `package.json` 的 `devDependencies`），`ensure-host-deps.sh` 从该文件读取版本号。格式建议为 `@wdio/cli=^8.40.0` 每行一条。 |
| **验收标准** | 升级 wdio 版本时只需修改一个文件；`ensure-host-deps.sh` 安装的是 `.dep-versions` 中指定的版本 |
| **依赖** | 无前置依赖 |

---

#### Issue #25 — validate-skill-dry-run.sh 增强

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | 当前校验脚本的禁止词列表需要更新以覆盖本次发现的残留问题 |
| **涉及文件** | `scripts/validate-skill-dry-run.sh` |
| **实施方案** | 在 `FORBIDDEN` 数组中新增 `"damageMisApply"`、`"/v2/"`（确认已有）、`"00-bootstrap"`（仅扫描 scaffold 外的硬编码）。新增检查规则：scaffold 文件中不应出现 `browser.pause(` 后跟硬编码数字（应为 timeouts 引用）；scaffold 文件中不应出现 `execSync(` 拼接变量（应为 execFileSync）。 |
| **验收标准** | `validate-skill-dry-run.sh` 能检测到本次报告中发现的所有 P0 级残留问题 |
| **依赖** | 建议在 Issue #3、#4、#12 完成后实施 |

---

#### Issue #31 — 改进 login.ts isLoggedIn() 启发式判断

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `login.ts` 仅通过 WebView context 是否存在来判断登录状态，但某些 App 的登录页本身就是 WebView，导致误判 |
| **涉及文件** | `helpers/login.ts`（第 86 行 `isLoggedIn()`） |
| **实施方案** | 将 `isLoggedIn()` 改为多层判断：1. 检查当前 URL 是否包含登录页特征（复用 `auth-detect.ts` 中的 `AuthSignal` 机制）；2. 检查 native 层是否存在登录控件（`resource-id*="login"` 或 manifest 配置的 `loginResourceId`）；3. 若两者均不存在，判定为已登录。优先使用 manifest 中 `hybrid.auth.loginIndicators`（若配置）。 |
| **验收标准** | 对 WebView 登录页场景，`isLoggedIn()` 返回 false 而非 true；已有 `auth-detect.ts` 的信号被复用而非重复实现 |
| **依赖** | 无前置依赖 |

---

#### Issue #32 — 修复 discover-project.ts 无意义三元表达式

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | 第 79 行 `confidence: fallback ? "low" : "low"` 无论条件如何都返回 `"low"`，暗示缺失了某个分支的逻辑 |
| **涉及文件** | `orchestration/discover-project.ts`（第 79 行） |
| **实施方案** | 根据上下文推断正确逻辑：当 `fallback` 存在时应为 `"low"`（从环境变量推断的低置信度），当 `fallback` 不存在且从项目代码中正则提取成功时应为 `"medium"` 或 `"high"`。修改为 `confidence: source === "env" ? "low" : source === "regex" ? "medium" : "high"`（具体值需根据 `parseApiOrigin` 的多种提取来源确定）。 |
| **验收标准** | `skill.project.json` 中的 `apiOriginConfidence` 字段反映实际的提取来源可靠度 |
| **依赖** | 无前置依赖 |

---

#### Issue #33 — AUTH_RECOVERY exitCode=42 副作用修正

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `auth-recovery.ts` 在 throw 之前设置 `process.exitCode = 42`，如果错误被上层 catch 住并正常处理，exit code 42 仍保留，进程退出时产生虚假的失败信号 |
| **涉及文件** | `helpers/auth-recovery.ts`（第 49 行 `process.exitCode = 42`） |
| **实施方案** | 移除 `process.exitCode = 42` 的直接设置。改为在 throw 的 Error 对象上附加 `exitCode` 属性（自定义 Error 类），由 CLI 入口（`cli.ts`）的顶层 catch 统一判断并设置 `process.exitCode`。这样如果错误被中间层 catch 处理了，exit code 不会被错误设置。 |
| **验收标准** | 当 auth-recovery 错误被韧性层正常处理后续跑成功时，进程退出码为 0 而非 42；仅在未被处理的 auth-recovery 错误场景下退出码为 42 |
| **依赖** | 建议在 Issue #8（CLI 输入校验）之后实施，确保 cli.ts 的顶层 catch 已完善 |

---

#### Issue #34 — crossValidate() 结果日志输出

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `discover-cases.ts` 调用 `crossValidate(cases)` 的结果只写入 registry 但从不被检查或 log，验证失败完全静默 |
| **涉及文件** | `orchestration/discover-cases.ts`（第 239 行） |
| **实施方案** | 在调用 `crossValidate` 后添加结果检查：若存在 validation warnings/errors，通过 `logger.warn` 输出摘要（如 `Cross-validation found ${n} issues: ${summary}`）。同时在 `present-test-plan` 生成的 `test-plan.md` 中包含 cross-validation 的警告信息，让用户在确认测试计划时可见。 |
| **验收标准** | 当 case registry 中存在 spec 路径不一致或 mock route 缺失等问题时，日志和 test-plan.md 中有明确提示 |
| **依赖** | 无前置依赖 |

---

#### Issue #35 — Mock 注入安全边界加固

| 维度 | 内容 |
|------|------|
| **优先级** | P3 |
| **问题** | `window.__E2E_REQUEST_MOCK__` 是全局可写对象，页面上的任何脚本都可以篡改 mock 规则或被测页面意外读取该全局变量 |
| **涉及文件** | `inject/web-request-mock.js` |
| **实施方案** | 1. 使用 `Object.defineProperty` 将 `__E2E_REQUEST_MOCK__` 设为 `configurable: false, writable: false`（内部通过闭包变量存储实际规则）。2. 使用 `Object.defineProperty` 将 `__E2E_REQUEST_MOCK_INSTALLED__` 设为不可删除。3. 在 `web-request-mock.js` 中添加 `// @e2e-internal — do not rely on this in production code` 注释。4. 在 scaffold 文档（host-setup.md）中提醒用户在 production build 中排除 mock 注入脚本。 |
| **验收标准** | 页面脚本执行 `delete window.__E2E_REQUEST_MOCK__` 后 mock 仍正常工作；`Object.getOwnPropertyDescriptor(window, '__E2E_REQUEST_MOCK__')` 显示 `configurable: false` |
| **依赖** | 建议在 Issue #14（XHR mock 修复）之后实施 |

---

### Phase 4：架构演进

本阶段目标：降低 Skill 的 context window 消耗、提升代码可测试性、为 iOS 扩展做基础设施准备。

---

#### Issue #26 — Skill Context Window 优化

| 维度 | 内容 |
|------|------|
| **优先级** | 架构 |
| **问题** | 当前 Skill 文档总量约 2000+ 行，Agent 加载时消耗大量 context window |
| **涉及文件** | `SKILL.md`、`reference/architecture-and-guide.md`、所有 reference 文件 |
| **实施方案** | 1. 将 `architecture-and-guide.md`（470 行）拆分为 `reference/arch-overview.md`（约 100 行精简版）+ `reference/arch-details.md`（完整版），SKILL.md 中只强制阅读精简版。2. 为每个 reference 文件添加 `## 触发条件` 头部元数据（如"仅在 `android_sdk_missing` blocker 时加载 android-sdk-setup.md"），供 Agent 按需加载。3. 将 `phases/` 文档压缩为单文件 `reference/lifecycle.md`（减少文件切换开销）。4. 评估 `reference/` 中低频文档（如 `archive-schema.md`、`case-sources.md`）是否可以合并到 `arch-details.md` 中。 |
| **验收标准** | SKILL.md 强制阅读链的总行数降低 40% 以上；Agent 在 `--plan-only` 场景下不加载 android-sdk-setup.md |
| **依赖** | 建议在 Phase 1-3 全部完成后实施（避免文档重构与代码修改冲突） |

---

#### Issue #27 — 可测试性改造

| 维度 | 内容 |
|------|------|
| **优先级** | 架构 |
| **问题** | 大量同步 I/O、模块级可变状态、`process.env` 直接修改，使单元测试极其困难 |
| **涉及文件** | 所有 `orchestration/*.ts` 文件 |
| **实施方案** | 引入 adapter 层封装副作用：1. 创建 `orchestration/adapters/fs-adapter.ts`（封装 `readFileSync`/`writeFileSync`/`existsSync`）。2. 创建 `orchestration/adapters/env-adapter.ts`（封装 `process.env` 的 get/set/delete）。3. 创建 `orchestration/adapters/exec-adapter.ts`（封装 `execSync`/`execFileSync`/`spawnSync`）。4. 核心编排函数接受 adapter 参数（可选，默认使用真实实现），测试时注入 mock adapter。5. 将 `write-archive.ts` 的模块级 `archives` Map 改为函数参数传递。 |
| **验收标准** | 核心编排函数（discover-project、probe-env、run-sequential 等）有对应的单元测试文件；测试可以在不依赖真实文件系统和 shell 的情况下运行 |
| **依赖** | 建议在 Phase 1-3 全部完成后实施 |

---

#### Issue #28 — iOS 扩展预留

| 维度 | 内容 |
|------|------|
| **优先级** | 架构 |
| **问题** | `E2E_PLATFORM=ios` 已预留但 `getIosCapabilities()` 直接 throw；ADB 相关逻辑无平台条件分支 |
| **涉及文件** | `config/app.ts`、`helpers/adb.ts`、`helpers/session.ts`、`helpers/deeplink.ts`、`config/platform.ts` |
| **实施方案** | 引入 DeviceBridge 接口：1. 定义 `helpers/device-bridge.ts`，声明接口 `{ getDeviceState(), launchApp(), openUrl(), dismissDialogs(), getForegroundPackage() }`。2. 实现 `AndroidBridge`（封装现有 ADB 逻辑）和 `IOSBridge`（预留，使用 `xcrun simctl` 或 `tidevice`）。3. 通过 `platform.ts` 的 `isIOS()`/`isAndroid()` 在运行时选择 bridge。4. `getIosCapabilities()` 改为返回基于 `xcrun simctl` 或真机 UDID 的 capabilities stub。 |
| **验收标准** | 所有 ADB 调用通过 DeviceBridge 接口进行；`E2E_PLATFORM=ios` 时不 crash 而是给出明确的 "iOS support not yet implemented" 信息 |
| **依赖** | 建议在 Phase 1-3 全部完成后实施；与 Issue #13（统一 browser/driver）协同 |

---

### 实施依赖图

```
Phase 1 (P0 + P1 安全/正确性):
  #1 补全缺失模块 ──┐
  #2 统一路径解析 ──┤
  #3 清除试点残留 ──┤── 依赖 #1
  #4 修复 Shell 注入 ─┤
  #5 消除 common.sh ──┤
  #6 bash 3.2 兼容 ──┤── 依赖 #5
  #7 WebView 共享函数 ┤── 依赖 #1
  #8 CLI 输入校验 ─────┤
  #9 韧性指标修复 ────┤── 依赖 #2
  #10 archive 类型安全 ┘

Phase 2 (P2 代码质量):
  #11 消除静默错误 ────┐
  #12 统一 timeouts ───┤── 依赖 #7
  #13 统一 browser ─────┤
  #14 XHR mock 修复 ───┤
  #15 模板注入防护 ─────┤
  #16 relaxedSecurity ──┤
  #17 竞态+退出码 ──────┤
  #29 archives Map 修复 ┤── 依赖 #2, #10
  #30 preflight 去重 ───┘

Phase 3 (P3 打磨, 可与 Phase 2 并行):
  #18 共享常量 ───────┐
  #19 嵌套三元简化 ──┤
  #20 YAML 安全 ─────┤
  #21 require 消除 ──┤
  #22 scaffold 修正 ──┤
  #23 清理死代码 ────┤
  #24 版本号外部化 ──┤
  #25 校验脚本增强 ──┤── 依赖 #3, #4, #12
  #31 login 判断改进 ─┤
  #32 无意义三元修复 ─┤
  #33 exitCode 修正 ──┤── 依赖 #8
  #34 crossValidate ──┤
  #35 mock 安全加固 ─┘── 依赖 #14

Phase 4 (架构演进, 依赖 Phase 1-3):
  #26 Context Window 优化
  #27 可测试性改造
  #28 iOS 扩展预留
```

---

### 每个 Issue 的验收 Checklist 模板

所有 Issue 完成后，统一跑以下自检：

```bash
# 1. Skill 校验
bash ~/.agents/skills/e2e-device/scripts/validate-skill-dry-run.sh

# 2. 全 scaffold TS 编译
cd <host-repo> && npx tsc --noEmit -p e2e-device/tsconfig.json

# 3. plan-only 全流程
bash e2e-device/scripts/init.sh --plan-only

# 4. 真机跑测（如有设备）
bash e2e-device/scripts/init.sh --sequential

# 5. 报告完整性检查
cat e2e-device/artifacts/resilience-report.md  # 指标不为全零

# 6. 安全性 grep
grep -rn 'execSync.*\${' e2e-device/ --include='*.ts'  # 应为零
grep -rn 'damageMisApply\|"/v2"' e2e-device/ --include='*.ts' --include='*.js'  # 应为零
grep -rn 'browser\.pause([0-9]' e2e-device/ --include='*.ts'  # 应为零
grep -rn 'require(' e2e-device/ --include='*.ts' | grep -v node_modules | grep -v '// '  # 应为零

# 7. 架构检查
grep -rn 'as never' e2e-device/ --include='*.ts'  # 应为零
grep -rn 'driver\.' e2e-device/ --include='*.ts' | grep -v node_modules | grep -v 'import'  # 应为零
grep -rn 'process\.exitCode' e2e-device/ --include='*.ts' | grep -v node_modules | grep -v 'cli.ts'  # 应为零
```

---

*本计划为完整优化路线图。建议按 Phase 分批提交 PR，每个 Phase 一个 PR，便于 review 和回滚。*
