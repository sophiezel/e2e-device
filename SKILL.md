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
| [references/lifecycle.md](references/lifecycle.md) | 三阶段执行细节 / progress 摘要时 |
| [references/hybrid-contract.md](references/hybrid-contract.md) | WebView context / anchor / Hybrid 失败时 |
| [references/decision-trees.md](references/decision-trees.md) | Quick Path / plan-only / mode 分支不明时 |
| [references/artifacts-governance.md](references/artifacts-governance.md) | 产物清理/查找时 |
| [references/mock-strategies.md](references/mock-strategies.md) | Mock 注入失败/策略调整时 |
| [references/failure-triage.md](references/failure-triage.md) | **MANDATORY** 有失败 case 或存在 `diagnose-request.json` 时 |
| [references/biz-case-extraction.md](references/biz-case-extraction.md) | biz case 缓存未命中、需从文档补齐时 |
| [references/env-vars.md](references/env-vars.md) | 需要完整环境变量列表时 |
| [references/pre-config-items.md](references/pre-config-items.md) | 前置三元组 / 端上依赖 / list-preconfig 时 |
| [references/android-sdk-setup.md](references/android-sdk-setup.md) | Android SDK 缺失需安装时 |

---

## 唯一入口

所有操作通过 skill 自身的 `scripts/run.sh` 路由，指定 `--project` 指向目标项目。
**禁止**使用 `assets/scaffold/scripts/init.sh`（LEGACY，仅历史仓库残留）。

```bash
bash scripts/run.sh --project /path/to/project --plan-only
bash scripts/run.sh --project /path/to/project --domain myFeature --mode standard
```

### Agent 执行契约（脚本保持非交互）

```
1. list-preconfig → 确认三元组 → export E2E_*
2. run.sh --plan-only          ← 默认先停在计划
3. AskQuestion 确认 mode       ← 用户确认后
4. run.sh（去掉 --plan-only）  ← 再执行
```

脚本**不会**在 plan 后 pause；确认由 Agent 完成。

### 效率契约（单 domain 墙钟）

| Profile | 预算 | 策略 |
|---------|------|------|
| `quick` | ≤12 min | smoke/p0；无 hybrid/chaos；排除 pending-assert |
| `standard` | **≤25 min** | 排除 pending-assert；form cap 默认 12（`E2E_STANDARD_FORM_CAP`） |
| `resilience` | 无硬顶 | 含 chaos / 弱断言，须用户显式选择 |

日常冒烟优先 `quick`。plan 估算超预算会警告。禁止用堆 case / 冷启换覆盖。

---

## 入口决策树

> **遇到 blockers 时** 读 [references/agent-gates.md](references/agent-gates.md) 对应门禁章节。
> **Do NOT load** `references/agent-gates.md` 全部内容（仅按需查门禁表）。
> **Do NOT load** `references/mock-strategies.md` 除非 Mock 注入失败。
> **失败后 MUST load** `references/failure-triage.md`。

### 1. 前置配置 🔴 CHECKPOINT

**输入**：用户请求 + 项目路径  
**动作**：`bash scripts/list-preconfig.sh --project <path> [--domain <hint>]`

读 JSON：`pageOriginCandidates` / `appPackageCandidates` / `domainCandidates` / `quickPathEligible`

| 条件 | 动作 |
|------|------|
| `quickPathEligible === true` 且三项 env 已齐 | **跳过 AskQuestion**；摘要展示 effective 三元组 |
| 否则 | AskQuestion 确认 pageOrigin / appPackage / domain（即使各 1 候选也确认） |

确认后 export（缺一 → `preconfig_unconfirmed`）：

```bash
export E2E_PAGE_ORIGIN=<H5基址>
export E2E_APP_PACKAGE=<测试包名>
export E2E_DOMAIN=<主测domain>
```

Quick Path 条件：同设备 + 同分支 + 同 domain + manifest `userConfirmed` 与当前 env 一致。详见 [decision-trees.md](references/decision-trees.md)。

### 2. 计划确认 🔴 CHECKPOINT

```bash
bash scripts/run.sh --project <path> --domain "$E2E_DOMAIN" --mode <hint> --plan-only
```

展示 case 清单与估算耗时 → AskQuestion：`standard`（默认）/ `q`=quick / `r`=resilience  
⚠️ 未经用户确认不得进入执行

### 3. 执行

```bash
bash scripts/run.sh --project <path> --domain "$E2E_DOMAIN" --mode <confirmed>
```

脚本自动：runtime / ADB / pageOrigin / App smoke / discover / case-cache / Journey wdio / publish-reports。

### 4. 失败诊断（有失败时）

若 `$E2E_HOME/sandbox/.../artifacts/runs/<runId>/diagnose-request.json` 存在：
1. **MUST** 读 [failure-triage.md](references/failure-triage.md)
2. 按 L0→L1→L2 读截图 + 错误栈 + logcat
3. 将根因与修复建议写入用户摘要（不修改业务代码）

---

## 执行前自检（进入 `--plan-only` 前）

- 设备就绪？`adb devices` 有 `device`
- WebView 可调试？debug 构建 + `setWebContentsDebuggingEnabled(true)`
- 锁屏？有 PIN → `E2E_DEVICE_PIN` 已 export（盲传，不入对话）
- 鉴权 case？`E2E_ACCOUNT` + `E2E_PASSWORD` 已在环境中（禁止 AskQuestion 回显密码）
- pageOrigin 可达？设备侧可访问 H5 基址

---

## 执行规则

### 全局约束

- **不阻断**: case 失败/超时 → 记录 → 轻量 reset → 继续
- **超时**: 每 case 45s
- **不修代码**: 只记录，不改业务代码
- **不污染 context**: 进度在 `progress.jsonl`；Agent 仅读尾部摘要 / 最终失败列表（禁止每 case TodoWrite）
- **零配置入项目**: 除最终报告，产物不写入项目仓库
- **凭据**: 仅 OS env / CI secret；禁止 `credentials.json`；禁止对话中明文密码

### Session（Journey 分段，默认）

| 段 | 内容 | Session |
|----|------|---------|
| `env` | app-launch | 冷启动 1 次 |
| `list` | 列表 smoke | 同 Session，轻量回锚点 |
| `form` | 表单回归 | 同 Session，expertReset；每 12 case 可选 reloadSession |
| `infra` | hybrid bridge/nav/error/performance | 新 Session |
| `chaos` | resilience 混沌 | 独立 Session |

回退：`E2E_SEQUENTIAL_INDIVIDUAL=1` 或 `E2E_SUITE_LEGACY=1`。

### 元素定位

```
优先: data-e2e → #id → [data-testid] → CSS → XPath（最后）
```

### Mock

默认开启；`E2E_ENABLE_WEB_MOCK=0` 关闭。规则来自宿主 `e2e-device/fixtures/{domain}/`。

### 覆盖率

探测 `window.__coverage__`；无探针时降级为「覆盖率不可用」，**不**因此判 case 失败。

---

## 测试后

```
全部 case 结束 →
  ├─ 截图 diff + logcat + 覆盖率合并
  ├─ diagnose-request.json（若有失败）→ Agent 按 failure-triage 诊断
  └─ publish-reports → {docsPath}/{date}-真机E2E-{time}.md
```

产物：`$E2E_HOME/sandbox/{hash}/{domain}/artifacts/runs/{runId}/`

---

## NEVER

- NEVER 使用 `init.sh` / 项目内 scaffold 作为主入口（唯一入口 `scripts/run.sh`）
- NEVER 在跑测中修改项目业务代码
- NEVER 因一个 case 失败而停止后续 case
- NEVER 在 Agent 对话中渲染完整进度面板或每 case TodoWrite
- NEVER 把截图/日志/中间产物写入项目仓库（仅报告可入）
- NEVER 把凭据写入任何文件或 AskQuestion 回显密码
- NEVER 对 WebView context 做精确全名匹配（用 `startsWith('WEBVIEW')`）
- NEVER 在未 hideKeyboard() 的情况下点击底部元素
- NEVER 把 biz case 提取成本转嫁给用户（Agent 读文档提取，用户只确认）
- NEVER 在 session 仍可复用时重建 session
- NEVER 使用 XPath 作为首选定位策略
- NEVER 用 `browser.pause(N)` 硬编码等待
- NEVER 对 Hybrid App 做纯 Playwright 测试
- NEVER 写死包名、公司域名、路径前缀、业务 domain 到通用模板
- NEVER 声称已自动 spawn「并行 LLM subagent」——诊断由 Agent 读 `diagnose-request.json` 完成
