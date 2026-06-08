<!-- 触发条件: Agent 需要了解具体模块实现时按需加载 -->

# e2e-device 架构详解

> 前置阅读：[arch-overview.md](arch-overview.md)

## 核心功能模块

### 脚手架（scaffold）

`bash e2e-device/scripts/scaffold.sh` — 从 `templates/scaffold` 同步基础设施，不覆盖 `specs/` `pageobjects/` `fixtures/`。

### 项目发现（discover-project）

自动生成 `skill.project.json`：包名/Activity、路由模式(React/Vue)、page/api origin、pilot.domain、mock.routes。

### 用例发现（discover-cases --union）

来源：matrix (bootstrap + smoke) ∪ specs-dir ∪ git-diff(仅spec存在) ∪ chaos。union 后 filterCasesWithExistingSpecs 防幽灵用例。

### 环境探测（probe-env）

输出 `ok` `blockers[]` `questions[]` `snapshot`。常见 blocker 见 [agent-gates.md](agent-gates.md)。

### 韧性层（resilience）

```
runCase → collectDiagnostics → classify(auth>host>param>emptyData>backend)
  → authRequired? → auth-recovery.json, exit 42, blocked_auth
  → mock-first → 重试 → pass_with_mock / 报告
```

### Mock（默认 inject）

`web-request-mock.js` hook fetch/XHR；支持 latency 模拟、fixture status 控制、JSBridge 拦截、JS 错误捕获。详见 [mock-strategies.md](mock-strategies.md)。

### 鉴权与域名

`applyCredentials`(仅env) → `ensureLoggedIn` → `auth-detect`(H5/API) → `AUTH_RECOVERY` 独立闭环。

### Profile

| Profile | 场景 | 韧性 |
|---------|------|------|
| fast | 日常/Agent | expert |
| full | 发版定责 | full |
| recovery | 污染后续跑 | 按需 |

### 报告与归档

| 产物 | 路径 |
|------|------|
| 测试计划 | `test-plan.md` |
| 执行记录 | `artifacts/runs/<runId>/cases-executed.jsonl` |
| 韧性报告 | `resilience-report.json|md` |
| 发布 | `publish-reports` → `docs/` |

## Agent 使用指南

### 主决策树

```
用户: 真机测试
  → 仓库有 init.sh? 否→ scaffold
  → preflight → plan-only → test-plan 确认
  → init.sh [--sequential]
  → 失败 → diagnose-run | resilience-report
  → auth-recovery.json → 重跑
  → publish-reports
```

### 门禁话术

| 阶段 | 行为 |
|------|------|
| adb | 等「已连接」，不列裸命令 |
| Appium | AskQuestion 安装或 5s 默认 |
| 计划 | 展示 test-plan，确认或 10s 默认 |
| 跑测 | TodoWrite `[i/N] caseId — outcome` |

### 首跑 vs 二跑

| 条件 | 问卷策略 |
|------|---------|
| `initialized !== true` | 最多 1-2 问 |
| `initialized === true` + 无 blockers | 禁止首跑问卷 |
| `auth-recovery.json` | 允许 AUTH_RECOVERY |

## 宿主接入

新仓库: `scaffold.sh` → `specs/00-bootstrap.spec.ts` → `wdio.conf.ts` → 配置凭据 → `init.sh --plan-only`

已有仓库: `scaffold.sh` → `init.sh --plan-only`

## 验收自检

```bash
bash ~/.agents/skills/e2e-device/scripts/validate-skill-dry-run.sh
bash e2e-device/scripts/init.sh --plan-only    # exit 0
bash e2e-device/scripts/init.sh                 # 有真机+凭据后
```

## 故障排查

| 现象 | 查看 |
|------|------|
| plan-only 报 ts-node | Skill `npm install` |
| wdio 找不到 | `ensure-host-deps.sh wdio` |
| test-plan 含不存在 spec | 重跑 `discover-cases --union` |
| WebView 找不到 | `webViewUrlAnchor`、`E2E_DOM_READY_MARKERS` |
| 登录弹窗 | `auth-recovery.json` → AUTH_RECOVERY |
| 域名不对 | `E2E_H5_ORIGIN`、`discover-project` |
