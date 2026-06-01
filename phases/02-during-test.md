# 02 测试中（During-test）

## 目标

按 registry 执行用例，韧性层 **mock-first（inject）**，实时同步 Todo 与 `cases-executed.jsonl`。

## 入口

```bash
bash e2e-device/scripts/init.sh              # 默认 run-device-e2e.sh
bash e2e-device/scripts/init.sh --sequential # 逐 spec，写 cases-executed.jsonl
```

单步：`yarn ts-node e2e-device/orchestration/cli.ts run-next-case <runId>`

## Agent 强制：TodoWrite

1. 从 `case-registry.json` 读取 `N` 条用例
2. 创建 `N` 条 todo（pending → in_progress → completed）
3. 每完成一条，更新文案：`[3/12] D-S5 — pass_with_mock`
4. outcome 来自韧性层：`pass` / `pass_with_mock` / `pass_after_autofix` / `degraded_fail`

## 韧性顺序（单用例）

当 `E2E_ENABLE_WEB_MOCK=1`（init / sequential 默认）时 **pre-inject mock**，再跑 live：

```
pre-inject (E2E_ENABLE_WEB_MOCK=1) → live-with-mock
  → 失败：诊断 → auto-fix + 重试（跳过 adb BACK）
  → 仍失败且未 pre-inject：enable-web-mock → mock 重试
  → 仍失败 → degraded_fail（套件不 bail）
```

未开启 `E2E_ENABLE_WEB_MOCK` 时：`live → 诊断 → auto-fix → mock 重试`。

环境：`E2E_RESILIENCE=1`（默认）、`E2E_ENABLE_WEB_MOCK=1`（init / sequential 已设）

## 禁止

- silent skip 未登记用例
- 在 Skill 对话中写死项目 API path

## 失败时

保留 `artifacts/<timestamp>_<test>/` 截图与 logcat；继续后续 case（sequential 模式）。
