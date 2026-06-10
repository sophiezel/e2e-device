<!-- 触发条件: 始终加载（门禁话术，每个会话前必须读取） -->
# Agent 交互门禁

Skill 负责话术与等待闭环；脚本只输出 `blockers[]` / 安装结果，**不在 shell 里 sleep**。

## adb 门禁

1. 调用 `bash e2e-device/scripts/check-adb.sh` 或 `orch_cli probe-env --adb-only`
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

- **若检测到有效 SDK 路径**：自动设置环境变量并写入 `e2e-device/.e2e-local.json`（env 键），然后重新 `probe-env`
- **若检测到 SDK 但缺少组件**（`android_sdk_incomplete`）：用 `sdkmanager` 自动补装 `platforms` + `build-tools`，无需询问用户
- **若完全未检测到**：进入安装流程

### 安装流程（自动检测失败后）

- **macOS 且已装 Homebrew**：说明将用 Homebrew 安装 commandlinetools + 必要组件；**AskQuestion** 是否现在安装，或 **5 秒后默认同意**；同意后执行 `bash e2e-device/scripts/install-android-sdk.sh` 或 `orch_cli install-android-sdk`。
- **安装失败或非 macOS**：引导 [android-sdk-setup.md](./android-sdk-setup.md) 手动安装（Android Studio 或官方 CLI）。
- **禁止**长串裸 `sdkmanager` 清单；自动安装失败时再给 1～2 条手动兜底。
- 完成后重新 `probe-env`；用户也可回复 **「SDK 已配置」**。
- 安装成功会把 `ANDROID_HOME` 写入 `e2e-device/.e2e-local.json`（非敏感键）。

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
2. 用户同意后：`orch_cli install-appium` 或 `bash e2e-device/scripts/install-appium.sh`
3. 失败时等待用户回复 **「安装完毕」** 再重 probe
4. 仅当 `E2E_APPIUM_GLOBAL=1` 时才尝试全局 `npm i -g`（非默认）

## 测试计划确认

1. `init.sh --plan-only` 或 pre 阶段会生成 `e2e-device/test-plan.md`
2. Agent **列出全部测试 case 清单**（含 caseId + 中文描述 + 预计耗时），如图：
   ```
   📋 evaluateRecovery 测试计划（58 用例）
   
   🔴 核心用例（必跑）:
   1. 打开页面 (evaluateRecovery.C15) — 1m
   2. 生命周期测试 (evaluateRecovery.hybrid.lifecycle) — 3m
   3. 导航测试 (evaluateRecovery.hybrid.navigation) — 4m
   
   🟡 设备边缘用例（按模式筛选）:
   4-15 键盘遮挡 (KEY-001~012) — 约5m
   16-22 弹窗滚动锁定 (MOD-001~007) — 约3m
   ...
   ```
3. Agent **AskQuestion**：确认开始 / 取消
4. 用户无响应：**10 秒后默认确认**并开始

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
# 读取所有 case
cases=$(node -e "const r=require('./e2e-device/case-registry.json');r.cases.forEach(c=>console.log(c.id+'|'+c.spec+'|'+(c.metadata?.description||c.name||c.id)))")

# 逐条执行并更新进度
for case in $cases; do
  id=$(echo "$case" | cut -d'|' -f1)
  spec=$(echo "$case" | cut -d'|' -f2)
  desc=$(echo "$case" | cut -d'|' -f3)
  
  echo "[$i/$N] $id ⏳ 正在执行: $desc..."
  
  export E2E_CURRENT_SPEC="$spec"
  npx wdio run e2e-device/wdio.conf.ts --spec "$spec" 2>&1 | tail -5
  
  # 根据 exit code 反馈结果
  if [ $? -eq 0 ]; then
    echo "[$i/$N] $id ✅ passed — $desc"
  else
    echo "[$i/$N] $id ❌ failed — $desc"
    # 读取 issues 展示给用户
  fi
  i=$((i+1))
done
```

**3. 每 case 完成后立即反馈**
- ✅ passed: 展示 case 描述 + 耗时 + 测试路径（从 spec 提取 `it()` 块标题）
- ❌ failed: 展示 case 描述 + 耗时 + 错误原因 + 建议修复方向

### 进度反馈格式

```
🔍 [1/3] 打开页面 (evaluateRecovery.C15) ⏳ 执行中...

🔍 测试路径:
  ✓ 确保 App 启动并进入 WebView
  ✓ 验证 WebView 加载成功

[1/3] 打开页面 ✅ passed (8.8s)

🔍 [2/3] 生命周期测试 (evaluateRecovery.hybrid.lifecycle) ⏳ 执行中...

🔍 测试路径:
  ✓ App 冷启动后 WebView 正常加载
  ✗ WebView 销毁后重新创建正常 — No chromedriver for Chrome 138

[2/3] 生命周期测试 ❌ failed (25s) — chromedriver 版本不匹配
🔄 复现: vivo + Chrome 138.0.7204 WebView → 切换 WebView context
🔧 建议: 设置 E2E_CHROMEDRIVER_PATH 为匹配版本 chromedriver
```

## 首跑 vs 二跑

| 场景 | AskQuestion |
|------|-------------|
| `initialized !== true` | 最多 1～2 问（见 questionnaire-first-run） |
| `initialized === true` 且无 blockers | **禁止首跑问卷** |
| `auth-recovery.json` 或 exit `42` | **AUTH_RECOVERY**：AskQuestion 凭据（仅 env）→ sequential 重跑失败 case |
| `page_origin_unknown` | **E2E_PAGE_ORIGIN** 单次恢复 |
| `--plan-only` | 可与 discover 并发 probe，不阻塞 discover |

## AUTH_RECOVERY（首选 sequential）

1. 读 `e2e-device/artifacts/auth-recovery.json`
2. AskQuestion 账号密码 → `export E2E_ACCOUNT=... E2E_PASSWORD=...`（**禁止**写入 report/jsonl/docs）
3. `bash e2e-device/scripts/init.sh --sequential` 从失败 case 续跑
4. 单次 `wdio` 遇 exit 42：**不要**在同一进程等待用户；续跑 registry 中失败 spec

## 报告摘要

跑测结束后 `publish-reports` 写入 `docs/guazi-flow/<任务>/e2e-device/` 或 `docs/e2e-device/`。用户摘要**必须**包含 docs 路径，不只 `artifacts/runs/`。
