<!-- 触发条件: 始终加载（架构核心，每个会话必须读取） -->

# e2e-device 架构总览

## 产品定位

面向 **Android USB 真机 + App 内 WebView H5** 的端到端自动化 Skill。

| 对象 | 目标 |
|------|------|
| **用户** | 只说「真机测试」，不必记 Appium、wdio、域名、fixture |
| **Agent** | 决策树驱动编排、门禁话术、失败分流，禁止手工拼 shell |
| **宿主仓库** | 任意 Hybrid H5（React/Vue），通过 `discover-project` 自动接入 |

**不覆盖**：无真机的纯 Playwright E2E。

## 设计铁律

| 编号 | 铁律 | 落地方式 |
|------|------|----------|
| G1 | 零硬编码 | `validate-skill-dry-run.sh` 扫描禁止词 |
| G2 | 项目差异只在 `manifest.json` | `discover-project` 自动生成到 E2E_HOME 缓存 |
| G3 | 唯一入口 `scripts/run.sh` | 所有操作经此路由 |
| G4 | Agent/脚本双层决策 | 确定性→脚本，判断性→Agent |
| G5 | 不阻断执行 | case 失败→记录→继续，bail:0 |

## 系统架构

```
Skill 层 (~/.agents/skills/e2e-device/)
  ├── SKILL.md + CONTEXT.md        ← Agent 入口 (决策树 + 术语表)
  ├── references/                  ← 按需加载文档 (14个)
  ├── assets/scaffold/             ← 模板 + 编排代码 (35 .ts 模块)
  ├── scripts/                     ← 可执行脚本 + node_modules (完整运行时)
  └── docs/adr/                    ← 架构决策记录

产物层 ($E2E_HOME, 默认 ~/.e2e-device/)
  ├── projects/{hash}/             ← 项目配置缓存 + case 缓存
  ├── sandbox/{hash}/{domain}/     ← 执行沙箱 (specs + artifacts)
  ├── chromedriver/                ← WebView 驱动多版本
  └── logs/                        ← Appium + logcat 日志

项目层 (仅输出)
  └── docs/{date}-真机E2E-{time}.md  ← 测试报告 (唯一写入)

真机层
  └── adb → Android App + WebView → 后端 API
```

## 依赖分层

| 用途 | 安装位置 | 方式 |
|------|----------|------|
| 全部依赖 (wdio/appium/ts-node) | Skill `scripts/node_modules/` | `ensure-skill-runtime.sh` |

**禁止**：在宿主仓安装依赖。Skill 自带完整运行时，零项目侵入。

## 三层故障模型 (L0/L1/L2)

| 层 | 名称 | 典型故障 |
|----|------|----------|
| **L0** | Native 容器 | 未登录、USB 未授权、WebView 调试关闭、权限弹窗、OEM 弹窗 |
| **L1** | Hybrid 通道 | URL host 错、context 切换失败、chromedriver 不匹配、深链格式错 |
| **L2** | 业务 H5 | 列表空、接口 500、页面白屏、JS 错误 |

原则：L2 问题不用 L0 代理顶替；auth 问题禁止 inject mock 绕过。

## 核心流程

```
用户: 真机测试
  → list-preconfig（含 quickPathEligible）
  → Quick Path? 同设备+同分支+同domain+userConfirmed → 跳过 AskQuestion
  → Full Path: AskQuestion 三元组
  → run.sh --plan-only → 用户确认 mode
  → run.sh 执行 (Journey session, 45s超时, 不阻断, progress.jsonl)
  → 失败 → diagnose-request.json → Agent 按 failure-triage 诊断
  → publish-reports → 写入项目 docs/
```

## 目录结构

**Skill（跨项目）**: `SKILL.md` / `CONTEXT.md` / `references/` / `assets/scaffold/` / `scripts/` / `docs/adr/`  
**产物（$E2E_HOME）**: `projects/` / `sandbox/{hash}/{domain}/` / `chromedriver/` / `logs/`  
**项目（仅报告）**: `docs/{YYYY-MM-DD}-真机E2E-{HHmm}.md`

## 相关文档

| 文档 | 何时加载 |
|------|---------|
| [arch-details.md](arch-details.md) | 需要了解具体模块实现时 |
| [env-vars.md](env-vars.md) | 需要配置环境变量时 |
| [host-setup.md](host-setup.md) | 新仓库接入 / 依赖安装失败 |
| [agent-gates.md](agent-gates.md) | blockers / 鉴权恢复时按需 |
| [lifecycle.md](lifecycle.md) | 测试三阶段执行细节 |
| [hybrid-contract.md](hybrid-contract.md) | WebView / Hybrid 失败 |
| [decision-trees.md](decision-trees.md) | Quick Path / plan-only 不明 |
| [mock-strategies.md](mock-strategies.md) | Mock/SSL/fixture 问题 |
| [failure-triage.md](failure-triage.md) | **失败时 MANDATORY** |
| [biz-case-extraction.md](biz-case-extraction.md) | biz case 缓存未命中 |
