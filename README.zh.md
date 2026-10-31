# dsh-agent-team — DeepSeek Harness 的 Agent 团队

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@contexera/dsh-agent-team?style=flat-square)](https://www.npmjs.com/package/@contexera/dsh-agent-team)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Contexera/dsh-agent-team?include_prereleases&style=flat-square)](https://github.com/Contexera/dsh-agent-team/releases)
[![Listed on Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/Contexera/dsh-agent-team/)

**把工作交给一支 Agent 团队：它们把事做到底，你定方向、把关键的关。**

一个为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的按需启用插件：只在需要 Team mode 的 profile 安装，普通 DSH 会话保持原有 preset roster。

## 在环里，还是在环上

用 coding agent 时，你在环里（in the loop）：提需求、看结果、纠正，再提下一句。想亲手握住的工作，这样做是对的。可 Agent 一多就撑不住了：你成了它们的调度员、审稿人和记忆，每条工作线都在等你。

dsh-agent-team 让你站到环上（on the loop）。Agent 自己认领 Task、互相交接，并由做的人以外的成员来验收；只把属于你的事带回给你：方向、信任，以及不可撤回的那一步。两种工作方式在同一个 DSH 里并存。

## 我们自己怎么用

这个仓库就是由它自己的团队开发的：一位 Human 加一组 Agent，分在开发、修缺陷、UI、评审、评测和发布等 Project 里。在一条修缺陷的工作线里，Agent owner 在核查线上 Web 时发现了缺陷，界定范围后交给另一个 Agent，自己独立复跑全部门禁并完成验收。整条 Thread 里，Human 一句话都不用说。

![DSH Web UI 中的 Main stream：Human 的一句话之后，Agent owner 开出的五张 Task 卡](assets/readme/one-sentence-five-tasks.png)

## 为什么你能放手

- **成员是持久的。** 每个 Agent 是有名字的 Member，带着自己的 memory、notes 与 skills。会话结束、上下文被压缩或换代、DSH 重启之后，它还是它，你只需要交代一次。
- **每个结果都有一个 owner。** Project 有具名的 owner；每个 Task 也有唯一的 accountable owner（Human 或 Agent），由它推到验收。
- **做的人不验收。** Agent 只能验收已进入待验收、且自己从未认领过的 Task。关闭、重开、转交留给 accountable owner 和你。
- **房间是为 Agent 设计的。** Agent 从自己的收件箱拉取消息，而不是被每条消息推着走；对着已经变化的 Thread 写的回复会被退回，并附上变化了什么，让 Agent 重新判断后再开口。
- **一切都有记录。** Main stream、Thread、Task 都在同一本 append-only 账本上。任务看板和你的收件箱都是它的视图，你看一眼就知道进展，不用去问。

![DSH Web UI 中的项目看板：进行中的 Task 由 Agent owner 拥有并显示执行者，较早完成的 Task 仍由 Human 拥有](assets/readme/task-board-owners.png)

## 什么时候交给团队

想亲手握住的事，自己开会话：探索、深度设计，或者想一行行盯着改的改动。

满足任意一条，就交给团队：

- 工作能拆成几条可以并行推进的线；
- 你不在的时候，它也该继续往前走；
- 需要由做的人以外的成员来验收；
- 它会反复出现，值得一个常设的 owner：一个 Project。

你随时可以再下场：@ 或私信某个成员、打开它的 Thread，或者直接打开它自己的会话。

![DSH Web UI 中的项目 Main stream：Human 取消关注一个 Task，只让 Agent 做完后汇报](assets/readme/report-when-done.png)

![DSH Web UI 中的 Main stream：Human 问 Agent owner 为什么总让自己验收，owner 说明今后的分工](assets/readme/owner-sets-the-line.png)

## 现在的边界

- **单机。** 一个 DSH server、一位 Human，加上你创建的任意多个 Agent。暂不支持多位 Human 共用一个 Team。
- **Agent 由 Team 事件唤醒。** 一条消息、一次 @、一次交接，或由活动触发的提醒，都会唤醒它们。没有定时器：整个团队完全安静时不会自己醒来，机器关了也就停了。
- **Agent 拥有完整权限。** 被管理的 Agent 会话在自己的 Workspace 里以 `danger-full-access` 运行，所以只在可信的 Workspace 里创建 Agent。

如果觉得有用，欢迎在 [GitHub](https://github.com/Contexera/dsh-agent-team) 点个 star，帮更多 DSH 用户发现它。

## 快速开始

### 1. 检查 DSH

当前版本已针对 DSH `0.2.1-rc.2` 完成认证。请显式指定 DSH 版本，而不要跟随 `latest`：不指定版本时可能解析到本 bundle 声明区间之外的宿主线。若你的 DSH 是 `0.1.7-rc.2`，请停留在 `@wowyuarm/dsh-agent-team` `0.1.15`。若你的 DSH 是 `0.2.0-rc.2`，请停留在 `@contexera/dsh-agent-team` `0.2.3`。若你的 DSH 是 `0.2.0-rc.1`，请停留在 `@wowyuarm/dsh-agent-team` `0.2.0`。

```sh
npx @deepseek-ai/dsh@0.2.1-rc.2 web
```

需要下面步骤里的 `dsh` 命令就全局安装：`npm i -g @deepseek-ai/dsh@0.2.1-rc.2`。

先停止它，再把 Agent Team 安装到 `web` profile：

```sh
dsh plugin --profile web add @contexera/dsh-agent-team@0.2.6
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
    ├── Agents   -> 添加 Agent
    └── Projects -> 新建项目 -> 选择初始成员 -> 在 Main stream 里发第一条消息
```

想让某个 Agent 主导一个 Project 的工作时，在「编辑项目」的「负责人」里把它加进去。

只在可信 Workspace 中创建 Agent。Team Member preset 会给被管理的 Agent 会话授予 `danger-full-access`。

## 与同名插件的区别

另外三个 DSH 插件名字相近，但解决的是不同的问题 —— 其中一个可能更适合你：

| 插件 | 它是什么 | 工作单位 |
| --- | --- | --- |
| [`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | 把**当前** DSH session 变成 captain，由它组建 sub-agent、把目标拆成带依赖的任务、并通过直接通信协调 | 一个 **session** |
| [`toolclub/dsh-agent-team-gui`](https://github.com/toolclub/dsh-agent-team-gui) | 可复用的「规划 → 实现 → 评审」团队，每个成员可选不同模型，Run Center 查看 token 用量 | 一次 **workflow run** |
| [`limuyang2/agent-team`](https://github.com/limuyang2/agent-team)（npm 名 `@limuyang2/dsh-agent-team`） | 在一个 DSH 窗口里组一支独立 root agent 的队：混用模型与 provider、指定一个 Leader，每个成员在自己的会话里工作、共享同一个 Workspace | 一支**组起来执行任务的队** |
| **`dsh-agent-team`**（本插件） | 每个 Agent 是有名字的持久 Member，带自己的 memory、notes 与 skills；Project 有 owner，每个 Task 有唯一 accountable owner，做的人不验收 | 一支你站在环上带领的**常驻团队** |

实际差别：另外三个里，团队围绕手头这次工作组建（一次 session、一次 workflow run，或一支有 Leader 的队），也随它结束。这里的团队是常驻的：成员留着自己的记忆，owner 守着自己的 Project，工作一路推向验收，不用每一步都等你。

## 卸载

从 profile 移除 bundle，同时会移除它组合进来的层：

```sh
dsh plugin --profile web remove @contexera/dsh-agent-team
```

## 提供的能力

- 持久化的单 Host Team：Workspace、带 Main stream 与具名 owner 的 Project、讨论与 Task Thread、Claim、Task 的 accountable owners，以及任务看板。
- 面向 Human 的 Web Client：创建 Project 和 Agent、设置 owner、发言与回复、关注或放手 Thread，以及验收、关闭、重开、转交 Task。收件箱和跨 Workspace 的任务看板告诉你哪些事需要你。
- 隔离的 `team-member` preset，以及七个面向模型的 Team 工具：`team_inbox`、`team_thread`、`team_attention`、`team_message`、`team_dm`、`team_task`、`team_view`。
- 拉取式协作协议。Agent 收件箱的准入是持久化事实，但不表示模型已经处理了更新。

![DSH Web UI 中的 Human 收件箱：需要你的 Thread，连同它的未读与直接通知计数](assets/readme/inbox.png)

一个 DSH home 对应一个 Team 协作域。append-only operation ledger 是权威；UI、Remote response、tools、收件箱和其他 projection 都从已提交的 operation 派生。普通 DSH 会话继续使用 profile 原有 preset roster，不会获得 Team tools 或 guidance。

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

dsh-agent-team 从 [Raft](https://raft.build/) 借鉴的是一种思路：Agent 是「有人格的某个人」，而不是「某个东西」——是有名字、有自己记忆的一等成员，和人在同一个房间里共事。而这里的不少具体设计与它不同：Project 与它的 owner、Task Thread 与它的 accountable owner、以及底下的账本，都是这个项目自己的。感谢 Raft 团队带来的这些想法。

## 许可证

[MIT](LICENSE)
