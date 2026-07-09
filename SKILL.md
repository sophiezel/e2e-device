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
| [references/agent-gates.md](references/agent-gates.md) | 环境预检返回 blockers 或鉴权恢复时（仅按需查门禁表，不加载全文） |
| [references/arch-overview.md](references/arch-overview.md) | 需要理解整体架构时 |
| [references/artifacts-governance.md](references/artifacts-governance.md) | 产物清理/查找时 |
| [references/mock-strategies.md](references/mock-strategies.md) | Mock 注入失败/策略调整时 |
| [references/failure-triage.md](references/failure-triage.md) | 诊断失败 case 时 |
| [references/env-vars.md](references/env-vars.md) | 需要完整环境变量列表时 |
| [references/pre-config-items.md](references/pre-config-items.md) | 前置三元组 / 端上依赖 / list-preconfig 时 |
| [references/android-sdk-setup.md](references/android-sdk-setup.md) | Android SDK 缺失需安装时 |

---

## 唯一入口

所有操作通过 skill 自身的 `scripts/run.sh` 路由，指定 `--project` 指向目标项目。
不需要在项目目录中安装或 scaffold 任何文件。

```bash
bash scripts/run.sh --project /path/to/project
bash scripts/run.sh --project /path/to/project --plan-only
bash scripts/run.sh --project /path/to/project --domain myFeature --mode resilience
```

---

## 执行前自检 · 🔴 CHECKPOINT

> 🛑 STOP — 以下全部通过后才可进入执行。

在调用 `run.sh` 之前，Agent MUST 按顺序完成：

### 0. 前置配置三元组（每次必做，不受 initialized 豁免）

```bash
bash scripts/list-preconfig.sh --project <path> [--domain <hint>]
```

1. 读取 JSON：`pageOriginCandidates` / `appPackageCandidates` / `domainCandidates`（含分数与证据）
2. **AskQuestion** 一轮确认三项（即使各只有 1 个候选也必须确认）：
   - **pageOrigin** — H5 部署基址（勿把 `I_ORIGIN` / API 域当 pageOrigin）
   - **appPackage** — 设备上测试包（正式包 vs 测试包）
   - **domain** — 本轮主测页面模块（多域任务选一个主测域）
3. 用户确认后 **export**（缺一不可，否则 `run.sh` 以 `preconfig_unconfirmed` 退出）：

```bash
export E2E_PAGE_ORIGIN=<确认的H5基址>
export E2E_APP_PACKAGE=<确认的测试包名>
export E2E_DOMAIN=<确认的主测domain>
```

4. 再执行 `bash scripts/run.sh --project <path> --domain "$E2E_DOMAIN" --mode ...`

详见 [references/pre-config-items.md](references/pre-config-items.md)。

### 1. 环境与设备

- **设备就绪？** `adb devices` 是否有 `device` 状态的设备？无设备 → 先走 agent-gates.md adb 门禁。
- **WebView 可调试？** App 是否用 debug 构建包（`setWebContentsDebuggingEnabled(true)`）？无此条件 WebView 测试全部失效——这是 Hybrid E2E 的硬前置条件。
- **PIN 已设置？** 设备有锁屏 → `E2E_DEVICE_PIN` 是否已 export？无 PIN 时 swipe 兜底解锁可能失败。
- **凭据已就绪？** 涉及鉴权 case → `E2E_ACCOUNT` + `E2E_PASSWORD` 是否已盲传至子进程环境变量？
- **pageOrigin 可达？** `adb shell curl` 目标 H5 部署域名是否返回 200/301/401？不可达 → 引导用户输入正确域名。

全部通过 → 🔴 CHECKPOINT PASSED → 执行 `bash scripts/run.sh --project <path>`。

---

## 入口决策树

> **遇到 blockers 时** 读 [references/agent-gates.md](references/agent-gates.md) 对应门禁章节。
> **Do NOT load** `references/agent-gates.md` 全部内容（仅按需查门禁表）。
> **Do NOT load** `references/mock-strategies.md` 除非 Mock 注入失败。
> **Do NOT load** `references/failure-triage.md` 除非有 case 失败需要诊断。

### 1. 前置配置确认 🔴 CHECKPOINT · 🛑 STOP

**输入**：用户请求 + 项目路径  
**动作**：`list-preconfig.sh` → AskQuestion 三元组 → `export E2E_*`  
**输出**：已确认的 `E2E_PAGE_ORIGIN` / `E2E_APP_PACKAGE` / `E2E_DOMAIN`  
**阻断**：缺任一 env → `preconfig_unconfirmed`（禁止用 manifest 缓存静默跑测）

### 2. 环境预检 🔴 CHECKPOINT · 🛑 STOP

**输入**：已确认的三元组 + USB 设备连接
**动作**：`run.sh --project <path>` 自动完成
- 依赖安装（ensure-skill-runtime.sh）
- 屏幕常亮 + PIN 解锁（开屏即执行）
- ADB 设备验证 + 自动重试
- WebView debug 状态提示
- pageOrigin 可达性检查
- App 启动冒烟（scheme deeplink + `-p`）
- 权限预授权

**输出**：
- ✅ 全部通过 → 进入步骤 3
- ❌ blockers[] → 🔴 CHECKPOINT · 🛑 STOP → 查 agent-gates.md → 引导用户解决 → 重新预检

### 3. 项目发现（派生配置，不问用户）

**输入**：已确认三元组
**动作**：run.sh 自动 discover-project → 写 `userConfirmed` 到 manifest
- deepLink.scheme / routingMode / apiOrigin 等由 discover 派生
- **禁止**用缓存 pageOrigin/appPackage/domain 覆盖用户 env

**输出**：`~/.e2e-device/projects/{hash}/manifest.json`

### 4. Case 发现

**输入**：domain + 项目结构
**动作**：run.sh 自动
- infra/chaos：框架内置
- biz：case-cache 命中复用 / 未命中 Agent 提取

**输出**：case 清单（展示给用户）

### 5. 测试级别确认 🔴 CHECKPOINT · 🛑 STOP

**输入**：case 清单 + 估算耗时 + **已确认的 appPackage**
**动作**：Agent 询问 → `standard 模式, N cases, 约 X min`
- 用户可选：Enter(确认) / q(quick) / r(resilience)
- 用户确认后 → 执行 `run.sh`（wdio 批量跑，不走逐 case 循环）

**输出**：确认的测试级别 + 进入执行阶段

⚠️ 未经用户确认不得进入执行阶段

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
- NEVER 把截图/日志/中间产物写入项目仓库（仅报告可入）→ 项目仓库不应被运行时产物污染，且截图可能含敏感数据
- NEVER 把凭据写入任何文件（仅 OS Keychain 或盲传环境变量）→ 凭据落盘是安全红线，泄露后需全部轮换
- NEVER 对 WebView context 做精确全名匹配（用 `startsWith('WEBVIEW')`）→ 不同 Android 版本/厂商的 WebView 全名不同（如 `WEBVIEW_12345`），精确匹配必挂
- NEVER 在未 hideKeyboard() 的情况下点击底部元素 → 键盘弹出时 Appium 坐标计算偏移，点击命中位置与实际元素错位
- NEVER 把 biz case 的提取成本转嫁给用户（Agent 读文档提取，用户只确认）
- NEVER 在 session 仍可复用时重建 session → 每次重建 = 30~90s 浪费，且冷启动触发 OEM 厂商欢迎页/权限弹窗
- NEVER 使用 XPath 作为首选定位策略 → XPath 对 DOM 结构敏感，H5 页面迭代后极易断裂；优先用 data-e2e / #id / [data-testid]
- NEVER 用 `browser.pause(N)` 硬编码等待（用 ExplicitWait 条件等待）→ 固定等待在 CI/低端机上不足、高端机上浪费时间，条件等待自适应
- NEVER 对 Hybrid App 做纯 Playwright 测试（必须有 Android USB 真机 + Appium）→ Playwright 无法访问 Native 容器、WebView context、设备传感器和 OEM 弹窗
- NEVER 写死包名、公司域名、路径前缀、业务 domain 到通用模板 → 硬编码导致 Skill 不可跨项目复用，应通过 discover-project 自动探测 + 缓存
