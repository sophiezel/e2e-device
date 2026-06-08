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

凭据不得写入 `resilience-report.*`、`cases-executed.jsonl`、guazi-flow 证据。
