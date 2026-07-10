<!-- 触发条件: 配置环境变量、排查环境问题、启用高级功能时按需加载 -->

# 环境变量速查

## Skill 级（跨项目通用）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `E2E_HOME` | `~/.e2e-device` | **产物根目录** (统一管理所有生成文件) |
| `E2E_AUTO_HEAL` | `1` | 启动时自动修复依赖问题 (0 关闭) |
| `E2E_DEVICE_SKILL_ROOT` | `~/.agents/skills/e2e-device` | Skill 根目录 |
| `E2E_AUTO_INSTALL_SKILL_RUNTIME` | `1` | 缺编排依赖时 Skill 目录 npm install |
| `E2E_AUTO_INSTALL_DEPS` | `1` | 缺 wdio 时宿主仓自动安装 |
| `E2E_PLATFORM` | `android` | 目标平台 (`android` / `ios` (预留)) |
| `E2E_ANDROID_API_LEVEL` | `34` | 自动安装 SDK 时的 API level |
| `E2E_ANDROID_BUILD_TOOLS` | `34.0.0` | 自动安装 build-tools 版本 |

## 凭据与域名

| 变量 | 说明 |
|------|------|
| `E2E_ACCOUNT` | 登录账号（禁止写入文件/报告） |
| `E2E_PASSWORD` | 登录密码（禁止写入文件/报告） |
| `E2E_PAGE_ORIGIN` | **跑测三元组**：H5 部署基址（用户确认后必设；`run.sh` 缺则 `preconfig_unconfirmed`） |
| `E2E_H5_ORIGIN` | 同 `E2E_PAGE_ORIGIN` 别名（二者任一即可） |
| `E2E_API_ORIGIN` | 覆盖 manifest apiOrigin（≠ pageOrigin） |
| `E2E_DOMAIN` | **跑测三元组**：主测 domain（或 `--domain`；缺则阻断） |
| `E2E_APP_PACKAGE` | **跑测三元组**：目标 Hybrid App 包名（缺则阻断） |
| `E2E_PILOT_DOMAIN` | 兼容别名，discover 推断用；跑测以 `E2E_DOMAIN` 为准 |

## 测试执行控制

| 变量 | 说明 |
|------|------|
| `E2E_SEQUENTIAL_BATCH` | `1` 批量模式（Journey 分段为默认，见下） |
| `E2E_SEQUENTIAL_INDIVIDUAL` | `1` 逐 spec 独立 wdio 进程（26-worker 调试 bisect） |
| `E2E_SUITE_LEGACY` | `1` 回退单文件 `__suite__` / bulk glob 模式 |
| `E2E_JOURNEY_SEGMENT` | 当前 Journey 段：`env` / `list` / `form` / `infra` / `chaos`（wdio 内部） |
| `E2E_JOURNEY_SPEC` | 当前段 entry spec 绝对路径（`__journey_{segment}__.spec.ts`） |
| `E2E_WARM_SESSION` | `1` form/list 段 warm 超时（domReady 12s / webview 10s / deeplink 1s） |
| `E2E_JOURNEY_FORCE_ENTRY` | `1` infra/chaos 段强制冷入口 |
| `E2E_FORM_MODULE` | form 段目标 pageModule（如 `evaluateRecovery`） |
| `E2E_SESSION_RESET_INTERVAL` | form/list 段每隔 N case reloadSession（默认 12） |
| `E2E_USER_INTENT` | 自然语言意图 → discover-intent |
| `E2E_INTENT_USE_GIT_DIFF` | `1` 用 git-diff 覆盖 manifest pilot |
| `E2E_PILOT_DOMAIN` | 指定试点 domain |
| `E2E_L1_ONLY` | `1` 仅 bootstrap，不强制 mock.routes |
| `E2E_RUN_ID` | 指定 run ID（不指定则自动生成） |
| `E2E_CURRENT_SPEC` | 当前执行 spec 路径（wdio 内部使用） |

## Mock 相关

| 变量 | 说明 |
|------|------|
| `E2E_ENABLE_WEB_MOCK` | `1` 启用 WebView inject mock（与 `E2E_DATA_MODE=mock` 任一即可） |
| `E2E_ENABLE_BRIDGE_MOCK` | `1` 启用 JSBridge 调用拦截 |
| `E2E_DATA_MODE` | `test` / `mock`（`mock` 时同样启用 inject） |
| `E2E_MOCK_PROFILE` | mock profile / state id（如 `INFO_OK`、`INFO_FAIL`；对应 `profileRouteMap`） |
| `E2E_PAGE_QUERY` | DeepLink / H5 URL 额外 query（如 `clueId=702485526`；也可由 case metadata `query` 注入） |
| `E2E_MOCK_LAYER` | mock 层次标记（内部使用，如 `inject`） |
| `E2E_LEGACY_FIXTURE_MAP` | `1` 回退试点 fixture-map |
| `E2E_NETWORK_LATENCY_MS` | mock 响应延迟模拟（毫秒） |

## 韧性

| 变量 | 说明 |
|------|------|
| `E2E_RESILIENCE` | `1` 启用韧性层（默认） |
| `E2E_RESILIENCE_AUTOFIX_SRC` | `0` 禁用 auto-fix 源码修改 |

## 厂商适配（内部自动设置）

| 变量 | 说明 |
|------|------|
| `E2E_VENDOR_WEBVIEW_POLL_EXTRA_MS` | WebView 检测额外轮询间隔 |
| `E2E_VENDOR_FORCE_NATIVE_RESET` | `1` 强制 NATIVE_APP 切换 |
| `E2E_VENDOR_DOM_READY_FACTOR` | DOM 就绪超时倍率 |
| `E2E_VENDOR_AVOID_CDP` | `1` 避免 CDP 操作 |

## 性能与诊断

| 变量 | 说明 |
|------|------|
| `E2E_PERF_THRESHOLD_FCP_MS` | FCP 超标阈值（不设则不告警） |
| `E2E_DEBUG` | `1` 打印调试日志 |
| `E2E_LOG_DIR` | 结构化日志输出目录 |
| `E2E_DOM_READY_MARKERS` | WebView DOM 就绪标记（逗号分隔） |

## 高级功能开关

| 变量 | 说明 |
|------|------|
| `E2E_COVERAGE_DETECTED` | `1` 已探测到 WebView 中含有 Istanbul 覆盖率数据（内部自动设置） |
| `E2E_VISUAL_DIFF` | `1` 启用视觉回归截图对比 |
| `E2E_VISUAL_DIFF_THRESHOLD` | pixel diff 阈值百分比（默认 0） |
| `E2E_VISUAL_DIFF_ENGINE` | pixel diff 引擎 (`pixelmatch`) |
| `E2E_FLAKY_THRESHOLD_LOW` | Flaky 检测低阈值（默认 0.2） |
| `E2E_FLAKY_THRESHOLD_HIGH` | Flaky 检测高阈值（默认 0.8） |
| `E2E_CLEAR_SHARED_PREFS` | `1` spec 间清除 SharedPreferences |
| `E2E_APPIUM_RELAXED_SECURITY` | `1` 禁用 Appium 安全检查 |
| `E2E_APPIUM_BIN` | 指定 appium 二进制路径 |
| `E2E_APPIUM_GLOBAL` | `1` 尝试全局 npm i -g appium |

## App 构建

| 变量 | 说明 |
|------|------|
| `E2E_APP_PACKAGE` | **跑测三元组**：目标 Hybrid App 包名（与上方「凭据与域名」表一致；`run.sh` 注入 deeplink `-p`） |
| `E2E_NATIVE_HTTP_DETECTED` | `1` 已知 Native HTTP Client 限制 |
