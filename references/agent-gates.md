<!-- 触发条件: probe-env 返回 blockers 或鉴权恢复时按需加载（勿全文预载） -->
# Agent 交互门禁

Skill 负责话术与等待闭环；脚本只输出 `blockers[]` / 安装结果，**不在 shell 里 sleep**。

**唯一入口**：`bash scripts/run.sh --project <path>`（先 `--plan-only` 再执行）。  
`assets/scaffold/scripts/init.sh` 为 **LEGACY**，勿引导用户使用。

## adb 门禁

1. 调用 `cli.ts probe-env`（经 `run.sh` auto-heal / 或 `ts-node .../cli.ts probe-env`）
2. 若 `blockers` 含 `adb_no_device` / `adb_unauthorized`（或预检映射的 adb 类 id）：
   - **禁止**向用户罗列裸命令清单
   - 说明：插好 USB、手机上点「允许 USB 调试」
   - 等待用户回复 **「已连接」** 后重新 probe
3. 无 adb blocker 后再进入 Appium / 跑测

| blocker id（与 probe-env 对齐） | 用户侧动作 |
|------------|------------|
| `adb_no_device` | 插线 + 授权；确认 `adb devices` 为 `device` |
| `adb_unauthorized` | 手机上重新允许 USB 调试 |
| `chromedriver_mismatch` | 等 preflight 下载匹配驱动或设 `E2E_CHROMEDRIVER_PATH` |
| `android_sdk_incomplete` / `android_sdk_missing` | 见 Android SDK 门禁 |

## Android SDK 门禁

1. `probe-env` 含 `android_sdk_missing` / `android_sdk_incomplete` 时先自动检测常见路径（见 [android-sdk-setup.md](./android-sdk-setup.md)）
2. 检测到有效路径 → 写入 `$E2E_HOME/projects/{hash}/manifest.json` env 键 → 重 probe
3. 未检测到 → AskQuestion 安装（5s 默认同意）→ `cli.ts install-android-sdk`
4. 完成后用户可回复 **「SDK 已配置」**

## 预检阻断项

预检由 `run.sh` 内联 + `cli.ts preflight` 完成（**勿**再单独依赖 `preflight-extended.sh`；该脚本为可选手工诊断工具）。

| blocker id | severity | Agent 动作 |
|------------|----------|------------|
| `chromedriver_mismatch` | warn/fail | 重 probe；仍 fail → 引导匹配 chromedriver 到 `~/.appium/chromedriver/` |
| `preflight_page_origin` / pageOrigin 警告 | warn | `list-preconfig` → 确认 `E2E_PAGE_ORIGIN`（勿用 API 域） |
| `preconfig_unconfirmed` | fail | 见前置配置门禁 |
| `preflight_app_launch` | fail | 确认测试包 / deeplink scheme / App 已安装 |

## Appium 门禁

1. `appium_missing`（含 driver 未就绪时的映射）：说明将在 **Skill runtime**（`scripts/node_modules`）安装，**非**宿主仓
2. AskQuestion 或 5s 默认同意 → `cli.ts install-appium` 或重跑 `run.sh`
3. 仅 `E2E_APPIUM_GLOBAL=1` 时才尝试全局安装

## 前置配置确认门禁

1. `bash scripts/list-preconfig.sh --project <path>`
2. 读 `quickPathEligible`：
   - **true** 且三项 env 已齐 → **跳过 AskQuestion**，摘要展示 effective
   - **false** → AskQuestion 确认 pageOrigin / appPackage / domain
3. export `E2E_PAGE_ORIGIN` + `E2E_APP_PACKAGE` + `E2E_DOMAIN`
4. `run.sh` 缺任一 → `preconfig_unconfirmed`（exit 1）

| blocker id | 动作 |
|------------|------|
| `preconfig_unconfirmed` | list-preconfig → 确认 → export → 再 run |
| `page_origin_probe_wrong` | 以用户确认的 `E2E_PAGE_ORIGIN` 为准 |
| `app_package_ambiguous` | 多包并存时必须用户选择或设置 `E2E_APP_PACKAGE` |

## 测试计划确认

脚本**不**交互。Agent MUST：

1. `run.sh --plan-only`
2. 列出 case 与 mode 耗时估算
3. AskQuestion：standard（默认）/ q=quick / r=resilience
4. 用户确认后再跑（去掉 `--plan-only`）

## 测试执行

- 一次性 `run.sh`（Journey 分段）
- 进度：`progress.jsonl` 尾部摘要；**禁止**每 case TodoWrite / 渲染完整面板
- **禁止** Agent 自行逐 case shell 循环

## AUTH_RECOVERY

1. 读 `artifacts/auth-recovery.json` 或 exit 42
2. **禁止** AskQuestion 回显密码；引导用户在本机终端自行：

   ```bash
   export E2E_ACCOUNT=...   # 用户本地输入，勿贴进对话
   export E2E_PASSWORD=...
   ```

3. `bash scripts/run.sh --project <path> --mode standard` 续跑
4. **禁止** mock 绕过鉴权

## 凭据安全

- 仅允许：进程环境变量 / CI secret
- **禁止**：`credentials.json`、`.e2e-local.json` 存密码、对话明文密码
- 日志脱敏：账号 `xx***yy`，密码 `****`（见 `helpers/credentials.ts` 的 `maskAccount` / `maskPassword`）
- Keychain Blind Relay：**目标态**（见 ADR-0003）；当前未实现，勿宣称已落地

## 依赖分层

| 层级 | 位置 | 安装 |
|------|------|------|
| Skill 运行时 (wdio/appium/ts-node) | `~/.agents/skills/e2e-device/scripts/node_modules` | `ensure-skill-runtime.sh` |
| 宿主仓 | **不安装** E2E 依赖 | — |

## 首跑问卷

仅当 `probe-env` 返回 `questions[].required === true`：

| id | 处理 |
|----|------|
| `E2E_PAGE_ORIGIN` | export `E2E_PAGE_ORIGIN`（主名）；别名 `E2E_H5_ORIGIN` 兼容 |
| `E2E_API_ORIGIN` | 可选 |
| `E2E_DEVICE_SERIAL` | 多设备时 |
| `E2E_CREDENTIALS` | 用户本机 export；禁止写入文件 / 禁止贴进对话 |

二跑：`initialized === true` 且无 blockers → 禁止重复首跑问卷；三元组走 Quick Path 规则。
