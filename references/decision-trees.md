<!-- 触发条件: 分支决策 / Quick Path / plan-only 不明时 -->
# 决策树

## 入口分流

```
用户请求真机 E2E
  → list-preconfig
  → quickPathEligible && env 齐?
       是 → 展示 effective 三元组（跳过 AskQuestion）
       否 → AskQuestion 三元组 → export E2E_*
  → run.sh --plan-only
  → AskQuestion mode (standard 默认 / q / r)
  → run.sh（执行）
  → 有 diagnose-request.json? → failure-triage
```

## Quick Path 条件（全部满足）

1. `E2E_PAGE_ORIGIN` / `E2E_APP_PACKAGE` / `E2E_DOMAIN` 已在环境中
2. manifest `userConfirmed` 与当前三元组一致（若存在）
3. 当前 git 分支与上次成功跑测分支相同（若有记录）
4. 当前设备 serial 与上次相同（若有记录）

任一不满足 → Full Path（AskQuestion 确认变更项）。

## Mode

| 输入 | Profile |
|------|---------|
| 默认 / Enter | `standard` |
| `q` / `--mode quick` | `quick`（env+list+form） |
| `r` / `--mode resilience` | `resilience`（+chaos） |

命名唯一：`quick` | `standard` | `resilience`（废弃 fast/full/recovery）。

## 计划 vs 执行

| 用户意图 | 命令 |
|----------|------|
| 只要计划 | `--plan-only` |
| 确认后跑测 | 去掉 `--plan-only` 再调 `run.sh` |

脚本永不在 plan 后交互 pause。

## LEGACY 禁止

| 旧路径 | 替代 |
|--------|------|
| `init.sh` / `scaffold.sh` 主流程 | `scripts/run.sh` |
| 宿主 `node_modules` 装 wdio | Skill `scripts/node_modules` |
| 项目内 `.e2e-local.json` 存配置 | `$E2E_HOME/projects/{hash}/manifest.json` |
| `E2E_H5_ORIGIN` 作为主文档名 | 主名 `E2E_PAGE_ORIGIN`（别名仍兼容） |
