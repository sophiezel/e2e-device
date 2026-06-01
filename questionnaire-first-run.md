# 首跑 / 恢复问答清单（最多 1～2 问）

## 依赖（不问用户）

| 层级 | 位置 | 安装 |
|------|------|------|
| 编排 discover/probe/plan | Skill `~/.agents/skills/e2e-device` | `ensure-skill-runtime.sh`（`init.sh` 开头自动调） |
| 真机 wdio 跑测 | **当前宿主仓** | `ensure-host-deps.sh wdio`（仅 `init.sh` 跑测时） |

宿主**不需要**为 plan-only 安装 `ts-node`。

## 首跑（`initialized !== true`）

仅当 `probe-env` 返回 `questions` 且 `required: true` 时提问。**顺序**：先 `E2E_PAGE_ORIGIN`（将 DeepLink 时），再 `E2E_CREDENTIALS`；或一轮 AskQuestion 两字段。

| id | 触发条件 | 处理 |
|----|----------|------|
| `E2E_PAGE_ORIGIN` | `pageOrigin` 未发现 | 写入 `E2E_H5_ORIGIN` + `.e2e-local.json`（非敏感）+ 更新 manifest |
| `E2E_API_ORIGIN` | `apiOriginConfidence: low`（可选） | 写入 `E2E_API_ORIGIN` |
| `E2E_DEVICE_SERIAL` | 多台 USB 设备 | `ANDROID_UDID` 或 `.e2e-local.json` 的 `E2E_DEVICE_SERIAL` |
| `E2E_CREDENTIALS` | 无 env / credentials.ts | 账号密码 → **仅** `export` env，禁止写入 local json |

## 二跑恢复（规则 8 例外）

| id | 触发条件 | 处理 |
|----|----------|------|
| `AUTH_RECOVERY` | `artifacts/auth-recovery.json` 或 exit 42 | 凭据仅 env → `ensureLoggedIn` → `init.sh --sequential` 重跑失败 case |
| `E2E_PAGE_ORIGIN` | `page_origin_unknown` / host 不匹配 | 配置 `E2E_H5_ORIGIN` 后重 probe |

二跑：若 `initialized === true` 且无 blockers / 无 auth-recovery，**禁止**首跑问卷。

保存非敏感配置：

```bash
echo '{"env":{"E2E_H5_ORIGIN":"https://...","E2E_DEVICE_SERIAL":"..."},"initialized":true}' | bash e2e-device/scripts/save-local-config.sh
```
