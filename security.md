# 安全规范（e2e-device）

- 禁止将 `E2E_ACCOUNT`、`E2E_PASSWORD`、token 或 `credentials.ts` 提交到 git。
- `.e2e-local.json` 已 gitignore；仅允许持久化非敏感 env 键。
- `e2e-device/artifacts/runs/` 下 archive 须脱敏凭据与 Cookie。
- 禁止将密钥写入 guazi-flow 执行记录或 PR 正文。
- 优先使用 env；勿将示例凭据复制进可跟踪文件。
