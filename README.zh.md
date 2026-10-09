# dsh-agent-team — DeepSeek Harness 持久 Agent 团队

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@contexera/dsh-agent-team?style=flat-square)](https://www.npmjs.com/package/@contexera/dsh-agent-team)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Contexera/dsh-agent-team?include_prereleases&style=flat-square)](https://github.com/Contexera/dsh-agent-team/releases)
[![Listed on Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/wowyuarm/dsh-agent-team/)

**dsh-agent-team** 给 DeepSeek Harness 一批不会归零的 Agent。每个 Agent 是持久的 Member，带着自己的 memory、notes 与 skills——上周你配好的成员，这周还是它，哪怕会话结束、上下文 rollover 或 DSH 重启过。方向由你定；Workspace 按项目组织团队，Channel 路由职责，Task Thread 保持一条推进线。

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的按需启用插件：只在需要 Team mode 的 profile 安装，普通 DSH Session 保持原有 preset roster。

## 核心想法

- **Agent 是 Team 的一等成员，不只是会话。** 每个 Agent 成员有自己的记忆与职责边界，以及私有空间——memory、notes 与 skills 单独维护；同时所有 Agent 在同一个共享项目 Workspace 下协作，多 Workspace 可管理多支 Team。
- **Workspace 组织一切。** 不同项目放在不同 Workspace，各自管理自己的 Agents 与 Channels。
- **Human 管 Channel 与职责。** 你决定谁在哪个频道、负责什么；@提及把工作路由到对的 Agent。
- **Task Thread 串联推进。** 用 Task 认领方向、Thread 保持上下文，多个 Session Agent 围绕同一条工作线推进而不散乱。工作事实落在同一条 Thread 里，成员之间不会各说各的。
- **无需操心上下文。** 上下文由成员自己管理：刷新到新上下文继续待命（`context_rollover`），回到过去的锚点（`context_status` / `context_checkpoint`），或就地缩短当前上下文（`context_compact`），切换与重启都不丢待决事项；memory 与 notes 持续沉淀，成员带着完整记忆进入新上下文。

## 预览

Team mode 就在普通 DSH Web UI 里：Channel 承载讨论，收件箱收拢需要你的事项，Task Thread 把一条工作线保留在同一条上下文里。

![DSH Web UI 中的 Channel：成员名单、@提及与消息流中的 Task 引用](assets/readme/channel.png)

Human 收件箱把需要你的未读 Thread 置顶，其下是最近活跃：

![DSH Web UI 中的 Human 收件箱：需要你的未读 Thread 在上，最近活跃的 Thread 在下](assets/readme/inbox.png)

### Task Thread

Task Thread 把 Claim、Agent 交接、Human 验收和后续回复保留在同一条可长期阅读的上下文中。

![DSH Web UI 中的 Task Thread：含 Claim、Agent 交接、Human 验收活动和回复 composer](assets/readme/task-thread.png)

如果觉得有用，欢迎在 [GitHub](https://github.com/Contexera/dsh-agent-team) 点个 star，帮更多 DSH 用户发现它。

## 快速开始

### 1. 检查 DSH

当前版本已针对 DSH `0.2.0-rc.2` 完成认证。请显式指定 DSH 版本，而不要跟随 `latest`：不指定版本时可能解析到本 bundle 声明区间之外的宿主线。若你的 DSH 是 `0.1.7-rc.2`，请停留在 `@wowyuarm/dsh-agent-team` `0.1.15`。若你的 DSH 是 `0.2.0-rc.1`，请停留在 `@wowyuarm/dsh-agent-team` `0.2.0`。

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

需要下面步骤里的 `dsh` 命令就全局安装：`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`。

先停止它，再把 Agent Team 安装到 `web` profile：

```sh
dsh plugin --profile web add @contexera/dsh-agent-team@0.2.2
```

这里刻意写明确切版本：pnpm 会跳过发布不满 24 小时的版本，不带版本号的 `@latest` 在发布当天会装到上一版。

本插件的 npm 包名是 `@contexera/dsh-agent-team`，仓库在 `Contexera/dsh-agent-team`。旧的 `@wowyuarm/dsh-agent-team` 停在 0.2.1，已标记废弃并指向新名；profile 换插件名即可，数据无需迁移。

### 2. 启动 Web UI

```sh
dsh web
```

不要从 DSH 源码 checkout 启动（`pnpm dsh web`）：源码模式会加载第二份 scope 模块，所有成员都会报 `selected preset is not team-enabled`。请始终使用编译产物启动。

Agent Team 是显式 opt-in 的。安装只会把 bundle 加入 `web` profile，不会修改 Harness 安装，也不会修改 shipped defaults。

### 3. 验证并开始使用

启动 UI 前可以检查 profile 的实际组装结果：

```sh
dsh --profile web --dump-config
```

输出中应包含 Team rows，例如 `wowyuarm-agent-team-scope` 和 `wowyuarm-agent-team-client`。打开浏览器后，从 DSH 导航进入 **Team mode**。第一次可以按下面的路径操作：

```text
Team mode
└── 选择一个 Workspace
    ├── Channels -> 新建频道 -> 发送第一条消息
    └── Agents   -> 添加 Agent -> 选择初始频道
```

只在可信 Workspace 中创建 Agent。Team Member preset 会给被管理的 Agent Session 授予 `danger-full-access`。

## 与同名插件的区别

另外三个 DSH 插件名字相近，但解决的是不同的问题 —— 其中一个可能更适合你：

| 插件 | 它是什么 | 工作单位 |
| --- | --- | --- |
| [`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | 把**当前** DSH session 变成 captain，由它组建 sub-agent、把目标拆成带依赖的任务、并通过直接通信协调 | 一个 **session** |
| [`toolclub/dsh-agent-team-gui`](https://github.com/toolclub/dsh-agent-team-gui) | 可复用的「规划 → 实现 → 评审」团队，每个成员可选不同模型，Run Center 查看 token 用量 | 一次 **workflow run** |
| [`limuyang2/agent-team`](https://github.com/limuyang2/agent-team)（npm 名 `@limuyang2/dsh-agent-team`） | 在一个 DSH 窗口里组一支独立 root agent 的队：混用模型与 provider、指定一个 Leader，每个成员在自己的会话里工作、共享同一个 Workspace | 一支**组起来执行任务的队** |
| **`dsh-agent-team`**（本插件） | 每个 agent 是持久 Member 身份，带自己的私有记忆、笔记与技能；Channel 与职责由你分配，Task Thread 是一条进度线 | 一支**常驻团队** |

实际差别：你上周创建的 Member，今天还是同一个 Member —— 同样的记忆、职责和私有笔记 —— 即使它的 session 已结束、上下文已滚动、或 DSH 重启过。另外三个里，团队是围绕手头这次工作组建的 —— 一次 session、一次 workflow run，或一支有 Leader 的队。

## 卸载

从 profile 移除 bundle，同时会移除它组合进来的层：

```sh
dsh plugin --profile web remove @contexera/dsh-agent-team
```

## 提供的能力

- 持久化的单 Host Team，包含 Channel、Message、Task、Thread、Claim 和 Agent membership。
- 面向 Human 的 Web Client 控制界面：创建 Channel 和 Agent、管理成员、发送 Message、打开 Thread、处理 Task。
- 隔离的 `team-member` preset，以及五个面向模型的工具：`team_inbox`、`team_thread`、`team_message`、`team_claim`、`team_view`。
- 拉取式协作协议。Agent Inbox admission 是持久化事实，但不表示模型已经处理了更新。

一个 DSH home 对应一个 Team 协作域。append-only operation ledger 是权威；UI、Remote response、tools、Inbox 和其他 projection 都从已提交的 operation 派生。普通 DSH Session 继续使用 profile 原有 preset roster，不会获得 Team tools 或 guidance。

## 从本地 checkout 安装

开发时，可以把本地 bundle 安装到同一个 profile：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-agent-team
dsh web
```

发布包已经包含构建产物。只有开发检查需要相邻的 Harness repository，终端用户安装不需要它。

## 开发

贡献指南：[`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md)——怎么提改动、CI 会跑什么、PR 里要写什么。

维护中的文档入口是 [`docs/README.zh.md`](docs/README.zh.md)。常用检查命令：

```sh
corepack pnpm install
npm run typecheck
npm test
npm run build
npm run lint
npm run test:browser
npm pack --dry-run
```

`npm run test:browser` 使用相邻的 `../deepseek-harness` checkout、隔离临时 profile 和 `/usr/bin/google-chrome`（可用 `CHROME_PATH` 覆盖），不需要 provider credentials。手动检查时，`npm run preview:ui` 会加载不调用模型的 Team fixture；`DEEPSEEK_API_KEY=... npm run preview` 会启动真实 provider preview。两个 preview 命令都会在 `Ctrl+C` 后清理临时状态。

架构和协作协议见 [`docs/architecture/README.zh.md`](docs/architecture/README.zh.md) 与 [`docs/team-collaboration/README.zh.md`](docs/team-collaboration/README.zh.md)。

## 致谢

dsh-agent-team 的协作形态——具名 Agent 成员、Channel、Task Thread、@mention 路由与成员级记忆——来源于 [Raft](https://raft.build/) 并借鉴了它的若干设计。感谢他们的工作。

## 许可证

[MIT](LICENSE)
