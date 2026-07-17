<!-- 触发条件: 新仓库接入 / 依赖安装失败时 -->
# Host 接入与依赖

## 零项目侵入

Skill **自带**完整运行时。宿主仓**不需要**安装 `@wdio/*` / `appium` / `ts-node`。

| 层级 | 位置 | 方式 |
|------|------|------|
| Skill 运行时 | `~/.agents/skills/e2e-device/scripts/node_modules` | `ensure-skill-runtime.sh`（`run.sh` 自动调） |
| 配置缓存 | `$E2E_HOME/projects/{hash}/manifest.json` | `discover-project` |
| 执行沙箱 | `$E2E_HOME/sandbox/{hash}/{domain}/` | `run.sh` 生成 |
| 报告 | 项目 `docs/` | `publish-reports`（唯一写入） |

## 首次接入

```bash
# 1. 确认设备
adb devices

# 2. 三元组候选
bash ~/.agents/skills/e2e-device/scripts/list-preconfig.sh --project /path/to/project

# 3. export 确认值后出计划
export E2E_PAGE_ORIGIN=...
export E2E_APP_PACKAGE=...
export E2E_DOMAIN=...
bash ~/.agents/skills/e2e-device/scripts/run.sh --project /path/to/project --plan-only

# 4. 用户确认 mode 后执行
bash ~/.agents/skills/e2e-device/scripts/run.sh --project /path/to/project --mode standard
```

## Android SDK

`probe-env` 检测；缺失见 [android-sdk-setup.md](android-sdk-setup.md)。配置好后回复「SDK 已配置」并重跑。

## LEGACY（勿用）

- `assets/scaffold/scripts/init.sh` — 旧宿主内入口
- `ensure-host-deps.sh` 向宿主装 wdio — v2 已废弃主路径
- 项目内 `e2e-device/` scaffold 写入 — 违反 ADR-0002
