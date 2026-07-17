# Biz Case 提取协议

<!-- 触发: case-cache 未命中、需从项目文档补齐 biz case 时 -->

## 边界

| 来源 | 执行者 | 说明 |
|------|--------|------|
| infra / hybrid / chaos / device-edge | 脚本内置 | 无需 Agent 提取 |
| matrix → `autoGenerateCases` | 脚本 | 从验收矩阵生成骨架 spec |
| 需求/技术方案文档补齐 | **Agent** | 本协议；用户只确认清单 |

Agent **不得**把读文档成本转嫁给用户。

## 输入

1. `E2E_DOMAIN`（主测域）
2. 项目内与该 domain 相关的 docs（PRD / 验收矩阵 / CWiki 导出 / `docs/guazi-flow` 任务书等——路径由项目决定，Skill 不写死）
3. 现有 `$SANDBOX/case-registry.json`（若有）与 fixtures 目录约定

## 输出（写入沙箱，不写宿主业务代码）

每个 biz case 至少：

```json
{
  "id": "<domain>.C01",
  "title": "短标题",
  "spec": "<domain>.C01.spec.ts",
  "tags": ["biz", "form|list", "smoke|regression", "assert-strong|pending-assert"],
  "source": "agent-extract",
  "sourceFiles": ["relative/path/to/doc.md"],
  "navigationDepth": 0,
  "steps": ["打开入口", "操作…", "断言…"],
  "asserts": ["可见元素或文案", "接口/状态"]
}
```

断言质量：

- `assert-strong`：可执行 expected（Toast 文案 / `data-e2e` / URL 子串 / 明确文案）→ 可进 `standard`
- `pending-assert`：仅启发式 → **standard/quick 默认剔除**；仅 resilience 或补强后再跑

- spec 文件生成在 `$E2E_HOME/sandbox/{hash}/{domain}/specs/`
- 更新 `case-registry.json`；由 `run.sh` case-cache 持久化到 `projects/{hash}/case-cache/{branch}/`

## 流程

```
cache miss
  → 脚本 autoGenerateCases（矩阵）
  → 仍不足? Agent 读文档提取 → 写 registry/specs
  → 向用户展示清单（只确认，不让用户写 case）
  → 用户确认后进入 --plan-only / 执行
```

## 定位与等待

- 优先 `data-e2e` / `#id` / `[data-testid]`
- ExplicitWait；禁止 `browser.pause(N)`
- 遵循 Journey：form 段依赖 expertReset，勿在 case 内冷启全量 App

## 禁止

- 把生成的 specs 提交进宿主仓（零项目写入）
- 硬编码公司域名 / 包名到通用模板
- 未确认清单就静默开跑大量新 case
