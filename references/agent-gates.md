<!-- 触发条件: 始终加载（门禁话术，每个会话前必须读取） -->
# Agent 交互门禁

Skill 负责话术与等待闭环；脚本只输出 `blockers[]` / 安装结果，**不在 shell 里 sleep**。

## adb 门禁

1. 调用 `bash scripts/preflight-extended.sh` 或 `orch_cli probe-env --adb-only`
2. 若 `blockers` 含 `adb_missing` / `adb_no_device` / `adb_unauthorized`：
   - **禁止**向用户罗列「安装 platform-tools、执行 adb devices…」等裸命令清单
   - 用自然语言说明：请插好 USB、在手机上点「允许 USB 调试」
   - 等待用户回复 **「已连接」** 后重新 `probe-env`
3. `probe.ok === true` 且无 adb 类 blocker 后再进入 Appium / 跑测

| blocker id | 用户侧动作 |
|------------|------------|
| `adb_missing` | 本机安装 Android platform-tools（Agent 可给一条官方下载链，不列多步） |
| `adb_no_device` | 插线 + 授权 |
| `adb_unauthorized` | 手机上撤销授权后重新允许 |

## Android SDK 门禁

1. `probe-env` 若含 **`android_sdk_missing`** / **`android_sdk_incomplete`**：
   - **先执行自动检测步骤**（见下方），确认 SDK 是否确实缺失；**禁止**直接问用户「是否已安装」

### 自动检测步骤

在询问用户之前，Agent **必须**按以下顺序自动检测 Android SDK：

```bash
# 1. 检查环境变量
if [ -n "$ANDROID_HOME" ] && [ -d "$ANDROID_HOME/platforms" ]; then
  echo "FOUND: ANDROID_HOME=$ANDROID_HOME"
fi

# 2. 检查常见 SDK 路径
for dir in \
  "$HOME/Library/Android/sdk" \
  "$HOME/Android/Sdk" \
  "/usr/local/lib/android/sdk" \
  "/opt/android-sdk"; do
  [ -d "$dir/platforms" ] && [ -d "$dir/build-tools" ] && echo "FOUND: $dir"
done

# 3. 检查 Homebrew 安装 (macOS)
if command -v brew &>/dev/null; then
  BREW_PREFIX=$(brew --prefix 2>/dev/null)
  [ -d "$BREW_PREFIX/share/android-commandlinetools/platforms" ] && \
    echo "FOUND: $BREW_PREFIX/share/android-commandlinetools"
fi

# 4. 检查 Apple Silicon 默认 Homebrew 路径
[ -d "/opt/homebrew/share/android-commandlinetools/platforms" ] && \
  echo "FOUND: /opt/homebrew/share/android-commandlinetools"
```

- **若检测到有效 SDK 路径**：自动设置环境变量并写入 `$E2E_HOME/projects/{hash}/manifest.json`（env 键），然后重新 `probe-env`
- **若检测到 SDK 但缺少组件**（`android_sdk_incomplete`）：用 `sdkmanager` 自动补装 `platforms` + `build-tools`，无需询问用户
- **若完全未检测到**：进入安装流程

### 安装流程（自动检测失败后）

- **macOS 且已装 Homebrew**：说明将用 Homebrew 安装 commandlinetools + 必要组件；**AskQuestion** 是否现在安装，或 **5 秒后默认同意**；同意后执行 `bash scripts/run.sh (自动触发)` 或 `orch_cli install-android-sdk`。
- **安装失败或非 macOS**：引导 [android-sdk-setup.md](./android-sdk-setup.md) 手动安装（Android Studio 或官方 CLI）。
- **禁止**长串裸 `sdkmanager` 清单；自动安装失败时再给 1～2 条手动兜底。
- 完成后重新 `probe-env`；用户也可回复 **「SDK 已配置」**。
- 安装成功会把 `ANDROID_HOME` 写入 `$E2E_HOME/projects/{hash}/manifest.json`（非敏感键）。

| blocker id | 用户侧动作 |
|------------|------------|
| `android_sdk_missing` | 安装 Android Studio SDK，设置 `ANDROID_HOME` / `ANDROID_SDK_ROOT` |
| `android_sdk_incomplete` | 在 SDK Manager 补装 Platform + Build-Tools |

## 预检阻断项

`probe-env` 还会输出以 `preflight_` 为前缀的阻断项，来自系统预检（preflight-check）。
这些项大部分会被 preflight 自动修复（如 chromedriver 自动下载），Agent 仅需在**修复失败时**介入。

| blocker id | severity | 含义 | Agent 动作 |
|------------|----------|------|------------|
| `preflight_vendor_webview` | warn / fail | 设备厂商 WebView 兼容性 或 chromedriver 版本不匹配 | ① preflight-check 已尝试自动下载匹配的 chromedriver。② 直接重新 `probe-env`，多数情况下自动修复会生效。③ 若仍为 fail：告知用户 WebView Chrome 版本与 chromedriver 不匹配，引导安装对应版本 `chromedriver` 到 `~/.appium/chromedriver/` |
| `preflight_page_origin` | warn / fail | E2E_PAGE_ORIGIN 未配置或页面不可达 | ① 若用户已有部署域名 → `export E2E_PAGE_ORIGIN=<域名>` 后重新 `probe-env`。② 若未提供 → 走 `E2E_PAGE_ORIGIN` 问题流程（见 SKILL.md 主决策树），引导用户输入 H5 部署域名 |

## Appium 门禁

1. `probe-env` 若含 `appium_missing` / `uiautomator2_driver_missing`：
   - 说明将**在项目内**安装 Appium 与 uiautomator2 driver（`yarn` + `npx appium driver install`）
   - **AskQuestion**：是否现在安装？或告知 **5 秒后默认同意**（由 Agent 计时，脚本不 sleep）
2. 用户同意后：`orch_cli install-appium` 或 `bash scripts/run.sh (自动触发)`
3. 失败时等待用户回复 **「安装完毕」** 再重 probe
4. 仅当 `E2E_APPIUM_GLOBAL=1` 时才尝试全局 `npm i -g`（非默认）

## 测试计划确认

2. Agent **列出全部 case 清单并按模式分层**，向用户说明各模式覆盖范围：

   ```
   📋 exampleFeature 测试计划（共 78 用例）
   
   🟡 标准模式 (standard) —— 默认，全部业务 + Hybrid + infra，约 40 分钟
   🟢 快速模式 (quick) —— 仅首条业务 + P0 infra，约 15 分钟
   🔴 全量模式 (resilience) —— 全部用例 + 混沌测试，约 60 分钟
   ```

3. Agent **AskQuestion**：「确认开始 standard 模式（N 用例，约 X 分钟）？输入 q=quick / r=resilience」
4. 用户无响应 → **10 秒后默认 standard 模式**并开始
5. 模式优先级: 用户输入 > E2E_RUN_PROFILE env > --mode arg > standard（默认）

## 跑测中进度（强制）

Agent **必须逐 case 执行并实时反馈**，不可只等 `init.sh` 跑完。

### 执行流程

**1. 前置准备**
```bash
# 确保环境无 blocker
orch_cli probe-env
# 背景启动 Appium
nohup npx appium --port 4723 > /tmp/e2e-appium.log 2>&1 &
sleep 5 && curl -s http://127.0.0.1:4723/status
# 创建归档
RUN_ID=$(orch_cli archive-start '{}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).runId))")
export E2E_RUN_ID="$RUN_ID"
```

**2. 逐条执行**
```bash
# 读取所有 case（含中文描述）
cases=$(node -e "
  const r = # v2: case-registry 在 sandbox 中;
  r.cases.forEach(c => 
    console.log(c.id + '|' + (c.metadata?.description || c.name || c.id))
  )
")

# 逐条执行并更新进度（每行必须含中文描述）
i=1; N=$(echo "$cases" | wc -l | tr -d ' ')
for case in $cases; do
  id="${case%%|*}"
  desc="${case#*|}"
  spec=$(node -e "const r=# v2: case-registry 在 sandbox 中;console.log(r.cases.find(c=>c.id==='$id')?.spec||'')")
  
  echo "[$i/$N] $desc ($id) ⏳ 执行中..."
  
  export E2E_CURRENT_SPEC="$spec"
  # v2: wdio 在 E2E_HOME sandbox 中执行 --spec "$spec" 2>&1 | tail -5
  
  if [ $? -eq 0 ]; then
    echo "[$i/$N] $desc ($id) ✅ passed"
  else
    echo "[$i/$N] $desc ($id) ❌ failed"
    echo "原因: （从 wdio 输出提取错误摘要）"
  fi
  i=$((i+1))
done
```

**3. 每 case 完成后立即反馈**
- ✅ passed: `[i/N] <中文描述> (<caseId>) ✅ passed (<耗时>)`
- ❌ failed: `[i/N] <中文描述> (<caseId>) ❌ failed (<耗时>)` + 错误原因 + 复现 + 建议
- **禁止**只输出 caseId 不输出中文描述

### 进度反馈格式

**执行前打印 TODO 清单**（由 `run-sequential.ts` 自动生成）：
```
📋 测试执行清单 (78 用例)
════════════════════════════════════════════════════════════════════════
  [ ]   1  打开页面                                    (exampleFeature.C01)  ~12s
  [ ]   2  打开 ?clueId=                               (exampleFeature.C02)  ~15s
  [ ]   3  生命周期测试（冷启动、WebView重建）           (exampleFeature.hybrid.lifecycle) ~30s
  ...
════════════════════════════════════════════════════════════════════════
⏳ 预计总耗时: ~30min  |  批量 Session 模式
```

**批量模式（默认）**：所有 spec 单次 wdio 调用，Session 创建一次，内部按 `E2E_SESSION_RESET_INTERVAL=15` 分批重置。
设置 `E2E_SEQUENTIAL_INDIVIDUAL=1` 回退逐 spec 模式。

**逐 spec 模式**每行格式：`[i/N] <进度条> <中文描述> (<caseId>) — <结果>`

```
[1/78] ██░░░░░░░░░░░░░░░░  打开页面 (exampleFeature.C01) ⏳ 执行中...
[1/78] ██░░░░░░░░░░░░░░░░  打开页面 (exampleFeature.C01) ✅ passed (12.5s)

[2/78] ███░░░░░░░░░░░░░░░  打开 ?clueId= (exampleFeature.C02) ⏳ 执行中...
[2/78] ███░░░░░░░░░░░░░░░  打开 ?clueId= (exampleFeature.C02) ✅ passed (15.3s)

[3/78] ████░░░░░░░░░░░░░░  生命周期测试（冷启动、WebView重建） (exampleFeature.hybrid.lifecycle) ⏳ 执行中...
⏳ 仍在执行... (已耗时 90s)  ← 长时间执行心跳
[3/78] ████░░░░░░░░░░░░░░  生命周期测试（冷启动、WebView重建） (exampleFeature.hybrid.lifecycle) ✅ passed (219s)

═══════════════════════════════════════════
  执行完成: ✅ 75 passed  |  ❌ 1 failed  |  ⏭  2 skipped
  总耗时: 1580s
═══════════════════════════════════════════
```

**鉴权跳过示例**:
```
[15/78] ██████░░░░░░░░░░░░  需要登录的用例 (exampleFeature.C15) ⏳ 执行中...
🔐 需要登录，无凭据。30s 内输入 E2E_ACCOUNT/E2E_PASSWORD，超时自动跳过...
⏰ 30s 超时，跳过此 case。
[15/78] ██████░░░░░░░░░░░░  需要登录的用例 (exampleFeature.C15) ⏭  跳过 (skipped_auth)
```

**失败示例**:
```
[2/3] 生命周期测试 (exampleFeature.hybrid.lifecycle) ❌ failed (25s)
原因: No chromedriver found for Chrome 138
🔄 复现: vivo WebView 138 → 切换 WebView context 时 chromedriver 版本不匹配
🔧 建议: export E2E_CHROMEDRIVER_PATH=<path>
```

**禁止**只输出 caseId（如 `exampleFeature.C15`），必须附带中文描述。

## 首跑 vs 二跑

| 场景 | AskQuestion |
|------|-------------|
| `initialized !== true` | 最多 1～2 问（参见本文档「首跑 / 恢复问卷」章节） |
| `initialized === true` 且无 blockers | **禁止首跑问卷** |
| `auth-recovery.json` 或 exit `42` | **AUTH_RECOVERY**：AskQuestion 凭据（仅 env）→ sequential 重跑失败 case |
| `page_origin_unknown` | **E2E_PAGE_ORIGIN** 单次恢复 |
| `--plan-only` | 可与 discover 并发 probe，不阻塞 discover |

## AUTH_RECOVERY（首选 sequential）

1. 读 `sandbox/artifacts/auth-recovery.json`
2. AskQuestion 账号密码 → `export E2E_ACCOUNT=... E2E_PASSWORD=...`（**禁止**写入 report/jsonl/docs）
3. `bash scripts/run.sh --project .` 从失败 case 续跑
4. 单次 `wdio` 遇 exit 42：**不要**在同一进程等待用户；续跑 registry 中失败 spec

## 报告摘要

跑测结束后 `publish-reports` 写入 `{E2E_REPORT_PATH 或 PROJECT/docs}/`。用户摘要**必须**包含 docs 路径，不只 `artifacts/runs/`。

## 凭据安全规范

- 禁止将 `E2E_ACCOUNT`、`E2E_PASSWORD`、token 或 `credentials.ts` 提交到 git。
- `.e2e-local.json` 已 gitignore；仅允许持久化非敏感 env 键。
- `sandbox/artifacts/runs/` 下 archive 须脱敏凭据与 Cookie。
- 禁止将密钥写入执行记录或 PR 正文。
- 优先使用 env；勿将示例凭据复制进可跟踪文件。

### 脱敏规则（代码层强制执行）

| 字段 | 脱敏格式 | 实现位置 |
|------|----------|----------|
| `E2E_ACCOUNT` | 前2位 + `***` + 后2位（如 `xu***44`） | `login.ts::maskAccount()` |
| `E2E_PASSWORD` | 固定 `****` | `login.ts::maskPassword()` |
| Shell 输出 | `E2E_ACCOUNT=xu***44 E2E_PASSWORD=****` | `init.sh` / `run-device-e2e.sh` |
| console.log | 使用 `maskAccount()` / `maskPassword()` | `login.ts` |

### 登录态探测（privacy-first）

- `probe-env` 先用 adb dumpsys 探测设备登录态，再决定是否索要凭据
- 若设备不在登录页 → 凭据非必须，测试中遇到鉴权 case 再 30s 交互
- 30s 超时自动跳过该 case，标记 `skipped_auth`

## 首跑 / 恢复问卷

### 依赖（不问用户）

| 层级 | 位置 | 安装 |
|------|------|------|
| 编排 discover/probe/plan | Skill `~/.agents/skills/e2e-device` | `ensure-skill-runtime.sh`（`init.sh` 开头自动调） |
| 真机 wdio 跑测 | **当前宿主仓** | `ensure-host-deps.sh wdio`（仅 `init.sh` 跑测时） |

宿主**不需要**为 plan-only 安装 `ts-node`。

### 首跑（`initialized !== true`）

仅当 `probe-env` 返回 `questions` 且 `required: true` 时提问。**顺序**：先 `E2E_PAGE_ORIGIN`（将 DeepLink 时），再 `E2E_CREDENTIALS`；或一轮 AskQuestion 两字段。

| id | 触发条件 | 处理 |
|----|----------|------|
| `E2E_PAGE_ORIGIN` | `pageOrigin` 未发现 | 写入 `E2E_H5_ORIGIN` + `.e2e-local.json`（非敏感）+ 更新 manifest |
| `E2E_API_ORIGIN` | `apiOriginConfidence: low`（可选） | 写入 `E2E_API_ORIGIN` |
| `E2E_DEVICE_SERIAL` | 多台 USB 设备 | `ANDROID_UDID` 或 `.e2e-local.json` 的 `E2E_DEVICE_SERIAL` |
| `E2E_CREDENTIALS` | 无 env / credentials.ts | 账号密码 → **仅** `export` env，禁止写入 local json |

### 二跑恢复

| id | 触发条件 | 处理 |
|----|----------|------|
| `AUTH_RECOVERY` | `artifacts/auth-recovery.json` 或 exit 42 | 凭据仅 env → `ensureLoggedIn` → `init.sh --sequential` 重跑失败 case |
| `E2E_PAGE_ORIGIN` | `page_origin_unknown` / host 不匹配 | 配置 `E2E_H5_ORIGIN` 后重 probe |

二跑：若 `initialized === true` 且无 blockers / 无 auth-recovery，**禁止**首跑问卷。

保存非敏感配置：

```bash
echo '{"env":{"E2E_H5_ORIGIN":"https://...","E2E_DEVICE_SERIAL":"..."},"initialized":true}' | # v2: 配置自动缓存至 E2E_HOME
```
