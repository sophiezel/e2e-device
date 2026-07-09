<!-- 触发条件: mock 配置 / fixture 问题 / E2E_DATA_MODE / SSL pinning 相关时加载 -->
# Mock 策略

## 默认：WebView inject

- 策略名：`inject`
- 脚本：`assets/scaffold/inject/web-request-mock.js`
- 启用：`enable-web-mock`（`browser.execute` 注入规则 + IIFE）
- 启用条件：`E2E_ENABLE_WEB_MOCK=1` **或** `E2E_DATA_MODE=mock`
- 规则来源：宿主仓 `e2e-device/fixtures/**` + `skill.project.json` → `mock.routes` / `profileRouteMap`
- Profile：`E2E_MOCK_PROFILE`（或 case metadata `mockProfile` / state id）
- DeepLink query：`E2E_PAGE_QUERY` 或 case `query`（如 `clueId=...`）
- 深链可选：`__E2E_MOCK__=1`
- 韧性层：`emptyData` / `backendError` → live → auto-fix → **inject 重试** → `pass_with_mock`
- 归档：`hybridEvidence.mockLayer: "inject"`

`cdp-mock.ts` 仅为历史文件名，内部**委托** `enableWebMock`，**不**依赖 Chrome DevTools `browser.mock`。

## 闭环：页面依赖 → 接口 → 多状态

```
src/pages/{domain} + src/services
        ↓ discover-page-api-graph / discover-request-layer
manifest.mock.pageApiGraph + mock.routes
        ↓ 宿主 e2e-device/fixtures/{domain}/states.json
profileRouteMap + matchQuery 多状态规则
        ↓ enableWebMock(profile) + DeepLink query
WebView inject（web-request-mock.js）
```

### 宿主 fixtures 约定

| 路径 | 内容 |
|------|------|
| `e2e-device/fixtures/{domain}/*.json` | 接口响应体（不含业务逻辑进 Skill） |
| `e2e-device/fixtures/{domain}/states.json` | MockState 列表 + 可选 `matrixKeywords` |

`states.json` schema（示意）：

```json
{
  "gateParam": "clueId",
  "matrixKeywords": { "缺少 clueId": "NO_CLUE" },
  "states": [
    {
      "id": "INFO_OK",
      "profile": "INFO_OK",
      "query": { "clueId": "…" },
      "routes": ["recovery-info.ok", "getPriceInfo.ok"],
      "source": "playwright"
    }
  ]
}
```

- `routes[]`：fixture stem（相对 `fixtures/{domain}/`，可省略 `.json`）
- discover 展开为带 `matchQuery` 的 route 变体，写入 `profileRouteMap[stateId]`
- **禁止**把业务 clueId / API path 写进 Skill 源码

### 矩阵 → state 启发式（Skill 通用，无业务值）

| 前置条件关键词 | state id |
|----------------|----------|
| 无 / 缺少 clueId（或泛化 `*Id`） | `NO_CLUE` |
| info 失败 / 接口失败 / 加载失败 | `INFO_FAIL` |
| 下架失败 / confirmRecycle 失败 | `DELIST_FAIL` |
| 提交失败 / submit 失败 | `SUBMIT_FAIL` |
| info 成功 / getPriceInfo / 收车价格 | `INFO_OK` |

宿主可用 `matrixKeywords` 覆盖或补充。

## discover 写入 manifest

`discover-request-layer` 扫描 services + page API graph，写入：

```json
"mock": {
  "strategy": "inject",
  "injectFlag": "__E2E_MOCK__",
  "fixtureDir": "e2e-device/fixtures",
  "routes": [],
  "profileRouteMap": {},
  "pageApiGraph": {},
  "mockStates": {}
}
```

`fixtureDir` 统一为宿主 `e2e-device/fixtures`（不再默认 `sandbox/fixtures`）。

## inject 规则匹配

- 默认：URL 子串 `urlPattern` + `method`
- 可选：`matchQuery`（如 `clueId=702485501`）——多状态时优先匹配带 query 的规则
- `loadMockRulesFromManifest(profile)` 只加载 `profileRouteMap[profile]` 中的 route ids

## 可选：项目 bmock

若 discover 识别到 `src/utils/bmock`，可在项目内深链 `__MOCK__` 或同步 fixture 到 bmock。**非** device E2E 默认路径。

## Native HTTP Client 场景（重要）

inject mock (`web-request-mock.js`) **仅拦截 WebView 内的 JS 层 fetch/XHR**。如果宿主 App 使用以下 Native HTTP 库发请求，mock 不会生效：

| 技术栈 | 库 | inject mock 是否生效 |
|---------|-----|---------------------|
| Android | OkHttp / Retrofit | ❌ 不生效 |
| Android | Volley | ❌ 不生效 |
| iOS | URLSession / Alamofire | ❌ 不生效 |
| H5 (WebView) | fetch / XMLHttpRequest | ✅ 生效 |
| React Native | fetch (JS 层) | ✅ 部分生效 |

**诊断方式**：
- `discover-request-layer` 会扫描项目源码中是否存在 `okhttp`、`retrofit` 引用
- 若检测到 Native HTTP 客户端，preflight 输出 warn 提示 mock 范围受限
- 用户可通过 `E2E_NATIVE_HTTP_DETECTED=1` 确认已知此限制

**解决方案**：
- 方案 A（推荐）：确保被测 H5 页面的 API 调用全部走 WebView JS 层
- 方案 B：在 `mock.routes` 中标记 `layer: "native"`，由宿主 App 提供 bmock 拦截
- 方案 C：使用 Whistle / Mitmproxy 在 L0 代理层拦截（非默认，需用户自行配置）

## SSL / Certificate Pinning

若 App 启用了 SSL Pinning（证书固定），即使 inject mock 在 HTTP 层生效，原生网络栈的 HTTPS 请求也可能被拦截。

**处理策略**：
- **Debug 构建**：确保 App 的 Debug variant 禁用了 SSL Pinning（常见实践）
- **Release 构建**：不建议用于 E2E 测试；建议使用 Debug 构建
- **WebView HTTPS**：inject mock 在 JS 层拦截请求，不经过 SSL 校验，不受 pinning 影响
- **Native HTTPS**：若 App 使用 Native HTTP Client + SSL Pinning，需：
  1. 在 `network_security_config.xml` 中为 debug 构建添加例外
  2. 或使用 Frida / objection 在运行时绕过 SSL Pinning

preflight 不会自动检测 SSL Pinning 状态（需 App 源码配合）。若怀疑 pinning 导致请求失败，
查看 `adb logcat` 中是否有 `javax.net.ssl.SSLPeerUnverifiedException` 或类似错误。

## 不在本 Skill 范围（v1）

- **Native 直连 API**（不经 WebView）：不纳入通用 mock 主方案
- **L0 代理**（Whistle / Charles）：仅作 FAQ 兜底
- 地图 geo / 围栏多状态、完整 TS AST、跨仓 mock-server

## 禁止

- Skill 正文写死 API path、域名、业务 domain、业务 clueId
- 默认要求用户配置 Whistle 才能跑通韧性用例
- inject 脚本内嵌业务 fixture JSON
