# dsh-agent-team 领域词汇

[English](domain-model.md) | 中文

## Agent Team

一个 dshHome 内唯一的共享协作域。Agent Team 保存跨 Member 的协作事实，不共享 Member 的模型上下文、session transcript 或私有记忆。

## Member

Agent Team 中可被授权读取、发言、认领和接收 Inbox 提示的稳定身份。Member 由不可变的 member ref 标识。私有记忆、skills、persona 与 model 是 Member 级全局事实，不是按 workspace 存放的状态。首版包含 Human Member 和 Agent Member。

## Workspace Participation

Member 与 workspace 之间可 join/leave 的关系，以 ledger operation 提交。与 channel membership 同一种关系形状，在其上一级（workspace participation → channel membership → Thread Attention）。Member 的 `workspaceId` 记录创建地且永不改变。所有授权都读当前参与集合而非创建字段。加入即获得协作能力，不会移动或创建 Member 的 session。当前每个 Member 只有创建 Workspace 下的一条 Session 血统；新增参与不创建另一条 Session，也不提供 cwd 切换。Member 可在其他已参与 Workspace 中发言、认领和回复。Human Member 参与每个 workspace。

## Human Member

当前 Harness 用户对应的特殊 Member。Human Member 参与消息、claim 和 activity，并拥有 channel、Member、验收及 task 终态的管理权限。

## Agent Member

由 Agent Team 创建和管理的 Member。创建于某个 workspace（其创建记录），后续通过 Workspace Participation 加入更多 workspace。本轮 Member 仍只运行一个 live Session，扎根于创建 workspace。按参与切分 Session 血统（每个 workspace 一条、可切换）是后续工作。普通 session 与 fork 不自动获得成员身份。

## Member Capabilities

Member 实体上的持久能力意图（可选 `capabilities` 字段：`tools.allow` 与 `skills.allow`）。随全部 lifecycle operation 原样流转并在 Host restart 后重放恢复。纯 intent：allow-list 中的名字在 commit 时不做白名单校验。Harness 升级改名或删除工具不能让旧 ledger 失去重放能力。与当时已知名字的偏差在 activation 时派生为 runtime warning（`capabilityWarnings`，投影派生态，不持久化。持久化的 warning 会在 Host 重启或升级后撒谎）。

## Workspace

一个项目及其共享工作目录。Agent Member 的 session cwd 是其 Workspace 的项目目录；Member 私有记忆不存放在项目根目录。

## Channel

Workspace 内的持久协作场所。Agent Member 必须显式加入 Channel 才能读取、发言、认领或 follow。Human Member 可以管理和查看 Workspace 内全部 Channel。

## Message

Member 在 Channel 或已有 Thread 中显式发出的不可变内容。每条 Channel 顶层 Message 原子创建一个 Thread。新 Client/tool 默认创建 taskless Thread，显式选择「作为任务」才在同一次提交中附加真实 Task。Thread Message 只延续已有 Thread。每条 Message 携带其提交 operation 的 wall-clock 时刻；agent-facing 表面在固定的 UTC+8 协调时区下渲染该时刻。

## Task

附着在既有 Thread 上的可选 work-tracking overlay，而不是 Thread 存在的前提。 它可由顶层 Message 的显式「作为任务」意图原子创建，或由 Human promotion 原子附加。promotion 同时追加一条公开说明 Message。 Task 的工作状态从 Claims 派生，Human acceptance 与 closed 是显式覆盖事实。常规验收要求全部 Claim 完成（in_review）；Human 也可在 in_progress 时提前验收：accept 操作随之把当时仍 active 的 Claims 投影为 done 并在 activity 记录 `completedClaimRefs`（owner 各自收到通知），不伪造 owner 的 claim-done 事件。从未被 claim 的 todo Task 也可直接验收：activity 不携带 claim 列表，账目如实记录为无 Claim 完成。 面向 Human 的 `Task #N` 是 Task 在 home Channel 内的 durable 创建序号。taskful 顶层发送和后续 promotion 均参与排序，taskless anchor 最初在时间线的位置不参与。既有 ledger 的编号保持不变。

它不是稳定身份；跨 Channel 导航和持久引用必须使用 branded `taskRef`。

## Thread

Channel 内独立的单层公开协作 aggregate：它总有 `threadRef`、anchor Message 和 revision，但可不带 Task。Thread revision 随公开 Message 递增；Taskful Thread 的 Claim 变化和 Task resolution 也递增。对既有 Thread 的公开写入必须携带该 Thread 的当前 revision。taskless Thread 仍支持 reply、follow、structured mention、Inbox、read 与 history，但没有 Claims、Task status 或 accept/close/reopen。协作读写优先以 `threadRef` 定位。released task-only Client 可以用 `taskRef` 作为仅限 taskful Thread 的 Host compatibility alias。Task/Claim 操作仍以 `taskRef` 为身份。revision 是内部并发令牌：仅供工具 baseRevision 透传，不作为消息正文的可引用事实。

## Direct Message

Member 之间的私有直达消息，非 Thread 的一部分。ledger 只追加一条 audit-only 的 `team/dm-sent` operation（requestId 幂等，sender/recipient 必须是同 Workspace 的 enabled Agent Member）。projection 有意不变：不产生 Channel、Thread、revision、Attention 或 Inbox markers。送达是瞬时运行时效果。收件人 idle 时以 relay-form user message 开一个 followup turn，busy 时 steer 进当前 turn。正文带一行有界相邻上下文（紧邻的前一条往来 DM 摘要）。注入失败不影响 durable 事实，发送方收到结构化 delivery error，不自动重投。DM 用于快速澄清与状态同步；任务工作、决策与需追溯内容属于 Thread。

## Claim

Member 对 Task overlay 中某个 Direction 的工作承诺。taskless Thread 没有 Claim。Claim 的状态为 active、done 或 released；同一 Task 中规范化后相同的 Direction 最多有一个 active Claim。多 Claims 是 dsh 对 Raft 单 owner 的有意偏离，不同文本仍可能表达重复工作。

## Direction

Claim 的自由文本工作方向。比较时执行 Unicode 规范化、首尾空白删除、连续空白压缩和大小写折叠；不推断同义词。

## Thread Attention

一个 Member 对一个 Thread 的私有、持久关注周期：当前关注周期的起点与连续的 read watermark。它的存在本身就是 follow，且不进入公开 Thread revision。周期的开始与结束规则见 [attention-and-messaging.zh.md](team-collaboration/attention-and-messaging.zh.md)。

## Thread Inbox

从 Thread Attention 与 direct mention 派生的 Member 级未读投影。它不是 Agent Session queue、浏览器状态或 per-message read 表。派生与读取语义见 [attention-and-messaging.zh.md](team-collaboration/attention-and-messaging.zh.md)，工具契约见 [tools.zh.md](team-collaboration/tools.zh.md)。

## Follow

Follow 是 Thread Attention 的一个操作语义，不是独立的持久对象或旧版 Delivery 订阅。follow 控制普通 Thread 更新是否形成该 Member 的 Inbox 工作；它不撤销 Channel 可见性。unfollow 在没有 active Claim 时结束当前 Attention 周期。

## Activity

由 Agent Team 记录的协作状态事实。Claim create/done/release 与 Task accept/close/reopen 是公开、revisioned Thread timeline facts。follow/unfollow 与 read-watermark 是 Attention audit facts，不进入公开协作时间线。Agent runtime error 可作为 Human UI 的当前风险观察。但不是 ledger Thread Activity 或 Agent Inbox 事实。

## Inbox Hint

Host 由 durable Thread Inbox 状态派生给 Agent 的安全边界提示。提示有界，可唤醒 idle Agent，也可在 running Agent 的下一个安全步骤送达；它不表示模型已读取、处理、回复或验收。恢复后从 durable unread 重新派生。

## Operation

Agent Team ledger 中一次不可变的原子业务提交。每个 Operation 有全局递增 sequence、稳定 operation id、幂等 request id、actor、一种业务事实和一个 wall-clock `occurredAt`。顺序与并发 authority 是 sequence，绝不是时刻。Thread fact envelope 投影其提交 operation 的时刻，使每条 fact 在任何重读路径上只见一个值。

## Revision

特定 Thread 最近一次相关 Operation 的 sequence。Revision 是 optimistic concurrency fence，不是消息数量。

## Ref

跨重启稳定、带对象类型且不可由调用者拼接的标识。Member、Channel、Task、Thread、Message、Claim 和 Operation 使用不同的 branded refs。Attention 由 Member 与 Thread 的组合标识，不暴露为可伪造的调用者对象。

## Runtime Presence

Agent Member 的进程内可用性投影，不是 ledger 事实。它使用 available（live idle）、working（Agent loop running）、error（当前 loop/tool failure，保留到下一次 loop 启动）与 unavailable（无可用 AgentHandle 或 lifecycle/setup/resume 阻止调用，也包括 context rollover 的短暂窗口：ledger 绑定已迁移、新 Session 尚未就绪）。列表以状态点呈现，和 Claim 状态分离。

## Member Diagnostic（成员诊断）

非正常 presence/availability 行背后的结构化原因，绝不持久化：`session-refused`（激活所需 Session 的确定性格式拒绝；可携带被拒 artifact 路径，以及一次修复尝试是否证明存在可修内容）、`session-unreadable`（missing、corrupt、io 或 unknown 的 Session 读取失败）、`preset-composition`（preset 装载/校验失败，通常是安装与运行时分裂）、`rollover`（换窗的短暂提交窗口）、`runtime`（运行中的 loop 或 compaction 失败）、`activation`（未分类的激活失败）。`class` 决定哪种恢复动作真正有效。不可修复的拒绝与换窗窗口不提供重启，其余均可通过重启尝试恢复。

## Context Generation（上下文代际）

一个 Member Session 的两个上下文边界之间的工作上下文。全新代际除 handoff 投递外从零开始；checkpoint 回返的代际以其来源的精确 completed-turn 前缀作 seed。ledger 记录当前绑定（任一时刻每个 Member 恰好一个）以及最近一次 renewal/rollover 的上一 Session。上下文历史本身保存在各 Session 日志中。所有代际都保留 Member 身份、模型、私有记忆、skills、Claims 和 Attention。

## Context Checkpoint（上下文检查点）

Member 在自己的 Session 内通过成功的 `context_checkpoint` 工具对记录的命名、已 resolve 的锚点。它在所属 turn 完成时 resolve；ref 由 tool call id 确定性派生。checkpoint 本身不改变任何东西：只有 Member 在 `context_rollover` 中引用它时才成为回返目标。seed 子代中继承的 checkpoints 保持为惰性历史。

## Context Handoff（上下文交接）

Member 通过 `context_rollover` 传递的私有桥接正文；它绝不是 ledger 事实。ledger 只记录可验证的信封（session 锚点、result sequence、trigger）。正文恰好一次地保存在新代际 Session 日志中，作为其第一份 model-facing context。落在 rollover 的 durable commit 与投递之间的崩溃会从上一 Session 的 durable intent 重建它，且仅一次。

## Suspend

临时停止 Agent Member 的 live Agent，同时保留成员身份、session、claims、Thread Attention、未读状态和私有 memory。Resume 恢复同一 session，并由 durable unread 决定是否重新提示 Inbox。

## Withdraw

离开一个 workspace：`team/member-workspace-left` 结束 Member 在该 workspace 的参与。退出其在该 workspace 的所有 channel 成员关系。释放该 workspace 的 active claims 并清除其 Thread Attention。其余一切——Member 身份、其他参与、live session 及其 cwd、私有 memory——都不受影响。创建 Workspace 不可撤回，应改用全量归档。UI 在非创建 workspace 上以此作为行上的破坏性动作。

## Archive

介于 Suspend 与 Remove 之间的隐藏第三态，适用于 Member 与 Channel。它在设计上可逆——事实完整保留在 ledger 中供重放与未来恢复。但本轮刻意不提供 restore 入口，与 dsh 的 archived session 对齐。`archiveMember` 释放 live session（私有 memory 与 Session log 留在磁盘）并以公开 `claims_released` Activity 释放全部参与 workspace 中的 active Claims。`archiveChannel` 对 Channel 上所有 Thread 的 owner 施加同样的释放形态。Membership 在归档后保留（隐藏态，非退出）。Archived 实体从所有 Team API surface 消失——projection、mention 候选、ref 解析、ref-addressed read 均以明确的 archived 错误拒绝。从 archived 状态 Remove 仍可作为数据清理路径。

## Remove

不可逆地停用 Agent Member。Remove 释放 active claims、结束 Thread Attention、删除私有 memory、归档 session。历史 Message、Activity 和身份快照永久保留。

## Member Lifecycle

每个 durable Member state 的外部期望状态只用一张表定义。每一次 lifecycle operation 在 commit 之后跑的正是这组 effect，Host 启动时也对每个 Member 重跑同一组。因此 commit 与 effect 之间 crash 或 effect 失败后，重跑同一条推导即可收敛：

| State | Live handle | Session grouping | Private memory |
| --- | --- | --- | --- |
| `enabled` | 一个，运行在记录的 binding 上 | active | 保留 |
| `suspended` | 无；resume 恢复同一 Session | 保留 | 保留 |
| `archived` | 无 | 归档（隐藏），log 留在磁盘 | 保留 |
| `inactive` | 无 | 归档 | 删除 |

每一步都只从 durable state 推导，因此 crash 或调用失败后重复执行时只补做还欠的步骤，绝不再写一次 durable 状态。
