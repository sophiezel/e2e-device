# e2e-device

面向 Android USB 真机 + App 内 WebView H5 的端到端自动化测试 Skill。
通过决策树驱动编排，实现真机 Hybrid E2E 测试的自动发现、执行、诊断与报告。

## Language

**宿主 App**:
安装在 Android 真机上的原生应用，内嵌 WebView 加载 H5 页面。它是测试的容器，不是测试目标本身。
_Avoid_: 宿主应用, host application, container app

**Domain**:
本次测试聚焦的业务模块标识（如 exampleFeature、anotherModule）。一个项目有多个 domain，一个 domain 产生一组相关的测试 case。
_Avoid_: 测试域, 业务域, 功能模块

**pageOrigin**:
H5 页面部署的基础 URL（如 `https://h5.example.com/v2`）。所有 WebView 内页面路径相对此 origin 解析。
_Avoid_: H5域名, 部署地址, base URL

**deepLink**:
通过 Android Intent URL scheme 直接从系统层面打开 App 并导航到指定 H5 页面的机制。格式如 `scheme://openapi/action?url=...`。
_Avoid_: 深链, scheme URL, intent URI

**Case**:
一个可独立执行的测试场景，包含操作步骤和断言。按来源分为 infra（基础设施）、biz（业务）、chaos（混沌注入）三类。
_Avoid_: 测试用例, test case, spec

**Test Level**:
测试覆盖范围的三级分层：quick（冒烟，每 domain 首个核心 case）、standard（完整自测，全部 case，默认）、resilience（完整自测 + 混沌注入）。
_Avoid_: 测试模式, run profile, 执行级别

**Session**:
Appium 与真机之间的单次连接生命周期。测试中保持 session 热复用以避免重建开销。仅在 Native 容器异常时重建。
_Avoid_: 会话, 连接

**Blind Relay**:
敏感凭据（账号、密码、PIN）的传输机制：用户输入直接进入子进程环境变量，永不过 Agent 上下文。
_Avoid_: 盲传, 安全通道

**Sandbox**:
`$E2E_HOME/sandbox/` 下按项目和 domain 隔离的临时执行环境，包含生成的 spec、case registry、产物目录。不与项目仓库产生任何文件交集。
_Avoid_: 沙箱, 执行目录

**Artifact**:
测试运行过程中产生的所有非报告文件（截图、日志、覆盖率数据、进度文件、诊断快照）。全部存储在 `$E2E_HOME`，不写入项目仓库。
_Avoid_: 产物, 中间文件

**Report**:
测试结束后写入项目 `docs/` 目录的唯一产物——纯文本 Markdown 文件，包含结果总览、失败详情、覆盖率摘要、LLM 介入统计。
_Avoid_: 测试报告, 输出报告

**Quick Path / Full Path**:
二次跑测的智能分流：同设备 + 同分支 + 同 domain → Quick Path（秒级确认后直接执行）。任一条件不满足 → Full Path（完整探测 + 引导确认）。
_Avoid_: 快速路径, 完整路径

**Case Cache**:
按 `{branch}/{domain}` 维度缓存的业务 case 提取结果，精确归因到源文档文件级别的哈希。源文档变更时增量失效，避免重复读取需求文档。
_Avoid_: case缓存, 用例缓存

**Vendor Workaround**:
针对不同 Android 厂商（华为 EMUI、小米 MIUI、OPPO/VIVO ColorOS/FuntouchOS）的 WebView 行为差异的设备特定适配策略。
_Avoid_: 厂商适配, OEM workaround

**No-Reset**:
Appium capability `noReset: true`，保持 App 状态跨 case 不重置。核心优化之一，避免每个 case 重建 session（节省 30-90s/case）。
_Avoid_: 不重置, 状态保持

**Progress Mediator**:
`progress.jsonl` 文件：脚本写入每个 case 的状态变更行，独立 viewer 进程读取渲染。Agent 不参与渲染，避免 context 污染；仅读尾部摘要与最终失败列表。
_Avoid_: 进度中介, 进度文件

**Diagnose Request**:
失败 case 结束后写入的 `diagnose-request.json`。脚本不自动 spawn LLM；Agent MUST 加载 failure-triage 后读截图/logcat 完成诊断。
_Avoid_: LLM subagent, 自动诊断进程

**Context Switch**:
Appium 中 NATIVE_APP 与 WEBVIEW context 之间的切换操作。Hybrid E2E 的核心操作，必须等待 WebView 就绪后才能切换。
_Avoid_: 上下文切换
