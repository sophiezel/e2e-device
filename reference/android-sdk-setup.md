<!-- 触发条件: blocker 含 android_sdk_missing 或 android_sdk_incomplete 时加载 -->
# Android SDK 安装指引（真机 E2E 必备）

真机 Hybrid E2E 使用 **Appium + UiAutomator2** 驱动 Android 真机与 WebView。  
**仅有 `adb`（platform-tools）不够**；跑测前必须配置 **完整 Android SDK** 并设置 `ANDROID_HOME` / `ANDROID_SDK_ROOT`。

## 为什么需要 SDK（而不只是 adb）

| 能力 | 仅 platform-tools（如 `brew install android-platform-tools`） | 完整 Android SDK |
|------|--------------------------------------------------------------|------------------|
| `adb devices`、DeepLink | ✅ | ✅ |
| Appium 创建 UiAutomator2 session | ❌ 常报 `ANDROID_HOME` / `ANDROID_SDK_ROOT` 未设置 | ✅ |
| 真机找控件、切 WebView、点原生层 | ❌ | ✅ |

典型失败日志：

```text
Neither ANDROID_HOME nor ANDROID_SDK_ROOT environment variable was exported
```

这与「USB 已连接、adb 正常」不矛盾：**adb 连通 ≠ Appium 可跑**。

## 与 Playwright 浏览器 E2E 的区别

- **`yarn test:e2e`（Playwright）**：只测浏览器里的 H5，**不需要** Android SDK。
- **e2e-device（本 Skill）**：测 **App 内 WebView + 真机**，**需要** SDK。

## 自动安装（macOS + Homebrew，推荐 Agent 使用）

与 Appium 一样，**需用户同意后再执行**（Agent 门禁：说明将安装 commandlinetools + JDK + platform/build-tools，5 秒默认同意或 AskQuestion）。

```bash
bash e2e-device/scripts/install-android-sdk.sh
# 或
orch_cli install-android-sdk
```

脚本会：

1. 若已有 `~/Library/Android/sdk` 且含 `platforms`、`build-tools` → 直接写入 `.e2e-local.json`
2. 否则 `brew install --cask android-commandlinetools`（及缺失时的 `temurin` JDK）
3. 用 `sdkmanager` 安装 `platform-tools`、`platforms;android-34`、`build-tools;34.0.0`
4. 设置 `ANDROID_HOME`（Homebrew 默认：`$(brew --prefix)/share/android-commandlinetools`）

**限制**：仅 macOS；Linux/Windows 仍走下方手动方式。不替代 Android Studio GUI，但足够 Appium 真机 E2E。

安装后执行 `bash e2e-device/scripts/init.sh --plan-only` 确认无 `android_sdk_missing`。

---

## 手动安装方式（macOS）

### 方式 A：Android Studio（适合日常开发）

1. 安装 [Android Studio](https://developer.android.com/studio)。
2. 打开 **Settings / Preferences → Languages & Frameworks → Android SDK**。
3. 确认 **SDK Location**（常见为 `~/Library/Android/sdk`）。
4. 在 **SDK Platforms** 勾选至少一个 API（建议与真机系统接近，如 API 33/34）。
5. 在 **SDK Tools** 勾选：
   - Android SDK Build-Tools
   - Android SDK Platform-Tools
   - Android SDK Command-line Tools（可选，便于 `sdkmanager`）

### 方式 B：命令行 sdkmanager（已装 Studio 时）

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

路径因本机安装位置而异，以 Android Studio 里显示的 **SDK Location** 为准。

### 不推荐：仅 Homebrew platform-tools

```bash
brew install android-platform-tools
```

这只提供 `adb`，**不能**替代完整 SDK。若 probe 报 `android_sdk_missing`，请按上文安装 Studio SDK。

## 环境变量（跑测前写入 shell 或 `.e2e-local.json` 的 env 键）

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"   # 改成你的 SDK Location
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"
```

持久化示例（zsh）：

```bash
# ~/.zshrc
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
```

## 自检（跑 `init.sh` 前）

```bash
test -n "$ANDROID_HOME" && test -d "$ANDROID_HOME/platforms" && test -d "$ANDROID_HOME/build-tools" && echo "SDK OK" || echo "SDK 不完整"
adb devices   # 应看到 device 而非 unauthorized
```

或由 Skill 编排：

```bash
bash e2e-device/scripts/init.sh --plan-only
```

查看 `probe` 输出中是否仍有 blocker `android_sdk_missing`。

## 真机侧额外注意

- 首次跑测时手机可能弹出 **安装 Appium 辅助应用**（如 `io.appium.settings`），需点 **允许**。
- USB 调试需授权；多台设备时在 probe 问卷中指定 `E2E_DEVICE_SERIAL`。

## Agent 话术（门禁）

当 `probe-env` 返回 `android_sdk_missing` 时：

- 说明：**需要完整 Android SDK，不是只装 adb**。
- 指向本文档：`reference/android-sdk-setup.md`（或宿主 `e2e-device/README.md` 中的链接）。
- **禁止**只丢一长串 `sdkmanager` 裸命令；可给 Android Studio 官方下载页一条链接。
- 用户配置好后等待回复 **「SDK 已配置」**，再重新 `probe-env` / `init.sh`。
