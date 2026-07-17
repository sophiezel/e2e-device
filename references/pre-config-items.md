# e2e-device 前置配置项分析

> 每次跑测前：Agent 自查候选 → 用户确认三元组 → export env → 再 `run.sh`。
> 脚本：`bash scripts/list-preconfig.sh --project <path> [--domain <hint>]`

---

## 配置项清单

| # | 配置项 | 路径 | 必需 | 自动探测 | 探测来源 | 用户交互 |
|---|--------|------|------|----------|----------|----------|
| 1 | **pageOrigin** | `hybrid.network.pageOrigin` | ✅ | ⚠️ 多候选 | publicPath / 项目 docs / 精确 H5 key（**排除** API 域） | Quick Path 可跳过；否则必确认 |
| 2 | **domain** | `pilot.domain` | ✅ | ⚠️ 多候选打分 | git diff / 工作区 / 路由入口 | Quick Path 可跳过；多域选主测域 |
| 3 | **appPackage** | `hybrid.container.package` | ✅ | ⚠️ adb 列表 | `adb pm list` + 项目配置；可选 `E2E_APP_PACKAGE_FILTER` | Quick Path 可跳过；否则必确认 |
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

## 强制流程：自查 →（Quick Path 或 AskQuestion）→ export → plan-only → 确认 → run

```
1. bash scripts/list-preconfig.sh --project <path>
2. 若 quickPathEligible === true 且 env 齐 → 跳过 AskQuestion，展示 effective
   否则 AskQuestion：pageOrigin / appPackage / domain
3. export E2E_PAGE_ORIGIN E2E_APP_PACKAGE E2E_DOMAIN
4. bash scripts/run.sh --project <path> --plan-only
5. 用户确认 mode 后 → bash scripts/run.sh --project <path> --mode <confirmed>
```

- 非交互 / Agent 模式：**禁止**静默「自动确认」探测值（除非 Quick Path）
- `run.sh` 缺任一三元组 env → `preconfig_unconfirmed` exit 1
- 确认后写入 `manifest.userConfirmed`（pageOrigin / appPackage / domain / confirmedAt）
- 探测来源应为通用信号（publicPath / git diff / adb），勿依赖公司特化关键词
---

## 用户交互场景

### pageOrigin（H5 部署域名）

```
list-preconfig 输出 pageOriginCandidates:
  - https://h5.example.com/v2     (config:publicPath, high)
  - https://api.example.com       (likely-api, low)  ← 勿选

AskQuestion → 用户确认 → export E2E_PAGE_ORIGIN=https://h5.example.com/v2
```

### domain（测试目标页面模块）

```
domainCandidates（多信号打分）:
  1. exampleFeature   score=65  sources=[docs:写集, git-diff:...]
  2. anotherModule    score=50  ...

AskQuestion → 选本轮主测 domain → export E2E_DOMAIN=exampleFeature
```

多域任务默认 **单域跑测**；若需测多个域，串行多次 `run.sh`。

### appPackage（目标 Hybrid App）

```
设备候选:
  1. com.example.app.debug [debuggable]
  2. com.example.app

AskQuestion → 选测试包 → export E2E_APP_PACKAGE=...
```

即使只有 1 个候选，非交互模式也必须先 export，禁止静默匹配。

---

## 需端上（Android Native / adb）才能确认的配置

纯 H5 仓库（无 `android/`）时，下列项 **不能**仅靠 H5 grep 定论：

| 配置项 | H5 能否推断 | 端上确认方式 |
|--------|-------------|--------------|
| **deepLink.scheme** | 部分（代码中的 scheme 字符串 hint） | `adb dumpsys package {pkg}` → `Scheme:` |
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

多 scheme 并存时以 adb 验证测试包已注册的为准。

**无需 Native、H5 + 文档可确认**：pageOrigin、domain/routes、apiOrigin、routingMode。

---

## 探测链路（discover-project）

```
list-preconfig / discover-project
├─ pageOriginCandidates
│  ├─ bundler publicPath
│  ├─ 项目 docs 中的 H5 URL
│  ├─ 精确 key: H5_HOST / PAGE_ORIGIN / PUBLIC_URL（禁止裸 ORIGIN / API 域）
│  └─ manifest 缓存（low hint）
├─ domainCandidates（加权：env > 项目 docs > git diff > 工作区 > routes > cache）
├─ appPackageCandidates（env > config > adb；可选 E2E_APP_PACKAGE_FILTER）
├─ quickPathEligible / quickPathReasons
└─ nativeHints（scheme source + needsNativeConfirm）

用户确认 → export E2E_* → run.sh --plan-only → 确认 mode → run.sh
├─ preconfig_unconfirmed gate
├─ _merge_env_to_manifest → userConfirmed
└─ preflight 展示 effective 三件套 + App 冒烟
```
