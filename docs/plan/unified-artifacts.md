# E2E-Device 产物统一管理方案

> **状态: ✅ 已实施 (2026-06-11)**
>
> 所有产物收敛至 `$E2E_HOME` (默认 `~/.e2e-device/`)
>
> CLI: `e2e-device info` 展示分布, `e2e-device clean` 一键清理

---

## 一、问题诊断

### 当前产物散落 7 处

```
~/.cache/e2e-device/projects/          ← 配置
/tmp/e2e-device/shared/                ← 框架缓存
/tmp/e2e-device/{项目}/{domain}/        ← 执行沙箱
~/.appium/chromedriver/                ← preflight 下载
/tmp/e2e-appium.log                    ← 日志
项目/docs/.../e2e-device/*.md          ← 报告
~/.appium/node_modules/                ← 驱动 (Appium 基础设施)
```

**问题**：
- 散落 6+ 个目录，用户无法一键清理
- `/tmp` 中的文件重启即丢，`~/.cache` 中的持久化——生命周期不一致
- 用户不知道该删哪些、保留哪些

---

## 二、四项准则

| # | 准则 | 含义 |
|---|------|------|
| 1 | Skill 纯粹 | Skill 代码与项目无关、与用户环境无关，可跨机器复用 |
| 2 | 项目仅报告 | 项目只产出测试报告，必要时报告内引用 spec 内容 |
| 3 | 产物统一 | 所有生成文件在一个根目录下分层管理，一键清除 |
| 4 | 透明可查 | Skill 内置 `info` 命令，输出产物清单和清理指引 |

---

## 三、目标架构

```
Skill 本身 (~/.agents/skills/e2e-device/)     ← 准则1: 通用, 不随项目/用户变化
├── bin/e2e-device.js
├── scripts/run.sh
├── orchestration/ helpers/ config/ ...
├── templates/
└── node_modules/              ← 全部依赖在此

用户产物根 ($E2E_HOME, 默认 ~/.e2e-device/)   ← 准则3: 统一入口
│
├── README.md                  ← 准则4: 自动生成, 说明每个目录用途
│
├── projects/                  ← 项目配置 (持久化)
│   └── {hash}.json            ← 每个项目一个配置文件
│
├── sandbox/                   ← 执行沙箱 (可按需清理)
│   ├── shared/                ← 框架缓存 (symlink + wdio.conf 等)
│   └── {项目名}/{domain}/      ← 需求隔离
│       ├── specs/             ← 按需生成的测试用例
│       ├── artifacts/         ← 运行时临时产物
│       └── reports → symlink → 项目 docs/
│
├── logs/                      ← 日志
│   └── appium.log             ← Appium 运行时日志
│
└── .gitkeep                   ← 确保目录存在

项目 (唯一输出)                               ← 准则2: 仅报告
└── docs/guazi-flow/<task>/e2e-device/
    └── YYYY-MM-DD-真机E2E-HHmm.md  ← 合并报告 (含 spec 引用)
```

### 对比

| | 改前 | 改后 |
|---|------|------|
| 产物根目录 | 6 个不同路径 | **1 个** `~/.e2e-device/` |
| 清理命令 | 分别找路径 `rm -rf` | **1 条** `rm -rf ~/.e2e-device/` |
| 生命周期 | `/tmp`(重启丢) + `~/.cache`(持久) | 统一持久化, `e2e-device clean` 分层清理 |
| 可见性 | 散落各处, 用户不知 | `e2e-device info` 一目了然 |

---

## 四、实施步骤

### Step 1: 引入 `$E2E_HOME` 环境变量

```bash
# 默认值
export E2E_HOME="${E2E_HOME:-$HOME/.e2e-device}"

# 所有路径从 E2E_HOME 派生
PROJECTS_DIR="$E2E_HOME/projects"
SANDBOX_DIR="$E2E_HOME/sandbox"
LOGS_DIR="$E2E_HOME/logs"
```

- `paths.ts`: 新增 `e2eHome()` / `projectsDir()` / `sandboxDir()` / `logsDir()`
- `run.sh`: `SHARED` / `SANDBOX` 从 `$E2E_HOME` 派生
- `bin/e2e-device.js`: `TMP_ROOT` → `E2E_HOME`

### Step 2: 迁移现有路径

| 原路径 | 新路径 |
|--------|--------|
| `~/.cache/e2e-device/projects/` | `$E2E_HOME/projects/` |
| `/tmp/e2e-device/shared/` | `$E2E_HOME/sandbox/shared/` |
| `/tmp/e2e-device/{项目}/{domain}/` | `$E2E_HOME/sandbox/{项目}/{domain}/` |
| `/tmp/e2e-appium.log` | `$E2E_HOME/logs/appium.log` |

首次运行时若检测到旧路径存在数据，自动迁移并提示用户删除旧目录。

### Step 3: `e2e-device info` 命令

```bash
$ e2e-device info

E2E_HOME: /Users/xuwei/.e2e-device (28M)

  projects/         1 文件 (4.8K)    ← 项目配置, 勿删
  sandbox/shared/   9 文件 (3K)      ← 框架缓存, 可重建
  sandbox/jian-h5/  2 需求 (232K)    ← 执行沙箱, 可按需清理
  logs/             1 文件 (21K)     ← 运行日志

清理:
  e2e-device clean --sandbox     清理所有沙箱
  e2e-device clean --project X   清理指定项目
  e2e-device clean --all         清理全部 (保留配置)
  rm -rf ~/.e2e-device           完全清除
```

### Step 4: 自动生成 `$E2E_HOME/README.md`

每次 `run.sh` 或 `e2e-device info` 执行时自动生成/更新，保证与磁盘状态一致。

```markdown
# E2E Device 产物目录

> 此目录由 e2e-device 自动生成和管理。
> 位置: $E2E_HOME (默认 ~/.e2e-device/)
> 可配置: export E2E_HOME=/your/path

---

## 目录架构

\`\`\`
~/.e2e-device/
├── README.md           ← 本文件
│
├── projects/           ← [持久化] 项目配置缓存
│   └── {hash}.json     ← 项目配置 (从 skill.project.json 迁移或 probe 生成)
│                         内容: 包名/deeplink/domain/pageOrigin/routes
│                         作用: 跨重启持久化, 避免每次 probe
│                         清理: 勿删 (丢失后需重新 probe)
│
├── sandbox/            ← [临时] 测试执行沙箱
│   ├── shared/         ← 框架缓存 (symlink 到 Skill 目录)
│   │   ├── helpers/    → symlink → Skill 通用工具函数
│   │   ├── config/     → symlink → Skill 配置模块
│   │   ├── orchestration/ → symlink → Skill 编排引擎
│   │   ├── resilience/ → symlink → Skill 韧性框架
│   │   ├── inject/     → symlink → Skill WebView Mock 脚本
│   │   ├── chaos/      → symlink → Skill 混沌测试模板
│   │   ├── wdio.conf.ts ← 从 Skill 模板生成 (沙箱模式)
│   │   └── tsconfig.json ← extends Skill tsconfig.base.json
│   │     作用: 跨项目复用, 避免重复创建 symlink
│   │     清理: 可删 (下次 run 自动重建, 耗时 <2s)
│   │
│   └── {项目名}/       ← 项目隔离
│       └── {domain}/   ← 需求隔离 (按 pilot.domain)
│           ├── skill.project.json → symlink → projects/{hash}.json
│           ├── specs/   ← 从 guazi-flow 矩阵 + 模板生成的测试用例
│           │   ├── {domain}.C01.spec.ts  ← 验收矩阵用例
│           │   ├── {domain}.hybrid.*.spec.ts ← Hybrid 测试
│           │   └── form-navigation.spec.ts ... ← 端侧通用用例
│           ├── case-registry.json ← 用例注册表 (discover-cases 生成)
│           ├── artifacts/  ← 运行时临时产物
│           │   └── runs/{runId}/
│           │       ├── cases-executed.jsonl  ← 用例执行记录
│           │       ├── diagnostic-snapshots/  ← 失败诊断快照
│           │       └── coverage-snapshots/    ← Istanbul 覆盖率
│           └── reports/ → symlink → 项目 docs/guazi-flow/
│
├── logs/               ← [临时] 运行日志
│   └── appium.log      ← Appium 服务端日志
│                         作用: 调试 Appium 启动/连接问题
│                         清理: 可删 (下次 run 自动创建)
│
└── .gitkeep            ← 占位文件

\`\`\`

---

## 文件详解

### projects/{hash}.json — 项目配置
- **内容**: 从项目 e2e-device/skill.project.json 迁移或首次 probe 自动生成
- **字段**: id, domain, hybrid(container/deeplink/webView/network/auth), pilot(routes)
- **修改**: 可直接编辑, 下次 run 生效
- **删除后果**: 下次 run 需重新 probe (引导输入 pageOrigin)

### sandbox/shared/wdio.conf.ts — WDIO 配置
- **内容**: WebdriverIO 测试运行器配置 (沙箱模式)
- **关键设置**: specs 路径指向 sandbox, Appium 端口, Session 重置间隔
- **来源**: 从 Skill templates/wdio.conf.sandbox.ts 复制
- **删除后果**: 下次 run 自动从 Skill 模板重新生成

### sandbox/{项目}/{domain}/specs/ — 测试用例
- **内容**: TypeScript 测试文件 (.spec.ts)
- **来源**: guazi-flow 验收矩阵骨架 + discover-hybrid 生成 + Skill 端侧模板
- **修改**: 可编辑补充测试逻辑, 下次 run 增量同步不会覆盖已有文件
- **删除后果**: 下次 run 从矩阵重新生成骨架 (手写逻辑丢失)

### sandbox/{项目}/{domain}/artifacts/ — 运行时产物
- **cases-executed.jsonl**: 每行一个 case 的执行结果 (caseId, outcome, durationMs)
- **diagnostic-snapshots/**: 失败 case 的页面截图、DOM 快照、网络日志
- **coverage-snapshots/**: Istanbul 覆盖率原始数据
- **删除后果**: 无影响, 每次 run 重新生成

---

## 清理指南

| 命令 | 效果 |
|------|------|
| \`e2e-device clean --sandbox\` | 删除 sandbox/ (保留配置) |
| \`e2e-device clean --logs\` | 删除 logs/ |
| \`e2e-device clean --all\` | 删除 sandbox/ + logs/ (保留配置) |
| \`e2e-device clean --system\` | 删除整个 ~/.e2e-device/ |
| \`rm -rf ~/.e2e-device\` | 等效 --system |

> 系统重启不会自动清理此目录。如需自动清理, 设置 \`export E2E_HOME=/tmp/e2e-device\`。
```

### Step 5: 报告内嵌 spec 引用

合并报告的「用例结果」表格中增加一列 `spec`，直接展示 spec 文件内容摘要：

```markdown
| # | case | spec | 结果 | 耗时 |
|---|------|------|------|------|
| 1 | 打开页面 | `should show Toast` → `expect(toast).toBeVisible()` | ✅ | 12.5s |
```

### Step 6: Skill 纯粹性审计与清理

**当前污染**：
| 文件 | 问题 | 修复 |
|------|------|------|
| `templates/scaffold/chaos/*.chaos.spec.ts` (10个) | 硬编码 `evaluateRecovery` domain | 改为 `{{domain}}` 模板变量, 沙箱中按 domain 实例化 |
| `templates/scaffold/skill.project.yaml.example` | `{{placeholder}}` 已是模板 | ✅ 无需改动 |
| `templates/scaffold/specs/` (端侧 spec) | 无项目特定引用 | ✅ 通用 |

**修复后**：Skill 中不再包含任何项目名/域名/包名。所有 domain 相关的 spec 在沙箱中按 `skill.project.json` 动态生成。

---

## 五、最终状态

```
用户只需知道两个路径:

  1. ~/.e2e-device/    ← 所有产物 (一键 rm -rf)
  2. 项目/docs/.../    ← 测试报告 (应提交 git)

查询:
  e2e-device info      ← 展示产物分布和清理指引

清理:
  e2e-device clean --sandbox    清理沙箱 (保留配置)
  e2e-device clean --logs       清理日志
  e2e-device clean --all        清理沙箱+日志 (保留配置)
  e2e-device clean --system     完全清除 ~/.e2e-device/
  rm -rf ~/.e2e-device          等效于 --system
```
