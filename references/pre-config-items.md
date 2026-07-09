# e2e-device 前置配置项分析

> 每次跑测前：Agent 自查候选 → 用户确认三元组 → export env → 再 `run.sh`。
> 脚本：`bash scripts/list-preconfig.sh --project <path> [--domain <hint>]`

---

## 配置项清单

| # | 配置项 | 路径 | 必需 | 自动探测 | 探测来源 | 用户交互 |
|---|--------|------|------|----------|----------|----------|
| 1 | **pageOrigin** | `hybrid.network.pageOrigin` | ✅ | ⚠️ 多候选 | publicPath / guazi-flow / 精确 H5 key（**排除** `I_ORIGIN`） | **每次必确认**；已设 `E2E_PAGE_ORIGIN` 可跳过 AskQuestion，仍展示 effective |
| 2 | **domain** | `pilot.domain` | ✅ | ⚠️ 多候选打分 | guazi-flow 写集 / git diff / 工作区 / App.tsx | **每次必确认**；多域任务选主测域 |
| 3 | **appPackage** | `hybrid.container.package` | ✅ | ⚠️ adb 列表 | `adb pm list` + 项目配置 | **每次必确认**；`E2E_APP_PACKAGE` 可跳过 AskQuestion |
| 4 | **deepLink.scheme** | `hybrid.deepLink.scheme` | ⚠️ | ✅ 优先 adb | **adb dumpsys** > AndroidManifest > e2e config > H5 字符串 hint | 通常不问；`needsNativeConfirm` 时 AskQuestion |
| 5 | **deepLink.openPath** | `hybrid.deepLink.openPath` | ❌ | ✅ | 默认 `openapi` | 无需交互 |
| 6 | **deepLink.h5Action** | `hybrid.deepLink.h5Action` | ❌ | ✅ | 默认 `openWebview`（H5 另有 `openRNView`） | 无需交互 |
| 7 | **routingMode** | `hybrid.webView.routingMode` | ❌ | ✅ | App.tsx HashRouter / BrowserRouter | 无需交互 |
| 8 | **webViewUrlAnchor** | `hybrid.webView.webViewUrlAnchor` | ❌ | ✅ | 从 domain + routingMode 派生 | 无需交互 |
| 9 | **apiOrigin** | `hybrid.network.apiOrigin` | ❌ | ✅ | `src/config/env.js` API 域（≠ pageOrigin） | 无需交互 |
| 10 | **loginResourceIds** | `hybrid.container.loginResourceIds` | ❌ | ⚠️ | e2e-device/config 或 Native layout | 可能需 Native 确认 |
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

## 强制流程：自查 → AskQuestion → export → run

```
1. bash scripts/list-preconfig.sh --project <path>
2. AskQuestion：pageOrigin / appPackage / domain（展示候选+推荐+证据）
3. export E2E_PAGE_ORIGIN E2E_APP_PACKAGE E2E_DOMAIN
4. bash scripts/run.sh --project <path> --domain "$E2E_DOMAIN"
```

- 非交互 / Agent 模式：**禁止**静默「自动确认」探测值
- `run.sh` 缺任一三元组 env → `preconfig_unconfirmed` exit 1
- 确认后写入 `manifest.userConfirmed`（pageOrigin / appPackage / domain / confirmedAt）

---

## 用户交互场景

### pageOrigin（H5 部署域名）

```
list-preconfig 输出 pageOriginCandidates:
  - https://xrk-c2b.guazi-cloud.com/v2  (config-overrides.js:publicPath, high)
  - https://i.guazi-cloud.com            (likely-api, low)  ← 勿选

AskQuestion → 用户确认 → export E2E_PAGE_ORIGIN=https://xrk-c2b.guazi-cloud.com/v2
```

### domain（测试目标页面模块）

```
domainCandidates（多信号打分）:
  1. evaluateRecovery  score=65  sources=[guazi-flow:写集, git-diff:...]
  2. checkRecovery     score=50  ...
  3. conversionTool    score=35  ...

AskQuestion → 选本轮主测 domain → export E2E_DOMAIN=evaluateRecovery
```

多域任务默认 **单域跑测**；若需测多个域，串行多次 `run.sh`（或后续支持逗号分隔）。

### appPackage（目标 Hybrid App）

```
设备候选:
  1. com.guazi.android.expert [debuggable]
  2. com.guazi.android.expert.release

AskQuestion → 选测试包 → export E2E_APP_PACKAGE=...
```

即使只有 1 个候选，非交互模式也必须先 export，禁止静默匹配。

---

## 需端上（Android Native / adb）才能确认的配置

纯 H5 仓库（无 `android/`）时，下列项 **不能**仅靠 H5 grep 定论：

| 配置项 | H5 能否推断 | 端上确认方式 |
|--------|-------------|--------------|
| **deepLink.scheme** | 部分（`jiangz://` / `guagua://` 字符串） | `adb dumpsys package {pkg}` → `Scheme:` |
| **deepLink.openPath / h5Action** | 惯例 `openapi` / `openWebview` | intent-filter / Native 路由表 |
| **appPackage** | 否 | `adb pm list packages` |
| **appActivity / openApiActivity** | 否（除非 e2e config） | dumpsys Activity / Manifest |
| **loginResourceIds** | 否 | Native layout id |
| **WebView debug** | 否 | `setWebContentsDebuggingEnabled` / chrome://inspect |
| **https App Links** | 否 | Native intent-filter |

**discover 优先级（scheme）**：

1. adb dumpsys（已装测试包）
2. 项目内 `android/` Manifest
3. `e2e-device/config/app.ts`
4. H5 字符串 hint（`confidence` 低，`needsNativeConfirm: true`）
5. 仍不确定 → `list-preconfig.nativeHints.needsNativeConfirm` → AskQuestion

H5 内常见多 scheme：`jiangz`（WebView/RN）与 `guagua`（另一容器）。Hybrid E2E 打开 H5 页通常用 `jiangz://openapi/openWebview`，须 adb 验证测试包已注册。

**无需 Native、H5 + 文档可确认**：pageOrigin、domain/routes、apiOrigin、routingMode。

---

## 探测链路（discover-project）

```
list-preconfig / discover-project
├─ pageOriginCandidates
│  ├─ config-overrides.js publicPath（含注释）
│  ├─ docs/guazi-flow/** /v2 URL
│  ├─ 精确 key: H5_HOST / PAGE_ORIGIN / PUBLIC_URL（禁止裸 ORIGIN / I_ORIGIN）
│  └─ manifest 缓存（low hint）
├─ domainCandidates（加权：env > guazi-flow > git diff > 工作区 > intent > routes > cache）
├─ appPackageCandidates（env > config > adb guazi|jian）
└─ nativeHints（scheme source + needsNativeConfirm）

用户确认 → export E2E_* → run.sh
├─ preconfig_unconfirmed gate
├─ _merge_env_to_manifest → userConfirmed
└─ preflight 展示 effective 三件套 + App 冒烟
```
