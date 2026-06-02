---
name: e2e-device
description: >-
  Android USB Hybrid 真机 E2E（Appium + WebdriverIO）：测试前/中/后三阶段，含 scaffold、
  intent 与 git-diff 用例 union、chaos、resilience、inject Mock、报告发布至 docs。
  在用户说 真机测试、真机E2E、e2e-device、Appium 真机、USB 真机、
  yarn test:e2e:device 时使用。
  勿用于无真机的纯 Playwright 浏览器 E2E，或无 Android USB 设备时。
---

# e2e-device（真机 Hybrid E2E）

## 阅读顺序（强制）

1. [security.md](security.md)
2. [reference/architecture-and-guide.md](reference/architecture-and-guide.md) — **设计架构 · 功能 · 使用总览**
3. [reference/host-setup.md](reference/host-setup.md) — 含 **Android SDK 必备** 摘要
4. [reference/android-sdk-setup.md](reference/android-sdk-setup.md) — **SDK 安装指引**（`android_sdk_missing` 时必读）
5. [reference/agent-gates.md](reference/agent-gates.md)
6. [phases/01-pre-test.md](phases/01-pre-test.md) → [02](phases/02-during-test.md) → [03](phases/03-post-test.md)
7. Mock：[reference/mock-strategies.md](reference/mock-strategies.md)
8. 分支不明时：[reference/decision-trees.md](reference/decision-trees.md)

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

## 环境变量（Skill 级）

| 变量 | 说明 |
|------|------|
| `E2E_DEVICE_SKILL_ROOT` | Skill 根目录，默认 `~/.agents/skills/e2e-device` |
| `E2E_AUTO_INSTALL_SKILL_RUNTIME` | `1`（默认）缺编排依赖时在 Skill 目录 `npm install` |
| `E2E_AUTO_INSTALL_DEPS` | `1`（默认）缺 wdio 时在**宿主仓**自动安装 |
| `E2E_ENABLE_WEB_MOCK` | `1` 启用 WebView inject |
| `E2E_USER_INTENT` | 自然语言意图，供 discover-intent |
| `E2E_ANDROID_API_LEVEL` | 自动安装 SDK 时的 API level，默认 `34` |
| `E2E_ANDROID_BUILD_TOOLS` | 自动安装 build-tools 版本，默认 `34.0.0` |

## 依赖分层（强制）

- **编排**（discover / probe / plan）：Skill 目录 `node_modules`（`ensure-skill-runtime.sh`），**不在宿主**装 ts-node
- **跑测**（wdio / appium）：**当前宿主仓** `node_modules`（`ensure-host-deps.sh wdio`）

## 自检

```bash
bash ~/.agents/skills/e2e-device/scripts/ensure-skill-runtime.sh
bash ~/.agents/skills/e2e-device/scripts/validate-skill-dry-run.sh
```

维护模板后同步旧目录：`bash ~/.agents/skills/e2e-device/scripts/sync-legacy-templates.sh`

旧路径 `~/.agents/skills/device-e2e` 已废弃，见该目录 `DEPRECATED.md`（若存在）。
