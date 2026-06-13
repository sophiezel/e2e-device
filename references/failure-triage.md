<!-- 触发条件: 测试失败后 diagnose-run 或手动排查时加载 -->
# 失败分诊（L0 / L1 / L2）

## 强制顺序

1. `bash e2e-device/scripts/init.sh` 或读 `e2e-device/artifacts/resilience-report.json`
2. `yarn -s ts-node e2e-device/orchestration/cli.ts diagnose-run`
3. 按 `blockers` / `rootCause` 处理，**禁止**未读报告就推荐 Whistle、业务 testid、造数

## rootCause 对照

| rootCause | 动作 |
|-----------|------|
| `authRequired` | 读 `auth-recovery.json`；AskQuestion 凭据（仅 env）；`ensureLoggedIn`；`init.sh --sequential` 重跑该 case；**禁止** mock |
| `page_host_mismatch` / `PAGE_ORIGIN_UNKNOWN` | 先 `E2E_H5_ORIGIN` / discover；再跑测 |
| `emptyData` / `backendError` | manifest inject（`E2E_ENABLE_WEB_MOCK=1`） |
| `paramError` | `ensureDetailListNav` / `detailFromList` autofix；list→detail 点击后补 URL query |
| `list_dom_missing_after_back` | 检查是否 adb BACK 破坏了 SPA 栈；韧性 retry 应 `skipAdbBack` |

## Sequential ledger

- `markRunStarted` 仅在 `archive-start`（init.sh）调用一次
- 每个 wdio spec 进程用 `markSpecStarted`，**不得**清空 ledger
- 全量报告见 `artifacts/runs/<runId>/resilience-ledger.jsonl`

## bridgeToken

Native 已登录但 API 仍 401：提示用户重登 App 或换 QA 账号，不要 inject。

## 安全

凭据不得写入 `resilience-report.*`、`cases-executed.jsonl`、执行记录。

## 快速排障

| 现象 | 排查 |
|------|------|
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` 未设置 | 见 [references/android-sdk-setup.md](references/android-sdk-setup.md)；仅 `brew install android-platform-tools` 不够 |
| 无设备 | `adb devices`、USB 调试、RSA 授权 |
| Appium 启动失败 | 先确认 SDK 已配置，再 `npx appium driver doctor`、检查手机是否允许安装 Appium 辅助 APK |
| 找不到 WebView | Chromedriver 版本、`CHROMEDRIVER_PATH`、manifest anchor |
| 登录死循环 | `E2E_ACCOUNT` / `E2E_PASSWORD` 或设备预登录 |
| manifest 过期 | `bash e2e-device/scripts/discover-project.sh` |

无真机仅生成计划：`bash e2e-device/scripts/init.sh --plan-only`
