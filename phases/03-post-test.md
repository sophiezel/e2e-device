# 03 测试后（Post-test）

## 目标

归档、发布简体中文报告到 **docs**，并向用户摘要 **docs 路径**（非仅 artifacts）。

## 自动发布

`init.sh` 结束调用 `publish-reports`：

| 文件 | 路径模式 |
|------|----------|
| 运行归档 | `docs/guazi-flow/<任务>/e2e-device/{YYYY-MM-DD}-真机E2E-run-archive-HHmm.md` |
| 韧性报告 | 同上目录 `{YYYY-MM-DD}-真机E2E-resilience-report-HHmm.md` |
| 兜底 | `docs/e2e-device/` |

解析顺序见仓库 `publish-reports.ts` → `resolveGuaziFlowTaskDir()`。

## 用户摘要模板（Agent）

```
真机 E2E 完成
- runId: <id>
- 通过: live <n> / mock <n> / autofix <n> / 失败 <n>
- 报告（请打开）:
  - <docs>/...-真机E2E-run-archive-....md
  - <docs>/...-真机E2E-resilience-report-....md
- 原始产物: e2e-device/artifacts/runs/<runId>/
```

## 待解决项

从韧性报告「待解决」段摘录；须含 repro 线索，禁止省略 degraded 失败。

## 可选提交

`docs/guazi-flow/**/e2e-device/*.md` **可提交**；`e2e-device/artifacts/**` 仍 gitignore。
