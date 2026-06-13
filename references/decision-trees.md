<!-- 触发条件: Agent 遇到分支决策（首跑vs二跑/profile选择/mock策略）时加载 -->
# 决策树

## 项目态（Project state）

| 状态 | 判定信号 | 动作 |
|------|----------|------|
| A | 无 `e2e-device/` | 从 templates 全量 scaffold |
| B | 仅有 Playwright（L1） | scaffold L2，保留 L1 |
| C | 已有 `wdio.conf.ts` | 仅 `scaffold --sync-missing` |

## 运行模式（Run mode）

| 条件 | 模式 |
|------|------|
| 无 `.e2e-local.json` 或 `initialized: false` | 首跑 + 问答 |
| `initialized: true` 且 probe 通过 | 二跑静默 |
| 用户仅要计划 | `--plan-only` |

## 用例来源（union）

1. 用户 intent 关键词 → domain
2. `git diff` 对比 `origin/main`
3. guazi-flow / product-specs 路径
4. manifest + `e2e-shared` 的 route matrix

始终执行 `discover-cases --union` 与 `discover-chaos`。

### 产出物

- `case-registry.json`：matrix ∪ existing ∪ diff ∪ chaos
- `specs/*.spec.ts`：测试前阶段按需生成（缺失时）

规则：**union，非 intersection** — 宁可多测；仅按 case `id` 去重。
