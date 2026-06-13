# 产物治理 (Artifacts Governance)

> e2e-device 所有生成文件的统一管理规范。
>
> 完整产物图谱: [artifacts-lifecycle.md](../../docs/artifacts-lifecycle.md)

---

## 产物根目录

```
$E2E_HOME  (默认 ~/.e2e-device/, 可通过 export E2E_HOME=/custom/path 修改)
│
├── README.md              ← 自动生成的说明文件 (每次 run 更新)
├── projects/              ← [持久化] 项目配置缓存
├── sandbox/               ← [临时] 执行沙箱
├── chromedriver/          ← [缓存] WebView 驱动多版本共存
└── logs/                  ← [临时] 运行日志
```

> 系统重启**不会**自动清理此目录。如需自动清理，设置 `export E2E_HOME=/tmp/e2e-device`。

---

## 各目录详解

### projects/{hash}.json — 项目配置缓存

- **来源**: 首次运行时从项目 `skill.project.json` 迁移，或 probe 自动生成
- **内容**: 包名、deeplink scheme、domain、pageOrigin、routes 等
- **生命周期**: 持久化，跨重启保留
- **清理**: `e2e-device clean --system` 删除。丢失后需重新 probe

### sandbox/shared/ — 框架缓存

- **来源**: 首次运行时从 Skill 目录 symlink 框架代码 + 生成 wdio.conf.ts
- **内容**: helpers/ config/ orchestration/ resilience/ inject/ chaos/(symlink) + wdio.conf.ts + tsconfig.json
- **生命周期**: 临时，跨项目复用
- **清理**: `e2e-device clean --sandbox`。下次 run 自动重建 (<2s)

### sandbox/{项目}/{domain}/ — 执行沙箱

- **来源**: 每次 `e2e-device run` 创建/复用
- **内容**:
  - `specs/` — 从 matrix 矩阵 + Skill 模板生成的测试用例 (`.spec.ts`)
  - `case-registry.json` — 用例注册表
  - `artifacts/runs/{runId}/` — 用例执行记录、诊断快照、覆盖率
  - `reports/` → symlink 到项目 `docs/` 目录
- **生命周期**: 临时，可增量复用 (保留 specs, 清理 artifacts)
- **清理**: `e2e-device clean --sandbox`

### chromedriver/ — WebView 驱动

- **来源**: preflight-check 自动下载，匹配设备 WebView Chrome 版本
- **内容**: `chromedriver-{version}/chromedriver` + `versions.json` (元数据)
- **治理**: 多版本共存，自动匹配；保留最近 5 个版本，旧版自动清理
- **清理**: `e2e-device clean --system`

### logs/appium.log — Appium 日志

- **来源**: 每次 run 启动 Appium 时写入
- **清理**: `e2e-device clean --logs`

---

## 项目输出

e2e-device 对项目的唯一写入：

```
项目/docs/
└── YYYY-MM-DD-真机E2E-HHmm.md    ← 合并报告 (执行摘要 + 失败详情 + 覆盖率)
```

项目其余部分（`src/`、`package.json`、`node_modules/`、`e2e-device/`）**零触碰**。

---

## 外部依赖 (不受 E2E_HOME 管理)

| 路径 | 内容 | 管理者 |
|------|------|--------|
| `~/.agents/skills/e2e-device/` | Skill 代码 + wdio/appium/ts-node | `npm install` |
| `~/.appium/node_modules/` | uiautomator2 驱动 | `appium driver install` |
| Android SDK | platform-tools, build-tools | Android Studio / sdkmanager |

---

## 清理命令

| 命令 | 效果 |
|------|------|
| `e2e-device info` | 展示产物分布、大小、依赖版本 |
| `e2e-device clean --sandbox` | 删除 sandbox/ (保留配置) |
| `e2e-device clean --logs` | 删除 logs/ |
| `e2e-device clean --all` | 删除 sandbox/ + logs/ (保留配置) |
| `e2e-device clean --system` | 完全清除 ~/.e2e-device/ |
| `rm -rf ~/.e2e-device` | 等效 --system |

---

## 版本治理

### chromedriver

多版本共存，按设备 WebView major 自动匹配。`versions.json` 记录每个版本的设备/时间。保留最近 5 版。

### Appium ↔ uiautomator2-driver

Appium 3.x 要求 driver ≥ 7.0。preflight 自动校验，不兼容时 `autoFixable=true`。

### 依赖版本一览

```
e2e-device info 输出:
  Appium        3.5.0
  UIA2 Driver   7.5.2       (validated: compatible ✅)
  WebdriverIO   8.46.0
  Node.js       v22.22.3    (validated: >=20.19 ✅)
```

---

## 自愈机制

默认 `E2E_AUTO_HEAL=1`，启动时自动探测并修复依赖问题。

**安全边界** (不可逾越):

| 允许 | 禁止 |
|------|------|
| `brew install` 系统工具 | 修改项目 `src/` |
| `npm install` (Skill 自身) | 修改项目 `package.json` |
| `appium driver install` → `~/.appium/` | 写入项目 `e2e-device/` |
| 写入 `~/.e2e-device/` | 任何触及项目的写操作 |

## archive.json 契约

```json
{
  "runId": "run-<timestamp>",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "status": "running|passed|failed|partial",
  "sections": {
    "plan": {},
    "execution": {},
    "resilience": {},
    "issues": [
      {
        "id": "string",
        "severity": "low|medium|high",
        "title": "string",
        "repro": "string",
        "cause": "string",
        "autoFixAttempted": true,
        "autoFixResult": "optional",
        "resolved": false
      }
    ],
    "artifacts": ["relative/paths"],
    "hybridEvidence": {}
  }
}
```

由 orchestration `write-archive` 写入；WebdriverIO 结束后由 `issue-ledger` 同步。
