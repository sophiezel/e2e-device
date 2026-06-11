# 安全规范（e2e-device）

## 凭据管理

- 禁止将 `E2E_ACCOUNT`、`E2E_PASSWORD`、token 或 `credentials.ts` 提交到 git。
- `.e2e-local.json` 已 gitignore；仅允许持久化非敏感 env 键。
- `e2e-device/artifacts/runs/` 下 archive 须脱敏凭据与 Cookie。
- 禁止将密钥写入 guazi-flow 执行记录或 PR 正文。
- 优先使用 env；勿将示例凭据复制进可跟踪文件。

## 脱敏规则（代码层强制执行）

| 字段 | 脱敏格式 | 实现位置 |
|------|----------|----------|
| `E2E_ACCOUNT` | 前2位 + `***` + 后2位（如 `xu***44`） | `login.ts::maskAccount()` |
| `E2E_PASSWORD` | 固定 `****` | `login.ts::maskPassword()` |
| Shell 输出 | `E2E_ACCOUNT=xu***44 E2E_PASSWORD=****` | `init.sh` / `run-device-e2e.sh` |
| console.log | 使用 `maskAccount()` / `maskPassword()` | `login.ts` |

## 登录态探测（privacy-first）

- `probe-env` 先用 adb dumpsys 探测设备登录态，再决定是否索要凭据
- 若设备不在登录页 → 凭据非必须，测试中遇到鉴权 case 再 30s 交互
- 30s 超时自动跳过该 case，标记 `skipped_auth`
