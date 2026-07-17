# Hybrid 契约

所有项目差异写入 `$E2E_HOME/projects/{hash}/manifest.json`（由 `discover-project` 生成）。  
沙箱内可能有指向该文件的 `skill.project.json` 符号链接——**权威源是 E2E_HOME manifest**。

## 字段说明

| 键 | 含义 |
|----|------|
| `hybrid.container.package` | Android App package |
| `hybrid.webView.pathPrefix` | H5 CDN path 前缀（Skill 内不得写死） |
| `hybrid.webView.webViewUrlAnchor` | 匹配 WebView URL 的子串 |
| `hybrid.deepLink.scheme` | Native deep link scheme |
| `hybrid.network.pageOrigin` | 页面 CDN origin（主配置；env: `E2E_PAGE_ORIGIN`） |
| `hybrid.network.apiOrigin` | API origin |

## WebView context 硬规则

- 匹配：**仅** `contextName.startsWith('WEBVIEW')`，禁止精确全名（厂商/版本后缀不同）
- URL 锚点失败默认**不** fallback 到任意 WebView（`allowEmptyUrlMatch` 默认 false；仅 `E2E_ALLOW_EMPTY_WEBVIEW_URL=1` 或 resilience 可开）
- 切换前：等待 WebView 进程出现 + 页面 load（ExplicitWait）
- 切换失败：先回 `NATIVE_APP` → 再列 contexts → 重试；仍失败归 **L1**
- OEM 弹窗：选择器点击「允许/同意」等，**禁止**盲目 `browser.back()`

## Anchor 解析顺序

测试调用 `switchToWebViewContaining(anchor)`：

1. `E2E_WEBVIEW_URL_ANCHOR`
2. manifest `hybrid.webView.webViewUrlAnchor`
3. 由 `pathPrefix` + `pilot.domain` 计算

## NATIVE ↔ WEBVIEW 时序

```
ensurePilotEntry / deeplink
  → NATIVE 处理权限/OEM（若有）
  → 等待 WEBVIEW_* 出现
  → switchToWebViewContaining(anchor)
  → waitForH5Selector(入口锚点)
  → case 操作
  → hideKeyboard + expertReset / returnToPilotAnchor
```

禁止在 WEBVIEW 未就绪时点 H5；禁止用 Playwright 替代本链路。

## OEM / 厂商弹窗（L0）

华为/小米/OPPO/VIVO 等可能打断首启：权限、电池、「仍要打开」。  
策略：预授权 `pm grant` + 检测弹窗点允许；失败则记录 L0，不归咎 L2 业务。

## mock（manifest）

| 键 | 含义 |
|----|------|
| `mock.strategy` | 默认 `inject` |
| `mock.injectFlag` | 深链 query，如 `__E2E_MOCK__` |
| `mock.fixtureDir` | 相对仓库根（约定 `e2e-device/fixtures`） |
| `mock.routes` | `{ path, method?, query?, fixture }[]` |

详见 [mock-strategies.md](mock-strategies.md)。Auth 失败禁止用 mock 绕过。

## archive 证据

跑测结束后填充 `sections.hybridEvidence.webviewAnchor`、`dataMode`；Mock 时 `mockLayer: "inject"`。

## 失败树（摘要）

| 症状 | 层 | 见 |
|------|----|----|
| 无 WEBVIEW context | L1 | 上文 context 规则 |
| URL host 与 pageOrigin 不符 | L1 | `E2E_PAGE_ORIGIN` |
| 白屏但 context 正常 | L2 | failure-triage |
| 登录墙 | L0 | AUTH_RECOVERY |
