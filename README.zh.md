# dsh-agent-team — DeepSeek Harness 的 Agent 团队

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/@contexera/dsh-agent-team?style=flat-square)](https://www.npmjs.com/package/@contexera/dsh-agent-team)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Contexera/dsh-agent-team?include_prereleases&style=flat-square)](https://github.com/Contexera/dsh-agent-team/releases)
[![Listed on Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/Contexera/dsh-agent-team/)

**把工作交给一支常设的 Agent 团队。你定方向，保留需要你拍板的决定。**

Agent Team 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的可选插件。只在需要团队模式的 profile 中安装即可，普通 DSH Session 仍使用原有 preset。

## 亲自推进，还是把方向

用编码 Agent 时，你往往亲自参与每一步（in the loop）：提需求、看结果、纠正偏差，再决定下一步。需要亲自掌控的工作就适合这样做。但 Agent 一多，分工、审查和传递上下文都落在你身上，每条工作线都得等你。

dsh-agent-team 让你把重心放在监督和决策上（on the loop）。Agent 自己认领 Task、互相交接，再由没有参与执行的 Member 验收。定方向、决定信任谁、批准不可撤销的操作，仍由你负责。两种工作方式可以在同一个 DSH 实例里并存。

## 我们自己怎么用

这个仓库由一位 Human 和一组 Agent 共同开发，按开发、缺陷修复、UI、评审、评测和发布等 Project 分工。有一次，负责缺陷修复的 Agent 在检查运行中的 Web 界面时发现问题，明确范围后把修复交给另一位 Agent，再独立复跑检查并验收。整条 Thread 都不需要 Human 介入。

![DSH Web 界面中的主对话：Human 发出一条消息后，负责 Project 的 Agent 开出了五张 Task 卡](assets/readme/one-sentence-five-tasks.png)

## 为什么可以放心交给团队

- **Member 的身份会保留。** 每个 Agent 都是具名的 Member，拥有自己的记忆、笔记和技能。即使 Session 结束、上下文压缩或换代，或者 DSH 重启，这些也会随 Member 保留。
- **结果有人负责。** Project 有明确的负责人；每个 Task 也由一位 Human 或 Agent 负责推进到验收。
- **Agent 不验收自己做过的事。** Agent 必须是 Project 负责人或该 Task 的负责人，才能验收已进入待验收状态、且自己从未持有过 Claim 的 Task。关闭、重开和转交由 Task 负责人或 Human 操作。
- **Agent 按需读取消息。** Agent 主动查看自己的收件箱。若写回复时所依据的 Thread 已有更新，系统会拒绝发送并告知变化，由 Agent 重新判断如何回复。
- **进展有据可查。** 主对话、Thread 和 Task 都记在同一本只追加的账本上。看板和收件箱据此显示进展，不用另行追问。

![DSH Web 界面中的看板：进行中的 Task 由 Agent 负责，并显示执行者；较早完成的 Task 仍由 Human 负责](assets/readme/task-board-owners.png)

## 什么时候交给团队

探索问题、深入做设计，或想逐行审视改动时，可以自己开一个 Session。遇到以下情况，可以把工作交给团队：

- 工作可以拆开，并行推进；
- 你不在时，工作也需要继续；
- 需要由执行者以外的 Member 验收；
- 工作会反复出现，适合建立 Project，指定长期负责人。

你随时可以介入：提及或私信某位 Member，也可以直接打开相关 Thread 或该 Member 的 Session。

![DSH Web 界面中的主对话：Human 取消关注一个 Task，请 Agent 做完后汇报](assets/readme/report-when-done.png)

![DSH Web 界面中的主对话：Human 问负责 Project 的 Agent 为什么总请自己验收，Agent 说明今后的分工](assets/readme/owner-sets-the-line.png)

## 现在的边界

- **一个 Host，一位 Human。** 暂不支持多位 Human 共用一个 Team。
- **通知和定时计划可以唤醒 Agent。** 消息、提及和交接都可能通知 Member；Member 的提醒和 Project 的订阅也会按计划运行。没有事件或启用的定时计划时，Team 不会自行唤醒；Host 停止运行后也不会继续执行。
- **Agent 以完整权限运行。** 受管理的 Agent Session 在所属 Workspace 中使用 `danger-full-access`，请只在可信的 Workspace 中创建 Agent。

如果觉得有用，欢迎在 [GitHub](https://github.com/Contexera/dsh-agent-team) 点个 Star，让更多 DSH 用户发现这个插件。

## 快速开始

### 1. 检查 DSH

此版本最初针对 DSH `0.2.2-rc.2` 完成认证。按本节操作时，请指定这个版本，不要依赖会变化的 `latest` 标签。其他已认证的版本见[兼容性记录](docs/dsh-release-compatibility.zh.md)。

如果想先试用，不必全局安装 CLI：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.2 web
```

如果启动了试用服务，请先停止。若还没有对应版本的 `dsh` 命令，请全局安装后再继续：`npm i -g @deepseek-ai/dsh@0.2.2-rc.2`。

如果需要保留较早的 DSH 版本：

| DSH | Agent Team |
| --- | --- |
| `0.2.2-rc.1` | `@contexera/dsh-agent-team@0.2.7` |
| `0.2.1-rc.2` 至 `0.2.1-rc.5` | `@contexera/dsh-agent-team@0.2.6` |
| `0.2.0-rc.2` | `@contexera/dsh-agent-team@0.2.3` |
| `0.2.0-rc.1` | `@wowyuarm/dsh-agent-team@0.2.0` |
| `0.1.7-rc.2` | `@wowyuarm/dsh-agent-team@0.1.15` |

### 2. 安装插件并启动 Web 界面

将插件安装到 `web` profile。请使用命令中的确切版本号。

```sh
dsh plugin --profile web add @contexera/dsh-agent-team@0.2.8
dsh web
```

运行已发布的插件时，请使用安装好的 `dsh` 命令。用 Harness 源码启动（`pnpm dsh web`）可能会重复加载 scope 模块，导致 `selected preset is not team-enabled`。

旧包名 `@wowyuarm/dsh-agent-team` 已弃用。如果 profile 中装过旧插件，请替换原有条目，不要同时安装两个包名。更名不需要迁移 Team 数据。

### 3. 验证并开始使用

如果界面没显示团队模式，可以检查 profile 的实际配置：

```sh
dsh --profile web --dump-config
```

输出中应包含 `contexera-agent-team-scope` 和 `contexera-agent-team-client` 等条目。打开浏览器，从 DSH 导航进入 **团队模式**。第一次可以按下面的路径操作：

```text
团队模式
├── 团队管理 → 在专用 DSH 对话中配置团队
└── 选择一个 Workspace
    ├── Agents → 添加 Agent
    └── 项目 → 新建项目 → 选择初始成员 → 在主对话中发第一条消息
```

想让某位 Agent 主导一个 Project 时，请在「编辑项目」的「负责人」中添加它。

只在可信的 Workspace 中创建 Agent。`team-member` preset 会让受管理的 Agent Session 以 `danger-full-access` 运行。

## 与同名插件的区别

这几个 DSH 插件名字相近，但各自组织工作的方式不同：

| 插件 | 用途 | 工作单位 |
| --- | --- | --- |
| [`NanmiCoder/dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) | 让当前 DSH Session 担任队长，调度子 Agent，拆分有依赖关系的任务，并通过私信协调 | 一个 **Session** |
| [`toolclub/dsh-agent-team-gui`](https://github.com/toolclub/dsh-agent-team-gui) | 复用「规划 → 实现 → 评审」流程，为不同角色选择模型，并在 Run Center 查看 token 用量 | 一次**工作流运行** |
| [`limuyang2/agent-team`](https://github.com/limuyang2/agent-team)（npm 包名 `@limuyang2/dsh-agent-team`） | 在同一个 DSH 窗口组建由独立 Agent 组成的团队。可选不同模型和服务商，指定一位 Leader；各自使用独立 Session，共用一个 Workspace | 一支**临时组建的团队** |
| **`dsh-agent-team`**（本插件） | Member 有独立的记忆、笔记和技能；Project 与 Task 有各自的负责人，执行与验收分开 | 一支由你把握方向的**常设团队** |

这里的不同之处在于，Session 结束后，Member 保留记忆，Project 也仍有负责人。下次回来可以接着做，不必每次都从组队开始。

## 卸载

从 `web` profile 移除插件，插件带来的配置也会一并移除：

```sh
dsh plugin --profile web remove @contexera/dsh-agent-team
```

## 提供的能力

- 持久化的单 Host Team：Workspace、带主对话和明确负责人的 Project、讨论与 Task Thread、Claim、Task 负责人以及任务看板。
- Human 可以在 Web 界面创建 Project 和 Agent、设置负责人、发消息、关注或取消关注 Thread，以及验收、关闭、重开或转交 Task。收件箱和跨 Workspace 的看板会提示哪些事需要处理。
- 团队管理使用专用对话。它是 Host 管理的 DSH Session，不是 Member，也不是账本实体。它沿用 Harness 的会话界面和输入框，有自己的私有记忆，也可以选择 **新开对话**。
- 隔离的 `team-member` preset，提供[面向模型的 Team 工具](docs/team-collaboration/tools.zh.md)。可选的 `team_worker` 仅在 Host 打开 Worker 开关时出现。
- Agent 主动读取收件箱。系统会持久保存哪些更新进入了收件箱，这不表示模型已经处理了这些更新。

![DSH Web 界面中的 Human 收件箱：一条待处理的 Thread，旁边标有未读和直接通知的数量](assets/readme/inbox.png)

每个 DSH home 对应一个 Team。账本如何支撑界面与工具，见[架构指南](docs/architecture/README.zh.md)。

## 安装本地构建

本地构建应与使用发布包的 `web` profile 分开。请参阅[开发 profile](docs/development/environments-and-install.zh.md#profile-模式与发布节奏)，按说明配置 `web-dev` 并选择对应的启动方式。

## 开发

- [贡献指南](CONTRIBUTING.zh.md)：如何提出、验证和提交改动。
- [开发指南](docs/development/README.zh.md)：环境配置、检查与预览。
- [文档索引](docs/README.zh.md)：架构、协作机制及其他工程文档。

## 致谢

dsh-agent-team 从 [Raft](https://raft.build/) 借鉴了一个理念：Agent 不只是一件工具，也是有名字、有记忆、能与人持续共事的队友。Project 与 Task 的责任分工以及底层账本，则是本项目自己的设计。感谢 Raft 团队带来的启发。

## 许可证

[MIT](LICENSE)
