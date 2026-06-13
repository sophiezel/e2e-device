# 设计准则约束 — Design Constraints

> **效力**: 任何对 e2e-device 的迭代修改必须满足以下所有约束。
> 违反任一条 → 拒绝合并。
> `scripts/validate-skill-dry-run.sh` 是这些约束的自动化守卫。

---

## 一、零硬编码 (Zero Hardcoding)

### 禁止

- 禁止在通用代码（`.ts` `.sh` `.js`）中写死业务 domain 名称（如 `evaluateRecovery`、`followUpMark`）
- 禁止在通用代码中写死项目路径前缀（如 `docs/guazi-flow/`）
- 禁止在通用代码中写死公司/组织名称或包名（如 `com.guazi`、`com.xrk`）
- 禁止在通用模板中写死 API 版本号（如 `/v2`、`/v1`）

### 允许

- 示例数据（注释中的 `exampleDomain`、`/exampleRoute` 等）——必须在注释或文档中
- 配置文件（`skill.project.json`、`manifest.json`）中由 `discover-project` 自动探测的值
- 测试用例数据（`.spec.ts` 中的 fixture 数据）——但必须来源于项目配置，不可写死在 skill 模板

### 执行机制

- 所有可配置项通过 `discover-project` 从项目源码自动探测
- 探测失败 → 引导用户输入 → 缓存至 `E2E_HOME/projects/{hash}/`
- 模板使用占位符（如 `<DOMAIN>`），运行时替换

---

## 二、零项目写入 (Zero Project Writes)

### 唯一例外

**测试报告**（纯文本 Markdown）是唯一允许写入项目仓库的文件：
- 路径: `{E2E_REPORT_PATH 或 PROJECT/docs}/{YYYY-MM-DD}-真机E2E-{HHmm}.md`
- 内容: 仅文本——不嵌入 base64、不嵌入二进制、不引用项目外部路径
- 截图以文字标注产物路径方式存在，不入报告文件

### 禁止写入项目的产物

| 产物 | 实际存放位置 |
|------|------------|
| scaffold 代码 (specs/helpers/config) | `$E2E_HOME/sandbox/{hash}/{domain}/` |
| case-registry.json | 同上 |
| cases-executed.jsonl | 同上 |
| 截图/日志/覆盖率数据 | 同上 |
| progress.jsonl | 同上 |
| 诊断快照 | 同上 |
| skill.project.json 缓存 | `$E2E_HOME/projects/{hash}/` |
| case 缓存 | 同上 |
| 任何临时/中间文件 | `$E2E_HOME/` |

### 执行机制

- `paths.ts` 中所有路径函数指向 `E2E_HOME`，不指向 `repoRoot()`
- `publish-reports.ts` 是唯一调用 `repoRoot()` 做写入的模块
- `validate-skill-dry-run.sh` 扫描 `path.join(repoRoot()` + write 模式

---

## 三、凭据零泄漏 (Zero Credential Exposure)

### 禁止

- 凭据（账号/密码/PIN/Token）写入任何文件（包括 `.env`、`.e2e-local.json`）
- 凭据在 Agent 对话上下文中出现（包括思考过程、工具输出、错误消息）
- 凭据在控制台输出中明文展示
- 凭据在日志文件（Appium/wdio/logcat）中明文出现
- 凭据在测试报告中出现

### 必须

- 凭据存储: OS Keychain (macOS) / Secret Service (Linux)，key 绑定 `{projectHash}/{branch}`
- 凭据传输: Blind Relay ——用户输入直接进入子进程环境变量，Agent 不参与不读取
- 凭据脱敏: 账号 `xu***44`（前2+后2），密码 `****`，Token `tok***ken`
- CI 环境: 使用 `E2E_ACCOUNT`/`E2E_PASSWORD` 环境变量（CI secret 管理）

### 执行机制

- `blind-input` 机制从 `/dev/tty` 或 `read -s` 读取，不走 Agent stdin
- 所有日志/报告输出前过脱敏函数
- `security.md` 内容已合并至 `references/agent-gates.md`

---

## 四、不阻断执行 (Non-Blocking Execution)

### 禁止

- 因单个 case 失败/超时而停止整个测试 run
- 在 case 失败时自动修改项目业务代码
- 在 case 失败时自动修改 skill 代码
- 无限等待某个 case（必须设超时）

### 必须

- 每 case 超时: 45s（`CASE_TIMEOUT_MS`）
- case 失败后: 轻量 reset（cookies + localStorage + sessionStorage + 回锚点 + hideKeyboard），耗时 ≤1s
- case 超时后: 截图 + 日志快照 + 标记 `TIMEOUT`
- 全部 case 跑完后: 有失败才启动 LLM subagent 诊断
- `bail: 0`（WebdriverIO 配置）

---

## 五、Agent Context 零污染 (Zero Context Pollution)

### 禁止

- Agent 在对话中渲染完整进度面板
- Agent 阅读每个 case 的执行结果详情（除非诊断阶段）
- 进度信息以对话消息形式逐条发送

### 必须

- 进度写入 `progress.jsonl`（Agent 写，不读）
- 独立 viewer 进程渲染（用户可选打开）
- Agent 仅在关键节点读摘要（如每 5 个 case 汇总一行）
- 全部 case 跑完后: Agent 读最终摘要 + 失败列表

---

## 六、目录结构约束 (Directory Structure)

### 必须遵循 Anthropic Skill 标准

```
e2e-device/
├── SKILL.md              ← <500行，决策树 + NEVER列表
├── CONTEXT.md             ← 术语表
├── references/            ← 按需加载文档
├── assets/                ← 模板、scaffold 代码
└── scripts/               ← 可执行脚本 + node_modules
    ├── package.json       ← 版本锁定
    └── node_modules/      ← .gitignore
```

### 禁止

- 在 skill 根目录放置 `node_modules/`
- 在 skill 根目录放置 `package.json`
- 在 skill 根目录创建非标准目录（`phases/`、`bin/`、`orchestration/` 等）
- 使用 `templates/` 目录名（用 `assets/`）

---

## 七、SKILL.md 内容约束

### 必须

- 以决策树为骨架（非过程叙述）
- 包含 NEVER 列表
- 包含 MANDATORY/Do NOT Load 触发标记
- 正文 <500 行
- description 包含 WHAT + WHEN + KEYWORDS + 否定空间（何时不用）

### 禁止

- 过程式步骤列表（"Phase 1: 做A, Phase 2: 做B"）
- 实现细节（放入 references/）
- 硬编码路径/域名/包名
- 对 Claude 已知的基础概念做解释

---

## 八、测试前流程约束

| 步骤 | 执行者 | 交互 |
|------|--------|------|
| 环境预检（adb/WebView调试/pageOrigin可达/权限预授权） | 脚本 | 仅失败时 |
| 项目发现（packageName/scheme/deepLink） | 脚本 | 多App时引导选择 |
| 域确认 | 脚本探测 + Agent 引导 | 分支切换时 |
| Case 发现（缓存 + Agent读文档提取） | Agent + 缓存 | 用户确认 |
| 测试级别 | Agent | 10s 默认 standard |

---

## 九、测试中执行约束

| 约束 | 值 |
|------|-----|
| case 超时 | 45s |
| reset 超时 | 1s |
| 定位策略优先级 | data-e2e > #id > [data-testid] > CSS > XPath |
| Mock 默认 | 开启 (`E2E_ENABLE_WEB_MOCK=0` 可关) |
| 等待策略 | ExplicitWait，禁止 `browser.pause(N)` |
| Session 管理 | `noReset: true`，不跨 case 重建 |
| WebView context 匹配 | `startsWith('WEBVIEW')`，不做精确全名匹配 |
| 键盘处理 | 每个 case 结束时 `hideKeyboard()` |

---

## 十、测试后产物约束

| 产物 | 位置 | 生命周期 |
|------|------|---------|
| 测试报告 `.md` | 项目 `docs/` | 永久（随 git） |
| 报告附带的截图 | `$E2E_HOME/sandbox/.../screenshots/` | 保留最近 5 次 run |
| case 执行记录 | `$E2E_HOME/sandbox/.../cases-executed.jsonl` | 同上 |
| 覆盖率数据 | `$E2E_HOME/sandbox/.../coverage-snapshots/` | 同上 |
| Appium 日志 | `$E2E_HOME/logs/` | 保留最近 3 次 run |
| logcat 日志 | 同上 | 同上 |
| progress.jsonl | `$E2E_HOME/sandbox/.../` | run 结束后可删 |
| case 缓存 | `$E2E_HOME/projects/{hash}/case-cache/` | 持久化 |
| 凭据 | OS Keychain | 持久化（分支作用域） |

---

## 十一、SKILL.md description 约束

必须包含:
- **WHAT**: Hybrid E2E 能力（Appium + WebdriverIO）
- **WHEN**: 明确的触发关键词列表
- **KEYWORDS**: 中文和英文搜索词
- **否定空间**: 明确何时不使用此 skill

当前 description 已满足，修改时必须保持同等质量。

---

## 十二、自动化验证

每次提交前必须通过:

```bash
bash scripts/validate-skill-dry-run.sh
```

检查项:
- 无硬编码路径 (`guazi-flow`、`e2e-device/specs` 等)
- 无硬编码业务 domain
- 无项目写入路径
- 无 `browser.pause(N)` 硬编码数字
- 无 `as never` / `as any` 类型逃逸
- 无 `require()` 混用
- 无 `process.exitCode` 副作用
- TODO 数量 ≤3
