# e2e-device 全生命周期产物图谱

> 所有产物分层管理，项目仅输出报告。

---

## 执行流程

```
e2e-device run --project /path/to/proj --domain X
│
├─ 1. 配置解析  → 读取/迁移/探测 skill.project.json
├─ 2. 自愈检查  → preflight 环境校验
├─ 3. 框架创建  → shared/ 建立 symlink + 配置模板
├─ 4. 沙箱创建  → sandbox/{项目}/{domain}/ 隔离执行环境
├─ 5. Spec 生成 → 从 guazi-flow 矩阵 + Skill 模板生成用例
├─ 6. WDIO 执行 → Appium 真机测试
├─ 7. 报告发布  → 写入 项目/docs/ (唯一项目输出)
└─ 8. 清理      → 可选: artifacts, sandbox, E2E_HOME
```

---

## 产物分层

### 📁 `~/.e2e-device/` (E2E_HOME)

```
~/.e2e-device/
│
├─ 📄 README.md                          ① 自说明文档
│     来源: run.sh generate_readme()
│     时机: 每次 run/plan
│     清理: clean --system
│
├─ 📁 projects/                          ② 项目配置缓存
│   └─ {hash}.json
│       来源: 项目文件迁移 / discover-project 探测
│       时机: 首次运行
│       清理: clean --system（丢失需重新探测）
│
├─ 📁 sandbox/
│   │
│   ├─ 📁 shared/                        ③ 框架缓存 (跨项目复用)
│   │   ├─ 🔗 helpers/ config/ orchestration/ resilience/
│   │   │   来源: ln -sf → $SKILL/
│   │   │   清理: clean --sandbox
│   │   ├─ 📄 wdio.conf.ts
│   │   │   来源: cp $SKILL/templates/wdio.conf.sandbox.ts
│   │   └─ 📄 tsconfig.json
│   │       来源: 动态生成 (extends skill)
│   │
│   └─ 📁 {项目名}/{domain}/             ④ 需求沙箱
│       ├─ 🔗 skill.project.json → ②
│       ├─ 🔗 helpers/ config/ ... → ③/shared/
│       │
│       ├─ 📁 specs/                     ⑤ 测试用例
│       │   ├─ {domain}.C01~C20.spec.ts   (guazi-flow 矩阵)
│       │   ├─ {domain}.hybrid.*.spec.ts  (Hybrid 测试)
│       │   ├─ *.chaos.spec.ts            (混沌测试)
│       │   └─ form-navigation.spec.ts ... (端侧通用, 从 Skill 模板)
│       │   来源: discover-cases → writeGeneratedSpecs
│       │         + Skill templates/scaffold/specs/
│       │   清理: clean --sandbox
│       │
│       ├─ 📄 case-registry.json         ⑥ 用例注册表
│       ├─ 📄 test-plan.md               ⑦ 测试计划
│       │
│       ├─ 📁 artifacts/
│       │   └─ 📁 runs/{runId}/
│       │       ├─ 📄 cases-executed.jsonl      ⑧ 执行记录
│       │       ├─ 📄 archive.json              ⑨ 归档
│       │       ├─ 📄 resilience-report.json    ⑩ 韧性报告
│       │       ├─ 📁 diagnostic-snapshots/     ⑪ 诊断快照
│       │       └─ 📁 coverage-snapshots/       ⑫ 覆盖率
│       │   清理: 每次 run 自动清 artifacts/
│       │
│       └─ 🔗 reports/ → 项目 docs/      ⑬ 报告输出 symlink
│
├─ 📁 chromedriver/                      ⑭ WebView 驱动
│   ├─ chromedriver-{version}/
│   │   来源: preflight-check 自动下载
│   │   治理: 多版本共存，保留最近 5 个
│   └─ versions.json
│
└─ 📁 logs/                              ⑮ 运行日志
    └─ appium.log
        来源: Appium 后台进程 stdout
        清理: clean --logs
```

### 📁 项目 (唯一输出)

```
项目/
└─ docs/guazi-flow/{task}/e2e-device/
    └─ YYYY-MM-DD-真机E2E-HHmm.md        ⑯ 合并报告
        来源: publish-reports.ts
        包含: 执行摘要 / 用例结果 / 失败详情 / 覆盖率
```

---

## 生命周期管理

| # | 产物 | 创建时机 | 复用策略 | 清理方式 |
|---|------|----------|----------|----------|
| ① | README.md | 每次 run | 覆盖 | clean --system |
| ② | 配置缓存 | 首次 run | 永久复用 | clean --system |
| ③ | shared/ | 首次 run | 跨项目复用 | clean --sandbox |
| ④ | 需求沙箱 | 每次 run | symlink 重建 | clean --sandbox |
| ⑤ | specs | 每次 run | 增量新增 | clean --sandbox |
| ⑥ | case-registry | 每次 run | 覆盖 | clean --sandbox |
| ⑦ | test-plan | 每次 run | 覆盖 | clean --sandbox |
| ⑧-⑫ | artifacts | 每次 run | 自动清 artifacts/ | 自动 + clean --sandbox |
| ⑬ | reports symlink | 每次 run | 重建 symlink | 无 (是 symlink) |
| ⑭ | chromedriver | 首次匹配 | 多版本共存，保留 5 个 | clean --system |
| ⑮ | appium.log | 每次 run | 覆盖 | clean --logs |
| ⑯ | 报告 | 每次 run | 新建文件 | 用户管理 (应提交 git) |

---

## 清理命令

| 命令 | 效果 |
|------|------|
| `e2e-device clean --sandbox` | 删除 sandbox/ (保留配置) |
| `e2e-device clean --logs` | 删除 logs/ |
| `e2e-device clean --all` | 删除 sandbox/ + logs/ |
| `e2e-device clean --system` | 删除整个 ~/.e2e-device/ |
| `rm -rf ~/.e2e-device` | 等效 --system |

---

## 安全边界

| 允许 | 禁止 |
|------|------|
| 写入 `~/.e2e-device/` | 写入项目 `src/` |
| 读取项目源码 (App.tsx, env.js) | 修改 `package.json` |
| 写入项目 `docs/` (报告) | 写入项目 `e2e-device/` |
| 下载 chromedriver 到 E2E_HOME | 修改 `node_modules/` |
