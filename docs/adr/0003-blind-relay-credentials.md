# Blind Relay 凭据安全模型

用户凭据（账号、密码、PIN）通过终端直接读取进入子进程环境变量，Agent 不参与传输、不读取内容。
凭据持久化使用 OS Keychain（macOS Keychain / Linux Secret Service），key 绑定 `{projectHash}/{branch}`，
实现分支级生命周期隔离。

## 为什么这样做

Agent 是 LLM 进程，它"看到"的任何内容都可能出现在对话中、被 compaction 压缩、或残留在 context 里。
如果把凭据明文交给 Agent → 存在泄漏到日志/报告/对话历史的不可控风险。

传统方案（`.env` 文件或 `.e2e-local.json`）将凭据以明文或弱加密形式落盘，不符合安全最佳实践。

OS Keychain 提供硬件级加密存储，且凭据仅在子进程地址空间存在，进程退出即消失。
分支作用域避免跨分支误用凭据（如 `feat/a` 的测试账号被 `feat/b` 的跑测意外使用）。

## 替代方案

- **环境变量文件（`.e2e-local.json`）**：明文或简单编码落盘。问题：任何能读文件系统的进程可读取。
- **Agent 内存传递**：Agent 收到凭据后 `export` 给子进程。问题：Agent 上下文被凭据污染。
- **全局 Keychain（无分支隔离）**：凭据永久全局存储。问题：切换分支/项目时可能误用错误的凭据。
