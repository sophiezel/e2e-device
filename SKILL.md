---
name: e2e-device
description: >-
  Android USB Hybrid 真机 E2E（Appium + WebdriverIO）：测试前/中/后三阶段，含 scaffold、
  intent 与 git-diff 用例 union、chaos、resilience、inject Mock、报告发布至 docs。
  在用户说 真机测试、真机E2E、e2e-device、Appium 真机、USB 真机、
  yarn test:e2e:device、混沌测试、全量测试、快速测试 时使用。
  勿用于无真机的纯 Playwright 浏览器 E2E，或无 Android USB 设备时。
---

# e2e-device（真机 Hybrid E2E）

## 阅读顺序（强制）

1. [security.md](security.md)
2. [reference/arch-overview.md](reference/arch-overview.md) — **架构总览**（必读，~60行）
3. [reference/artifacts-governance.md](reference/artifacts-governance.md) — **产物治理**（必读，所有生成文件的位置/清理/自愈）
4. [docs/pre-config-items.md](docs/pre-config-items.md) — **前置配置项分析**（首次运行需要哪些配置，如何获取）
5. [reference/host-setup.md](reference/host-setup.md) — 宿主接入与依赖分层
5. [reference/agent-gates.md](reference/agent-gates.md) — Agent 门禁话术
6. [reference/lifecycle.md](reference/lifecycle.md) — 测试前/中/后三阶段流程
7. Mock/鉴权：[reference/mock-strategies.md](reference/mock-strategies.md)
8. 按需加载：
   - 环境变量完整列表：[reference/env-vars.md](reference/env-vars.md)
   - 模块实现细节：[reference/arch-details.md](reference/arch-details.md)
   - SDK 安装：[reference/android-sdk-setup.md](reference/android-sdk-setup.md)（`android_sdk_missing` 时）
   - 故障排查：[reference/failure-triage.md](reference/failure-triage.md)
   - 分支决策：[reference/decision-trees.md](reference/decision-trees.md)

## 主决策树

```
用户: 真机测试 / e2e-device
  → 仓库是否存在 e2e-device/scripts/init.sh？
      否 → scaffold（见 01-pre-test）再重试
  → probe blockers（adb / Android SDK / Appium / preflight_vendor_webview / preflight_page_origin）→ 见 agent-gates
  → 读 probe-env 输出的 questions[]:
      - E2E_PAGE_ORIGIN: 引导用户输入 H5 部署域名(如 https://h5.example.com/v2)
      - E2E_CREDENTIALS: 探测设备登录态后再决定是否必填（见下方「凭据安全交互规范」）
      - 其他: 按 required 标记判断
  → present-test-plan → 列出全部 case 按模式分层 → 用户确认:
      - quick（默认，自动选中，10s 无操作即执行）
      - resilience: 全部 + 混沌
      - 默认模式在代码层由 E2E_RUN_PROFILE / discover-intent 强制执行
  → 打印 TODO 清单（[ ] 1 中文描述 (caseId) ~Xs）
  → 默认批量 Session 模式执行（E2E_SEQUENTIAL_INDIVIDUAL=1 回退逐 spec）
  → 实时进度反馈:
      [3/78] ████░░░░░░░░░░ 中文描述 (caseId) ⏳ 执行中...
      [3/78] ████░░░░░░░░░░ 中文描述 (caseId) ✅ passed (12.5s)
      遇鉴权失败且无凭据 → 30s 交互超时 → 跳过该 case 并在报告中标记 skipped_auth
  → 全部执行完毕，生成报告（含测试路径/复现路径/修复建议）
  → publish-reports → 摘要 docs 路径
  → 若存在 artifacts/auth-recovery.json → AUTH_RECOVERY 问卷 → sequential 重跑失败 case
```

### 关键节点：probe-env 结果解析（Agent 必须执行）

`init.sh --plan-only` 输出的 JSON 中，`probeEnv.questions` 数组列出需要用户输入的项。
同时会探测项目是否已引入 Istanbul 覆盖率插件（检查 package.json 依赖及 babel/vite/webpack 配置）。

```json
{
  "probe": {
    "ok": false,
    "snapshot": { "appLoginState": "login_screen" },
    "questions": [
      {"id": "E2E_PAGE_ORIGIN", "prompt": "请输入...", "required": true},
      {"id": "E2E_CREDENTIALS", "prompt": "设备当前在登录页...", "required": true}
    ]
  }
}
```

> `appLoginState` 为 `"login_screen"` 时 `E2E_CREDENTIALS.required = true`；
> 为 `"likely_logged_in"` 或 `"unknown"` 时 `required = false`。

**Agent 必须**：
1. 逐条向用户提问（自然语言，非 JSON 原文）
2. `E2E_PAGE_ORIGIN` → 设置 `export E2E_PAGE_ORIGIN=...` 后重新 `init.sh --plan-only`
3. `E2E_CREDENTIALS`（仅 `required: true` 时）→ 设置 `export E2E_ACCOUNT=xxx E2E_PASSWORD=xxx`（**禁止写入文件**）
4. `required: false` 的 `E2E_CREDENTIALS` → 告诉用户可跳过（测试中遇到需要登录的 case 再交互，30s 超时跳过）
5. **禁止**在用户未回应时使用空字符串默认值

首次提供 `E2E_PAGE_ORIGIN` 后会持久化到 `.e2e-local.json`，二次跑不再询问。

### 凭据安全交互规范（Agent 必须遵守）

probe-env 会**先探测设备登录态**（通过 adb dumpsys window 分析前台 Activity）：
- 若设备**明确在登录页**（如 LoginActivity）→ `required: true`，必须提供凭据
- 若设备**不在登录页**或无法判断 → `required: false`，凭据非必须

当 `E2E_CREDENTIALS` 为 required 时，Agent 必须：

1. **引导用户输入账号密码**：
   > 检测到 App 在登录页。请输入登录凭据，密码仅存在环境变量中，不会写入任何文件或日志：
   > - 账号：____
   > - 密码：____（输入时不可见，仅本次会话内存有效）

2. **设置环境变量**：
   ```bash
   export E2E_ACCOUNT=<用户输入的账号>
   export E2E_PASSWORD=<用户输入的密码>
   ```
   禁止写入 `.e2e-local.json`、`credentials.ts` 或任何仓库文件。

3. **全链路脱敏**：凭据设置后，所有控制台输出、shell 日志、测试报告必须脱敏展示：
   - 账号：`xu***44`（前2位+末尾2位，中间 `***`）
   - 密码：`****`（固定4个星号）
   - init.sh / run-device-e2e.sh 自动脱敏打印
   - login.ts 所有 console.log 使用 `maskAccount()` / `maskPassword()`

4. **30s 交互超时**：测试执行中遇到需登录的 case 且无凭据时，打印提示后等待 30s：
   - 超时未输入 → 跳过该 case，标记 `outcome: "skipped_auth"`，继续执行其他 case
   - 用户在 30s 内输入 → 设置凭据继续执行
   - 报告中汇总 `⏭ 跳过 (未登录) ×N`

5. **CI 提示**：若为 CI 环境，应提示用户在 CI secret 中设置 `E2E_ACCOUNT` 和 `E2E_PASSWORD`，而非 Agent 交互输入。

6. **登录失败处理**：若跑测中因 auth 失败退出（exit 42），生成 `artifacts/auth-recovery.json`，Agent 询问是否重新输入凭据后重跑。

### 设备锁屏 PIN 交互（Agent 必须执行）

当 `probe-env` 输出 `E2E_DEVICE_PIN` 问题时，说明设备可能有锁屏。

1. **引导用户输入**：
   > 设备可能有锁屏密码。请输入数字 PIN（仅用于本次测试自动解锁，不落盘、不传输）：
   > PIN：____（无锁屏或图案锁则跳过）

2. **设置环境变量**：
   ```bash
   export E2E_DEVICE_PIN=<用户输入的PIN>
   ```
   禁止写入任何文件。仅本次 session 有效。

3. **解锁机制**：`wakeDevice()` 使用 `input keyevent` 逐位输入数字 PIN + ENTER。仅支持数字 PIN。

4. **代替方案**：若不想提供 PIN，用户可开启「开发者选项 → 保持唤醒（充电时不熄屏）」+ USB 连接充电，即可跳过锁屏。

### 深链格式诊断（Agent 必须执行）

当 hybrid 测试报 `No WEBVIEW context appeared` 时：

1. **自动试探**：`probeDeepLinkFormats()` 按优先级逐一尝试 3 种格式：
   - `jiangz://openapi/openWebview?url=...`（有 action 路径，最常见）
   - `jiangz://openapi?url=...`（无 action 路径）
   - HTTP URL（直接打开浏览器）

2. **若仍失败**，Agent 应主动询问用户：
   > WebView 未加载。请提供此 App 打开 H5 页面的深链 URL 格式。
   > 如不确定，可提供 Android 项目中的 `SCHEME_HOST` 和 action 常量，我来配置。

3. **用户提供后**，写入 `skill.project.json` 的 `hybrid.deepLink.h5Action`（当前默认 `"openWebview"`）。

4. 此机制与 `openH5ViaAdb` 深度集成——优先使用 manifest 中的 `h5Action`，回退到 `probeDeepLinkFormats()`。

## 唯一入口

```bash
bash e2e-device/scripts/init.sh
bash e2e-device/scripts/init.sh --plan-only    # discover + probe + test-plan.md
bash e2e-device/scripts/init.sh --sequential   # 按 case-registry 逐 spec
```

## 硬性规则

1. Skill 正文**不得**写死包名、公司域名、路径前缀、业务 domain；只读 `e2e-device/skill.project.json`
2. 只 orchestrate `init.sh` / `orch_cli`；禁止手工串联 10+ 条 shell
3. adb / Appium：**禁止**裸三步命令清单；用 [agent-gates.md](reference/agent-gates.md) 话术
4. 跑测前展示 `test-plan.md`；确认或 10s 默认后开始
5. 跑测中 **TodoWrite** + `[i/N] caseId — outcome`；`cases-executed.jsonl` 留痕
6. Mock 默认 **inject**（fetch/XHR）；见 [mock-strategies.md](reference/mock-strategies.md)
7. 凭据仅 env / `.e2e-local.json`（gitignore）；禁止写入 archive / docs 报告
8. 二跑：`initialized === true` 且无 blockers → **禁止首跑问卷**；**允许** `AUTH_RECOVERY` / `E2E_PAGE_ORIGIN`（`auth-recovery.json` 或 `page_origin_unknown`）单次恢复
9. 跑测失败必先 `orch_cli diagnose-run` 或读 `resilience-report.json`；见 [failure-triage.md](reference/failure-triage.md)
10. CI 须预置 `E2E_ACCOUNT`/`E2E_PASSWORD`；`AUTH_RECOVERY` 仅本地 Agent

## 环境变量

完整列表见 [reference/env-vars.md](reference/env-vars.md)。常用变量：

| 变量 | 说明 |
|------|------|
| `E2E_ACCOUNT` / `E2E_PASSWORD` | 登录凭据（禁止写入文件） |
| `E2E_H5_ORIGIN` | 覆盖 manifest pageOrigin |
| `E2E_ENABLE_WEB_MOCK` | `1` 启用 WebView inject mock |
| `E2E_DEBUG` | `1` 打印调试日志 |
| `E2E_PLATFORM` | `android`（默认）或 `ios`（预留） |
| `E2E_SEQUENTIAL_BATCH` | `1` 批量模式 |
| `E2E_NETWORK_LATENCY_MS` | mock 响应延迟（ms） |
| `E2E_VISUAL_DIFF` | `1` 启用视觉回归截图对比 |
| `E2E_COVERAGE_DETECTED` | `1` 已探测到 WebView 中存在 Istanbul 覆盖率数据（内部自动设置） |

### 代码覆盖率（Istanbul）

真机测试自动探测并采集 Istanbul 代码覆盖率，**重点输出增量覆盖率**（仅统计当前分支相对 main/master 变更的业务文件）：

1. **探测阶段**（`probe-env`）：检查项目 `package.json` 及 babel/vite/webpack 配置是否已引入 `babel-plugin-istanbul` / `vite-plugin-istanbul` / `nyc` 等覆盖率插件
2. **运行时探针**（`webview-context.ts`）：切换至 WebView 后自动探测 `window.__coverage__` 和 `window.__coverage_report__`，若存在则标记 `E2E_COVERAGE_DETECTED=1`
3. **采集**：每个 spec 结束后采集覆盖率快照至 `artifacts/runs/<runId>/coverage-snapshots/`；失败 case 也采集部分覆盖率
4. **增量过滤**（`getGitDiffFiles` + `filterBusinessFiles`）：获取 `git diff base...HEAD` 变更文件列表，排除 `package.json`、`*.spec.ts`、`*.d.ts`、样式/文档/配置等非业务文件，仅保留 `.ts/.tsx/.js/.jsx/.vue` 等业务源码
5. **路径匹配**（`filterCoverageByDiff`）：将 Istanbul raw coverage 中的文件路径（支持绝对路径、webpack:// 前缀、相对路径）与 git diff 文件做多策略匹配
6. **汇总**（`finalizeCoverage()`）：合并快照 → 全量 coverage-raw.json + 增量覆盖率摘要（语句/分支/函数/行）
7. **报告**：增量覆盖率优先展示，含变更文件明细（按覆盖率从低到高）、未覆盖文件告警、低于 60% 警告；全量覆盖率折叠展示

增量覆盖率报告示例：
```markdown
### 🔍 增量覆盖率（git diff vs origin/main）
> 变更文件 15 个 · 业务文件 8 个 · 匹配覆盖率 6 个
| 语句 | 342/420 | **81.43%** |
| 分支 | 56/98   | **57.14%** |
| 函数 | 38/48   | **79.17%** |
| 行   | 336/410 | **81.95%** |

⚠️ 变更但未匹配覆盖率（2 个）：
- `src/pages/order/detail.tsx`
- `src/utils/newPayment.ts`
```

- **编排**（discover / probe / plan）：Skill 目录 `node_modules`（`ensure-skill-runtime.sh`），**不在宿主**装 ts-node
- **跑测**（wdio / appium）：**当前宿主仓** `node_modules`（`ensure-host-deps.sh wdio`）

## 自检

```bash
bash ~/.agents/skills/e2e-device/scripts/ensure-skill-runtime.sh
bash ~/.agents/skills/e2e-device/scripts/validate-skill-dry-run.sh
```

模板目录为 `templates/scaffold/`。
