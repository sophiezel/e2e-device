# 排障指南

| 现象 | 排查 |
|------|------|
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` 未设置 | 见 [reference/android-sdk-setup.md](reference/android-sdk-setup.md)；仅 `brew install android-platform-tools` 不够 |
| 无设备 | `adb devices`、USB 调试、RSA 授权 |
| Appium 启动失败 | 先确认 SDK 已配置，再 `npx appium driver doctor`、检查手机是否允许安装 Appium 辅助 APK |
| 找不到 WebView | Chromedriver 版本、`CHROMEDRIVER_PATH`、manifest anchor |
| 登录死循环 | `E2E_ACCOUNT` / `E2E_PASSWORD` 或设备预登录 |
| manifest 过期 | `bash e2e-device/scripts/discover-project.sh` |

无真机仅生成计划：`bash e2e-device/scripts/init.sh --plan-only`
