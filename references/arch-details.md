<!-- 触发条件: 需要模块实现细节时（非默认加载） -->
# 架构细节

## 模块地图

| 模块 | 路径 | 职责 |
|------|------|------|
| 统一入口 | `scripts/run.sh` | 预检 → discover → plan/execute → publish |
| CLI | `assets/scaffold/orchestration/cli.ts` | discover/preflight/journeys/reports |
| Journey | `generate-journey-plan.ts` + `run-journeys.ts` | 分段 Session |
| Case 发现 | `discover-cases.ts` + `auto-generate-cases.ts` | infra/biz/chaos union |
| Case 缓存 | `$E2E_HOME/projects/{hash}/case-cache/{branch}/` | `generatorVersion=journey-v2-1` |
| WDIO | `assets/wdio.conf.sandbox.ts` | hooks / 45s / expertReset |
| 报告 | `publish-reports.ts` | **唯一**写项目 docs |

## Profile（唯一命名）

| Profile | 段 |
|---------|-----|
| `quick` | env + list + form |
| `standard` | + infra |
| `resilience` | + chaos |

## 执行流

```
list-preconfig (Agent)
  → export E2E_*
  → run.sh --plan-only
  → 用户确认 mode
  → run.sh
       → ensure-skill-runtime
       → discover-project → manifest
       → case-cache hit? 复用 : discover-cases --union
       → present-test-plan
       → Appium + run-journeys
       → publish-reports
```

## LEGACY（勿作为主路径）

| 旧物 | 状态 |
|------|------|
| `assets/scaffold/scripts/init.sh` | LEGACY |
| 宿主内 `scaffold.sh` 写入项目 | 违反 ADR-0002 |
| Profile 名 `fast/full/recovery` | 已废弃 |
| `$E2E_HOME/cache/cases` TTL 旁路 | 废弃；以 projects/case-cache 为准 |

## 故障速查

| 症状 | 动作 |
|------|------|
| `preconfig_unconfirmed` | list-preconfig + export |
| pageOrigin 错 | 主名 `E2E_PAGE_ORIGIN` |
| session 慢 | 确认未误开 `E2E_SEQUENTIAL_INDIVIDUAL` |
| 诊断 | 读 `diagnose-request.json` + failure-triage |

更多总览见 [arch-overview.md](arch-overview.md)。
