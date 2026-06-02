# Agent 交互门禁

Skill 负责话术与等待闭环；脚本只输出 `blockers[]` / 安装结果，**不在 shell 里 sleep**。

## adb 门禁

1. 调用 `bash e2e-device/scripts/check-adb.sh` 或 `orch_cli probe-env --adb-only`
2. 若 `blockers` 含 `adb_missing` / `adb_no_device` / `adb_unauthorized`：
   - **禁止**向用户罗列「安装 platform-tools、执行 adb devices…」等裸命令清单
   - 用自然语言说明：请插好 USB、在手机上点「允许 USB 调试」
   - 等待用户回复 **「已连接」** 后重新 `probe-env`
3. `probe.ok === true` 且无 adb 类 blocker 后再进入 Appium / 跑测

| blocker id | 用户侧动作 |
|------------|------------|
| `adb_missing` | 本机安装 Android platform-tools（Agent 可给一条官方下载链，不列多步） |
| `adb_no_device` | 插线 + 授权 |
| `adb_unauthorized` | 手机上撤销授权后重新允许 |

## Android SDK 门禁

1. `probe-env` 若含 **`android_sdk_missing`** / **`android_sdk_incomplete`**：
   - 说明：真机 E2E 需要 **完整 Android SDK**（`ANDROID_HOME`），**不是**只装 `adb` / Homebrew platform-tools。
   - **macOS 且已装 Homebrew**：与 Appium 相同流程——说明将用 Homebrew 安装 commandlinetools + 必要组件；**AskQuestion** 是否现在安装，或 **5 秒后默认同意**；同意后执行 `bash e2e-device/scripts/install-android-sdk.sh` 或 `orch_cli install-android-sdk`。
   - 安装失败或非 macOS：引导 [android-sdk-setup.md](./android-sdk-setup.md) 手动安装（Android Studio 或官方 CLI）。
   - **禁止**长串裸 `sdkmanager` 清单；自动安装失败时再给 1～2 条手动兜底。
   - 完成后重新 `probe-env`；用户也可回复 **「SDK 已配置」**。
2. 安装成功会把 `ANDROID_HOME` 写入 `e2e-device/.e2e-local.json`（非敏感键）。

| blocker id | 用户侧动作 |
|------------|------------|
| `android_sdk_missing` | 安装 Android Studio SDK，设置 `ANDROID_HOME` / `ANDROID_SDK_ROOT` |
| `android_sdk_incomplete` | 在 SDK Manager 补装 Platform + Build-Tools |

## Appium 门禁

1. `probe-env` 若含 `appium_missing` / `uiautomator2_driver_missing`：
   - 说明将**在项目内**安装 Appium 与 uiautomator2 driver（`yarn` + `npx appium driver install`）
   - **AskQuestion**：是否现在安装？或告知 **5 秒后默认同意**（由 Agent 计时，脚本不 sleep）
2. 用户同意后：`orch_cli install-appium` 或 `bash e2e-device/scripts/install-appium.sh`
3. 失败时等待用户回复 **「安装完毕」** 再重 probe
4. 仅当 `E2E_APPIUM_GLOBAL=1` 时才尝试全局 `npm i -g`（非默认）

## 测试计划确认

1. `init.sh --plan-only` 或 pre 阶段会生成 `e2e-device/test-plan.md`
2. Agent **AskQuestion**：确认开始 / 取消
3. 用户无响应：**10 秒后默认确认**并开始（Agent 层倒计时）
4. 取消 → 引导用户补充 `E2E_USER_INTENT` → 重新 discover

## 跑测中进度（强制）

- 读取 `case-registry.json` 用例总数 `N`
- **TodoWrite**：每条 case 一条 todo，`[i/N] <caseId> — <outcome>`
- 顺序跑：`init.sh --sequential` 或循环 `orch_cli run-next-case <runId>`
- 进度文件：`e2e-device/artifacts/runs/<runId>/cases-executed.jsonl`

## 首跑 vs 二跑

| 场景 | AskQuestion |
|------|-------------|
| `initialized !== true` | 最多 1～2 问（见 questionnaire-first-run） |
| `initialized === true` 且无 blockers | **禁止首跑问卷** |
| `auth-recovery.json` 或 exit `42` | **AUTH_RECOVERY**：AskQuestion 凭据（仅 env）→ sequential 重跑失败 case |
| `page_origin_unknown` | **E2E_PAGE_ORIGIN** 单次恢复 |
| `--plan-only` | 可与 discover 并发 probe，不阻塞 discover |

## AUTH_RECOVERY（首选 sequential）

1. 读 `e2e-device/artifacts/auth-recovery.json`
2. AskQuestion 账号密码 → `export E2E_ACCOUNT=... E2E_PASSWORD=...`（**禁止**写入 report/jsonl/docs）
3. `bash e2e-device/scripts/init.sh --sequential` 从失败 case 续跑
4. 单次 `wdio` 遇 exit 42：**不要**在同一进程等待用户；续跑 registry 中失败 spec

## 报告摘要

跑测结束后 `publish-reports` 写入 `docs/guazi-flow/<任务>/e2e-device/` 或 `docs/e2e-device/`。用户摘要**必须**包含 docs 路径，不只 `artifacts/runs/`。
