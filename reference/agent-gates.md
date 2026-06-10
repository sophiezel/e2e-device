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

1. `init.sh --plan-only` 生成 `e2e-device/test-plan.md`
2. Agent **列出全部 case 清单并按模式分层**，向用户说明各模式覆盖范围：

   ```
   📋 evaluateRecovery 测试计划（共 58 用例）
   
   🟢 快速模式 (quick) —— 默认，仅跑 3 个核心用例，约 8 分钟：
   1. 打开页面 (evaluateRecovery.C15) — 验证联系人掩码
   2. 生命周期测试 (evaluateRecovery.hybrid.lifecycle) — 冷启动+WebView重建
   3. 导航测试 (evaluateRecovery.hybrid.navigation) — Native↔WebView切换
   
   🟡 标准模式 (standard) —— 增加 49 个 P0/P1 设备边缘用例，约 30 分钟：
   4-15 键盘遮挡 (KEY-001~012)
   16-22 弹窗滚动锁定 (MOD-001~007)
   23-37 表单导航回填 (FRM-001~015)
   38-45 WebView 通信 (WEB-001~008)
   46-53 存储清理 (CLN-001~008)
   54-57 中断恢复 (INT-001~004)
   
   🔴 全量模式 (resilience) —— 全部 58 用例 + 混沌测试，约 45 分钟
   
   当前默认: quick（仅核心 3 用例，其余 55 将跳过）
   ```

3. Agent **AskQuestion**：「确认开始 quick 模式（仅 3 核心用例）？还是选择 standard（52 用例）或 resilience（58 用例）？」
4. 若用户选择 standard/resilience → `export E2E_RUN_PROFILE=standard` 后重新 `init.sh --plan-only`
5. 用户无响应 → **10 秒后默认 quick 模式**并开始

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
  const r = require('./e2e-device/case-registry.json');
  r.cases.forEach(c => 
    console.log(c.id + '|' + (c.metadata?.description || c.name || c.id))
  )
")

# 逐条执行并更新进度（每行必须含中文描述）
i=1; N=$(echo "$cases" | wc -l | tr -d ' ')
for case in $cases; do
  id="${case%%|*}"
  desc="${case#*|}"
  spec=$(node -e "const r=require('./e2e-device/case-registry.json');console.log(r.cases.find(c=>c.id==='$id')?.spec||'')")
  
  echo "[$i/$N] $desc ($id) ⏳ 执行中..."
  
  export E2E_CURRENT_SPEC="$spec"
  npx wdio run e2e-device/wdio.conf.ts --spec "$spec" 2>&1 | tail -5
  
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

**每行必须包含 caseId 和中文描述**，格式：`[i/N] <中文描述> (<caseId>) — <结果>`

```
[1/3] 打开页面 (evaluateRecovery.C15) ⏳ 执行中...

🔍 测试路径:
  ✓ 打开页面
  ✓ 预期: 联系电话 placeholder 为掩码，不展示明文

[1/3] 打开页面 (evaluateRecovery.C15) ✅ passed (8.8s)

[2/3] 生命周期测试（冷启动、WebView重建） (evaluateRecovery.hybrid.lifecycle) ⏳ 执行中...

[2/3] 生命周期测试（冷启动、WebView重建） (evaluateRecovery.hybrid.lifecycle) ✅ passed (219s)

[3/3] 导航测试（Native↔WebView切换） (evaluateRecovery.hybrid.navigation) ⏳ 执行中...

[3/3] 导航测试（Native↔WebView切换） (evaluateRecovery.hybrid.navigation) ✅ passed (264s)

=== 全部 3 条用例执行完毕 ===
```

**失败示例**:
```
[2/3] 生命周期测试 (evaluateRecovery.hybrid.lifecycle) ❌ failed (25s)
原因: No chromedriver found for Chrome 138
🔄 复现: vivo WebView 138 → 切换 WebView context 时 chromedriver 版本不匹配
🔧 建议: export E2E_CHROMEDRIVER_PATH=<path>
```

**禁止**只输出 caseId（如 `evaluateRecovery.C15`），必须附带中文描述。

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
