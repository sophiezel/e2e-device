# e2e-device 全生命周期产物图谱

> v2: 所有产物分层管理，项目仅输出测试报告。

---

## 执行流程

```
e2e-device run --project /path/to/proj --domain X
│
├─ 1. 配置解析  → 读取/迁移项目配置到 E2E_HOME 缓存
├─ 2. 环境预检  → adb / WebView调试 / pageOrigin可达 / 权限预授权
├─ 3. 项目发现  → packageName / scheme / deepLink / 登录态
├─ 4. 域确认    → git diff + 文档探测 → 交叉验证
├─ 5. Case发现  → infra(框架) + chaos(框架) + biz(缓存/Agent提取)
├─ 6. WDIO 执行 → Appium 真机测试 (session热保持, 45s超时, 不阻断)
├─ 7. 后处理    → 截图diff + logcat提取 + 覆盖率合并 + LLM诊断
└─ 8. 报告发布  → 写入 项目/docs/ (唯一项目输出)
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
├─ 📁 projects/                          ② 项目配置 + case 缓存
│   └─ {hash}/
│       ├─ manifest.json                  项目配置缓存
│       │   来源: discover-project 探测
│       │   时机: 首次运行
│       │
│       ├─ case-cache/                    业务 case 缓存
│       │   └─ {branch}/{domain}.json
│       │       来源: Agent 从需求文档提取
│       │       失效: 源文档哈希变更时增量失效
│       │
│       └─ preferences.json              粘性偏好
│           内容: lastDomain, lastTestLevel, lastEnv
│           刷新: 分支切换时
│
│      清理: clean --cache (case-cache + preferences)
│             clean --system (全部)
│
├─ 📁 sandbox/
│   └─ 📁 {hash}/{domain}/              ③ 执行沙箱
│       ├─ 📁 specs/                     ④ 测试用例
│       │   ├─ {domain}.C01~C20.spec.ts   (矩阵用例)
│       │   ├─ {domain}.hybrid.*.spec.ts  (Hybrid 测试)
│       │   ├─ *.chaos.spec.ts            (混沌测试)
│       │   └─ form-navigation.spec.ts ... (端侧通用)
│       │   来源: discover-cases 从 assets/scaffold/specs/ + 业务提取
│       │   清理: clean --sandbox
│       │
│       ├─ 📄 case-registry.json         ⑤ 用例注册表
│       ├─ 📄 test-plan.md               ⑥ 测试计划
│       │
│       ├─ 📁 artifacts/runs/{runId}/    ⑦ 运行时产物
│       │   ├─ 📄 cases-executed.jsonl    执行记录
│       │   ├─ 📄 progress.jsonl          进度事件
│       │   ├─ 📄 archive.json            归档
│       │   ├─ 📄 resilience-report.json  韧性报告
│       │   ├─ 📄 coverage-raw.json       全量覆盖率
│       │   ├─ 📁 diagnostic-snapshots/   诊断快照 (截图)
│       │   ├─ 📁 coverage-snapshots/     覆盖率快照
│       │   └─ 📁 screenshots/            失败截图
│       │   清理: 每次 run 自动清 artifacts/
│       │
│       └─ 📁 reports/ → 项目 docs/      ⑧ 报告输出 symlink
│
├─ 📁 chromedriver/                      ⑨ WebView 驱动
│   ├─ chromedriver-{version}/
│   │   来源: preflight-check 自动下载 (Chrome for Testing API)
│   │   治理: 多版本共存，按设备 WebView major 自动匹配
│   │   保留: 最近 5 个版本
│   └─ versions.json
│
└─ 📁 logs/                              ⑩ 运行日志
    ├─ appium.log
    └─ logcat.log                         设备日志 (环形缓冲 5000 行)
        来源: 后台进程持续采集
        清理: clean --logs
```

### 📁 项目 (唯一输出)

```
项目/
└─ docs/                                 ⑪ 测试报告 (唯一写入项目)
    └─ {YYYY-MM-DD}-真机E2E-{HHmm}.md
        来源: publish-reports.ts
        内容: 结果总览 / 失败详情 / 覆盖率 / LLM介入统计
        格式: 纯文本 Markdown，零二进制嵌入
        末尾: 标注产物路径 → $E2E_HOME/sandbox/.../runs/{runId}/
```

---

## 生命周期管理

| # | 产物 | 创建时机 | 复用策略 | 清理方式 |
|---|------|----------|----------|----------|
| ① | README.md | 每次 run | 覆盖 | clean --system |
| ② | 项目配置缓存 | 首次 run | 永久复用 | clean --system |
| ③ | 执行沙箱 | 每次 run | 增量复用 specs | clean --sandbox |
| ④ | specs | 每次 run | 增量新增，不删已有 | clean --sandbox |
| ⑤ | case-registry | 每次 run | 覆盖 | clean --sandbox |
| ⑥ | test-plan | 每次 run | 覆盖 | clean --sandbox |
| ⑦ | 运行时产物 | 每次 run | 自动清 artifacts/ | 自动 + clean --sandbox |
| ⑧ | reports symlink | 每次 run | 重建 symlink | 无 (是 symlink) |
| ⑨ | chromedriver | 首次匹配 | 多版本共存，保留 5 个 | clean --system |
| ⑩ | 运行日志 | 每次 run | 追加/覆盖 | clean --logs |
| ⑪ | 测试报告 | 每次 run | 新建文件 | 用户管理 (应提交 git) |

---

## 清理命令

| 命令 | 效果 |
|------|------|
| `e2e-device clean --sandbox` | 删除 sandbox/ (保留配置和缓存) |
| `e2e-device clean --logs` | 删除 logs/ |
| `e2e-device clean --cache` | 删除 projects/ 下 case-cache/ + preferences |
| `e2e-device clean --all` | 删除 sandbox/ + logs/ (保留配置) |
| `e2e-device clean --system` | 完全清除 ~/.e2e-device/ |
| `e2e-device clean --credentials` | 清除 OS Keychain 中本项目凭据 |
| `rm -rf ~/.e2e-device` | 等效 --system |

---

## 安全边界

| 允许 | 禁止 |
|------|------|
| 写入 `~/.e2e-device/` (全部产物) | 写入项目 `src/` |
| 读取项目源码 (App.tsx, env.js, docs/) | 修改项目 `package.json` |
| 写入项目 `docs/` (仅测试报告 .md) | 写入项目其他任何路径 |
| 下载 chromedriver 到 E2E_HOME | 修改项目 `node_modules/` |
| 写入 OS Keychain (凭据) | 凭据写入任何文件 (.env, .json) |
