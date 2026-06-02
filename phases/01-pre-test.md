# 01 测试前（Pre-test）

## 目标

在 WebdriverIO 启动前，完成仓库准备、机器契约（manifest）、用例 union、**Agent 门禁**与测试计划确认。

## 检查清单

- [ ] Skill 编排运行时已就绪（`ensure-skill-runtime.sh`）；宿主仅需 wdio 依赖（见 [host-setup.md](../reference/host-setup.md)）
- [ ] `bash e2e-device/scripts/init.sh --plan-only` 或首跑完整 `init.sh`
- [ ] `e2e-device/skill.project.json` 已生成（含 `mock.routes` 时由 discover-request-layer 写入）
- [ ] `case-registry.json`（`discover-cases --union`）
- [ ] **Android SDK** 已安装并配置 `ANDROID_HOME`（见 [android-sdk-setup.md](../reference/android-sdk-setup.md)）
- [ ] `probe-env` 无 blockers（adb → SDK → Appium，见 [agent-gates.md](../reference/agent-gates.md)）
- [ ] `test-plan.md` 已展示并确认（或 10s 默认）
- [ ] `artifacts/runs/<runId>/` 已创建

## Agent 门禁（必须先于跑测）

| 步骤 | 动作 |
|------|------|
| adb | `check-adb.sh` / `probe-env --adb-only`；等待用户 **「已连接」** |
| Android SDK | `android_sdk_missing` → 引导 [android-sdk-setup.md](../reference/android-sdk-setup.md)；等待 **「SDK 已配置」** |
| Appium | 说明项目内安装；征得同意或 5s 默认 → `install-appium`；失败等 **「安装完毕」** |
| 计划 | `present-test-plan` → AskQuestion 或 10s 默认 |

禁止向用户抛出裸 `adb devices` + `npm i -g appium` 清单。

## 脚本（黑盒调用）

| 脚本 / CLI | 产出 |
|------------|------|
| `scaffold.sh --sync-missing` | orchestration、inject、脚本基础设施 |
| `discover-project` | `skill.project.json` + yaml |
| `discover-request-layer`（discover-project 内） | `mock.routes` |
| `discover-from-diff` | `diff-inferred-cases.json` |
| `discover-chaos` | `chaos-case-registry.json` |
| `discover-cases --union` | `case-registry.json` |
| `probe-env` | blockers + questions |
| `present-test-plan` | `test-plan.md` |
| `save-local-config` | bootstrap 后 `initialized: true` |

## 首跑问答（最多 1～2 问）

见 [questionnaire-first-run.md](../questionnaire-first-run.md)。仅当 probe 返回 `required: true` 的 questions 时才提问。

## 退出标准

- 无 adb / Appium blockers
- 测试计划已确认（或默认继续）
- bootstrap spec 存在
- 首次 bootstrap 成功后 `initialized: true`

## 失败时

→ [troubleshooting.md](../troubleshooting.md)
