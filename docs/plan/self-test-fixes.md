# E2E-Device 自测问题修复方案

> **状态: ✅ 全部修复 (2026-06-11)**

---

## P0: 阻塞性

### 问题6 — discover-cases 污染项目目录

**现象**: `plan` 后项目出现 `e2e-device/specs/*.spec.ts` (25个) + `e2e-device/.e2e-run.json`

**根因**: `auto-generate-cases.ts::writeGeneratedSpecs()` 使用 `repoRoot()` → 项目根。沙箱模式未生效。

**修复**: `writeGeneratedSpecs()` 优先写入 `E2E_SANDBOX/specs/`

**影响文件**: `auto-generate-cases.ts`, `paths.ts`

---

## P1: 功能性

### 问题1 — 端侧 spec 缺失

**现象**: sandbox 只有 25 specs (缺 form-navigation, keyboard-occlusion 等 7 个端侧 spec)

**根因**: run.sh 的 specs 同步只从项目 e2e-device/specs/ 复制。Skill 模板中的端侧 spec 仅在沙箱为空时的 fallback 中才补充。

**修复**: 每次 sync 都从 Skill 模板补充端侧 spec（增量, 不覆盖已有）

**影响文件**: `run.sh`

### 问题5 — 零配置首次运行生成空壳

**现象**: 无 `skill.project.json` 时, 引导输入 pageOrigin 后生成只有 3 个字段的配置, domain 等缺失导致后续失败

**根因**: run.sh 的 fallback 配置只包含 `id/domain/pageOrigin`, 未运行 `discover-project` 自动探测

**修复**: 首次运行自动调用 `discover-project` 探测项目结构, 填充完整配置后再引导输入缺失字段 (pageOrigin)

**影响文件**: `run.sh`

---

## P2: 体验

### 问题2 — Appium debug 污染 stdout

**现象**: `e2e-device info` 输出中出现 `dbug Appium Creating hash file directory: ...`

**根因**: `appium --version` 在某些情况下输出 debug 到 stdout

**修复**: 设置 `APPIUM_HOME` 环境变量抑制, 或重定向 stderr

**影响文件**: `bin/e2e-device.js`

### 问题3 — README 变量未展开

**现象**: README 显示 `${E2E_HOME:-~/.e2e-device/}` 文本而非实际路径

**根因**: heredoc `<<'READEOS'` 单引号阻止变量展开

**修复**: 改为双引号 heredoc 或 echo 拼接

**影响文件**: `run.sh`

### 问题4 — info 指向可能不存在的 README

**现象**: `e2e-device info` 始终显示 `详细说明: ~/.e2e-device/README.md` 即使文件不存在

**根因**: 未检查 README 是否存在

**修复**: 仅存在时显示路径, 否则提示运行 `plan` 或 `run` 生成

**影响文件**: `bin/e2e-device.js`
