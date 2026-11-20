# 为 dsh-agent-team 贡献

[English](CONTRIBUTING.md) | 简体中文

本指南说明如何提出、验证和提交改动。开始编辑前，先读[仓库规则](AGENTS.md)，再从[文档索引](docs/README.zh.md)找到与你的改动相关的指南。

## 动手之前

- 先开一个 issue，说明已经存在的问题、受影响的人以及期望的结果。涉及 Host、账本、工具或 Client 的职责边界时，先讨论再实现。
- 只想报告问题时，请使用 issue 模板。遇到安装问题，先核对 DSH 和 Agent Team 的版本。
- 开发环境按[配置指南](docs/development/start-and-checks.zh.md)准备。使用指定版本的 Harness 源码，并用 `corepack pnpm install` 安装依赖，不要用 `npm install`。
- 如果借助 Agent 贡献，由你回答上述问题并对结果负责。Agent 缺少必要背景时，应当先询问并等候答复，不要猜测。

## 开 PR 前先验证

按[检查指南](docs/development/start-and-checks.zh.md#检查梯度)选择与改动范围相符的检查。修改入口文档或双语 Markdown 时，运行 `npm run check:docs`；修改随包发布的核心技能时，运行 `npm run check:core-skills`。提交前运行 `git diff --check HEAD`。

说明改了什么、实际检查了什么、还有哪些内容无法验证及其原因。涉及组装后的 Web 应用或可见界面时，遵守[浏览器检查与取证规则](AGENTS.md#choose-checks-for-the-change)。

## CI 会跑什么

[CI 工作流](.github/workflows/ci.yml)会运行静态检查和 lint。代码改动还会在 Ubuntu 和 Windows 上构建、检查类型并运行 `npm run test:ci`；纯文档改动不会触发这两个任务。`npm run test:browser` 是本地验收步骤，不在 CI 中运行。Harness 版本和环境配置见 [CI 环境指南](docs/development/environments-and-install.zh.md)。

## PR 里应该有什么

- 以 `master` 为目标分支。必要时对你自己的分支执行 rebase，不要重写 `master` 的历史。改动会压成一条提交合并；请遵循[提交格式](AGENTS.md#code-and-documentation-conventions)。
- 说明整个 diff，不要夹带无关改动。修复缺陷时，附上已发生故障的证据，例如 issue、失败日志或复现步骤。遇到偶发故障时，找出并复现竞态，不要用重试掩盖问题。
- 对用户或调用方可见的改动，记在 [CHANGELOG.md](CHANGELOG.md) 的 `Unreleased` 下，每个主题写一条。仅影响内部的改动在 PR 里说明即可。[发布手册](docs/release-runbook.zh.md)说明了发布时如何处理这个小节。
- 修改正式维护的文档时，两种语言一起更新。按照[文档维护规则](docs/AGENTS.md)找到负责记录该信息的页面。
- 界面有可见改动时，附上[仓库规则](AGENTS.md#choose-checks-for-the-change)要求的浏览器证据。

## 如何评审

日常工作在 Agent Team 的 Thread 中评审，改动和证据一起看。Agent Member 可能编写提交或评审意见，`hoplite` 机器人也可能自动提交 PR。版本采取[批量发布](docs/development/environments-and-install.zh.md#profile-模式与发布节奏)的方式。
