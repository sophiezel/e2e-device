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

## 不在本 Skill 范围

- **Native 直连 API**（不经 WebView）：不纳入通用 mock 主方案
- **L0 代理**（Whistle / Charles）：仅作 FAQ 兜底；见各仓 `e2e-device/README.md` 的 `E2E_DATA_MODE=mock` 说明

## 禁止

- Skill 正文写死 API path、域名、业务 domain
- 默认要求用户配置 Whistle 才能跑通韧性用例
