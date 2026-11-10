# Host authority

[English](host-authority.md) | 中文

Team 是每个 DSH home 内唯一的协作域。append-only operation ledger 是 Member、Workspace、Project、Message、独立 Thread aggregate、可选 Task overlay、Claim、Thread Attention、Inbox 和 Activity facts 的 durable authority。

修改 Host capability 时，先阅读 package source/tests，再阅读匹配的 Harness capability contract。导航表见 [`harness-navigation.zh.md`](../harness-navigation.zh.md)。导航表把 Host 改动映射到 `deepseek-harness/docs/subsystems/` 和 source packages。

## Ledger 权威与提交
- 当前 Session 上下文可满足 [Thread 阅读条件](../team-collaboration/boundaries.zh.md#mutation-fences)，但不确认未读，也不建立第二份权威；只有显式读取才提交已读状态变化。
- Agent 的 Thread 与 Main stream read 在 ledger 结果上增加[按上下文调整的呈现](../team-collaboration/tools.zh.md#team_thread)：缺失的近期 Message 背景与已可见正文的省略说明。工具按输出上限选出能渲染的前缀，Thread receipt 以 `selectedThroughSequence` 记录这个界限，旧 receipt 仍按缺省 batch 解释；Host 只提交该前缀。Human read、Remote 参数与 replay 语义均不变，重放不依赖 Session。
- mutation 进入 Host authority，并提交一条 durable operation。
- 重放会重算每条记录应有的 Inbox delta 并逐项比较，所以改变既有 kind 校验规则的版本要先写一条 `team/rules-version-adopted`（Host actor，`{ version }`）。每条记录按它之前最新的标记校验；没有标记的 ledger 为版本 1。标记由 `initialize` 在它自己排队的提交里追加，因此早于之后的所有写入，包括启动恢复。标记只升不降，每个版本至多一条；ledger 采用的版本高于本构建实现的版本时拒绝打开。
- 当前构建实现版本 2：挂载时若 ledger 的最新标记低于它，就追加版本 2 标记；全新 ledger 在 `team/initialized` 之后立即写入该标记。
- 规则版本 2 起，Host 还会提交 `team/main-message-posted`、`team/main-stream-read` 和 `team/thread-started`，它们在版本 1 的记录段内会被拒绝，而 `team/message-sent` 在版本 2 的记录段内被拒绝。Host 不再写 `team/message-sent`（开 Thread 用 `startThread`），它只在版本 1 的记录段内重放。
- 0.2.5 预览开关打开过的 ledger 正是落在这条拒绝上：它带版本 2 标记，而它当年开 Thread 走的 `sendMessage` 仍无守卫地写版本 1 的 `team/message-sent`，因此只有当该段内没有这条记录时才能打开。该开关本就只用于一次性的 `DSH_HOME`。
- inbox delta 可带可选的 `mainMarkers` 列表，使用独立的 marker 形状（`projectRef` 加 `messageRef` 或 `activityRef`）。它只在确有变化时出现，所以版本 1 的记录保持存储字节不变；离开的 Member 的 Main stream marker 随同一 operation 与其他 inbox 状态一起清除。
- inbox delta 还可带可选的 `mainAttention` 列表（`set` 是 Main stream Attention 行，`removed` 是它们的键），同样只在确有变化时出现，因此 Main stream Attention 出现之前写下的 delta 保持存储字节不变。显式 follow/unfollow 由 `team/main-attention-changed` 写入；owner 授权写入它起始的那一行，撤回则移除该行。这一行按 Member × Project 键控，永不进入 Thread 索引。
- Agent 通过与 Thread marker 相同的 direct 通知路径被 Main stream marker 唤醒；Attention 覆盖的普通 Main stream 更新同样立即投递。每条未读事实都会打断，因此 Thread 的普通更新只因读者 follow 了该 Thread 才到达：没有任何身份——owner 或 accountable——被放进更慢的等级，也没有任何东西在通知发出前先累积计数。`covered` 是保存在进程内的签名，用于阻止同一批 durable facts 的重复派生花掉第二次尝试；已入队但尚未读取的通知会被替换，而不是叠加。
- 回复把被回答的 Message 记为自身 Message 上的 `replyToMessageRef`，Host 在提交前用 ledger 解析这个 ref：未知的 ref、或属于别的 Thread 的 ref 一律拒绝，不会被存下。父消息作者在提交时加入收件人，与 mention 走同一套解析、拿同一个 direct marker 被送达——全程没有任何邀请环节。规则版本 2 下 `undeliveredMentions` 永远不会被填上：每个可寻址的收件人都会送达，不论该 Thread 是否曾经承载过它，也不因此开始任何 Attention。报告未送达的残余只属于版本 1 兼容路径。被引用的画面 —— 父消息作者与其正文一行 —— 是读取期派生（`replyTo`），绝不是第二份存储副本。因此它不可能与父消息不一致，父消息不在本次读取这一页里时也照样填得上。ref 不再可解析时只留裸 ref。引用不是可选项：这个参数属于回复契约的一部分，携带 ref 的回复只按 ref 本身被接受或拒绝。
- Projections、Inbox results、tools、commands、Remote responses 和 UI 都从已提交的 operations 派生。
- Client code 不得解释 ledger records，也不得创建 parallel authority。

## Lifecycle 与通知
- Agent lifecycle、replay、authorization、idempotency 和 revision checks 留在 Host。durable unread 变化可通过 public safe-boundary API 产生一条有界、合并的通知：direct mention 携带 Message 和 source；direct Task/Claim Activity 携带完整事件；ordinary unread 携带 Thread-first route、有界摘要和溢出数量，存在 Task 时带 overlay。Promotion 通过 Activity markers 到达 followers。通知不是第二权威，也不保证恰好处理一次。
- 通知先排缺失的 direct 信号，再排 reminder 与普通摘要；其排序、上限和字符预算见 [attention-and-messaging.zh.md](../team-collaboration/attention-and-messaging.zh.md)。
- 已提交的 Session transition（`team/member-session-renewed`、`team/member-session-rolled-over`、`team/member-session-recycled`）记录的是 desired binding，而不是已完成的切换。retire 旧代与 activate 目标都是 ledger 写入之外的 Host 效果。startup 与 Member 的显式 recovery 动作都会补完被中断的 transition，依据记录的 previous Session。每个效果各自推导自己是否已完成。live handle 不能证明 archive 那一半跑过。重复请求只返回已记录的 receipt 与诚实状态，不再提交一次绑定。
- 这条 transition 记录就是一次换代的全部 lineage。后继 Session 的 header 不写 `parentSession`——那个字段专指 subagent 的创建者——所以想找退役 Session 的读者去读 ledger，而不是读 header。
- 每个 durable Member state 只有一组期望的外部 effect，即 [Member Lifecycle](../domain-model.zh.md#member-lifecycle) 表。每一次 lifecycle operation 在 commit 之后重跑这组 effect。startup 对每个非 enabled Member 也重跑同一组。archive、suspension、remove 因此走同一条推导重跑收敛，不做第二次 durable 写入。即使 Workspace/Session/filesystem 调用被 crash 或失败打断，也一样收敛。
- startup 绝不把非 enabled Member 激活为 enabled。启动阶段失败的 effect 只记日志，下一次 boot 重试，不让 boot 失败。同一 Member 的 lifecycle operation 按提交序串行；不同 Member 从不排在彼此的等待之后。
- Task 提醒由 Host 在 Team 事件后评估并写入 `team/reminder-raised`，不使用 timer。其可选 `reminderMarkers` Inbox delta 仅属于一个接收者；marker 被读取消费后，replay 仍保留完整 episode 用于去重。
- Member reminder 由 Host 写入 `team/member-reminder-created`、`team/member-reminder-raised`、`team/member-reminder-consumed`、`team/member-reminder-cancelled`。触发依据是 Host 自己的 timer 与 Team 事件，不是模型写的 schedule 文本。
- ledger 只存创建、每次 raise、消费与取消。raise 出的 occurrence 带只属于其唯一接收者的私有 `memberReminderMarkers` Inbox delta；每个 reminder 只写一个 marker，未读的 occurrence 因此被替换而不是叠加。archived 或 removed 的 Member 与 Member Lifecycle 表同样派生：全部取消。
- 消费要指明它结账的那个 marker sequence，因此渲染过较旧 occurrence 的通知不会顺带消费掉替换它的较新 occurrence。durable ref 形状解析不回来的 reminder ref 在创建边界就被拒绝，而不是留到 replay 时才失败。
- 消费写失败时，这条通知赚到的 coverage 随之失效，Host 为活着的 Session 重新派生该通知——occurrence 仍然欠着，同样的 durable facts 不该被读成已结账。重试按连续失败次数设上限；stand down 之后 occurrence 保持未读且不在 coverage 里，直到下一条触及该 Member 的 Team 事件。
- reminder operation 会使对应 Task Thread 的 change scope 失效，让 Human Inbox 刷新，但不增加公开 fact 或 revision。Member reminder 的 occurrence 不让任何公开 scope 失效，它只到达一个 Member 的私有 Inbox。accept、close 与生命周期清理会移除已经失效的未读 marker，同时保留 episode 历史。Agent idle 是进程内观测，跨 generation 替换保留，Host 重启后丢弃；idle 未知时不满足时间条件。

- ledger append 之后剩下的是 delivery 效果：commit listeners、Client change invalidation、participation notice。每个受影响的 Member 还会收到一次 wake。每一项都经过同一条边界：普通失败只记日志，不让操作本身失败，调用方仍收到 committed result。
- 通知读取只在一次同步 read set 内共享 Thread/Main 未读材料，文本渲染复用本次 delivery plan，不跨 commit 缓存。`running` 边沿先从当前未读事实重新派生，再判断是否已经覆盖；读取之后不能仅凭上一条通知的 coverage 作此判断。
- 一次提交影响至少 8 个身份时，通知 effect 延迟到 durable commit 和 Client invalidation 之后执行。同一 Member 按序处理；后续小批次遇到未完成队列时也加入，不能插队。不同 Member 独立调度。关闭时跳过尚未开始的 effect，activation 再从持久未读事实派生。队列排空只表示派发结束，不代表 Agent 已读取或回复通知。
- 同步执行的 invariant divergence 仍会让调用方收到 reject；延迟通知中的 divergence 因 commit 已经返回，只记 error 级日志。失败的 Inbox wake 清掉这个 wake 记录的 notice state。因此，下一次触及该 Member 的 commit 重新推导同一批 durable Inbox facts 并重试，不追加第二次操作。DM 保留显式的 recorded-but-not-delivered 错误。

## 哪些操作会唤醒 Member，以及成员卡住时怎么选

唤醒是 Host 经四种 cause 之一投递的一条**有界合并通知**，每条都带上产生它的持久事实：

| Cause | 产生它的事实 |
| --- | --- |
| `commit` | 任何触及该 Member 的已提交操作：提及、DM、Task 活动、promotion、被接受的回答 |
| `transition` | 一条已记录的 `team/member-session-renewed`、`team/member-session-recycled` 或旧式 `team/member-session-rolled-over`，其 retire 与 activation 效果没有按序完成；重新派生的 Inbox 排在携带输入之后 |
| `activation` | 一次新的 activation，有 carried input 时带上旧 Session id |
| `running` | Member 自身 `agent/status` 转为 `running`——每次转换一次，不是每步一次 |

唤醒不是第二权威，也不承诺恰好一次被模型处理。一次投递失败会清掉它记录的 notice 状态，于是下一条触及该 Member 的提交会重新派生同样持久事实并重试，不会追加第二次通知。

`recoverMember` 是人工入口，按顺序且只选一个：

| 条件 | 动作 | 适用场景 |
| --- | --- | --- |
| handle 缺失，或活动 handle 的 Session id 不是记录中的绑定，且存在已记录的 transition | 完成这条已记录的 transition | 崩溃或某个效果失败，使一次 Session transition 只执行了一半 |
| 持久状态不是 `enabled`，但仍有活动 handle | 完成该状态的效果 | suspend/archive/removal 已提交，但它的 disposal 失败 |
| 活动 handle 的 preset 组合已丢失 | 原地 reactivate | 一次 reload 丢了 preset 组合，Member 的工具不可用 |
| 完全没有活动 handle | reactivate | activation 本身就失败了 |
| 其余情况 | steer 一条 resume 提示 | Member 活着、组合完成、绑定正常——其余状态都已被上面几行接走 |

带活动 handle 的 error 态 Member 落在最后一行：`recoverMember` 会 steer 它，而如果原因仍在，下一轮会再失败一次。选之前先分清两件事：模型路由坏了或网关拒收，要改的是路由而不是恢复 Member，在路由通之前 steer 什么也救不回来。恢复从不会重置上下文世代：绑定已经迁移的滞留 Member 由这条路径补完那条已记录的 transition，而 Remote 面上没有任何东西会 renew 或 rollover 一个 Session。

Member 当前的失败原因以 `diagnostic` 挂在 status 上并由 Client 渲染。它由活动 surface 派生、不落盘。Host 重启后只有在有东西唤醒该 Member 时才会重新派生，所以一个没有被唤醒的 Member 在下次被操作触及前不显示原因。

## 变更流与 Projection
- `changes()` 是流式 Remote，可声明一个 scope（workspace/project/thread/presence）。省略 scope 时观察共享 Team 投影变化，不包含 presence。Host 先注册监听，再发送当前基线，之后只发送匹配的变更通知。消费者暂停期间，只保留最新待发送版本。取消或 Host 释放时关闭订阅。
- Thread read 与 `team/dm-sent` 不改变共享投影：既不推进版本，也不唤醒订阅者。私有 reminder 会使其 Task Thread scope 失效，从而让已打开的 Human Inbox 得知提醒；它不会因此成为公开 Thread 历史。Presence 使用进程内 epoch，其他 scope 使用最近一次共享投影提交的 ledger sequence。版本只在同一 scope 和 Host 生命周期内有意义。Host 只为受 operation 影响的 Members 重算 Inbox hints。
- `TeamChangeStream` 在每个页面内通过 `ctx.remote.$stream()` 按 scope 共享一个逻辑流。Harness 管理共享的 `/api/remote.mux` WebSocket 和连接恢复。每次开场基线都会触发重新读取 Host，包括重连后的相同或更低版本。开场基线既补上首次读取与订阅之间的变化，也在没有新提交时恢复失败的读取。最后一个 listener 离开时释放这个 scope，插件释放时关闭所有 scope。传输失败在恢复前只报告一次。终止性错误直接报告，不走 Team 自有重试循环。没有长轮询回退、跨页面主从选举或单活跃页面限制。并发的补充读取合并通知。读取期间再收到通知，保留后续一轮读取，不用旧版本过滤重连基线。Human Inbox 徽标订阅无 scope 通知。订阅经 debounce 重拉 Inbox 合计，在本页 Thread read 后刷新。Presence 订阅更新 Member 可用状态，不唤醒 Inbox。通知只是重新读取的提示，不是第二份事实存储。
- `contextContinuity` unit 经 Harness projection registry 增量折叠活动 Session 事件，只保留恢复所需的旧 intent、checkpoint、continuation 与未答复输入。激活与退休 Session 恢复也可全量折叠被检视日志。
- Member clock baseline 经 `session-event-cursor.ts` 只消费追加事件。Session 身份、继承前缀、日志长度或锚点事件变化时从头重折。守卫依赖日志只追加的契约；同一 sequence、同一事件类型的就地替换不在检测范围内。
- 读取投影按用途定界。`view` 只回答它自己那一页 fact 加上请求点名的 Thread：catalog 字段带的是这一页的 Task、Thread、显示序号与 Claim。只有 `includeCatalog` 才返回整个请求 scope 的 Task/Thread/Claim catalog，也就是模型侧 `team_view` 渲染的 address book 投影。
- Agent view 额外请求 `includeWorkspaceDirectory`：独立目录列出全部 active Project、owners、读者参与关系和订阅计数，以及 Workspace Member roster。这个目录绝不提供内容 catalog 使用的 Project refs，因此 `directory only` 不会泄露 Thread、Task 或 Claim。
- 一页读取沿 fact ledger 走到超出 limit 的第一个匹配为止。catalog 读取再多一次对 scope 内 Thread 的目录过滤，以及每个 Task 行一次活 Claim 查询。这些分量必须分开报告，不合并成一个总数：只报返回行数看不出这次读取走过了什么。
- Claim 按 Task 分桶，由重放派生的索引支撑，所以按 Task 的读取（Claim 列表、Thread 画面、Inbox 行、Task board）绝不走账本的全部 Claim。这里每个索引都由重放重建，绝不是第二份 durable 权威。

## Session 持久化与重放
- Bundle 目标为 DSH `0.2.2-rc.1`。Bundle 的 Session persistence 使用当前 DSH schema。随附的 JSONL backend 会自行迁移已发布的旧格式（v0/v1/v2 → V3 → V4），旧格式 Session 数据无需手动处置。这个 DSH Session-schema 策略不会抹掉 Team operation history。Team 有意保留针对旧版、Message-level `occurredAt` 之前 records 的窄 replay normalization。
- 普通存储的 Message operations 在加载时使用包裹 operation 的 instant。旧 `team/thread-read` snapshot anchors 与 Message facts 从来源 Message operation 解析 instant。只在必要时回退到 read operation。而 snapshot 正是唯一仍会走到这条 normalization 的记录形态。snapshot 把 Message anchors 与 Thread facts 连同消费掉的 Inbox delta 一起冻结在记录里。

  当前每次读写入的 receipt 只存进度与 Inbox delta，是唯一不存任何 instant 的 Thread-read 形态。旧记录就地 normalize 并校验，绝不改写。不要增加 Team 自有的 Session migration、宽泛 compatibility reads 或 fallback storage paths。可选的 `member.model` inheritance 与可选 Message attachments 都是当前语义，不是 legacy fields。

## Attention 与 Inbox 权威
- Thread Attention 是 private Member x Thread state。ordinary unread 来自当前 Attention。structured mentions 创建 direct markers。terminal Task changes 在 Attention 结束后仍可能保留稀疏 Activity markers。Host 是唯一 Inbox authority。Session history 可以保留有界 notification context，包括 direct Message bodies 和 Task/Claim transition summaries。但 Session history 不能形成 parallel unread projection。
- Inbox 读取先对读者的整条未读队列排序，只为自己返回的行准备 preview 文本、instant 的署名者与活 Claim owner。总计仍针对整条队列，所以只取一行的角标也报告全部未读 Thread。`threadObservations` 返回最新的 `limit` 条 observation 并带 `hasMore`，follower 集合始终是完整当前状态。

## Session 策略与上下文压力
- Team 管理的 Agent sessions 使用显式 Team preset 和可信的 `danger-full-access` policy。这是面向可信 Workspace 的有意产品边界。
- Host 激活 Member 时，通过 session-title service 用这个 Member 的 handle 命名没有标题的 Member session。这样普通 Session list 就会显示 Member identity。显式 rename 或任何已有 title 始终优先。命名失败不会导致 activation 失败。
- Member 上下文的两个机制都在 Host 侧，模型没有对应工具（见 Tools and preset）：Team 通过 preset 中的适配层控制请求预算，Harness 的 `BasicCompactionEngine` 把过大的 Session 就地缩短；换代协调器在唤醒边界换掉冷下来的一代，并以 Host actor 记录 `team/member-session-recycled`。压力与唤醒阈值归 [`memory-and-context.zh.md`](../team-collaboration/memory-and-context.zh.md)。
- 换代窗口内的这一代报告 unavailable，并带 `rollover` diagnostic，直到新代激活。所以跟随该行的 Client 绝不会打开一个尚不存在的 Session。
- 换代携带的是输入，不是上下文：commit 记下退役日志的偏移，新代只重放该边界及其之后的输入，并按 Message id 去重；即使输入已被 claim，也使用最初的 durable inbox 插入记录。不经过进程内存拷贝（见 [Tools and preset](tools-and-preset.zh.md)）。
- Pending/error bookkeeping 只在进程内维护。只有进入 transaction 的 compactions 才会写入 durable Session history，绝不写入 Team ledger。
- 终止回合的恢复先读 Harness 的结构化失败，再看措辞。稳定的 code 单独决定结果。`RATE_LIMIT` 是 rate limiting，`TRANSPORT`/`TIMEOUT` 是 transient network，显式 429/503 响应是 rate limiting。其他任何 code（quota、auth、context、请求状态）无论 message 写什么都保持 manual。只有无 code 可用的错误才回落到窄 message 签名。
- `agent/error` 负责终止回合恢复及其连续错误上限。无论走哪条路，失败都保留已记录的 Member diagnostic。
- 在任何 `turn/start` 之前被丢弃的 Team 唤醒，是唯一一类背后没有 `agent/error` 的 error diagnostic。当一条 Team 自己的 Inbox 或 recovery 通知在 Agent 开启回合前离开队列、且不是 Host 自己做的替换或 dispose 时，Host 记一条 `runtime` 类 diagnostic，带上 `source: 'agent/inbox/discarded'`、该 Member 的 `sessionId` 和 `occurredAt`。Host 有意替换或拆除的通知不触发任何东西，所以普通的通知替换从不显示 error。被取消的 splice 不带 durable 原因，因此它和所有 runtime diagnostic 一样只在进程内维护。重启后，在下一次唤醒真正运行或再次取消之前什么都不显示。

## 私有记忆、归档与身份效应
- Member preset 根据当前 Host facts 与当前 Session surface 派生身份、Project ownership、Workspace 参与及私有记忆上下文。分类和记忆更新规则见 [Member 上下文注入](../team-collaboration/memory-and-context.zh.md#member-上下文注入)，不建立第二份持久状态。
- `$DSH_HOME/agent-team/members/` 下的 private-memory directories 是 Member identity 的 Host-owned effects，不是第二权威。Member activation 确保 private-memory directory、`notes/` 和缺失的 `memory.md` 存在。startup 不会清理 ledger 不知道的 `member:` directories。显式 Member removal 会归档这个 Member 的 Session，并移除这个 Member 的 private-memory directory。Team removal path 之外的 entries 保持不动。
- 这项删除，以及 activation 时对旧式 colon 目录的改名，都限定在当前进程自己的 members root 之内。记录里的 `privateMemoryPath` 是一条 durable 绝对事实，指向「当初添加这个 Member 的那个 DSH home」里的目录。因此解析到另一个 home 的进程会拒绝搬移或删除这个目录（并告警），而不是把 Member 的真实私有记忆搬出 Member 自己的 home。
- Member 与 Project 的归档是介于 suspend 与 remove 之间的可逆第三态。`archiveMember` 提交 `team/member-archived`。dispose live session，私有 memory 与 Session log 留在磁盘，并把 Session 从分组 surface 归档。`archiveMember` 再以公开 `claims_released` Activity 加上 Attention/marker 清理，释放这个 Member 的 active Claims。被隐藏的 Member 不得让 Task 卡在 in progress，也不得留下幻影 unread 计数。`archiveProject` 提交 `team/project-archived`，对 Project 上所有 Thread 的 owner 施加同样的释放形态。两种归档形态下 Membership 都保留（隐藏态，非退出）。

  Archived 实体从所有 Team API surface 消失：
  - projection：view projects/threads/tasks/members、mention 候选、Project join、编辑。
  - ref 解析：`resolveTaskRefs`/`resolveThreadRefs` 跳过 Archived 实体，message 正文渲染为纯文本。
  - ref-addressed read：`readThread`、`threadHistory`、`threadObservations`、`listClaims` 以明确的 archived 错误拒绝，绝不伪装成 unknown-ref。

  事实则完整保留在 ledger 中，供重放与未来恢复。这条边界就是 archival 与 remove 的分界。从 archived 状态 Remove 仍可作为数据清理路径。本轮刻意不提供 restore 入口，与 dsh 的 archived session 对齐。Project 归档之前写入的 ledger 省略 `project.state`。记录 schema 在 load 时把 `project.state` 归一化为 `active`。

## Member capabilities 与 skills
- Member capabilities 是随全部 lifecycle operation 原样流转的 durable intent。Member capabilities 指 Member 实体上的 `capabilities` 字段，即预留的 `tools.allow` 与 `skills.allow`。commit 时不做已知名白名单校验，保证 Harness 升级后旧 ledger 仍可重放。与已知名的偏差在 activation 时派生为不持久化的 `capabilityWarnings`。`tools.allow` 是有意的接口预留：当前没有 UI 写入路径。编辑是局部更新：字段缺省即保持已存储的值，显式传 `null` 才清除。因此不管理 capabilities 的调用方可以直接省略该字段，其他来源写入的覆盖不会被带掉。`model` 是例外，不可清除，见下面的模型契约。
- Activation 在 preset 校验前限制每个 Member，顺序为 mount → restrict → validate；未配置 `tools.allow` 时也生效。allow-list 只能缩减 preset 基准范围，保留 Team tools（`team_worker` 视开关）与 `working_directory`；范围外的名字被忽略并报告 warning。工具过滤、执行检查和限制见 [Tools and preset](tools-and-preset.zh.md)。对 live Member 编辑 allow-list，在 turn 边界同 Session 换装 restriction。idle Member 立即生效，running Member 的编辑等自己这个回合结束。每个 Member 各自拥有一条 lifecycle 链，所以该等待只挡住这个 Member 后续的操作，且仍按提交序。管理别的 Member 从不排在它之后，而 ledger 仍是唯一的有序 writer。

  Host shutdown 释放每一个待定的等待，而不是去等一个可能永不结束的回合；在链之外被销毁的 Session 同样释放它。stop 取消该 Member 在途的回合，然后等 Agent 收敛。所以排在停靠编辑之后的 stop 先到达那个边界（编辑此时已生效），随后通常发现 Agent 已 idle。stop 从不清除或中止已提交的配置：编辑要么在边界生效，要么返回 `deferred:no-live-handle`；两种顺序都让存储的意图在下次 activation 时仍然成立。

  等待按类别记日志，带 Member、Session 与时长：等自己的回合是 `stage 'wait-turn'`，等外部执行（例如 Agent 释放自己的 Session 写路径）是 `stage 'wait-external'`。activation 期间的 restriction 失败只表现为这个 Member 的 activation failure。
- live 应用失败不会放宽面：编辑保留其 ledger commit，旧 restriction 继续生效（新装失败时恢复原状），Remote 调用照常暴露失败。同 requestId 重试会重新应用已存储配置且不产生第二次业务提交。Host 比较的是存储意图与运行时实际已应用的效果，绝不与该次请求自身的历史比较。
- 配置编辑把「效果」与「提交」分开回报：`updateMember` 返回 `effect`，取值 `applied`、`already-applied`、`deferred:no-live-handle` 或 `deferred:generation-changed`（先落账、下次激活生效）。失败不进取值——保持响亮拒绝，同时留一条可路由的 `capability-apply` diagnostic。`detail` 带 requestId、operationId、阶段与原因，Session 结构化放在 `sessionId`，日志用同一组关联 id。
- Member 始终跑一条显式路由。创建必须给出一条，编辑只能替换、不能清除回 Host 默认；写入者只有两个：Human 的编辑（本节）与该 Member 自己的 Session（下条）。在此契约之前写入的账本记录没有 `model`，仍可读取，并按当时 Host 的默认选择唤醒。
- 模型编辑的落账与回报和其他编辑一样，但新路由是否生效由上游决定：切换后新窗口在压缩之后仍装不下当前 Session 时会被拒绝并保留原路由，pending 选择就等到换回兼容模型为止，而记录在案意图两种情况下都在。
- composer 是另一个入口，且不靠选择事件落账。真正证明切换越过了 Host 的压缩检查、进入一次真实请求的是 Member Session 的 `request/header`，所以 Host 以 `header.config` 的路由写一条 Human 的 `team/member-updated`。只写路由：推理档位是 Session 日志里的事实，activation 对同一条路由重新读取。
- 有三种请求什么都不写。一种是请求的路由与 Member 当前正在跑的路由一致，包括 Team 自己在 activation 时写回的那条，于是写回不会经账本自循环。另一种是被 Host 拒绝的切换：它根本不会记下 header，因此也从不写入。第三种是 Member 已经走过的 header：该 step 固定路由之后发生的选择更新，写回这条 header 的路由会把被替换掉的那条按回去。
- 名册每行恒带 `capabilityState`（`applied` | `pending`），由运行时实际已应用的效果派生；没有活面的状态字面报 `pending`。该字段与 `availability`/`presence` 正交：后两者回答 Member 会不会跑，它回答存储配置此刻生效没有。
- Skills 是 Member 私有的。preset 不带共享 skill-filesystem row。Host 在每个 Member 的 agent exact scope layer 上注册一个 filesystem provider。它是 traceable-service 接缝，与 tool restriction 同构。这个 provider 只扫两个 Team 自有 root，排除默认 roots。排前的是插件内置的只读 core skills（`packages/agent-team/core-skills/`，同名内置 skill 跨升级保持稳定）。排后的是 Member 可写的 `$DSH_HOME/agent-team/members/<memberId>/skills/`。

  Member catalog 从内置集起始，内置集里有 `member-skill-manager` meta skill。全部 skill 写作/安装/credentials 引导都在这个 meta skill 里面。persona 只陈述私有空间物理事实。安装就是往 Member 自己的目录写。目录形态为 `skills/<name>/SKILL.md` 加可选 references/scripts，或平铺 `.md`。有意不提供上传 Remote，发现由 filesystem watcher 驱动。

  `skills.allow` 通过已挂载 provider 上的 live selection swap 过滤 `list()` 输出。编辑与 tool 编辑在同一 turn 边界换过滤并失效 catalog。过滤是可见性语义，不是安全边界：两个 root 始终被扫描和 watch。Member remove 连同私有目录一起删除。suspend/resume 与 Host restart 恢复相同 catalog。

## Host 服务面（`ctx.agentTeam`）

Host row 只发布一个服务 `ctx.agentTeam`，它被两类消费方以不同方式使用，稳定性承诺也不同。没有 CLI、没有 `bin`、也没有 loopback HTTP 入口。Web Client 是唯一的人类控制面，所有变更都经 typed Remote 下发到 Host。

- **Remote 方法**（带 `@Remote` 装饰的，如 `members`、`view`、`addMember`、`updateMember`、`sendMessage`、`readThread`、`inbox`、`humanProfile`）是 Client 契约。它们由声明生成 Typert 产物来定型，所以 Client、模型侧工具和其他消费方编译期对齐同一形状；改动其中任何一个都属契约变更。
- **仅 Host 侧的服务方法**（如 `memberForAgent`、`membersForClient`、`status`，以及激活/生命周期内部实现）供进程内 Host 调用方使用——preset 行、commit listener、启动期的派生逻辑。它们没有兼容承诺，可能随版本调整。

只有 Remote 那一组是契约。`ctx.agentTeam` 上其余部分都是内部实现，改动形状时不会附迁移说明。

preset 行必须在执行时解析 `ctx.agentTeam`，不能在声明期静态捕获：该服务在 Host 插件启动后才提供，import 期就闭包捕获它的行拿到的是空。外部代码里的 `ctx.get('agentTeam')` 同理，那是对内部面的未文档化使用，不是受支持的集成点。

## 订阅调度与无人值守执行

每个订阅的定时器都由 Host 拥有。`SubscriptionScheduler`（`packages/agent-team/src/subscription-runtime.ts`）全局最多放行 4 个脚本运行——owner 手动触发的试运行也占其中一格——同一订阅的定时条目在等待队列中只保留一个并合并之后的到期时刻，同一订阅也不会同时跑两次，统计连续失败，并按每个订阅每分钟 20 条的花费发布额度。

admission 依据账本而不是排队时的快照：等待中的试运行或定时运行若遇上订阅被删除、或 Project 被归档，会被直接拒绝、脚本不执行；处于这种终态的记录不再发布，也不再保留 checkpoint。它的状态——下次到期时间、失败计数、发布窗口、最后成功时间——放在私有 domain `agent_team_subscriptions`（`packages/agent-team/src/subscription-store.ts`）里，永不进账本：删掉所有 checkpoint 不改变任何领域结果，重启从持久化的到期时刻继续，而不是重置。

同一个 domain 还放四张没有任何账本事实依赖的表：`runs` 保留每个订阅最近 50 次运行，`deliveries` 保留自动重试用尽的 webhook 投递，`replays` 保留每个重放请求已经得到的答案，`admissions` 保留已接收但还欠一次运行或一次接受的 webhook 请求，连它到达时的订阅定义和队列满时暂存的批次一起。

一条运行记录带触发方式、开始时间、耗时、结构化类别、退出码或超时、事件数、两路输出各自末尾 8 KiB，以及解释它的身份——`subscriptionRevision`、`scriptHash`、`runRef`，投递运行再加 `deliveryRef` 和用尽重试的那次 attempt。

事件数是这次运行真正被账本接受的数量，绝不是脚本打印了多少：试运行什么都不发布，被拒的整批什么都不接受，订阅早已知道的 id 也不算新事件。

试运行同样记录，所以 owner 问“我这个修复过没过”读的是同一份历史；但 create 的草稿试运行不记录，因为账本从未存下这条记录该归属的订阅。删除订阅时，这四张表和 checkpoint 一起清掉：清理在调用报告删除之前就已完成，重启时再把中断的删除留下的行收敛掉。Project 归档时，它名下每个订阅的同一份私有状态在归档当下就清掉，不必等下一次重启。

清理用的是与私有写入同一把写锁，所以它不可能落进某一段写入的中间：要么它先跑——那这段写入的终态重读会发现已经不可写，什么都不写、并如实报告没写成；要么它后跑，把这段写入的每一行都带走。每一段写入在真正写入前也会重新核一次终态，因此落在两段之间的删除同样留不下任何行。

读历史是 Project 级读取，但中间有一道切分：每个成员都能看到摘要，而输出——两段尾部，以及一次运行用来自述的那句话——只属于 Human 和 owner，因为脚本是在该 Project 的凭据下跑的。这道切分只切输出：成功的运行对 owner 同样展示输出，身份信息随摘要一起返回，于是一条投递、它到达时的 revision、以及它产生的那次运行能读成同一件事。`team_subscription` 的 `logs` 动作和 Remote 上的 `subscriptionLogs` 读的是同一批记录。

成功只有唯一线性化点：输出被账本持久接受的那一刻这次运行才算成功，而这也正是清零连续失败计数、推进最后成功时间的同一次提交。

接受与这次清零是订阅写锁下的**同一段**，所以之后才执行的 settle 步骤只推进下一次到期时间。让清零可信的正是这把锁：ingress 在运行旁边计出的失败，要么落在这段成功所结束的连败之内，要么完全在其之外，读计数与写计数之间没有任何东西能插进来。

只有固定 revision 仍等于当前 revision 的接受或失败，才会改变连续失败数与最后成功时间。
旧 revision 的迟到结果仍按该 revision 保留，但既不清零也不增加当前 revision 的连续失败。

脚本本身在锁外执行——把脚本也放进锁里，会让整个运行期间每条投递都被卡住。空输出的成功走同一段、同样清零，因为它本来就是同一件事：这次运行是好的。脚本 exit 0 但没有任何新事件，是一次“什么都没接受”的成功；一次运行自己就印出超过 500 条事件的整批拒绝，因为之后任何一趟都不可能再把它发布出去；会让未发布总量越过上限的记为失败，webhook 投递则是例外——它那份请求再也取不回来，所以把这一批留在自己那一行上等空位（见下面的入口）。

已经到上限的订阅在 admission 阶段就被跳过、脚本根本不启动，所以那种跳过不计数。只有定时运行和 webhook 运行计入，试运行既不计入也不清零，`resume` 只有提交成功才清零——试运行失败的 resume 两者都不改变。

重试用尽的投递成为 `deliveries` 里的一行：稳定的 `deliveryRef`、接收时的 revision 与 scriptHash 连同那个版本的脚本和凭据、脚本从 stdin 读到的请求体、最后一次错误，以及 7 天到期时间，每个订阅最多 10 条。它比解释它的运行记录活得更久，并且无论试了几次都只计 1 次连续失败——提供方重投同一个请求仍是同一条投递。

每一笔 checkpoint 写入都是那把锁下的一次读—改—写：推进到期时间的 settle、计数的投递、成功清零、发布窗口，改的都是同一行的某一个字段，而用早先读到的记录拼出整行再去写的调用方会丢掉别人已提交的改动——而且是静默丢掉，因为最后写入的赢。投递正是经同一把锁逐条计数，所以三条同时到达会加 3 次而不是 1 次，第三条仍会暂停。

入站入口是唯一不经调度准入的写入方，所以它写之前自己重读终态：投递给已删除订阅、或已归档 Project 的，直接丢弃，而不是把删除刚清掉的行重建出来。

`replay` 动作会再跑一次——默认用当前定义，让修好的脚本能处理旧请求，也可以指定原版本——像任何一次运行那样发布脚本打印的内容，成功与否由同一段提交裁决：投递成功的那次会结束失败连败，而脚本本身失败的 replay 不计数。它是一次运行，所以按运行准入：同样 4 个运行位、同样的同订阅互斥、Host 停止时同样收敛；暂停、删除、Project 归档都会在入场时拒绝它。

`requestId` 命名的是完整意图，而 `replays` 在**任何执行之前**就把它记下来：先以 `running` 状态写入这次请求所指的投递与版本，运行结束后再落定答案。

当前构建写入的 create 与 update operation 还会保存调用方的脚本来源、触发选项和 create baseline。
通过当前操作者与 Project 权限校验后，已提交请求的重试会先按这份意图返回；文件读取、origin 检查、凭据查找与脚本执行都只用于首次提交。

没有这份意图的旧 operation 仍可读取和重试，并按已存的规范化字段比较。
旧的内联脚本可以精确比较；旧记录无法验证的路径重试会被拒绝并返回已提交的 `subscriptionRef`，调用方应先读取已有订阅，再发起新请求。

写这笔记录是前置条件——记不下自己意图的调用会直接拒绝，而不是去跑一个届时无人能交代的脚本；一旦记录存在，这个 id 就被用掉了：同一个 id 指向另一条投递、或同一条投递的另一个版本，一律按请求碰撞拒绝，即使没有任何答案存活下来佐证也是如此；已经重放成功的投递也不会被新的 id 再跑一遍，因为那会把同一份输出发布两次。

仍是 `running` 的记录，是“答案没落地的尝试”。重试无法把它和“中途死掉的尝试”区分开，所以不会重跑：若账本里存着该 id 已接受的事件，就说明输出确实交付了，重试据此作答；否则如实告诉调用方上一次尝试从未记录答案，并让它换一个新的 requestId。答案与投递自己的墓碑属于同一段加锁写入，所以删除只会排在两者之前或之后，不会插在中间。

这两笔写入任一出存储故障都被记日志、调用照样按运行的实际情况作答：输出已经进了账本，一份私有副本写不进去，不能把一次已交付的重放变成无法把握的未知；保留期带走投递时，答案也随它一起走。

HTTP 入口是它自己的一台 WebServer：由本 bundle 自己的 `webhook-ingress` 一行以 `isolate: { webServer: true }` 挂载，所以它提供的东西与浏览器 API 用的监听器毫无共享。这一行自己挂载监听器，而不在组合里点名那台 WebServer，因为 Harness 把该模块列为受保护模块：一旦点名它，bundle 就无法再被禁用，而运行时开关正是运维对该 bundle 用的东西。它只注册 `/team/hooks` 一个前缀，并且只接受 `<前缀>/<token>`——嵌套或更长的路径都不是地址。

监听器绑定 `127.0.0.1` 上 `DSH_TEAM_WEBHOOK_PORT`（默认 3081）指定的端口，发布它是部署决定——前面放隧道或反向代理，并把同一个公网地址写进 `webhook.publicOrigin`。

token 在账本已武装的地址里解析（比对哈希，跨全部已武装订阅做常量时间比较），所以重置、丢掉触发方式、删除订阅、归档 Project 全都答 404，而已经入队的投递保留它那一行——重置移动的是地址，不是队列。

状态码表就是契约：行写进持久存储后才是 202；token 不存在、订阅已删除或 Project 已归档是 404；暂停中是 409；已有十条排队或重试中的投递时是 429 并带 `Retry-After`；请求体超过 256 KiB 是 413；header 超过 1 KiB 是 431；非 identity 的 `content-encoding` 是 415；请求体不是 UTF-8 是 400；非 POST 是 405；存储拒绝入队是 5xx。

单个 header 超过 1 KiB 会直接拒绝投递而不是截断，非 identity 的 `content-encoding` 同样拒绝——验签必须针对提供方签过的那些字节。

只有 `content-type`、`user-agent` 以及匹配 `x-*-event`、`x-*-delivery`、`x-*-signature*`、`x-*-timestamp` 的 header 会到达脚本且一律小写；`authorization`、`cookie`、`x-api-key` 与反向代理插入的 header 永远不会。

入口只在那一行写完之后才答 202，因此在应答之前重启不会丢掉任何东西：队列是私有状态，下一趟补上它欠下的工作。运行从 stdin 读 `{headers, body}`，`DSH_TEAM_TRIGGER=webhook`，并把入队时分配的 id 作为 `DSH_TEAM_DELIVERY_ID`——同一条投递在多次重试和后来的重放中因此保持同一身份。

失败的运行保留那一行，按 1、5、30 分钟等待；第四次失败才把它变成 owner 可重放的 `deliveries` 行，而自己就超过上限的批次直接变成那一行，因为重试只会再打印同一份输出。重试成功的投递就此结束，不为它计一次失败。

重置为同一个订阅铸一个新 token，并把 `generation` 加一而不移动 revision：已接受的投递保留它到达时的版本，而调用方拿到的地址是明文里唯一的一份——账本只存哈希。

create、update 或 reset 的已提交重试，只有该 operation 自身确实武装了地址时才返回 `webhookAddressGone`。
update 由 Host 比较该 operation 与前一 revision 的订阅状态；普通 update 保留已有地址时，即使两次写入落在同一毫秒，也不会返回该标志。

调度器只通过 ports 触达外部，所以 runtime 测试可以用假时钟和假执行器驱动。定时运行经 `ctx.shell` 执行快照——与 Member 的 shell 工具是同一个执行器——但 policy 由 Host 自己从可信的 Workspace 记录构造：以该 Workspace 为根的 `workspace-write`、60 秒、65,536 字节 stdout 上限，且永不用提权模式，因为无人值守运行没有当场批准的人。当前挂载的 shell 家族靠行为探测一次并缓存；用另一个家族记录的快照会以该原因失败，而不会在它并非为其编写的 shell 下运行。

运行以该 Workspace 目录为工作目录，绝不是 Host 进程自己的工作目录；把绝对 checkout 路径写死的脚本在搬迁后会失败，而不是读到旧树。

根本没有挂载执行器时，每次运行都在脚本启动前以 `executor-missing` 失败。执行器已挂载、却起不来钉死 policy 的探测——例如部署里没有可用的沙箱后端——则以 `spawn-failed` 失败，原因就是执行器自己给出的拒绝，这样被暂停的订阅会指向沙箱，而不是让人去找一个其实已挂载的执行器。所以没有可用沙箱后端的部署，任何订阅都跑不起来。

Team runner 对恢复后的原始脚本 stdout 限 65,536 字节；这不是工具或调用方可配置的字段。
执行器收到的 `ShellExecSpec.stdoutMaxBytes=1` 只用于迫使 Harness 公共采集器发布 `spillPath`；Team 随后从 spill 恢复原始字节、按上限校验，并清理这次 spill。
provider 默认 `maxSpillBytes` 是 64 MiB；spill 超限、缺失或不完整时一律拒绝，不回退为接受解码后的文本。

运行的 stdout 就是输出合同：每行一个 JSON 对象，由 Team 从恢复后的原始 spill 用字节级解析器校验。
恢复出的原始字节必须完整、是合法 UTF-8，并落在 Team 上限内；解码后的尾部或看起来合法的尾部都不能冒充完整输出。

新事件按运行固定的 revision 与 scriptHash 接受进账本，并按额度发布；连续三次运行失败会暂停订阅，账本记录这条时没有 Member actor，因为是 Host 自己做的，并且这次暂停为每个 owner（含 Human，无论是否还在关注）各带一个 Main stream marker，让该知道的人都知道。

credential 值每次运行前经 `ctx.credentials` 解析，并在执行器自身环境清除之后合并。Host 从零构造这张表——托管 `DSH_TEAM_*` 事实加上订阅声明的引用——所以 Team 代码不会转发 Host 进程环境里的任何内容。

### 每个 DSH home 只允许一个 Host

同一个 `$DSH_HOME` 最多只能运行一个 Host 进程。订阅的定时器与私有 checkpoint 都在这个 home 里；两个 Host 共用时会各自触发每一次到期、各自推进账本投影与序号，提交操作因此互相竞争。这是部署约束，不是 bundle 强制的锁：同时运行的 profile 要各用独立的 `DSH_HOME`，不要在别的 Host 正在使用的 home 上再启动一个 `dsh web`。

## Worker 委派

每次 Member 委派的 Worker，其授权与执行记录归 Host；准入、激活容量与完成通知归 Harness subagent 服务。两者由 `WorkerRegistry`（`packages/agent-team/src/worker-service.ts`）与 `TeamWorkerProvider`（`packages/agent-team/src/worker-runtime.ts`）接起来。

subagent 服务跟随 Host，而不是跟随 Member：Team 组合的是一处 `@deepseek-ai/dsh-subagent` 挂载加每个已启用引擎一行 provider，Member 的工具调用从它自己的 Agent context 抵达该服务，并把该 live Agent 作为激活的 `parent` 传入。按 Member 各挂一份 provider 会让同一个 projection 在每位 Member 处重复注册，并给每人一棵独立激活树，因此不是本设计。

授权在调用时从 ledger 判定，不看当前页面或目录：目标必须存在且自身一致，调用者必须是它所属 Project 当前的 Agent owner 之一，并且 Host 设置行的 `worker` 组里开关与该引擎都已打开。Human 拥有每个 Project 但不调用 Team 工具，所以不存在 Human 入口。任何拒绝都发生在原生进程启动之前；已接纳的 `requestId` 只对开启它的成员与那次委派返回它自己的执行。

那个答案只属于开启该 id 的成员与那次委派：同一个 id 的两次并发调用只开一个引擎，换成员、换任务、换引擎或换目标复用该 id 会被拒绝，而不是被应答。

provider 为每次委派打开一个 OAR 会话，使用操作者显式给出的引擎设置，并把设置行里的 Codex 权限模式带进那次打开：精确 pin 的 OAR 0.95.1 从 Host 进程自己的 `OAR_CODEX_SANDBOX` 读取它——会话的 `env` 只到子进程，库也没有逐会话的选项——所以这个值只在打开调用期间设置，到 app-server 握手返回后恢复——这是本 Host 里另一个 Codex 会话打开时可能看到它的唯一窗口。

该行的开关还决定 Member 表面，而不只是执行：关闭时 `team_worker` 不声明给 Member，实时修改在已有 Session 的下一个 turn 边界生效。同一开关还决定 `team:project-owner` prompt section 里的 Worker 段落，而该段落每次组装都会重新求值。registry 在开关关闭时仍然拒绝发起，所以尚未跟上的表面永远不会变成执行路径，而已在执行的 run 保留自己的 handle。

从未存过该策略的设置行解析为 `danger-full-access`；Claude 不需要自己的策略：两个引擎在嵌入式用法里都无门槛运行——没人值守的批准提示是卡死而不是安全——所以本 bundle 不会给操作者已经委派出去的工作再加一道权限闸。收紧某个 Worker 是操作者的显式选择，这个字段只为它存在：设置页只展示开关与引擎，不展示该策略，所以更窄的 Worker 是手写设置行，而不是页面上的字段。

provider 还保留引擎的原生 session 身份与工作目录，并把只读诊断所需的锚点——原生 turn 与引擎自己记录的绝对路径——捕获在结果对象上。Codex 会自报该路径；Claude 的流里没有，所以它由 CLI 自报的 cwd 与本次执行打开时的环境（`CLAUDE_CONFIG_DIR`，否则 `$HOME/.claude`）推导而来，猜错时只是读不到，而不会去搜别的文件。它直接使用精确 pin 的 `@botiverse/oar`，而不是 Harness 的 OAR provider：Worker 必须暴露该原生身份，且执行记录必须归 Team；该库按需导入，所以没有它的 Host 依然能启动，普通 Session 也不受影响。

委派在写任何东西之前先绑定目标：`taskRef` 定住它的 Thread，只给 `threadRef` 时定住该 Thread 以及它自己的 Task，只给 `projectRef` 则是纯 Project 委派。Thread 或 Task 决定 owner 校验所针对的 Project，把 Task 与不属于它的 Thread 一起给出按矛盾拒绝。所有拒绝都发生在写 started 记录之前、原生进程启动之前。绑定写定后即冻结：之后的页面、目录、成员关系变化或 Task 转派都不会移动一次执行的结果。

绑定带来两种记录形态。

**绑定**的执行写两条 ledger 操作——`team/worker-started` 与 `team/worker-settled`——Thread 上对应 `worker_started` 与 `worker_settled` 两条公开事实。started 事实说明一次执行开始并给出引擎；终态事实再加 `state`，失败或停止时加一行不超过 2000 码点的 `reason`。Worker 的答案永远不公开：它留在终态操作的私有载荷里，与任务正文、工作目录、原生 session 身份和完整 diagnostic 一起，只通过同一次提交唤醒发起者的 Inbox notice 抵达他本人——notice 标明它是外部文本，是数据不是指令。于是任何参与者都能看到执行发生过、怎么结束的，而只有发起该委派的 Member（或 Human）读到它说了什么。激活使用 caller delivery，父 Session 不会收到第二份。

也正因如此，这段文本只存在于记录里：失败或被停止的运行会保留它已经产生的部分——终态说明走到哪里为止，状态词不代替它。

**未绑定**的执行在公开面上保持原样：parent delivery、没有 Thread 事实、不向 Project 发布任何东西。执行记录照样写入——本 Host 启动的每次执行都有 `team/worker-started` 与 `team/worker-settled`——这正是纯 Project 执行之后仍能按 `worker:` 引用查到的原因。

规则版本 6 引入这两个操作：旧 build 打开版本 6 的 ledger 会拒绝并要求更新版本；采纳版本 6 的 Host 会在下次启动时写入这次采纳。

绑定执行的持久状态是派生的，从不存第二份。`threadWorkerStates` 读执行记录而不是某次分页返回的事实，所以长 Thread 上每个绑定的执行都有状态，即使它的事实落在窗口之外。仍标记 `running` 而在本 Host 里没有活跃句柄的记录——运行中被替换的 Host 的签名——读作 `unconfirmed`：结果无法确认，不重跑、不自动重试。`unconfirmed` 不写 marker、不唤醒任何人，只在 Thread 上可见。

停止只有一条事务：成员的 `team_worker` 带 `stop`，与 Human 的 `stopWorker` Remote，进入同一个 `WorkerRegistry.stop`。授权只看打开这次执行的身份——它的 `initiatedBy` 成员，或 Human——刻意不重新套用启动条件，所以 owner 变更、Task 转移或关掉开关都不会左右一次停止。事务先 abort 启动信号（发布之前唯一的取消通道），再 dispose 已发布的 activation，然后等引擎自己的证据决定那一次终态写入。`stopping` 是派生的进程内视图：账本仍只有 `running → 终态`，Thread 读取与 Human 列表在停止进行时加这个词，不为它写任何持久内容。

终态由引擎的结果决定，而不是由请求决定。先到的自然完成或失败保留真实状态，停止回答的就是它。被取消的执行若 dispose 被拒绝，记为 `failed` 并说明清理未确认——绝不报 `stopped`，因为没人确认的停止是 Host 支撑不了的断言。执行已经产出的部分输出随同一份结果走，所以那一次 Inbox 通知把文本与保留意见放在一起。

卸载是同一事务在 Host 尺度的展开，顺序是：拒绝新委派；取消所有仍在启动的执行——包括还在写 started 记录的那一个，它被封口而不是去开引擎；dispose 已发布的；对每个终态最多等五秒；仍未确认的封口；等挂起的终态写入；最后才释放 provider 注册。被封口的执行保留 `running` 记录、不再接受任何迟到的终态，所以关闭存储不会与一次写入赛跑。

Human 的入口是「编辑 Agent」弹窗，列出该成员仍在运行的执行（`running`、`stopping`）、上一个 Host 留在 `running` 的未确认记录，以及按结束时间排序的最近二十条已结束执行——早启动、刚结束的长执行仍在这个窗口内——每条都给出 Host 确认的终态与自己的诊断入口。它的 `stopWorker` 回执是结构化事实而不是要解析的句子：`ended` 给出执行真正到达的状态与 Host 的诊断，`pending` 说明清理仍在进行，`unconfirmed` 说明本 Host 已不再持有句柄。上一个 Host 留下的执行显示为 `unconfirmed`，附说明且不给停止控件；请求本身没有完成的调用只说明这一点，绝不据此判定执行的状态。

### 只读查看一次执行的诊断

查询所需的锚点随执行的终态一起写入，绝不在事后补采。provider 捕获引擎自己的会话、这次执行驱动的 turn，以及引擎自报的记录绝对路径，并把它们挂在结果对象上——Harness 原样交回该对象，锚点是非枚举属性，而不是模块级映射，所以被封口的执行或迟到的终态不会留下任何待收集的条目。

捕获发生在会话仍然打开的时候：取消或清理开始之前，以及 turn 自己结束之时。引擎在拆除过程中关闭记录流，事后再采只会什么都读不到。turn 绑定到本次执行提交的那条输入——记录里若还有另一个根 turn，就无法与本执行唯一关联，此时报「没有 turn id」，而不是取最后看到的那一个。捕获失败不改变任何结局：终态保留引擎报告的状态、诊断与输出，记录只是没有锚点。

`readWorkerHistory`（`packages/agent-team/src/worker-inspection.ts`）是唯一的读取方，两个引擎的记录走同一趟有界读取：引擎只决定哪些字段标识会话、turn 与失败，其余规则不变。它拒绝不是引擎自己目录下绝对 `.jsonl` 路径的记录位置——Codex 是 `sessions`，Claude 是 `projects`——超长值整条拒绝，而不是裁成一个没人记录过的路径。

它解析真实路径，把打开句柄的身份与位置所指的文件比对，读取后再核对一次，并要求首条记录写明所记会话：Codex 的 session 头，或 Claude 在第一个 turn 之前写下的 queue 头。本次执行的 turn 是 Codex 为它记录的 span，或 Claude 侧 uuid 等于 OAR 写入的 input id 的那条 prompt user 消息。8 MiB 预算花在读取本身，所以超长单行永远不会被解析。它只返回该次执行自己那个 turn 的记录、逐片段限长，命中凭证形状的文本整条不返回——带引号的 JSON 键值同样如此。Claude 把失败的 turn 记成 `api_error` system 行或合成 assistant 消息，重试会重复同一条失败，所以读取方只报最后一条一次，而不是越堆越长。每条原因都是一句有界的话，陈述事实而不回显原生值。读到的任何内容都不会写回 Team。

读取在下一条顶层 prompt 处结束，所以日后被继续使用的原生会话不会把后续 turn 的模型或失败借给这次执行。

报告是分层的。公开 Thread 保持原有摘要；详细答案——失败发生的阶段、原生标识、有界片段，或记录无法回答的那一个原因（`missing`、`unreadable`、`unpersisted`、`unsupported`、`unmatched`）——只给发起成员与 Human。尚未结束的执行只回答摘要，并说明记录在结束后才读取；在记录会话之前就结束的执行如实说明这一点，而不会声称引擎从未打开会话。

### 给正在执行的 turn 补一句指令

补指令用的是引擎自己的同轮输入，不是 Team 发明的机制。Host 通过 OAR 的 `session.steer` 转发，它发出运行时的 `turn/steer`，带上 OAR 当前正在驱动的 turn id，因此指令进入的正是正在跑的那一个 turn：不开第二个 turn、不为下一轮排队、也不会到达别的执行。发布版 CLI 的契约——工具执行中提交的指令会进入同一 turn 的下一次模型请求，turn 结束后提交则被拒绝——由 `artifacts/probe-05-steer.mjs` 对着真实二进制与一个 loopback Responses 端点实证。

这条活动控制归执行注册表所有。`WorkerRegistry` 为每个打开的引擎会话保留一个条目，`TeamWorkerProvider` 通过 `WorkerSessionSink` 在会话打开与关闭时上报；该执行的 result 结算时摘除该条目，Host 释放执行时整表清空。没有模块级表，也没有第二个状态所有者：本 Host 不再持有的会话没有可到达的控制，重启也不带任何条目过去。

授权就是打开这次执行的身份——它的 `initiatedBy` 成员。其他成员按 `worker_steer_forbidden` 拒绝；这一版 Human 没有入口，所以 Human 能读一次执行的诊断，但不往它的 turn 里加东西。是否仍在运行由持久记录决定；上一个 Host 留在 `running` 的记录按 `worker_unconfirmed` 拒绝，而不是照发。这一版只对 Codex 开放：它的控制会指明正在驱动的那个 turn；Claude Code 的「接受」覆盖的窗口比当前 turn 更宽——工具结果待处理或最终文本仍在流式时都会接受，可能落进下一个 turn——所以它按 `worker_steer_unsupported` 拒绝，而不是借一个引擎并不提供的保证。

幂等回答先于所有状态检查。`RunEntry.steers` 按 request id 保留一份回执，所以执行仍在跑时和结束后，重送都拿回第一次的回执，且不会再到达引擎；换一个新的 request id 重送同一句话同样如此；用已用过的 request id 送不同指令按 `worker_steer_conflict` 拒绝。已结束的执行、停止在途的执行，以及没有同轮控制能力的引擎会话，各自给出自己的拒绝，而不是发出任何东西。

回执与诊断一样是分层的。`submitted` 是 OAR 有意做出的弱承诺：引擎把输入接管进了当前 turn，这不等于模型读过它、也不等于它在 turn 结束前落地、更不等于有任何结果。答案带上引擎确认过的那个 turn，以及写出答案这一刻执行的状态，所以期间落地的停止是可见的。补指令不写任何账本操作：它不是终态事实、不跨重启，这次执行仍只有原来那一个终态与那一次回传。

## Composer attachments（cache，不是 archive）

Composer attachments 是有界 cache，不是 archive，也不是 ledger bytes。cache 目录是 `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/`，存经过清理的原始名称和 `meta.json` sidecar。

- `putAttachment` 写入 immutable payload：每个文件上限 10 MB，名称中的 path separators 和 control characters 会被剥离。`getAttachment` 为 Client display 读取它们。两者和其他 Host capabilities 一样都是 typed Remote actions。
- `requestId` 是一次 upload 的幂等键。同一 payload 的重试 replay 原结果，而不是写第二份条目。复用该 key 携带不同 payload 的调用被拒为 request collision。cache id 单独由 request id 派生，因此 Host 重启后重试仍收敛到同一条目，不需要第二个 durable store 或进程内 map。
- Project 与 Thread composer 的附件入口有两个：「+」按钮选择文件，或直接向输入框粘贴。携带文件的粘贴会被拦截，并进入同一 pending-file chips 流。纯文本粘贴保持浏览器原生插入。
- Message 在 ledger 中记录 attachment metadata（`attachmentId`、`name`、`byteSize`、`mediaType`）。存储 body 为每个 attachment 携带一行面向机器的 `[attachment] <absolute path>`，供 Member agents 通过普通 file tools 按 path 读取 bytes。Client 会从 display 中移除这些行，改为根据 metadata 渲染 thumbnails/chips。
- Ledger 是唯一 durable attachment authority。Bytes 是 transient 的：Host startup 以及每 24h 执行一次 GC sweep。被 Message 引用且超过 72h 的 uploads（Member consumption window）会被移除。从未发送的 orphaned uploads 超过 24h 同样移除。Metadata 保留，Client 随后优雅降级为 name chip。
- Members 通过 `team_message` 的可选 `attachments` 共享文件。`attachments` 是 absolute paths。Host 先验证每个 path：absolute、regular file、non-empty、10 MB。再以 extension-derived media type 复制到 cache 的 immutable entry。entry id 由该 message/reply request 及 path 在列表中的位置派生，因此 agent-sent images 与 composer uploads 的渲染一致。任一 rejection 都会拒绝整个 send，不提交也不复制。
- request 派生的 identity 让重试收敛。同一 request 的 send/reply 重试复用首次尝试准备的条目，不产生 orphan。body 中每文件一行的 `[attachment]` 跨重试保持一致。准备之后才失败的 message/reply 会删除本次尝试准备、且没有 committed Message 引用的条目，ledger 的引用集是 guard。真正未被引用的 uploads 仍由 GC 回收。复用 request id 时，ledger 比较记录的 resolved attachment ids 与本次重试的 resolved ids。携带不同 attachment 集合的重试被判为 collision。
- 不需要为手动 path references 增加机制。粘贴到 Message body 的 absolute path 会被 Member agent 像其他文件一样读取，Host 不会触碰不属于自己的内容。

## Human profile 与版本脚注

Human 的显示名与头像引用存放在 Team Host row 自己的 Config。settings namespace 就是这个 row 的 id，user layer。头像 bytes 存放在持久的 `$DSH_HOME/agent-team/human/v1/` store，从不进入带 TTL 的 attachment cache。

改名前的 profile 把整个 row Config 存在旧 id `wowyuarm-agent-team-host` 下：显示名、头像引用，以及 `wakeRecycle`、`memberCompaction` 两组 operational 配置。那一行不再挂载，这些值全部悄悄回落到 schema 默认——运维关掉的 Member compaction 会自己回来。

所以启动时 Host 从 profile 自己的 patch 文档把它们读出来，只把当前 namespace 的 user 层还没有存过的字段逐个写进去；Human 升级后在那边设过的值优先，即使等于 schema 默认。含 `!!js` 表达式的字段留 schema 默认，不把表达式源码当值写回；头像引用只在 bytes 还在 store 里时才搬；与活跃 Member handle 撞名的显示名丢掉不写。

已退役的 `agent-team-human` section 不再是权威。rc.1 的 settings importer 通过一份封闭的内置映射搬运 section。第三方 section 会留在改名后的 legacy document 里。启动时某个字段在当前 namespace 里没存过，就从那里收养它，走设置页同一条写入路径；该 section 只带名字与头像引用，已经重新填过的值优先。

只有 Host row 有这条迁移路径：profile patch 用改名前的 id（`wowyuarm-agent-team-{scope,preset-registry,preset-team-member,client,invariant}`）覆盖其余五行之一的，会被跳过——没有 loader entry 认这个 id，Team 回落到该行的出厂值。手改过 Team preset 或 preset 注册表 `default` 的，升级后要重新应用一次。

设置页由四个 typed Remote 服务。`humanProfile` 提供名字、头像引用与版本脚注 facts。`putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar` 只收图片，与 attachments 共用 10 MB 上限。已删除的条目读取时抛错，Client 回退到首字母。

脚注携带本 Host 实际运行的那份 bundle 的版本，以及 repository 链接。版本从已安装包自己的 manifest 读取，因此陈述的是 profile 真正装上的版本，而不是每次发版都得记得改的字符串。当后台检查观察到更新的已发布 release，再多一条点名这个版号的更新 tip。

检查最多每 12h 询问一次公开 npm `latest` document。后台刷新使 profile 读取永不等待网络。任何失败都落为「无已知更新」。`DSH_AGENT_TEAM_UPDATE_CHECK=0` 时保持关闭。

ledger 为 `team_view` 与 @ 匹配读取同一份 profile，一次改名同时到达每个 surface。`human` 是 Human 的永久别名，任何 agent handle 不得占用这个字面。因此 `@human` 跨改名持续送达，而 chip 始终渲染当前显示名。
