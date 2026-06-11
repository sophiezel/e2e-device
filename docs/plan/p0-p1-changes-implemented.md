# E2E-Device 安全与体验优化 — 已实施变更 (2026-06-11)

## P0: 安全与可用性（已实施）

### 1. 登录优先校验 + 30s 交互超时

**问题**: probe-env 无条件问密码，即使 App 已登录。

**方案**:
- `orchestration/probe-env.ts` 新增 `probeAppLoginState()` 函数
- 通过 `adb shell dumpsys window` 分析前台 Activity 是否含 `LoginActivity` / `SignInActivity` 等特征
- `E2E_CREDENTIALS.required` 根据探测结果动态设置:
  - `login_screen` → `required: true`
  - `likely_logged_in` / `unknown` → `required: false`
- `run-sequential.ts` 新增 30s auth 超时机制:
  - 测试中遇需登录 case + 无凭据 → 等待 30s (可配置 `E2E_AUTH_INPUT_TIMEOUT_MS`)
  - 超时 → 跳过 case → `outcome: "skipped_auth"`
  - 报告中标记 `🔐 跳过 (未登录) ×N`

**影响文件**: `probe-env.ts`, `run-sequential.ts`, `issue-ledger.ts`, `render-report-zh.ts`

### 2. PIN/密码全链路脱敏

**问题**: 账号密码在控制台、Shell 日志中明文展示。

**方案**:
- `helpers/login.ts` 新增 `maskAccount()` / `maskPassword()` 脱敏函数
  - 账号: `xu***44`（前2位 + `***` + 后2位）
  - 密码: `****`
- 所有 `console.log` 改用脱敏版本
- `scripts/init.sh` 和 `run-device-e2e.sh` 脱敏打印凭据
- `security.md` 新增脱敏规则表

**影响文件**: `login.ts`, `init.sh`, `run-device-e2e.sh`, `security.md`

### 3. 默认 quick 模式代码层兜底

**问题**: quick 默认只写在文档中，代码未强制。

**方案**:
- `discover-intent.ts`: `parseIntentProfile()` 中 `"unknown" → "quick"` 兜底
- `scripts/init.sh`: 空 `E2E_USER_INTENT` 时设 `E2E_RUN_PROFILE=quick`
- `wdio.conf.template.ts`: 同步更新 session reset 条件

**影响文件**: `discover-intent.ts`, `init.sh`

---

## P1: 性能与体验（已实施）

### 4. 批量 Session 模式默认启用

**问题**: 逐 spec 执行 → 每个 spec 新 Appium session → 78 个 case 约 23 分钟 session 开销。

**方案**:
- 反转开关: `E2E_SEQUENTIAL_BATCH=1` 变为 `E2E_SEQUENTIAL_INDIVIDUAL=1`
- 默认批量: 所有 spec 单次 wdio 调用
- `SESSION_RESET_INTERVAL`: 8 → 15（减少 session 重置频率）
- `executeWdioBatch` 改为异步 `spawn` + `setInterval` 30s 心跳

**预期**: 总耗时从 ~68min → ~25-35min（节省 ~60%）

**影响文件**: `run-sequential.ts`, `wdio.conf.ts`, `wdio.conf.template.ts`, `cli.ts`

### 5. TODO 清单 + 中文进度

**问题**: 执行前无清单，执行中无中文描述，进度不可见。

**方案**:
- `printTodoList()`: 执行前打印结构化清单 `[ ] 1 中文描述 (caseId) ~Xs`
- `caseDisplayName()`: 从 `metadata.description` 提取中文名
- `progressBar()`: `████░░░░` 进度条
- 批量模式 30s 心跳: `⏳ 批量执行中... (已耗时 90s)`
- 汇总格式: `✅ 75 passed  |  ❌ 1 failed  |  ⏭  2 skipped`

**影响文件**: `run-sequential.ts`, `agent-gates.md`

### 6. skipped_auth 报告标记

**方案**:
- `render-report-zh.ts`: 新增 `skipped_auth: "🔐"` 图标
- `issue-ledger.ts`: 新增 `blockedAuthCount`，`skipped_auth` 归入 `blockedAuth` 统计
- `publish-reports.ts`: 已有 `skipped` / `blockedAuth` 字段（兼容）

**影响文件**: `render-report-zh.ts`, `issue-ledger.ts`

---

## 变更文件总览

```
Skill 级 (文档):
  SKILL.md                          ← 决策树更新
  reference/agent-gates.md          ← 进度格式 + auth 超时示例
  reference/env-vars.md             ← E2E_SEQUENTIAL_INDIVIDUAL
  security.md                       ← 脱敏规则表

项目级 (代码):
  e2e-device/helpers/login.ts       ← maskAccount / maskPassword
  e2e-device/orchestration/probe-env.ts     ← probeAppLoginState
  e2e-device/orchestration/discover-intent.ts ← 默认 quick
  e2e-device/orchestration/run-sequential.ts  ← batch 默认 + TODO + 心跳 + auth skip
  e2e-device/orchestration/cli.ts            ← await runSequential
  e2e-device/orchestration/render-report-zh.ts ← skipped_auth 🔐
  e2e-device/resilience/issue-ledger.ts      ← blockedAuthCount
  e2e-device/scripts/init.sh                 ← 默认 quick + 脱敏 + --individual
  e2e-device/scripts/run-device-e2e.sh       ← 脱敏打印
  e2e-device/wdio.conf.ts                   ← SESSION_RESET_INTERVAL=15
  e2e-device/wdio.conf.template.ts           ← 同步更新
```

---

## 预期效果

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 78 case 总耗时 | ~68min (per-spec session) | ~25-35min (batch) |
| Session 开销占比 | ~34% | ~8% |
| 登录凭据误问率 | 100% | 仅未登录时 |
| 密码泄露风险 | 高 (控制台/Shell 明文) | 低 (全链路脱敏) |
| 执行可见性 | 无 TODO / 无中文 | 结构化清单 + 进度条 + 心跳 |
| 鉴权超时处理 | 无限等 | 30s 自动 skip + 报告标记 |
