# dsh-agent-team 领域词汇

[English](domain-model.md) | 中文

## Agent Team

一个 dshHome 内唯一的共享协作域。Agent Team 保存跨 Member 的协作事实；Member 的模型上下文、session transcript、私有记忆都不在共享之列。

## Team manager

Host 持有的普通 DSH Session，帮助 Human 理解和管理 Agent Team。它不是 Member：没有 Member ref、Workspace 参与关系、Claim 或 Member Inbox，它的对话也不是 Team 事实。

它使用隔离的 `team-manager` preset。Session 生命周期与私有资源见 [Workspace 与 Session storage](architecture/workspace-session-storage.zh.md#team-manager-session)，工具见 [Tools 与 preset](architecture/tools-and-preset.zh.md#team-manager-preset)。

## Member

Agent Team 中可被授权读取、发言、认领并接收 Inbox 提示的稳定身份，Member 以不可变的 member ref 标识。私有记忆、skills、persona 与 model 是 Member 一级的全局事实，不按 workspace 存放。首版有 Human Member 和 Agent Member 两类。

## Workspace Participation

Agent Member 与 Workspace 之间持久的加入／退出关系。现行规则下，参与 Workspace 即可读取其中的 Project；enabled 的参与者可以协作，但发起或提升 Thread 还要求 Project owner 身份。不再有需要另行加入的 Project 成员关系。

Member 的不可变 `workspaceId` 记录创建 Workspace。加入其他 Workspace 不移动或新建 Session：Member 保留一条 Session 血统，通过 `working_directory` 切换工作目录。Human 可以访问每个 Workspace。路由规则见[协作模型](team-collaboration/model-and-time.zh.md#协作模型)。

## Human Member

对应当前 Harness 用户的特殊 Member。Human Member 参与消息、claim 与 activity。它拥有 project、Member、验收和 task 终态的管理权限。

## Agent Member

由 Team 创建并管理的 Member，同一时刻只运行一个使用 `team-member` preset 的 live Session。创建 Workspace 固定其 Session 血统；Workspace 参与关系让同一身份可以在其他地方协作。普通 Session 与 fork 不会自动获得 Team 身份。

## Worker Execution

Team 持有的一次原生 Codex 或 Claude 会话执行，以 `worker:` ref 标识。它记录发起 Member、Project、可选 Thread 与 Task、引擎、cwd 和执行结果。Worker 没有 Team 身份，不能代替发起者认领、验收或作答。

steer 向同一原生会话追加输入。已结束执行的续跑会建立新执行，以 `continuedFrom` 关联前驱，不改写前驱记录。调用规则见 [Worker 工具契约](team-collaboration/tools.zh.md#team_worker)，执行与原生记录处理见 [Host authority](architecture/host-authority.zh.md#worker-委派)。

## Member Capabilities

Member 上持久保存的能力意图，字段为可选的 `capabilities.tools.allow` 和 `capabilities.skills.allow` 列表。意图不等于实际工具或 skill 集合：当前注册、preset 限制与 Host 策略也参与决定。未知名称产生运行时警告，不会让旧 ledger 记录失效。执行约束与隔离 skill 目录见 [Host authority](architecture/host-authority.zh.md#member-capabilities-与-skills)。

## Workspace

共享工作目录与授权域。Agent Member 的 session header cwd 是创建 Workspace 的目录，永不改变；它实际工作的目录属于 Session 自己，可通过 `working_directory` 切换。Member 私有记忆不存放在 Workspace 目录中。

## Workspace Rules

每个 Workspace 一份 Team 自有的文件，放在所有仓库之外，只装这支 Team 在那里共享的约定。它注入给该 Workspace 的每个参与 Member，以及作为主编的 team manager；它低于仓库的 `AGENTS.md`，也不是 Team 事实。注入规则见 [记忆与上下文](team-collaboration/memory-and-context.zh.md#workspace-规则)。

## Project

Workspace 内持久的协作场所，包含一个 Main stream 与单层 Thread。

现行规则区分三种关系：

| 关系 | 含义 |
| --- | --- |
| Workspace 参与关系 | 可以读取 Project 内容，enabled 时可以协作 |
| Project owner 身份 | 可以发起或提升 Thread，并管理 Project 订阅 |
| follow | 接收普通更新的 Attention，不授予访问权限 |

Human 隐式拥有每个 Project。Agent owner 可以有 Project 专属的 `responsibility`：写入前去除首尾空白，至多 2,000 字符；它不同于 Member 的全局 description，也不同于 Project 的共享 description。没有填写表示未说明，不是错误。

Main stream 是所有 Thread 之外的会话。其 Message 带 `scope: 'main'`，不属于 Thread 或 Task；回复只能指向同一 Project 的另一条 Main stream Message。Thread 也会以当前状态卡片出现在其中。读取卡片的 Main 条目，不等于读取该 Thread。

规则版本 9 以 Workspace 访问权限和 own/follow 关系取代派生的 Project 成员关系。版本 10 让 Task 创建与提升接受和 transfer 相同的 accountable 目标。当前 ledger 规则版本为 10；采用规则与历史兼容由[规则版本与重放](architecture/host-authority.zh.md#规则版本与重放)维护。

发现地址与发言见[工具契约](team-collaboration/tools.zh.md)，Main stream 未读规则见 [Attention 与消息](team-collaboration/attention-and-messaging.zh.md#main-stream-attention)。

## 订阅（Subscription）

Project 持有的脚本定义，由 Host 在没有 Member Session 的情况下按间隔或 webhook 触发运行。持久定义包括脚本快照、credential 引用（不存 credential 值）、revision，以及 `active`、`paused` 或 `deleted` 状态。

接受的事件按订阅与 event id 去重，再作为定向的 Main stream 记录发布，而不是 Message。暂停不丢弃已接受事件；删除与 Project 归档阻止后续接受和发布。

Project owner 与 Human 管理订阅。参数和结果见[工具契约](team-collaboration/tools.zh.md#team_subscription)，调度、沙箱与私有运行历史见 [Host authority](architecture/host-authority.zh.md#订阅调度与无人值守执行)。

## Message

Member 在 Project 或已有 Thread 中显式发出的不可变内容。Thread 由 `startThread` 创建，Main stream 消息从不创建 Thread：`postMainMessage` 写出的 Main stream Message 不属于任何 Thread，`startThread` 才写出 Thread 的 anchor。启动的 Thread 是 discussion，`kind: 'task'` 时才同时带上 Task；taskless Thread 之后可经 Human promotion 获得 Task。Thread Message 只延续已有 Thread。每条 Message 携带提交 operation 的 wall-clock 时刻；agent-facing 表面在固定的 UTC+8 协调时区下渲染该时刻。

## Task

Thread 上可选的工作跟踪层。owner 可以通过 `kind: 'task'` 同时创建，也可以把既有 taskless Thread 提升为 Task。提升记录一条结构化的 `promote` Activity，不额外写散文 Message。

Task 有显式的 resolution（`open`、`accepted`、`closed`）与投影得到的 status。open 时从 Claim 推导 `todo`、`in_progress` 或 `in_review`；accepted 与 closed 的 Task 分别显示为 `done` 和 `closed`。验收不是 Claim 状态。状态转换见[协作模型](team-collaboration/model-and-time.zh.md#协作模型)。

一个 accountable Member 承担责任，Claim 承担执行。规则版本 10 下，创建或提升可以指定 transfer 接受的任意目标；省略则由创建者负责。转交不移动 Claim。验收、转交、close 与 reopen 权限见 [Task 权限](team-collaboration/boundaries.zh.md#ownership-与-task-权限)。

`Task #N` 是 Project 内持久的 Task 创建序号，计入带 Task 的 Thread 创建和后续提升。taskless Thread 更早的位置不决定编号。稳定身份是 `taskRef`，不是显示编号。

`sourceThreadRefs` 不可变地指向同一 Project 内的 taskless 来源讨论。Task 在来源中显示为只读的当前状态卡片，而非 Main stream 卡片。

## Thread

Project 内独立的单层公开协作 aggregate：一定有 `threadRef`、anchor Message 和 revision，但可以没有 Task。Thread revision 随公开 Message 递增，Taskful Thread 的 Claim 变化和 Task resolution 也一样。往既有 Thread 公开写入时，必须带上该 Thread 的当前 revision。taskless Thread 仍支持 reply、follow、structured mention、Inbox、read 与 history，但没有 Claims、Task status 或 accept/close/reopen。协作读写定位优先用 `threadRef`。Host 也将 `taskRef` 解析到其 taskful Thread。Task/Claim 仍用 `taskRef`；action 地址要求见[工具契约](team-collaboration/tools.zh.md)。revision 是内部并发令牌，只在工具 baseRevision 里透传，不写进消息正文当引用事实。

绑定 Worker 执行的开始与终态是两条公开 Thread 事实，但不推进 revision：它们不改变 Thread 状态，所以落在 revision 之后；read 的确认界限取 Thread 的事实头部，不是这个数（见[`team_thread`](team-collaboration/tools.zh.md#team_thread)）。

## Claim

Member 针对 Task overlay 里某个 Direction 做出的工作承诺。taskless Thread 没有 Claim。Claim 的状态不是 active、done，就是 released；同一个 Task 里，规范化后相同的 Direction 至多有一个 active Claim。多个 Claims 是 dsh 对 Raft 单 owner 的刻意偏离：文本不同，也可能讲的是同一份工作。

## Direction

Claim 的自由文本工作方向。比较时依次做 NFKC 规范化、去除首尾空白、压缩空白和转小写；不推断同义词。

## Thread Attention

一个 Member 对一个 Thread 的私有而持久的关注：记下当前关注周期的起点和连续的 read watermark。只要这个关注存在，就是 follow；它不进入公开 Thread revision。周期的开始与结束规则见 [attention-and-messaging.zh.md](team-collaboration/attention-and-messaging.zh.md)。

## Thread Inbox

Member 的协作未读投影，包含 Thread 与 Main stream 未读、direct marker 和私有提醒。它不是 Session 队列、浏览器状态或逐 Message 已读表。派生与投递见 [Attention 与消息](team-collaboration/attention-and-messaging.zh.md)，模型侧分流见[工具契约](team-collaboration/tools.zh.md#team_inbox)。

## Follow

Follow 是 Thread Attention 的一种操作语义：不是独立的持久对象，也不是旧版 Delivery 订阅。普通 Thread 更新是否进该 Member 的 Inbox，由 follow 决定；它不撤销 Project 可见性。unfollow 在没有 active Claim 时结束当前 Attention 周期。

## Activity

Agent Team 记下的协作状态事实。Claim create/done/release 与 Task accept/close/reopen 是公开、revisioned Thread timeline facts。follow/unfollow 与 read-watermark 是 Attention audit facts，不进入公开协作时间线。Agent runtime error 可以摆在 Human UI 上当当前风险看。但它不是 ledger Thread Activity，也不是 Agent Inbox 事实。

## Inbox Hint

Host 从 durable Thread Inbox 状态里给 Agent 派生出的安全边界提示。提示有界：能唤醒 idle Agent，也能在 running Agent 的下一个安全步骤送达；它不代表模型已经读取、处理、回复或验收。恢复后照 durable unread 重新派生。

## Member Reminder

Member 对自己作出的持久时间约定，不绑定 Session、Thread 或 Workspace。每个提醒只有一位收件人，包含 note、`once`、`every` 或 `cron` 日程，以及 `active`、`done` 或 `cancelled` 状态。

每次到期产生一个 occurrence。循环提醒的新 occurrence 替换尚未消费的旧 occurrence，不叠加。与 Thread 未读不同，只有实际渲染了它的通知进入 turn 时才消费它。被省略的 occurrence 仍待送达；消费写入失败时也一样。

暂停期间继续计时，恢复后送达；归档或删除 Member 会取消提醒。日程限制、重试身份与管理见[提醒工具](team-collaboration/tools.zh.md#team_reminder)。

## Operation

Agent Team ledger 里一次不可变的原子业务提交。每个 Operation 有全局递增 sequence、稳定 operation id、幂等 request id、actor、一种业务事实和一个 wall-clock `occurredAt`。顺序与并发 authority 是 sequence，绝不是时刻。Thread fact envelope 会投影提交 operation 的时刻，让每条 fact 在任何重读路径上只看到一个值。

## Revision

最近一次改变 Thread 状态的写入所对应的全局 operation sequence。它是并发栅栏，不是 Message 数量，也不一定等于最新公开事实的序列号：Worker 开始／结束事实不推进它。工具把它渲染为 next-write token；按[写入栅栏](team-collaboration/boundaries.zh.md#mutation-fences)原样复制到 `baseRevision`。

## Ref

跨重启稳定、带对象类型、调用者拼不出来的标识。Member、Project、Task、Thread、Message、Claim 和 Operation 使用不同的 branded refs。Attention 拿 Member 与 Thread 的组合当标识，不做成调用者能伪造的对象。

## Direct Message

Member 之间的私有直达消息，不属于 Thread。ledger 只追加一条 audit-only 的 `team/dm-sent` operation。requestId 幂等，sender/recipient 必须是同 Workspace 的 enabled Agent Member。projection 有意不变：不产生 Project、Thread、revision、Attention 或 Inbox markers。送达是运行时的瞬时效果。正文以 relay-form user message 走 steer 车道送达：idle 收件人由此开一个 turn，busy 收件人在最近的 step 边界收下。正文里带一行有界的相邻上下文（紧邻上一条往来 DM 的摘要）。注入失败不影响 durable 事实，发送方收到结构化 delivery error，不自动重投。DM 用于快速澄清与状态同步；任务工作、决策和需追溯的内容归 Thread。


## Runtime Presence

Agent Member 在进程内的可用性投影，不是 ledger 事实。它取以下四态之一：

- available（live idle）；
- working（Agent loop running）；
- error（当前 loop/tool failure，保留到下一次 loop 启动）；
- unavailable：无可用 AgentHandle，或 lifecycle/setup/resume 阻止调用。这也包括 context rollover 的短暂窗口：ledger 绑定已迁移、新 Session 尚未就绪。

列表按状态点呈现，和 Claim 状态分开。

## Member Diagnostic（成员诊断）

presence/availability 行不正常时，背后的结构化原因（绝不持久化）：

- `session-refused`：激活所需 Session 的确定性格式拒绝。可携带被拒 artifact 路径，以及一次修复尝试是否证明存在可修内容。
- `session-unreadable`：missing、corrupt、io 或 unknown 的 Session 读取失败。
- `preset-composition`：preset 装载/校验失败，通常是安装与运行时分裂。
- `rollover`：换窗的短暂提交窗口。
- `runtime`：运行中的 loop 或 compaction 失败。
- `activation`：未分类的激活失败。

`class` 决定哪种恢复动作管用。没法修的拒绝和换窗窗口不给重启，其他的都可以用重启试着恢复。

## Context Generation（上下文代际）

一个 Member Session 的两个代际边界之间的工作上下文。全新代际收到当前 Member 背景和唤醒消息，不收到换代公告；背景内容见 [Member 上下文注入](team-collaboration/memory-and-context.zh.md#member-上下文注入)。ledger 记录当前绑定（每个 Member 恰好一个）以及最近一次 transition 的上一 Session；上下文历史保存在 Session 日志中。每代保留 Member 身份、模型、私有记忆、skills、Claims 和 Attention。

换代完全是 Host 的决定，在唤醒边界做出。旧日志里仍可能带着早先版本写下的 checkpoint 锚点、rollover 对或 pending 意图；折叠层继续解码它们，让旧 ledger 与旧 Session 日志仍可读回，但当前构建不再产生其中任何一种。

## Suspend

把 Agent Member 的 live Agent 暂挂起来。成员身份、session、claims、Thread Attention、未读状态和私有 memory 都留着。Resume 回到同一个 session，要不要重新提示 Inbox，看 durable unread。

## Withdraw

从一个 workspace 离开：`team/member-workspace-left` 结束 Member 在该 workspace 的参与——随之结束参与所承载的一切 Project 权利。释放该 workspace 的 active claims 并清除其 Thread Attention。其余一切——Member 身份、其他参与、live session 及其 cwd、私有 memory——都不受影响。创建 Workspace 不可撤回，应改用全量归档。UI 把它放在非创建 workspace 的行上，当破坏性动作。

## Archive

藏在 Suspend 和 Remove 之间的第三态，Member 和 Project 都适用。设计上它可逆。事实完整留在 ledger 里，供重放和未来恢复。但本轮刻意不提供 restore 入口，与 dsh 的 archived session 对齐。`archiveMember` 放掉 live session。私有 memory 和 Session log 留在磁盘。它同时以一条公开 `claims_released` Activity，放掉全部参与 workspace 里的 active Claims。`archiveProject` 让 Project 上所有 Thread 的 owner 走同样的释放。规则版本 9 之前派生的 Project 成员关系作为已存事实在归档后保留（隐藏态，非退出）。Archived 实体从所有 Team API surface 消失。projection、mention 候选、ref 解析、ref-addressed read，一律以明确的 archived 错误拒绝。从 archived 状态 Remove 仍可以当数据清理用。

## Remove

把 Agent Member 不可逆地停用。Remove 释放 active claims、结束 Thread Attention、删除私有 memory、归档 session。历史 Message、Activity 和身份快照永久保留。

## Member Lifecycle

每个 durable Member state 的外部期望状态，一张表就够定义。每次 lifecycle operation 在 commit 后跑的正是这组 effect，Host 启动时也会给每个 Member 重跑一遍。所以 commit 和 effect 之间 crash 了、effect 失败了，重跑同一条推导就能收敛：

| State | Live handle | Session grouping | Private memory |
| --- | --- | --- | --- |
| `enabled` | 一个，运行在记录的 binding 上 | active | 保留 |
| `suspended` | 无；resume 恢复同一 Session | 保留 | 保留 |
| `archived` | 无 | 归档（隐藏），log 留在磁盘 | 保留 |
| `inactive` | 无 | 归档 | 删除 |

每一步都只从 durable state 推导：crash 或调用失败后重跑，只补还欠的步骤，绝不再写一遍 durable 状态。
