# 排障指南

| 现象 | 排查 |
|------|------|
| 无设备 | `adb devices`、USB 调试、RSA 授权 |
| Appium 启动失败 | `yarn appium:doctor`、`prepare-device.sh` |
| 找不到 WebView | Chromedriver 版本、`CHROMEDRIVER_PATH`、manifest anchor |
| 登录死循环 | `E2E_ACCOUNT` / `E2E_PASSWORD` 或设备预登录 |
| manifest 过期 | `bash e2e-device/scripts/discover-project.sh` |

无真机仅生成计划：`bash e2e-device/scripts/init.sh --plan-only`
