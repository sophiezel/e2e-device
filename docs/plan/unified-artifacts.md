# E2E-Device 产物统一管理方案

> 目标：所有 e2e-device 产物收敛到单一根目录，项目仅输出报告。

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

```markdown
# E2E Device 产物目录

此目录由 e2e-device 自动管理。

## 目录说明

| 目录 | 用途 | 可删除 |
|------|------|--------|
| projects/ | 项目配置缓存 | ❌ 勿删 |
| sandbox/ | 测试执行沙箱 | ✅ 可清理 |
| logs/ | 运行日志 | ✅ 可清理 |

## 清理

```bash
e2e-device clean --all     # 清理沙箱+日志
rm -rf ~/.e2e-device       # 完全清除
```
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
