# 宿主项目接入（通用）

Skill 不绑定任何业务仓库。在**宿主项目根目录**执行：

```bash
bash e2e-device/scripts/scaffold.sh --sync-missing
bash e2e-device/scripts/init.sh --plan-only
```

## 依赖分层

| 层级 | 安装位置 | 内容 | 何时需要 |
|------|----------|------|----------|
| **Skill 编排运行时** | `~/.agents/skills/e2e-device/node_modules` | `typescript` `ts-node` `@types/node` | `init.sh --plan-only` / discover / probe |
| **宿主跑测依赖** | 当前宿主仓 `node_modules` | `@wdio/*` `appium` | `init.sh` 真机跑测 / `run-device-e2e.sh` |

### Skill 编排运行时（一次安装，全宿主共用）

```bash
cd ~/.agents/skills/e2e-device
npm install
# 或首次 init 时自动：E2E_AUTO_INSTALL_SKILL_RUNTIME=1（默认）
```

`orch_cli` 使用 `$E2E_DEVICE_SKILL_ROOT/node_modules/.bin/ts-node` 执行宿主目录下的 `e2e-device/orchestration/cli.ts`（cwd 仍为宿主根目录）。

### 宿主跑测依赖（每个宿主仓）

`run_wdio` 前执行 `ensure-host-deps.sh wdio`：

- 默认 `E2E_AUTO_INSTALL_DEPS=1` → 在本仓 npm/yarn 自动安装
- 失败则打印本仓应执行的 `npm install --save-dev ...` 并退出

```bash
bash e2e-device/scripts/ensure-host-deps.sh wdio
```

**不要**为编排去改宿主 `package.json` 装 `ts-node`（除非宿主另有 TypeScript 需求）。

强制用 git-diff 覆盖 manifest 的 pilot：`export E2E_INTENT_USE_GIT_DIFF=1`

## Android SDK（真机跑测必备）

真机 E2E 依赖 **Appium UiAutomator2**，必须配置完整 **Android SDK**（`ANDROID_HOME` / `ANDROID_SDK_ROOT`）。  
**仅安装 `adb` / Homebrew `android-platform-tools` 不够**。

| 检查项 | 说明 |
|--------|------|
| SDK 目录 | 含 `platforms/`、`build-tools/`（常见路径 `~/Library/Android/sdk`） |
| 环境变量 | `ANDROID_HOME`、`ANDROID_SDK_ROOT` 指向上述目录 |
| USB | `adb devices` 为 `device`（非 `unauthorized`） |

**完整安装步骤** → [android-sdk-setup.md](./android-sdk-setup.md)（Agent 遇 `android_sdk_missing` 时必须引用该文档向用户说明）。

`init.sh --plan-only` 的 `probe-env` 会检测 SDK；未通过则不得开始跑测。

## 宿主必须自备（Skill 不生成业务用例）

- `e2e-device/wdio.conf.ts`（可从 `wdio.conf.template.ts` 复制）
- `e2e-device/specs/00-bootstrap.spec.ts`
- `e2e-device/skill.project.json`
- 真机：**Android SDK**（见上）、`E2E_ACCOUNT`、`E2E_PASSWORD`、`ANDROID_UDID`（或 probe 识别的 serial）

## L1 vs L2

- **L1**：registry 仅 bootstrap → 不强制 `mock.routes`
- **L2**：有业务 spec → 需 `mock.routes` + fixtures

`export E2E_L1_ONLY=1` 可强制按 L1 检查。

## 入口

manifest `commands.run`：有 `yarn test:e2e:device` 则用该脚本，否则 `bash e2e-device/scripts/init.sh`。
