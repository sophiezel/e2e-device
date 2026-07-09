# Hybrid 契约

所有项目差异写入 `$E2E_HOME/projects/{hash}/manifest.json`（由 discover 生成）。

## 字段说明

| 键 | 含义 |
|----|------|
| `hybrid.container.package` | Android App package |
| `hybrid.webView.pathPrefix` | H5 在 CDN 上的 path 前缀（Skill 内不得写死全局常量） |
| `hybrid.webView.webViewUrlAnchor` | 匹配 WebView URL 的子串 |
| `hybrid.deepLink.scheme` | Native deep link scheme |
| `hybrid.network.pageOrigin` | 页面 CDN origin |
| `hybrid.network.apiOrigin` | API origin |

## WebView 切换

测试调用 `switchToWebViewContaining(anchor)`，`anchor` 解析顺序：

1. 环境变量 `E2E_WEBVIEW_URL_ANCHOR`
2. `skill.project.json` → `hybrid.webView.webViewUrlAnchor`
3. 由 `pathPrefix` + `pilot.domain` 计算

## mock（manifest）

| 键 | 含义 |
|----|------|
| `mock.strategy` | 默认 `inject` |
| `mock.injectFlag` | 深链 query，如 `__E2E_MOCK__` |
| `mock.fixtureDir` | 相对仓库根的 fixture 目录（约定：`e2e-device/fixtures`） |
| `mock.routes` | `{ path, method?, query?, fixture }[]` |

详见 [mock-strategies.md](mock-strategies.md)。

## archive 中的 Hybrid 证据

跑测结束后须填充 `sections.hybridEvidence.webviewAnchor`、`dataMode`，Mock 时 `mockLayer: "inject"`。
