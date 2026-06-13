<!-- 触发条件: mock 配置 / fixture 问题 / E2E_DATA_MODE / SSL pinning 相关时加载 -->
# Mock 策略

## 默认：WebView inject

- 策略名：`inject`
- 脚本：`e2e-device/inject/web-request-mock.js`
- 启用：`enable-web-mock`（`browser.execute` 注入规则 + IIFE）
- 规则来源：`e2e-device/resilience/fixture-map.ts` + `e2e-device/fixtures/**`
- 深链可选：`__E2E_MOCK__=1`（`E2E_ENABLE_WEB_MOCK=1` 或 `E2E_DATA_MODE=mock`）
- 韧性层：`emptyData` / `backendError` → live → auto-fix → **inject 重试** → `pass_with_mock`
- 归档：`hybridEvidence.mockLayer: "inject"`

`cdp-mock.ts` 仅为历史文件名，内部调用 inject，**不**依赖 Chrome DevTools `browser.mock`。

## discover 写入 manifest

`discover-request-layer` 扫描 `src/**/request`、services，写入 `skill.project.json` → `mock.routes[]`：

```json
"mock": {
  "strategy": "inject",
  "injectFlag": "__E2E_MOCK__",
  "fixtureDir": "e2e-device/fixtures",
  "routes": []
}
```

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

## 不在本 Skill 范围

- **Native 直连 API**（不经 WebView）：不纳入通用 mock 主方案
- **L0 代理**（Whistle / Charles）：仅作 FAQ 兜底；见各仓 `e2e-device/README.md` 的 `E2E_DATA_MODE=mock` 说明

## 禁止

- Skill 正文写死 API path、域名、业务 domain
- 默认要求用户配置 Whistle 才能跑通韧性用例
