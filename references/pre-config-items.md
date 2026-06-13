# e2e-device 前置配置项分析

> 首次运行时需要获取的配置项及获取方式。

---

## 配置项清单

| # | 配置项 | 路径 | 必需 | 自动探测 | 探测来源 | 用户交互 |
|---|--------|------|------|----------|----------|----------|
| 1 | **pageOrigin** | `hybrid.network.pageOrigin` | ✅ | ⚠️ | `src/config/env.js` 中 `H5_HOST` / `REACT_APP_*_ORIGIN` | 0个→输入；1个→确认 |
| 2 | **domain** | `pilot.domain` | ✅ | ⚠️ | `src/App.tsx` 路由表 / `git diff` 推断 / `docs/guazi-flow/` | 0个→输入；1个→确认；多个→选择 |
| 3 | **appPackage** | `hybrid.container.package` | ⚠️ | ✅ | `adb` + 项目配置文件 | 无需交互 |
| 4 | **deepLink.scheme** | `hybrid.deepLink.scheme` | ⚠️ | ✅ | `adb` 探测 + 项目配置 | 无需交互 |
| 5 | **deepLink.openPath** | `hybrid.deepLink.openPath` | ❌ | ✅ | 默认 `openapi` | 无需交互 |
| 6 | **deepLink.h5Action** | `hybrid.deepLink.h5Action` | ❌ | ✅ | 默认 `openWebview` | 无需交互 |
| 7 | **routingMode** | `hybrid.webView.routingMode` | ❌ | ✅ | 项目配置（history / hash） | 无需交互 |
| 8 | **webViewUrlAnchor** | `hybrid.webView.webViewUrlAnchor` | ❌ | ✅ | 从 domain 派生 | 无需交互 |
| 9 | **apiOrigin** | `hybrid.network.apiOrigin` | ❌ | ✅ | `src/config/env.js` | 无需交互 |
| 10 | **loginResourceIds** | `hybrid.container.loginResourceIds` | ❌ | ⚠️ | 项目配置 | 无需交互（启发式兜底） |
| 11 | **device PIN** | `E2E_DEVICE_PIN`（环境变量） | ❌ | ❌ | — | 运行时可选，不存盘 |

### 图例

| 标记 | 含义 |
|------|------|
| ✅ 必需 | 缺少则无法执行 |
| ⚠️ 建议 | 缺少则部分功能降级 |
| ❌ 可选 | 有默认值或不需要 |
| ✅ 自动探测 | discover-project 可自动获取 |
| ⚠️ 自动探测 | 可能获取到也可能获取不到 |
| ❌ 自动探测 | 无法自动获取 |

---

## 用户交互场景

### pageOrigin（H5 部署域名）

```
探测到 1 个:
  [probe] 探测到 pageOrigin: https://xrk-c2b.guazi-cloud.com/v2
  确认使用? [Enter=确认 / 输入新值]: ↵

探测到 0 个:
  [probe] 未探测到 pageOrigin (H5 部署域名)
  请输入 pageOrigin: https://h5.example.com/v2
```

### domain（测试目标页面模块）

```
探测到 1 个:
  [probe] 探测到 domain: evaluateRecovery
  确认使用? [Enter=确认 / 输入新值]: ↵

探测到多个:
  [probe] 探测到以下可用 domain:
    1. evaluateRecovery
    2. followUpMark
    3. advanceRecovery
    ...
  输入编号选择, 或直接输入 domain: 1

探测到 0 个:
  [probe] 未探测到 domain
  请输入 domain: evaluateRecovery

--domain 参数指定:
  [probe] domain 已通过 --domain 指定: evaluateRecovery
```

---

## 探测引擎

`discover-project.ts` 执行流程：

```
discover-project
├─ 读取 src/App.tsx           → routes (路由表)
├─ 读取 src/config/env.js     → pageOrigin / apiOrigin
├─ 读取 package.json          → scripts / dependencies
├─ 读取 e2e-device/config/    → appPackage / loginIds
├─ 执行 adb                    → deepLink scheme / 安装包名
├─ 扫描 docs/guazi-flow/       → pilot domain 候选
├─ git diff                    → 变更文件推断 domain
└─ 输出: skill.project.json   → 写入 ~/.e2e-device/projects/{hash}.json
```

纯读取项目源码，通过临时 `E2E_SANDBOX` 隔离写入，不触碰项目目录。
