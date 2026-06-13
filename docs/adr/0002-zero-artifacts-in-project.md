# 零配置落入项目仓库

e2e-device 对项目仓库的唯一写入是最终测试报告（`docs/{date}-真机E2E-{time}.md`）。
scaffold 代码（spec/helper/config）、case registry、截图、日志、覆盖率数据、进度文件等全部存放在 `$E2E_HOME`。

## 为什么这样做

- 项目仓库不应被测试框架的临时产物污染。产物的生命周期属于测试环境，不属于项目代码。
- `skill.project.json`（项目 Hybrid 特征描述）也是缓存而非配置——其全部内容可从项目源码重新生成，不应随 git 走。
- 当前 skill 将 scaffold 产物写入项目 `e2e-device/` 目录，导致 `.gitignore` 维护负担和 CI 环境的不确定性。

## 替代方案

- **scaffold 写入项目**：测试框架文件随项目 git 版本化。问题：框架升级时需要处理存量项目的迁移；CI 环境可能无法写入项目目录。
- **混合方案**：部分入项目、部分入 E2E_HOME。问题：边界模糊，维护者需要记住"什么在哪里"。
