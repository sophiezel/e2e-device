<!-- 触发条件: 始终加载（测试执行三阶段流程） -->

# E2E 测试生命周期

## 阶段 1：测试前（Pre-test）

**目标**：仓库就绪、环境探测、用例发现、计划确认。

### 检查清单
- [ ] Skill 编排运行时就绪 (`ensure-skill-runtime.sh`)
- [ ] `bash e2e-device/scripts/init.sh --plan-only` 或首跑完整 `init.sh`
- [ ] `skill.project.json` 已生成 (discover-project)
- [ ] `case-registry.json` (discover-cases --union)
- [ ] Android SDK 已配置 `ANDROID_HOME`
- [ ] `probe-env` 无 blockers (adb→SDK→Appium)
- [ ] Istanbul 覆盖率探测（构建配置检测 + WebView 运行时探针）
- [ ] `test-plan.md` 已展示并确认 (或 10s 默认)
- [ ] `artifacts/runs/<runId>/` 已创建

### Agent 门禁
| 步骤 | 动作 |
|------|------|
| adb | 等待用户「已连接」，不列裸命令 |
| Android SDK | 引导安装，等待「SDK 已配置」 |
| Appium | 征得同意或 5s 默认 → install-appium |
| 计划 | AskQuestion 或 10s 默认 |

### 关键脚本
`scaffold.sh --sync-missing` → `discover-project` → `discover-cases --union` → `probe-env` → `present-test-plan` → `save-local-config`

### 退出标准
- 无 adb/Appium blockers
- 测试计划已确认
- bootstrap spec 存在
- 首次成功后 `initialized: true`

---

## 阶段 2：测试中（During-test）

**目标**：按 registry 执行用例，韧性层 mock-first，实时同步进度。

### 入口
```bash
bash e2e-device/scripts/init.sh              # 默认
bash e2e-device/scripts/init.sh --sequential # 逐 spec
```

### Agent 强制：TodoWrite
- 从 registry 读取 N 条用例，创建 N 条 todo
- 更新格式：`[3/12] caseId — outcome`

### 韧性顺序
```
pre-inject mock (E2E_ENABLE_WEB_MOCK=1) → live-with-mock
  → 失败: 诊断 → auto-fix + 重试
  → 仍失败: enable-web-mock → mock 重试
  → 仍失败: degraded_fail
```

### 覆盖率采集
- WebView 切换后自动探测 `window.__coverage__` / `window.__coverage_report__`
- 每个 spec 结束后采集覆盖率快照到 `coverage-snapshots/`
- 失败 case 也采集部分覆盖率（`on-failure.ts`）
- `finalizeCoverage()` 合并快照 → 全量 + **增量**（git diff vs base branch）两维覆盖率
- 增量覆盖率仅统计当前分支变更的业务文件，排除 `package.json`、测试、mock、样式等非业务文件

### 禁止
- silent skip 未登记用例
- Skill 正文写死项目 API path

### 失败时
保留截图与 logcat；sequential 模式继续后续 case。

---

## 阶段 3：测试后（Post-test）

**目标**：归档、发布报告到 docs，摘要 docs 路径。

### 自动发布
`publish-reports` 写入：
- `docs/guazi-flow/<任务>/e2e-device/{YYYY-MM-DD}-真机E2E-run-archive-HHmm.md`
- 同上 `{YYYY-MM-DD}-真机E2E-resilience-report-HHmm.md`
- 兜底：`docs/e2e-device/`

### Agent 摘要模板
```
真机 E2E 完成
- runId: <id>
- 通过: live <n> / mock <n> / autofix <n> / 失败 <n>
- 覆盖率: 增量 语句 <pct>% 分支 <pct>% 函数 <pct>% 行 <pct>%（<n>/<m> 变更业务文件）
- 报告: <docs>/...-真机E2E-run-archive-....md
- 原始产物: `$E2E_HOME/sandbox/{项目}/{domain}/artifacts/runs/<runId>/`
- 覆盖率原始数据: `$E2E_HOME/sandbox/{项目}/{domain}/artifacts/runs/<runId>/coverage-raw.json`
- 产物治理: [artifacts-governance.md](artifacts-governance.md)
```

### 待解决项
从韧性报告「待解决」段摘录，须含 repro 线索。
