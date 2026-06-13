---
name: e2e-device
description: >-
  Android USB Hybrid 真机 E2E（Appium + WebdriverIO）。覆盖测试前环境预检/项目发现/域确认/case提取、
  测试中分组执行/进度追踪/超时保护/失败不阻断、测试后诊断与报告发布。涵盖 infra/biz/chaos 三类 case，
  支持 quick/standard/resilience 三级测试深度。使用场景：真机测试、真机E2E、e2e-device、
  Appium 真机、USB 真机、yarn test:e2e:device、混沌测试、全量测试、快速测试。
  勿用于无真机的纯 Playwright 浏览器 E2E，或无 Android USB 设备时。
---

# e2e-device（真机 Hybrid E2E）

## 阅读入口

首次加载：读完本文（决策树 + 规则）。
需要了解具体细节时再按需加载对应 reference，不要预加载全部。

| 文件 | 何时读 |
|------|--------|
| [CONTEXT.md](CONTEXT.md) | 术语含义不明时 |
| [references/agent-gates.md](references/agent-gates.md) (凭据安全规范章节) | 处理凭据/PIN/敏感数据时 |
| [references/agent-gates.md](references/agent-gates.md) | 需要与用户交互的话术时 |
| [references/arch-overview.md](references/arch-overview.md) | 需要理解整体架构时 |
| [references/artifacts-governance.md](references/artifacts-governance.md) | 产物清理/查找时 |
| [references/mock-strategies.md](references/mock-strategies.md) | Mock 注入失败/策略调整时 |
| [references/failure-triage.md](references/failure-triage.md) | 诊断失败 case 时 |
| [references/env-vars.md](references/env-vars.md) | 需要完整环境变量列表时 |
| [references/android-sdk-setup.md](references/android-sdk-setup.md) | Android SDK 缺失需安装时 |

---

## 唯一入口

Skill 级入口脚本位于 skill 自身的 `scripts/` 目录。
项目被 scaffold 后，项目内也会生成 `e2e-device/scripts/init.sh`——这是两个不同的脚本：
- **Skill 级**: `bash ~/.agents/skills/e2e-device/scripts/run.sh --project <项目路径>`
- **项目级**（scaffold 后）: `bash e2e-device/scripts/init.sh`

```bash
# Skill 级调用
bash scripts/run.sh --project /path/to/project
bash scripts/run.sh --project /path/to/project --plan-only

# 项目级调用（需先 scaffold）
bash e2e-device/scripts/init.sh
bash e2e-device/scripts/init.sh --plan-only
```

---

## 入口决策树

> **MANDATORY — READ [references/agent-gates.md](references/agent-gates.md) 完整文件** 在与用户交互的每个门禁步骤时。
> **Do NOT load** `references/mock-strategies.md` 除非 Mock 注入失败。
> **Do NOT load** `references/failure-triage.md` 除非有 case 失败需要诊断。

```
用户: 真机测试 / e2e-device

├─ 仓库是否有 e2e-device/scripts/init.sh?（项目级 scaffold 产物）
│   否 → 执行 scaffold（见 assets/scaffold/）→ 再回来
│   是 → 继续
│
├─ [环境预检]
│   ├─ adb devices → 有 device? 
│   │   否 → "请连接手机并开启 USB 调试"
│   │   是offline/unauthorized → "请在手机上授权 USB 调试弹窗"
│   │   是 → 继续
│   │
│   ├─ WebView 调试开关检测
│   │   检测不到 WEBVIEW context → "请使用 debug 构建包（需开启 setWebContentsDebuggingEnabled）"
│   │   这是 Hybrid E2E 的硬前置条件，不可跳过
│   │
│   ├─ 设备信息采集: manufacturer / model / Android 版本 / WebView 版本
│   ├─ chromedriver 匹配（多版本共存，按 WebView major 自动匹配）
│   ├─ pageOrigin 可达性检查（adb shell curl）
│   ├─ 权限预授权（adb shell pm grant 定位/存储等）
│   ├─ Appium + uiautomator2-driver 就绪检查
│   └─ 输出: deviceProfile
│
├─ [项目发现]
│   ├─ 从项目源码发现 packageName/scheme/deepLink模板/routingMode/docsPath
│   ├─ adb 匹配已安装 App（多 App? → 引导用户选择）
│   ├─ 深链格式预验证（adb am start 测试是否成功打开 WebView）
│   ├─ 探测登录态（前台 Activity 分析）
│   └─ 输出: projectManifest + loginState
│
├─ [判断: Quick Path?]
│   条件: 同设备 + 同分支 + lastDomain 存在?
│   是 → 跳过域确认和 case 提取, 直接进入测试级别确认
│   否 → Full Path（继续以下步骤）
│
├─ [域确认] ← 仅 Full Path
│   ├─ git diff 当前分支 vs main → 推断 domain 候选
│   ├─ 扫描 docsPath 最新文档 → 提取 domain 候选
│   ├─ 交叉验证 → 与 lastDomain 对比
│   │   1条结果 → 确认/手动修正
│   │   多条结果 → 引导选择/手动输入
│   │   0条结果 → 引导手动输入
│   └─ 更新 lastDomain
│
├─ [Case 发现] ← 仅 Full Path
│   ├─ infra case: 框架内置（WebView切换、深链、登录态、页面不白屏、键盘隐藏）
│   ├─ chaos case: 框架内置（接口超时、JS错误降级、Mock异常）
│   ├─ biz case:
│   │   ├─ 查 case-cache/{branch}/{domain}.json
│   │   ├─ 缓存命中且源文档哈希不变? → 直接复用
│   │   ├─ 缓存部分失效? → 只对变化文档重新提取
│   │   ├─ 缓存全失/不存在? → Agent 读需求文档 → 理解→提取→缓存
│   │   │   每个 case 标注 fromFile 归因
│   │   └─ 展示 case 清单 → 用户确认/补充
│   └─ 输出: caseRegistry（含 infra/biz/chaos 全量）
│
└─ [测试级别确认]
    ├─ 展示: "standard 级别, N cases, 预计 X min, 10s 后执行"
    ├─ 用户可选: Enter(确认) / q(quick) / r(resilience) / c(切换domain)
    ├─ quick → 每 domain 只取首个 biz case
    ├─ resilience → 追加全部 chaos case
    └─ 输出: finalCaseList + 预估耗时
```

---

## 执行规则

### 全局约束

- **不阻断**: 一个 case 失败/超时 → 记录 → 轻量 reset → 继续下一个
- **超时**: 每 case 45s。超时 → 截图 + 日志快照 + 标记 TIMEOUT → 继续
- **不修代码**: 测试中遇到问题，只记录，不修改业务代码
- **不污染 context**: 进度写入 `progress.jsonl`，Agent 不渲染面板
- **零配置入项目**: 除最终测试报告，任何产物不写入项目仓库
- **凭据安全**: 账号/密码/PIN 仅通过盲传通道注入子进程环境变量，永不过 Agent 上下文

### Session 管理

- `noReset: true`, `skipDeviceInitialization`, `skipServerInstallation`
- 一次 session 跑全部 case, 不在 case 间重建
- 仅 Native 容器异常（crash/弹窗无法 dismiss）时重建
- 自动 dismiss 系统弹窗（OEM 首次启动、权限二次确认）

### 执行顺序

- 按 domain 分组, 共享 WebView 预热
- 组内按导航深度递增排序（浅→深）
- 每个 case 结束回 domain 锚点页
- 轻量 reset (cookies + localStorage + sessionStorage + 回锚点 + hideKeyboard)

### 元素定位策略

```
优先: data-e2e (DOM 运行时标注注入)
回退: #id > [data-testid] > CSS tag.class > XPath（最后兜底）
```

### Mock

- 默认开启，环境变量 `E2E_ENABLE_WEB_MOCK=0` 可关闭
- 启动后、第一个 case 前预注入全部 Mock 规则

### 覆盖率

- 自动探测 Istanbul 覆盖率（WebView 内检测 `window.__coverage__`）
- 每 case 后采集快照 → 全部完成后合并 → 增量覆盖率（git diff vs main）

---

## 测试后

```
全部 case 结束 →
  ├─ 脚本批量处理: 截图 diff + logcat 错误提取 + 覆盖率合并
  ├─ 有失败 case? → 并行 LLM subagent 诊断每个失败 case
  │                   读截图 + 错误栈 + logcat → 判定根因 → 修复建议
  └─ 模板生成报告 → 写入 {docsPath}/{date}-真机E2E-{time}.md

报告内容:
  - 总览: 通过/失败/超时/跳过 + 通过率
  - 失败详情: 测试路径 + 错误 + 复现步骤 + 修复建议
  - 增量覆盖率
  - LLM 介入统计 (reason + tokens)
  - 产物目录路径（截图/日志等的位置）

产物查找:
  截图/日志/覆盖率数据/进度文件 → $E2E_HOME/sandbox/{project}/{domain}/artifacts/runs/{runId}/
  报告末尾标注产物路径
```

---

## NEVER

- NEVER 在跑测中修改项目业务代码
- NEVER 因一个 case 失败而停止后续 case
- NEVER 在 Agent 对话中渲染完整进度面板（用 progress.jsonl 中介）
- NEVER 把截图/日志/中间产物写入项目仓库（仅报告可入）
- NEVER 把凭据写入任何文件（仅 OS Keychain 或盲传环境变量）
- NEVER 对 WebView context 做精确全名匹配（用 `startsWith('WEBVIEW')`）
- NEVER 在未 hideKeyboard() 的情况下点击底部元素
- NEVER 把 biz case 的提取成本转嫁给用户（Agent 读文档提取，用户只确认）
- NEVER 在 session 仍可复用时重建 session
- NEVER 使用 XPath 作为首选定位策略
- NEVER 用 `browser.pause(N)` 硬编码等待（用 ExplicitWait 条件等待）
- NEVER 对 Hybrid App 做纯 Playwright 测试（必须有 Android USB 真机 + Appium）
- NEVER 写死包名、公司域名、路径前缀、业务 domain 到通用模板
