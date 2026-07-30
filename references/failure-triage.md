<!-- 触发条件: 有失败 case 或存在 diagnose-request.json 时 MANDATORY 加载 -->
# 失败分诊（L0 / L1 / L2）

## 诊断闭环（v2 真源）

脚本**不**自动 spawn LLM。失败后写入：

1. `diagnose-request.json` — 失败 case 列表
2. `diagnosis.json` — **规则预填** rootCause（L0/L1/L2）

报告「失败诊断」节会嵌入预填结果。

Agent **MUST**：

1. 先读报告诊断节 / `diagnosis.json`
2. **仅**对 `unknown` 或难判 L2 深挖：截图 + 错误栈 + logcat
3. 将复核结论写入用户摘要
4. **禁止**未读产物就推荐 Whistle、造数、改业务 testid

重跑入口：`bash scripts/run.sh --project <path>`（**禁止** `init.sh`）。

---

## L0 — Native 容器

| 现象 / rootCause | 动作 |
|------------------|------|
| USB / adb offline | 等「已连接」→ 重 probe |
| 未登录 / `authRequired` | 读 `auth-recovery.json`；用户本机 `export E2E_ACCOUNT/PASSWORD`（禁止对话明文）；`ensureLoggedIn`；重跑；**禁止 mock** |
| 权限 / OEM 弹窗 | 预授权或手动点允许；见 vendor workaround |
| WebView 调试关闭 | 换 debug 包；硬前置 |
| App 未启动 / `preflight_app_launch` | 确认 `E2E_APP_PACKAGE` + scheme |

## L1 — Hybrid 通道

| 现象 / rootCause | 动作 |
|------------------|------|
| `page_host_mismatch` / `PAGE_ORIGIN_UNKNOWN` | 以 `E2E_PAGE_ORIGIN` 为准；重 discover / 确认三元组 |
| context 切换失败 | 见 [hybrid-contract.md](hybrid-contract.md)；`startsWith('WEBVIEW')`；等页面就绪 |
| chromedriver 不匹配 | preflight 自动下载；仍失败则手动对齐版本 |
| 深链格式错 | 核对 `hybrid.deepLink.scheme` |
| `list_dom_missing_after_back` | 避免破坏 SPA 栈的 adb BACK；retry 用 `skipAdbBack` |
| `L1_spec_invalid` — `invalid selector` / `Unsupported CSS selector` | 生成器输出了 UiAutomator2 不支持的逗号复合选择器；检查 `GENERATOR_VERSION` 是否过期 → 清 case-cache → regen spec |

## L2 — 业务 H5

| 现象 / rootCause | 动作 |
|------------------|------|
| `emptyData` / `backendError` | 确认 mock：`E2E_ENABLE_WEB_MOCK=1` + fixtures |
| `paramError` | list→detail URL query / autofix |
| 白屏 / JS 错误 | logcat + WebView console；业务缺陷只记录不改代码 |
| bridgeToken / Native 已登但 API 401 | 提示重登 App；不要 inject |

原则：**L2 问题不用 L0 代理顶替**；auth 禁止 inject mock 绕过。

---

## 产物解读清单

对每个 `failedCaseId`：

1. `screenshots/{caseId}.png`（或近似名）
2. `logs/{caseId}.log` / Appium log / logcat 错误行
3. `cases-executed.jsonl` 中该 case 的 error / status
4. Journey 段：`journey-meta.json` 是否整段 partial

## Sequential / Journey 注意

- Journey 为默认；`E2E_SEQUENTIAL_INDIVIDUAL=1` 为调试回退
- ledger：`markRunStarted` 仅在 `archive-start` 一次；不得清空

## 安全

凭据不得出现在 resilience-report、cases-executed.jsonl、诊断摘要、对话中。
