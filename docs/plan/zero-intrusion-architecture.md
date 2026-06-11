# E2E-Device 零侵入架构实施方案

> 目标：测试项目仅保留 1 个配置文件 + 输出报告，其余全部隔离到 `/tmp` 执行沙箱。

---

## 一、痛点分析

### 1.1 当前项目残留

```
项目 e2e-device/ 目录：
  config/          8 个 TS 文件
  helpers/        22 个 TS 文件
  orchestration/  25 个 TS 文件
  resilience/      6 个 TS 文件
  scripts/        13 个 sh 文件
  inject/          2 个 JS 文件
  chaos/          10 个 spec 文件
  specs/          32 个 spec 文件 (项目特有)
  skill.project.json / .yaml
  wdio.conf.ts / wdio.conf.template.ts
  tsconfig.json
  .e2e-*.json / case-registry / test-plan / diff-inferred
  ─────────────────────────────────
  合计: 159 个文件 (其中 ~120 个与 Skill 重复)
```

### 1.2 node_modules 污染

```
宿主 node_modules/@wdio/*  → symlink → skill/node_modules  (16 个)
宿主 node_modules/appium/  → symlink → skill/node_modules
宿主 node_modules/.bin/{wdio,appium} → symlink
```

虽不改 package.json，但污染了 node_modules 目录结构。

### 1.3 artifacts 残留

```
e2e-device/artifacts/runs/<runId>/
  cases-executed.jsonl
  diagnostic-snapshots/
  coverage-snapshots/
  problems-collected.jsonl
  resilience-report.json / resilience-report.md
  ...
→ 每次运行后残留，需手动清理
```

---

## 二、目标架构

### 2.1 项目只保留

```
<项目根>/
├── e2e-device/
│   └── skill.project.json          ← 唯一配置文件 (~30 行 JSON)
│
└── docs/guazi-flow/<task>/e2e-device/
    ├── YYYY-MM-DD-真机E2E-run-archive-HHmm.md       ← 执行摘要
    └── YYYY-MM-DD-真机E2E-resilience-report-HHmm.md  ← 韧性报告
```

`package.json`、`node_modules`、`tsconfig.json` **零触碰**。

### 2.2 执行沙箱 `/tmp/e2e-device/`

所有框架代码、依赖、临时产物、测试用例生成均在 `/tmp` 中完成。系统重启自动清理。

---

## 三、分层沙箱设计

```
/tmp/e2e-device/
│
├── shared/                              ← L1: 框架层 (一次创建, 跨项目复用)
│   ├── wdio.conf.ts                     ← 从 Skill templates/ 生成
│   ├── tsconfig.json                    ← extends Skill tsconfig.base.json
│   │
│   ├── helpers/       → symlink → $SKILL/helpers/
│   ├── config/        → symlink → $SKILL/config/
│   ├── orchestration/ → symlink → $SKILL/orchestration/
│   ├── resilience/    → symlink → $SKILL/resilience/
│   ├── inject/        → symlink → $SKILL/inject/
│   ├── chaos/         → symlink → $SKILL/chaos/
│   └── scripts/       → symlink → $SKILL/scripts/
│
├── jian-h5/                            ← L2: 项目层
│   └── evaluateRecovery/               ← L3: 需求层 (按 domain 隔离)
│       ├── skill.project.json → symlink → 项目源文件
│       ├── specs/                      ← AI 生成 / 模板实例化
│       │   ├── app-launch.spec.ts
│       │   ├── evaluateRecovery.C01.spec.ts
│       │   ├── ...
│       │   └── webview-communication.spec.ts
│       ├── case-registry.json          ← 自动生成
│       ├── test-plan.md                ← 自动生成
│       ├── artifacts/                  ← 运行时临时产物
│       │   └── runs/<runId>/
│       │       ├── cases-executed.jsonl
│       │       ├── diagnostic-snapshots/
│       │       ├── coverage-snapshots/
│       │       └── resilience-report.json
│       └── reports/  → symlink → <项目>/docs/guazi-flow/{匹配}/e2e-device/
│
├── another-app/                        ← 另一个项目, 完全隔离
│   └── homePage/
│       └── ...
│
└── .cache/                             ← 跨项目缓存 (长久保留)
    ├── chromedriver/                   ← WebView 版本匹配的 chromedriver
    ├── sdk-state.json                  ← Android SDK 路径
    └── app-config.json                 ← 上次探测的 App 配置
```

### 层级说明

| 层级 | 路径 | 生命周期 | 职责 |
|------|------|----------|------|
| L1 框架层 | `shared/` | 长久保留，系统重启自动清 | symlink Skill 框架代码，通用配置 |
| L2 项目层 | `{项目名}/` | 项目需要时存在 | 隔离不同项目 |
| L3 需求层 | `{项目名}/{domain}/` | 按需创建，可并行 | 隔离不同需求/domain |
| L4 缓存 | `.cache/` | 长久保留 | chromedriver、SDK 路径等 |

---

## 四、执行入口

### 4.1 CLI

```bash
# 从 Skill 执行 (不在项目内)
bash ~/.agents/skills/e2e-device/scripts/init.sh run \
  --project /path/to/jian-h5 \
  --domain evaluateRecovery \
  --mode quick
```

或安装为全局命令：
```bash
# npx / npm link 后
e2e-device run --project /path/to/jian-h5 --domain evaluateRecovery
```

### 4.2 init.sh 内部流程

```
1. 前置检查
   ├─ adb devices → 有设备?
   ├─ Android SDK → ANDROID_HOME?
   └─ $SKILL/node_modules → 存在?

2. 项目配置校验
   └─ <project>/e2e-device/skill.project.json → 存在? 有效?

3. 创建/复用 shared/
   ├─ 首次: 创建框架 symlink + wdio.conf.ts + tsconfig.json
   └─ 已存在: 跳过

4. 创建 SANDBOX=/tmp/e2e-device/{项目}/{domain}/
   ├─ symlink skill.project.json → 项目源
   ├─ 运行 discover-cases --union → 生成 specs/
   ├─ 生成 case-registry.json + test-plan.md
   └─ symlink reports/ → 项目 docs/

5. 呈现测试计划 → 用户确认 (10s 默认 quick)

6. 执行
   ├─ export PATH=$SKILL/node_modules/.bin:$PATH
   ├─ cd $SANDBOX && npx wdio run ../../shared/wdio.conf.ts
   └─ Session 默认批量模式 (E2E_SEQUENTIAL_INDIVIDUAL=1 回退)

7. 发布报告
   └─ npx ts-node $SKILL/orchestration/cli.ts publish-reports $RUN_ID
      → 自动写入 项目/docs/guazi-flow/<task>/e2e-device/

8. 可选清理
   ├─ 默认: 保留 specs/ 加速下次执行
   └─ --clean: rm -rf $SANDBOX (报告已发布, 仅删临时产物)
```

---

## 五、项目配置文件

### 5.1 skill.project.json（唯一需要手写的文件）

```json
{
  "id": "jian-h5",
  "domain": "evaluateRecovery",
  "hybrid": {
    "platform": "android",
    "container": {
      "package": "com.guazi.android.expert"
    },
    "webView": {
      "routingMode": "history",
      "webViewUrlAnchor": "/evaluateRecovery"
    },
    "deepLink": {
      "scheme": "jiangz",
      "openPath": "openapi",
      "h5Action": "openWebview"
    },
    "network": {
      "pageOrigin": "https://xrk-c2b.guazi-cloud.com/v2"
    },
    "auth": {
      "layers": ["native", "bridgeToken"],
      "loginResourceIds": {
        "account": "com.example:id/et_account",
        "password": "com.example:id/et_password",
        "loginBtn": "com.example:id/btn_login"
      }
    }
  }
}
```

### 5.2 首次接入流程

```bash
# 方式 A: probe 自动探测 + 引导填写
e2e-device probe --project /path/to/project
# → 探测 AndroidManifest / build.gradle / 包名
# → 交互式引导填写 pageOrigin / domain / deepLink
# → 自动生成 skill.project.json

# 方式 B: 手写
touch e2e-device/skill.project.json
# 填写上述字段即可
```

---

## 六、多需求并行

```bash
# 终端 1: evaluateRecovery
e2e-device run --project jian-h5 --domain evaluateRecovery

# 终端 2: followUpMark (同时跑, 互不干扰)
e2e-device run --project jian-h5 --domain followUpMark

# Appium 端口自动分配:
#   evaluateRecovery → 4723 (默认)
#   followUpMark     → 4724 (lock-free)
```

每个需求独立 sandbox，artifacts 隔离，specs 隔离。

---

## 七、清理策略

| 命令 | 效果 |
|------|------|
| `e2e-device clean --project jian-h5` | 删除项目层 (保留 shared/) |
| `e2e-device clean --project jian-h5 --domain X` | 删除指定需求 |
| `e2e-device clean --all` | 删除项目 + shared |
| `e2e-device clean --system` | 删除 /tmp/e2e-device/ 全部 |
| 系统重启 | 自动清空 (macOS/Linux /tmp 重启即清) |

---

## 八、对比表

| 指标 | 当前状态 | 方案目标 |
|------|----------|----------|
| 项目 e2e-device/ 文件数 | 159 | **1** (`skill.project.json`) |
| 项目 node_modules 污染 | 16 symlink | **0** |
| 项目 package.json 改动 | 0 | **0** |
| 项目 tsconfig.json | 1 个独立文件 | **0** (在 /tmp 中) |
| 业务代码侵入 | 0 | **0** |
| specs 存放位置 | 项目内 (git) | /tmp 中按需生成 |
| 执行后残留 | artifacts/ + .e2e-* | **0** (可选 --clean) |
| 多需求并行 | ❌ | ✅ |
| 跨项目共享框架代码 | ❌ (每项目复制一份) | ✅ (shared/ 复用) |
| 报告输出 | docs/ | docs/ (不变) |
| Skill 框架代码位置 | 每项目 e2e-device/*.ts | Skill ~/.agents/ 唯源 |

---

## 九、实施阶段

### Phase 1: Symlink 透明代理（最小改动，验证可行性）

- `init.sh` 在项目 `e2e-device/` 下创建 symlink 指向 Skill 目录
- specs 仍在项目内
- wdio 通过 skill/node_modules 执行
- **改动量**: ~50 行 bash
- **项目文件**: 159 → ~44 (specs + 配置 + 7 symlink)

### Phase 2: 执行沙箱迁移

- 创建 `/tmp/e2e-device/shared/` + `/tmp/e2e-device/{项目}/{domain}/`
- specs 移入沙箱，按需生成
- `init.sh` 接受 `--project` 参数，从 Skill 运行
- **改动量**: ~200 行 bash + 重构 paths.ts 支持 `E2E_PROJECT_ROOT`
- **项目文件**: 1 (`skill.project.json`)

### Phase 3: CLI 化 + 全局安装

- 封装为 `e2e-device` 命令 (npm bin / npx)
- 清理策略、缓存管理
- 多需求并行锁
- **改动量**: ~100 行 TS

### Phase 4: 性能优化

- specs 缓存增量更新（仅重新生成变更的 spec）
- shared/ 预热 (daemon 常驻)
- chromedriver 按需下载缓存

---

## 十、风险与缓解

| 风险 | 缓解 |
|------|------|
| `/tmp` 空间不足 | specs + artifacts 通常 < 50MB；可配置 `E2E_TMPDIR` 替代 |
| 系统重启丢 shared/ | `init.sh` 自动重建，成本 < 2s |
| Windows `/tmp` 不存在 | 自动检测 → fallback `%TEMP%` 或 `$HOME/.cache/e2e-device` |
| spec 文件 import 路径解析 | symlink 透明代理，不改一行 import |
| IDE 无 spec 文件提示 | spec 按需生成，IDE 不需要打开 `/tmp` 中的文件 |
| 多用户冲突 | `/tmp/e2e-device` 权限 700，用户隔离 |

---

## 十一、相关文档

- [安全规范](../security.md) — 凭据脱敏、登录态探测
- [环境变量](../reference/env-vars.md) — 完整变量列表
- [架构总览](../reference/arch-overview.md) — 系统架构
- [Agent 门禁](../reference/agent-gates.md) — 交互规范
- [生命周期](../reference/lifecycle.md) — 测试三阶段
