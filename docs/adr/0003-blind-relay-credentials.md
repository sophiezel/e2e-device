# Blind Relay 凭据安全模型

## 现状（2026-07 降级声明）

**已落地**：凭据仅允许通过进程环境变量 / CI secret 注入（`E2E_ACCOUNT` / `E2E_PASSWORD` / `E2E_DEVICE_PIN`）。

**明确未落地**：OS Keychain 持久化、`/dev/tty` blind-input CLI。文档与 CONSTRAINTS 不得宣称 Keychain「已实现」。

**已禁止**：`credentials.json`、`.e2e-local.json` 存密码、Agent AskQuestion 回显密码、报告/jsonl 明文。

## 目标态（未来）

用户凭据经终端直接读取进入子进程环境变量，Agent 不参与传输、不读取内容。
持久化使用 OS Keychain（macOS Keychain / Linux Secret Service），key 绑定 `{projectHash}/{branch}`。

## 为什么这样做

Agent 是 LLM 进程，它"看到"的任何内容都可能出现在对话中。明文交给 Agent → 泄漏风险不可控。

## 当前 Agent 规程

1. 需要鉴权时：提示用户在**本机终端**自行 export，勿把密码贴进对话
2. AUTH_RECOVERY：同样只引导本地 export，然后 `run.sh` 续跑
3. 日志使用 `maskAccount` / `maskPassword`（`helpers/credentials.ts`）

## 替代方案（已否定）

- **credentials.json / .e2e-local.json**：落盘明文 — 禁止
- **Agent 内存传递 AskQuestion**：污染 context — 禁止
- **未实现却宣称 Keychain**：误导 — 禁止
