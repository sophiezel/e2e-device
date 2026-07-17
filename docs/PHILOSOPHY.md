# e2e-device 设计哲学与架构

> 本文档记录 v2 架构的全部设计决策及其理由。
> 每一个决定都经过多轮专家审视（自动化测试专家 × 全栈研发架构专家 × Skill 设计专家）。
> 配套约束见 [CONSTRAINTS.md](../CONSTRAINTS.md)。

---

## 一、设计哲学

### 核心命题

**"如何把一个资深 Hybrid E2E 测试专家的大脑，压缩进一个 205 行的 SKILL.md？"**

答案不是"把测试专家的操作步骤写成文档"——那是教程。答案是"提取测试专家的决策模型"——遇到什么信号做出什么判断。

### 三原则

| 原则 | 含义 |
|------|------|
| **知识增量 > 知识复述** | Skill 的价值在于 Claude 不知道的东西。Claude 知道什么是 Appium，但不知道 WebView context 名带有不稳定的 PID 后缀。 |
| **决策树 > 过程叙述** | "如果 X 则 Y"比"第一步做 A、第二步做 B"更有用。前者给 Claude 判断力，后者给 Claude 枷锁。 |
| **Scripts Execute, Agent Decides** | 确定性逻辑放脚本（执行不进 context），需要上下文理解的放 Agent（只在关键节点介入）。 |

---

## 二、架构全景

```
┌─────────────────────────────────────────────────────────────┐
│  Skill 层 (~/.agents/skills/e2e-device/)                     │
│  ┌──────────┐  ┌─────────────┐  ┌──────────────────────┐   │
│  │ SKILL.md  │  │ references/  │  │ scripts/              │   │
│  │ 决策树    │  │ 按需文档    │  │ run.sh + case-cache   │   │
│  │ NEVER列表 │  │ (14个)      │  │ + progress + preflight│   │
│  └──────────┘  └─────────────┘  │ + wdio + appium + ...  │   │
│                                  └──────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ assets/scaffold/ (35 .ts 编排模块 + 模板)              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                              │
         │  编排指令                     │  执行脚本
         ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent 层 (LLM)                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 决策: 域确认引导 / case提取 / 测试级别确认 / 失败诊断   │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
         │
         │  进度写入(不读取)    报告写入(唯一项目产物)
         ▼
┌─────────────────────────────────────────────────────────────┐
│  产物层 ($E2E_HOME = ~/.e2e-device/)                         │
│  ┌──────────┐  ┌─────────────────────┐  ┌──────────────┐   │
│  │ projects/ │  │ sandbox/{hash}/{domain}/│  │ logs/        │   │
│  │ 配置缓存  │  │ specs + artifacts    │  │ appium.log   │   │
│  │ case缓存  │  │ progress + coverage  │  └──────────────┘   │
│  └──────────┘  └─────────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
                                              │
                                              │ 唯一写入
                                              ▼
                              ┌───────────────────────────┐
                              │ 项目仓库                    │
                              │ docs/{date}-真机E2E-{time}.md│
                              └───────────────────────────┘
```

---

## 三、关键设计决策

### 决策 1: Agent/脚本双层模型

**问题**: 谁来做决策——脚本还是 Agent？

**选择**: 双层。确定性操作归脚本，需要判断的归 Agent。

**理由**:
- 脚本可靠、可审计、零 token 消耗——适合 adb 检测、设备信息采集、chromedriver 匹配
- Agent 理解上下文——适合多条配置候选的引导确认、从需求文档理解验收场景、失败根因诊断
- 单层模型的失败模式: 纯脚本无法处理自然语言交互；纯 Agent 会被冗长的工具输出淹没（84% 的 turn token 是环境观察）

**详见**: [ADR-0001](adr/0001-agent-script-dual-layer.md)

---

### 决策 2: 零配置落入项目

**问题**: scaffold 代码（spec/helper/config）放哪里——项目目录还是独立沙箱？

**选择**: 全部在 `$E2E_HOME` 沙箱，唯一例外是测试报告。

**理由**:
- 项目仓库不应被测试框架的临时产物污染
- `skill.project.json` 也是缓存——全部内容可从项目源码重新生成
- 当前 skill 的 `e2e-device/` 目录污染已经造成 `.gitignore` 维护负担

**详见**: [ADR-0002](adr/0002-zero-artifacts-in-project.md)

---

### 决策 3: Blind Relay 凭据安全

**问题**: 凭据怎么传给测试进程，同时保证 Agent 不接触明文？

**选择**: 用户输入直接进子进程环境变量（现行）。OS Keychain + 分支作用域为**目标态**（ADR-0003，未落地）。

**理由**:
- Agent 是 LLM 进程，"看到"的内容可能残留在 context/compaction/日志中
- OS Keychain 提供硬件级加密，且凭据仅在子进程地址空间存在
- 分支作用域避免 `feat/a` 的测试账号被 `feat/b` 误用

**详见**: [ADR-0003](adr/0003-blind-relay-credentials.md)

---

### 决策 4: 决策树驱动而非过程叙述

**问题**: SKILL.md 应该写什么形态？

**选择**: 决策树 + NEVER 列表，不写过程步骤。

**理由**:
- Anthropic Skill 最佳实践: "决策树 > 过程列表"
- Claude 需要判断力（"遇到 X→走 Y"），不是待办列表（"Step1→Step2→Step3"）
- 过程叙述在 SKILL.md 加载后持续占用 context，决策树让 Claude 自行探索分支

---

### 决策 5: Anthropic 标准目录结构

**问题**: 代码和资源怎么组织？

**选择**: `scripts/` `references/` `assets/` 三目录。

**理由**:
- Anthropic 规范: `scripts/` 执行不加载到 context，`references/` 按需加载，`assets/` 存放模板
- 旧结构有 `phases/` `bin/` `orchestration/` `templates/` `reference/` 等非标准目录
- 标准化后 skill 可跨平台分发，也更容易通过 skill-judge 评分

---

### 决策 6: 进度中介（progress.jsonl）

**问题**: Agent 如何知道测试进度，又不被进度信息淹没 context？

**选择**: Agent 写入 `progress.jsonl`（追加一行 JSON），独立 viewer 进程读取渲染。Agent 不读。

**理由**:
- 每个 case 的进度更新如写入对话 → 30 case × 3 条消息 = 90 条消息的永久 context 污染
- Anthropic 研究: 84% 的 Agent turn token 是环境观察——进度信息加重这个问题
- 文件中介模式被 pytest-tally、playwright-cli、gotestshow 等工具验证

---

### 决策 7: Case 缓存 + 文件哈希增量失效

**问题**: 如何避免 Agent 每次跑测都重读需求文档提取 case？

**选择**: Case 按 `{branch}/{domain}` 缓存，精确归因到源文档文件级哈希。仅变更文档触发重新提取。

**理由**:
- 需求周期内同一 domain 会被反复测试，重读文档浪费 token
- 敏捷开发中同一分支的需求文档可能迭代，需感知变更
- 精确到文件级（非目录级）哈希避免同事的无关文档变更误触发失效
- case 级 fromFile 归因支持增量更新（只对变化文档重新提取）

---

### 决策 8: 单设备串行 + 分组优化

**问题**: 单台真机能并发跑 case 吗？

**选择**: 不能。单设备上 Appium session 是单线程的。优化方向是分组减少 setup 开销 + 严格超时防卡壳。

**理由**:
- 物理现实: 一台手机只有一个屏幕，两个 spec 同时操作会产生焦点争夺
- 真正可并发的: 不操作设备的后处理任务（通过 subagent）
- 优化策略: session 热保持、导航链排序（浅→深）、Mock 预注入、WebView 预热

---

### 决策 9: 业务 Case 由 Agent 从文档理解提取

**问题**: 业务 case 怎么来——用户口述？正则匹配文档？

**选择**: Agent 直接读需求文档全文，用 LLM 理解验收场景，提取为可测试 case 并展示给用户确认。不做正则/NLP 模式匹配。

**理由**:
- 需求文档是给人读的——"验收标准: 用户能提交估价单"→ NLP 不知道要测"表单校验"、"提交成功跳转"、"重复提交防护"
- Agent 本身就是 LLM，理解自然语言是它的核心能力
- 不能把提取成本转嫁给用户（让用户从零口述 case）

---

## 四、测试全链路

```
用户: "真机测试"
  │
  ▼
[Quick Path 判断] 同设备+同分支+同domain?
  │ YES ──▶ 秒级确认 ──▶ 直接执行
  │ NO
  ▼
[环境预检] adb → WebView调试 → pageOrigin可达 → 权限预授权 → chromedriver匹配
  │
  ▼
[项目发现] packageName → scheme → deepLink预验证 → 登录态探测
  │
  ▼
[域确认] git diff + 文档探测 → 交叉验证 → 引导确认 → 更新lastDomain
  │
  ▼
[Case发现] infra(框架) + chaos(框架) + biz(缓存/Agent提取/用户确认)
  │
  ▼
[级别确认] quick / standard(默认) / resilience → Agent AskQuestion（脚本不自动计时确认）
  │
  ▼
═══════════ 测试执行 ═══════════
  │
  ├─ Session 创建 (noReset, 一次性)
  ├─ 注入 annotation + mock + CDP连接
  ├─ 按 domain 分组 → 导航链排序
  ├─ 每 case: 执行(45s超时) → 写progress → 1s轻量reset → 继续
  ├─ 不阻断: 失败→截图+记录→继续
  │
  ▼
═══════════ 测试后 ═══════════
  │
  ├─ 脚本批量: 截图diff + logcat提取 + 覆盖率合并
  ├─ 有失败? → diagnose-request.json + preclassify → Agent 按 failure-triage（禁止自动 spawn LLM）
  └─ 模板生成报告 → 写入项目 docs/
```

---

## 五、配置分层

```
L0  全局持久化        adb/Appium/Node路径、chromedriver缓存策略

L1  项目持久化        packageName、scheme、deepLink模板、
                      pageOrigin、docsPath、routingMode
     └─ devices/{serial}/  chromedriverVer、webviewVer、
                           厂商workaround、appVer

L1.5 粘性偏好          lastDomain、lastTestLevel
                      （分支切换时刷新）

L2  会话级            --domain/--level 显式覆盖、runId

L3  敏感-env          凭据 → 进程 env / CI secret（Keychain 为目标态）
                      永不过Agent上下文
```

---

## 六、执行优化（12项）

| # | 优化 | 类型 |
|---|------|------|
| 1 | Session 热保持 + noReset | 启动优化 |
| 2 | 导航链排序（浅→深） | 编排优化 |
| 3 | 异步任务机（分析脱离主线程） | 并行优化 |
| 4 | Mock 预注入 | 启动优化 |
| 5 | WebView 预热 | 启动优化 |
| 6 | skipDeviceInitialization + skipServerInstallation | Appium 优化 |
| 7 | Accessibility ID + DOM 运行时标注 | 定位优化 |
| 8 | ExplicitWait 替代所有 browser.pause() | 等待优化 |
| 9 | CDP 持久连接 | WebView 优化 |
| 10 | 增量测试（git diff 过滤） | 范围优化 |
| 11 | Appium 插件按需加载 | 内存优化 |
| 12 | logcat 独立进程持续采集 | 诊断优化 |

---

## 七、故障模型（L0/L1/L2）

| 层 | 名称 | 典型故障 |
|----|------|----------|
| **L0** | Native 容器 | 未登录、USB 未授权、WebView 调试关闭、权限弹窗、OEM 弹窗 |
| **L1** | Hybrid 通道 | URL host 错、context 切换失败、chromedriver 版本不匹配、深链格式错误 |
| **L2** | 业务 H5 | 列表空、接口 500、页面白屏、JS 错误 |

**原则**: L2 问题不用 L0 代理顶替；auth 问题禁止 inject mock 绕过。

---

## 八、相关文档

| 文档 | 内容 |
|------|------|
| [SKILL.md](../SKILL.md) | 入口决策树 + NEVER 列表 |
| [CONTEXT.md](../CONTEXT.md) | 术语表 |
| [CONSTRAINTS.md](../CONSTRAINTS.md) | 设计约束（不可违反） |
| [ADR-0001](adr/0001-agent-script-dual-layer.md) | 双层决策 |
| [ADR-0002](adr/0002-zero-artifacts-in-project.md) | 零配置入项目 |
| [ADR-0003](adr/0003-blind-relay-credentials.md) | 凭据安全 |
| [references/arch-overview.md](../references/arch-overview.md) | 架构总览 |
| [references/arch-details.md](../references/arch-details.md) | 模块实现细节 |
| [references/artifacts-governance.md](../references/artifacts-governance.md) | 产物治理 |
