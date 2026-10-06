# dsh-agent-team 领域词汇

[English](domain-model.md) | 中文

## Agent Team

一个 dshHome 内唯一的共享协作域。Agent Team 保存跨 Member 的协作事实；Member 的模型上下文、session transcript、私有记忆都不在共享之列。

## Member

Agent Team 中可被授权读取、发言、认领并接收 Inbox 提示的稳定身份，Member 以不可变的 member ref 标识。私有记忆、skills、persona 与 model 是 Member 一级的全局事实，不按 workspace 存放。首版有 Human Member 和 Agent Member 两类。

## Workspace Participation

Member 与 workspace 之间是可 join、可 leave 的关系。每次变动都以 ledger operation 提交。它与 channel membership 是同一种关系形状，位置在其上一级。层级是 workspace participation → channel membership → Thread Attention。Member 的 `workspaceId` 只记录创建地、永不改变。一切授权只看当前参与集合，不看创建字段。加入带来协作能力，但不移动也不创建 Member 的 session。当前每个 Member 只有创建 Workspace 下的一条 Session 血统。新增参与不创建另一条 Session，也不提供 cwd 切换。Member 在其他已参与的 Workspace 中同样可以发言、认领和回复。Human Member 参与每个 workspace。

## Human Member

对应当前 Harness 用户的特殊 Member。Human Member 参与消息、claim 与 activity。它拥有 channel、Member、验收和 task 终态的管理权限。

## Agent Member

由 Agent Team 创建和管理的 Member。Member 在某个 workspace 中创建。这个 workspace 就是 Member 创建记录所载之处。之后通过 Workspace Participation 加入更多 workspace。本轮 Member 仍只运行一个 live Session。它扎根于创建 workspace。按参与切分 Session 血统（每个 workspace 一条、可切换）是后续工作。普通 session 与 fork 不自动获得成员身份。

## Member Capabilities

写在 Member 实体上的持久能力意图（可选 `capabilities` 字段：`tools.allow` 与 `skills.allow`），随全部 lifecycle operation 原样流转，Host restart 后重放恢复。它只是意图（intent）：allow-list 里的名字在 commit 时不做白名单校验——Harness 升级改名或删除工具，都不能让旧 ledger 失去重放能力。与当时已知名字的偏差，在 activation 时变成 runtime warning（`capabilityWarnings`，由投影派生、不持久化：持久化的 warning 会在 Host 重启或升级后失真）。

## Workspace

一个项目及其共享工作目录。Agent Member 的 session cwd 是该 Member 所属 Workspace 的项目目录；Member 私有记忆不存放在项目根目录。

## Channel

Workspace 内的持久协作场所。Agent Member 必须显式加入 Channel 才能读取、发言、认领或 follow。Human Member 可以管理和查看 Workspace 内全部 Channel。

## Message

Member 在 Channel 或已有 Thread 中显式发出的不可变内容。Channel 顶层每条 Message 原子地创建一个 Thread。新 Client/tool 默认创建 taskless Thread，只有显式选择「作为任务」，同一次提交才会附带真实 Task。Thread Message 只延续已有 Thread。每条 Message 携带提交 operation 的 wall-clock 时刻；agent-facing 表面在固定的 UTC+8 协调时区下渲染该时刻。

## Task

贴在既有 Thread 上的一层可选 work-tracking overlay——Thread 不靠它存在。它的原子创建有两种：顶层 Message 的显式「作为任务」意图，或 Human promotion 的后附。promotion 同时追加一条公开说明 Message。 Task 的工作状态从 Claims 派生。Human acceptance 与 closed 是显式覆盖事实。常规验收要全部 Claim 完成（in_review）。Human 也可在 in_progress 时提前验收。accept 会把当时仍 active 的 Claims 投影为 done，并在 activity 里记下 `completedClaimRefs`。owner 各自收到通知。它不伪造 owner 的 claim-done 事件。从未被 claim 的 todo Task 也能直接验收。activity 里没有 claim 列表，账目上如实记为无 Claim 完成。 面向 Human 的 `Task #N` 是 Task 在 home Channel 内的 durable 创建序号。taskful 顶层发送和后续 promotion 均参与排序。taskless anchor 最初在时间线的位置不参与。既有 ledger 的编号保持不变。

它不是稳定身份；跨 Channel 导航和持久引用必须使用 branded `taskRef`。

## Thread

Channel 内独立的单层公开协作 aggregate：一定有 `threadRef`、anchor Message 和 revision，但可以没有 Task。Thread revision 随公开 Message 递增，Taskful Thread 的 Claim 变化和 Task resolution 也一样。往既有 Thread 公开写入时，必须带上该 Thread 的当前 revision。taskless Thread 仍支持 reply、follow、structured mention、Inbox、read 与 history，但没有 Claims、Task status 或 accept/close/reopen。协作读写定位优先用 `threadRef`。released task-only Client 可把 `taskRef` 用作仅限 taskful Thread 的 Host compatibility alias。Task/Claim 操作的身份仍是 `taskRef`。revision 是内部并发令牌，只在工具 baseRevision 里透传，不写进消息正文当引用事实。

## Direct Message

Member 之间的私有直达消息，不属于 Thread。ledger 只追加一条 audit-only 的 `team/dm-sent` operation。requestId 幂等，sender/recipient 必须是同 Workspace 的 enabled Agent Member。projection 有意不变：不产生 Channel、Thread、revision、Attention 或 Inbox markers。送达是运行时的瞬时效果。收件人 idle 时以 relay-form user message 开一个 followup turn，busy 时 steer 进当前 turn。正文里带一行有界的相邻上下文（紧邻上一条往来 DM 的摘要）。注入失败不影响 durable 事实，发送方收到结构化 delivery error，不自动重投。DM 用于快速澄清与状态同步；任务工作、决策和需追溯的内容归 Thread。

## Claim

Member 针对 Task overlay 里某个 Direction 做出的工作承诺。taskless Thread 没有 Claim。Claim 的状态不是 active、done，就是 released；同一个 Task 里，规范化后相同的 Direction 至多有一个 active Claim。多个 Claims 是 dsh 对 Raft 单 owner 的刻意偏离：文本不同，也可能讲的是同一份工作。

## Direction

Claim 用自由文本写下的工作方向。比较时做 Unicode 规范化、去首尾空白、压缩连续空白、折叠大小写；不推断同义词。

## Thread Attention

一个 Member 对一个 Thread 的私有而持久的关注：记下当前关注周期的起点和连续的 read watermark。只要这个关注存在，就是 follow；它不进入公开 Thread revision。周期的开始与结束规则见 [attention-and-messaging.zh.md](team-collaboration/attention-and-messaging.zh.md)。

## Thread Inbox

从 Thread Attention 与 direct mention 派生的 Member 级未读投影。它不是 Agent Session queue、浏览器状态或 per-message read 表。派生与读取语义见 [attention-and-messaging.zh.md](team-collaboration/attention-and-messaging.zh.md)，工具契约见 [tools.zh.md](team-collaboration/tools.zh.md)。

## Follow

Follow 是 Thread Attention 的一种操作语义：不是独立的持久对象，也不是旧版 Delivery 订阅。普通 Thread 更新是否进该 Member 的 Inbox，由 follow 决定；它不撤销 Channel 可见性。unfollow 在没有 active Claim 时结束当前 Attention 周期。

## Activity

Agent Team 记下的协作状态事实。Claim create/done/release 与 Task accept/close/reopen 是公开、revisioned Thread timeline facts。follow/unfollow 与 read-watermark 是 Attention audit facts，不进入公开协作时间线。Agent runtime error 可以摆在 Human UI 上当当前风险看。但它不是 ledger Thread Activity，也不是 Agent Inbox 事实。

## Inbox Hint

Host 从 durable Thread Inbox 状态里给 Agent 派生出的安全边界提示。提示有界：能唤醒 idle Agent，也能在 running Agent 的下一个安全步骤送达；它不代表模型已经读取、处理、回复或验收。恢复后照 durable unread 重新派生。

## Operation

Agent Team ledger 里一次不可变的原子业务提交。每个 Operation 有全局递增 sequence、稳定 operation id、幂等 request id、actor、一种业务事实和一个 wall-clock `occurredAt`。顺序与并发 authority 是 sequence，绝不是时刻。Thread fact envelope 会投影提交 operation 的时刻，让每条 fact 在任何重读路径上只看到一个值。

## Revision

特定 Thread 最近一次相关 Operation 的 sequence。Revision 是 optimistic concurrency fence，不是消息数量。

## Ref

跨重启稳定、带对象类型、调用者拼不出来的标识。Member、Channel、Task、Thread、Message、Claim 和 Operation 使用不同的 branded refs。Attention 拿 Member 与 Thread 的组合当标识，不做成调用者能伪造的对象。

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

一个 Member Session 的两个上下文边界之间的工作上下文。全新代际除了收到的 handoff，从零开始；checkpoint 回返的代际拿来源的精确 completed-turn 前缀作 seed。ledger 记录当前绑定（任一时刻每个 Member 恰好一个）以及最近一次 renewal/rollover 的上一 Session。上下文历史本身保存在各 Session 日志中。Member 身份、模型、私有记忆、skills、Claims 和 Attention，代代都保留。

## Context Checkpoint（上下文检查点）

Member 在自己 Session 里通过一次成功的 `context_checkpoint` 工具调用记下的命名锚点，且已 resolve。它在所属 turn 完成时 resolve；ref 由 tool call id 确定性派生。checkpoint 本身不改变任何东西：只有 Member 在 `context_rollover` 中引用它时才成为回返目标。seed 子代里继承的 checkpoints 仍是惰性历史。

## Context Handoff（上下文交接）

Member 经 `context_rollover` 传过去的私有桥接正文；它绝不是 ledger 事实。ledger 只记录可验证的信封（session 锚点、result sequence、trigger）。正文只在新代际 Session 日志里存一份，当新代际 Session 的第一份 model-facing context。崩溃落在 rollover 的 durable commit 和投递之间，正文就从上一 Session 的 durable intent 重建，且只重建一次。

## Suspend

把 Agent Member 的 live Agent 暂挂起来。成员身份、session、claims、Thread Attention、未读状态和私有 memory 都留着。Resume 回到同一个 session，要不要重新提示 Inbox，看 durable unread。

## Withdraw

从一个 workspace 离开：`team/member-workspace-left` 结束 Member 在该 workspace 的参与。退出其在该 workspace 的所有 channel 成员关系。释放该 workspace 的 active claims 并清除其 Thread Attention。其余一切——Member 身份、其他参与、live session 及其 cwd、私有 memory——都不受影响。创建 Workspace 不可撤回，应改用全量归档。UI 把它放在非创建 workspace 的行上，当破坏性动作。

## Archive

藏在 Suspend 和 Remove 之间的第三态，Member 和 Channel 都适用。设计上它可逆。事实完整留在 ledger 里，供重放和未来恢复。但本轮刻意不提供 restore 入口，与 dsh 的 archived session 对齐。`archiveMember` 放掉 live session。私有 memory 和 Session log 留在磁盘。它同时以一条公开 `claims_released` Activity，放掉全部参与 workspace 里的 active Claims。`archiveChannel` 让 Channel 上所有 Thread 的 owner 走同样的释放。Membership 在归档后保留（隐藏态，非退出）。Archived 实体从所有 Team API surface 消失。projection、mention 候选、ref 解析、ref-addressed read，一律以明确的 archived 错误拒绝。从 archived 状态 Remove 仍可以当数据清理用。

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
