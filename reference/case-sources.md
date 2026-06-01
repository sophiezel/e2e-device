# 用例来源（先画靶再射箭）

**测什么**的优先级（勿把既有 spec 当作唯一事实源）：

1. 用户口述（domain 关键词）
2. Git diff 变更页面
3. guazi-flow / product-specs 提及的 domain
4. manifest 中 pilot routes

**产出物**（生成 / 同步）：

- `case-registry.json`：matrix ∪ existing ∪ diff ∪ chaos
- `specs/*.spec.ts`：测试前阶段按需生成（缺失时）

规则：**union，非 intersection** — 宁可多测；仅按 case `id` 去重。
