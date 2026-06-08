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
3. [reference/host-setup.md](reference/host-setup.md) — 宿主接入与依赖分层
4. [reference/agent-gates.md](reference/agent-gates.md) — Agent 门禁话术
5. [reference/lifecycle.md](reference/lifecycle.md) — 测试前/中/后三阶段流程
6. Mock/鉴权：[reference/mock-strategies.md](reference/mock-strategies.md)
7. 按需加载：
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
  → probe blockers（adb / Android SDK / Appium）→ 见 agent-gates（已连接 / SDK 已配置 / 安装完毕）
  → present-test-plan → 用户确认或 10s 默认
  → init.sh 或 init.sh --sequential
  → publish-reports → 摘要 docs 路径
  → 若存在 artifacts/auth-recovery.json → AUTH_RECOVERY 问卷 → sequential 重跑失败 case
```

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

## 依赖分层（强制）

- **编排**（discover / probe / plan）：Skill 目录 `node_modules`（`ensure-skill-runtime.sh`），**不在宿主**装 ts-node
- **跑测**（wdio / appium）：**当前宿主仓** `node_modules`（`ensure-host-deps.sh wdio`）

## 自检

```bash
bash ~/.agents/skills/e2e-device/scripts/ensure-skill-runtime.sh
bash ~/.agents/skills/e2e-device/scripts/validate-skill-dry-run.sh
```

模板目录为 `templates/scaffold/`。
