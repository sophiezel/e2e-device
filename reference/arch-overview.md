<!-- 触发条件: 始终加载（架构核心，每个会话必须读取） -->

# e2e-device 架构总览

## 产品定位

面向 **Android USB 真机 + App 内 WebView H5** 的端到端自动化 Skill。

| 对象 | 目标 |
|------|------|
| **用户** | 只说「真机测试」，不必记 Appium、wdio、域名、fixture |
| **Agent** | 单入口编排、门禁话术、失败分流，禁止手工拼 shell |
| **宿主仓库** | 任意 Hybrid H5（React/Vue），通过 `discover-project` 自动接入 |

**不覆盖**：无真机的纯 Playwright E2E。

## 设计铁律

| 编号 | 铁律 | 落地方式 |
|------|------|----------|
| G1 | 零硬编码 | `validate-skill-dry-run.sh` 扫描禁止词 |
| G2 | 项目差异只在 `skill.project.json` | `discover-project` 自动生成 |
| G3 | 唯一入口 `init.sh` | 所有操作经此路由 |
| G4 | 脚本驱动，非口水 | `orch_cli` + JSON 驱动 Agent |
| G5 | 宁可多测 | union(matrix, specs, git-diff, chaos) |

## 系统架构

```
Skill 层 (~/.agents/skills/e2e-device/)
  ├── SKILL.md + reference/        ← Agent 阅读
  ├── node_modules                 ← wdio/appium/ts-node 全部依赖
  ├── orchestration/ helpers/ config/ resilience/ ← 框架代码
  ├── templates/                   ← scaffold 模板 + wdio.conf
  ├── scripts/ (run.sh)            ← 统一入口
  └── bin/ (e2e-device CLI)       ← 全局命令

产物层 ($E2E_HOME, 默认 ~/.e2e-device/)
  ├── projects/                    ← 项目配置缓存
  ├── sandbox/shared/              ← 框架 symlink 缓存
  ├── sandbox/{项目}/{domain}/     ← 执行沙箱 (specs + artifacts)
  ├── chromedriver/                ← WebView 驱动多版本
  └── logs/                        ← Appium 日志

项目层 (仅输出)
  └── docs/guazi-flow/<task>/e2e-device/*.md  ← 合并报告

真机层
  └── adb → Android App + WebView → 后端 API
```

## 依赖分层

| 用途 | 安装位置 | 方式 |
|------|----------|------|
| 编排 (discover/probe/plan) | Skill `node_modules` | `ensure-skill-runtime.sh` |
| 跑测 (wdio/appium) | 宿主仓 `node_modules` | `ensure-host-deps.sh wdio` |

**禁止**：为编排依赖 `export` 其他项目的 `node_modules`。

## 三层故障模型 (L0/L1/L2)

| 层 | 名称 | 典型故障 |
|----|------|----------|
| **L0** | Native 容器 | 未登录、USB 未授权 |
| **L1** | Hybrid 通道 | URL host 错、路由模式错 |
| **L2** | 业务 H5 | 列表空、接口 500 |

原则：L2 问题不用 L0 代理顶替；auth 问题禁止 inject mock 绕过。

## 核心流程

```
用户: 真机测试
  → 仓库有 init.sh? 否→ scaffold
  → preflight (adb/Appium/SDK/设备厂商/App版本)
  → discover-project → discover-cases --union
  → present-test-plan → 用户确认
  → init.sh [--sequential] 跑测
  → 失败 → diagnose-run → resilience-report
  → publish-reports → 告知 docs 路径
```

## 目录结构

**Skill（跨项目）**: `SKILL.md` / `scripts/` / `templates/` / `reference/` / `orchestration/` / `helpers/`  
**产物（$E2E_HOME）**: `projects/` / `sandbox/shared/` / `sandbox/{项目}/{domain}/` / `chromedriver/` / `logs/`  
**项目（仅报告）**: `docs/guazi-flow/<task>/e2e-device/*.md`

## 相关文档

| 文档 | 何时加载 |
|------|---------|
| [arch-details.md](arch-details.md) | 需要了解具体模块实现时 |
| [env-vars.md](env-vars.md) | 需要配置环境变量时 |
| [host-setup.md](host-setup.md) | 新仓库接入 / 依赖安装失败 |
| [agent-gates.md](agent-gates.md) | 始终（门禁话术） |
| [lifecycle.md](lifecycle.md) | 测试三阶段执行细节 |
| [mock-strategies.md](mock-strategies.md) | Mock/SSL/fixture 问题 |
| [failure-triage.md](failure-triage.md) | 测试失败排查 |
| [decision-trees.md](decision-trees.md) | 分支决策不明时 |
