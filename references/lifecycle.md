<!-- 触发条件: 需要三阶段执行细节时加载 -->
# E2E 测试生命周期

**唯一入口**：`scripts/run.sh --project <path>`。  
`assets/scaffold/scripts/init.sh` 为 LEGACY，勿使用。

## 阶段 1：测试前（Pre-test）

**目标**：三元组确认、计划生成、用户确认 mode。

### Agent 检查清单

- [ ] `list-preconfig.sh` → Quick Path 或 AskQuestion → export `E2E_*`
- [ ] `run.sh --plan-only` 成功（ensure-skill-runtime / discover / case-registry）
- [ ] 用户确认 mode（quick / standard / resilience）
- [ ] 无 adb / Appium / preconfig blockers

### Agent 门禁

| 步骤 | 动作 |
|------|------|
| adb | 等待「已连接」，不列裸命令 |
| Android SDK | 见 agent-gates / android-sdk-setup |
| Appium | 征得同意或 5s 默认 → Skill runtime 安装 |
| 计划 | **必须** `--plan-only` + AskQuestion；脚本不 pause |

### 退出标准

- 无 blockers
- mode 已确认
- 可进入阶段 2（去掉 `--plan-only` 执行）
- `test-plan.json` 中 `budgetGate !== fail`（超预算 plan 硬退出）

### 节点耗时预算（墙钟硬/软）

| 层 | quick | standard | resilience |
|----|-------|----------|------------|
| L-prep（discover+plan） | ≤90s | ≤120s | ≤180s |
| L-boot（Appium+smoke+env） | ≤180s | ≤210s | ≤300s |
| L-warm（list+form） | ≤8min | ≤18min | 无硬顶 |
| L-infra | 0 | ≤5min | ≤10min |
| L-post | ≤60s | ≤90s | ≤120s |
| **Wall** | **≤12min 硬** | **≤25min 硬** | 无硬顶 |
| 每 case | 45s | 45s | 45s |
| expertReset | ≤4s | ≤4s | ≤4s |

执行中：累计 wall ≥ 预算 95% 时跳过剩余 `infra`/`chaos`（不跳过 env/list/form）。

---

## 阶段 2：测试中（During-test）

```bash
bash scripts/run.sh --project <path> --domain "$E2E_DOMAIN" --mode <confirmed>
```

Journey：`generate-journey-plan` → `run-journeys`（每段 1 session）→ `finalize-coverage` → `publish-reports`

### 进度（零 context 污染）

- 写入：`artifacts/runs/<runId>/progress.jsonl`
- Agent：**禁止**每 case TodoWrite / 渲染完整面板
- Agent 可：每 ~5 case 读尾部一行摘要；结束后读失败列表

### 韧性顺序

```
pre-inject mock → live-with-mock
  → 失败: 诊断 → auto-fix + 重试
  → 仍失败: mock 重试
  → 仍失败: degraded_fail
```

鉴权失败：**禁止** mock 绕过。

### 覆盖率

- 探测 `window.__coverage__`；无探针 → 降级标记 `enabled: false`，不判 case 失败
- `finalizeCoverage()` 合并快照 + 增量（git diff vs base）

---

## 阶段 3：测试后（Post-test）

1. `publish-reports` → 项目 `docs/{date}-真机E2E-{time}.md`（唯一项目写入）
2. 若存在 `diagnose-request.json` → **MUST** 读 [failure-triage.md](failure-triage.md) 并输出诊断摘要
3. 用户摘要模板：

```
真机 E2E 完成
- runId: <id>
- 通过/失败/超时/跳过
- 覆盖率: 增量 … 或「不可用（无 Istanbul 探针）」
- 报告: <docs>/...
- 产物: $E2E_HOME/sandbox/{hash}/{domain}/artifacts/runs/<runId>/
```
