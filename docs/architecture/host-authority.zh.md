# Host authority

[English](host-authority.md) | 中文

本文说明 Host 的决策及失败边界：持久提交、运行时效果，以及从中派生的投影。先读 ledger 规则，再用生命周期与恢复章节区分「事实已经提交」和「效果仍待完成」。

每个 DSH home 只有一个 Team 协作域。只追加的 ledger 保存 Member、Workspace 参与关系、Project、Message、Thread、可选 Task、Claim、Attention、Inbox 与 Activity 等 Team 事实。Workspace 是否存在及 Session 如何存储仍由 Harness 决定，见 [存储复用](workspace-session-storage.zh.md)。

修改 Host capability 时，先阅读 package source/tests，再阅读匹配的 Harness capability contract。导航表见 [`harness-navigation.zh.md`](../harness-navigation.zh.md)。导航表把 Host 改动映射到 `deepseek-harness/docs/subsystems/` 和 source packages。

## Ledger 权威与提交

### 规则版本与重放

- 当前 Session 上下文可满足 [Thread 阅读条件](../team-collaboration/boundaries.zh.md#mutation-fences)，但不确认未读，也不建立第二份权威；只有显式读取才提交已读状态变化。
- Agent 的 Thread 与 Main stream read 在 ledger 结果上增加[按上下文调整的呈现](../team-collaboration/tools.zh.md#team_thread)：缺失的近期 Message 背景与已可见正文的省略说明。工具按输出上限选出能渲染的前缀，Thread receipt 以 `selectedThroughSequence` 记录这个界限，旧 receipt 仍按缺省 batch 解释；Host 只提交该前缀。Human read、Remote 参数与 replay 语义均不变，重放不依赖 Session。
- mutation 进入 Host authority，并提交一条 durable operation。
- 重放会重算每条记录应有的 Inbox delta 并逐项比较，所以改变既有 kind 校验规则的版本要先写一条 `team/rules-version-adopted`（Host actor，`{ version }`）。每条记录按它之前最新的标记校验；没有标记的 ledger 为版本 1。标记由 `initialize` 在它自己排队的提交里追加，因此早于之后的所有写入，包括启动恢复。标记只升不降，每个版本至多一条；ledger 采用的版本高于本构建实现的版本时拒绝打开。
- 当前构建实现版本 10。挂载时若 ledger 的最新标记低于它，只追加一次版本 10 标记；全新 ledger 在 `team/initialized` 之后立即写入该标记，已经处于版本 10 的 ledger 重新打开不会再写。下面关于版本 2 规则的内容仍只描述各自的记录段，而不是当前标记。
- 版本 10 改变 `team/thread-started` 与 `team/thread-promoted` 对 Task accountable 的校验：任何 transfer 接受的目标都合法。更早的记录段仍要求 Agent 创建者本人、Human start 的 enabled owner 或 Human、promotion 的 promoter，并按各自规则逐字节重放；只实现到版本 9 的 build 会停在版本 10 标记处。
- 版本 9 以 Workspace 参与关系取代 Project 成员关系门槛：enabled Member 可以写入，suspended Member 仍可读取，inactive 或 archived Member 不可读取。新 Project 不保存成员关系列表，旧记录段继续遵循原规则。ownership 仍是独立权限。
- 版本 8 新增 `team/project-owner-responsibility-updated`，并给 `team/project-owner-added` 增加可选的 `responsibility`。两者在版本 8 以下的记录段内都被拒绝，因此更早的构建写下的 ledger 仍逐字节重放，其 owner 记录继续读作未说明；只实现到版本 7 的 build 会在解析这两种形状之前先被版本 8 标记拒绝。所以升级不需要数据迁移——由标记本身决定哪些记录段可以携带新字段。
- 规则版本 2 起，Host 还会提交 `team/main-message-posted`、`team/main-stream-read` 和 `team/thread-started`，它们在版本 1 的记录段内会被拒绝，而 `team/message-sent` 在版本 2 的记录段内被拒绝。Host 不再写 `team/message-sent`（开 Thread 用 `startThread`），它只在版本 1 的记录段内重放。
- 版本 2 记录段内出现 `team/message-sent` 就会被拒绝，带有这种组合的 preview ledger 也不例外；决定重放的是标记与 operation kind，不是 release 标签。

### Inbox 增量与回复引用

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
- 如果 reload 后仍有另一个 live Agent 持有当前 binding 的 write handle，Member 保持 unavailable，直到那个 owner dispose。释放会把一次 runtime-only 重试排入队列，仍针对同一 binding，不会再产生一次 transition。
- 这条 transition 记录就是一次换代的全部 lineage。后继 Session 的 header 不写 `parentSession`——那个字段专指 subagent 的创建者——所以想找退役 Session 的读者去读 ledger，而不是读 header。
- 每个 durable Member state 只有一组期望的外部 effect，即 [Member Lifecycle](../domain-model.zh.md#member-lifecycle) 表。每一次 lifecycle operation 在 commit 之后重跑这组 effect。startup 对每个非 enabled Member 也重跑同一组。archive、suspension、remove 因此走同一条推导重跑收敛，不做第二次 durable 写入。即使 Workspace/Session/filesystem 调用被 crash 或失败打断，也一样收敛。
- startup 绝不把非 enabled Member 激活为 enabled。启动阶段失败的 effect 只记日志，下一次 boot 重试，不让 boot 失败。Member 与 manager 的恢复在 Host ready 之后才开始。teardown 会取消 listing 与 activation；已取消的 Member startup effect 自己拦截晚到的 handle，只有 manager disposal 会等待 100ms 的 drain 宽限期。因此卡住的恢复既不会拖住 boot，也不会拖住 shutdown。同一 Member 的 lifecycle operation 按提交序串行；不同 Member 以及 manager 从不排在彼此的等待之后。
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

## 哪些操作会唤醒 Member，以及 Member 卡住时怎么选

唤醒是 Host 经四种 cause 之一投递的一条**有界合并通知**，每条都带上产生它的持久事实：

| Cause | 产生它的事实 |
| --- | --- |
| `commit` | 任何触及该 Member 的已提交操作：提及、DM、Task 活动、promotion、被接受的回答 |
| `transition` | 一条已记录的 `team/member-session-renewed`、`team/member-session-recycled` 或旧式 `team/member-session-rolled-over`，其 retire 与 activation 效果没有按序完成；重新派生的 Inbox 排在携带输入之后 |
| `activation` | 一次新的 activation，有 carried input 时带上旧 Session id |
| `running` | Member 自身 `agent/status` 转为 `running`——每次转换一次，不是每步一次 |

唤醒不是第二权威，也不承诺恰好一次被模型处理。一次投递失败会清掉它记录的 notice 状态，于是下一条触及该 Member 的提交会重新派生同样持久事实并重试，不会追加第二次通知。

恢复指令排队时记录当时的 Inbox 覆盖。之后到达的事实、整体省略的 Thread 和正文未包含的 Member reminder occurrence 仍待投递。

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
- `TeamChangeStream` 在每个页面内通过 `ctx.remote.$stream()` 按 scope 共享一个逻辑流。Harness 管理共享的 `/api/remote.mux` WebSocket 和连接恢复。每次开场基线都会触发重新读取 Host，包括重连后的相同或更低版本。开场基线既补上首次读取与订阅之间的变化，也在没有新提交时恢复失败的读取。最后一个 listener 离开时释放这个 scope，插件释放时关闭所有 scope。传输失败在恢复前只报告一次。终止性错误直接报告，不走 Team 自有重试循环。没有长轮询回退、跨页面主从选举或单活跃页面限制。

  并发的补充读取合并通知。读取期间再收到通知，保留后续一轮读取，不用旧版本过滤重连基线。Human Inbox 徽标订阅无 scope 通知。订阅经 debounce 重拉 Inbox 合计，在本页 Thread read 后刷新。Presence 订阅更新 Member 可用状态，不唤醒 Inbox。通知只是重新读取的提示，不是第二份事实存储。
- `contextContinuity` unit 经 Harness projection registry 增量折叠活动 Session 事件，只保留恢复所需的旧 intent、checkpoint、continuation 与未答复输入。激活与退休 Session 恢复也可全量折叠被检视日志。
- Member clock baseline 经 `session-event-cursor.ts` 只消费追加事件。Session 身份、继承前缀、日志长度或锚点事件变化时从头重折。守卫依赖日志只追加的契约；同一 sequence、同一事件类型的就地替换不在检测范围内。
- 读取投影按用途定界。`view` 只回答它自己那一页 fact 加上请求点名的 Thread：catalog 字段带的是这一页的 Task、Thread、显示序号与 Claim。只有 `includeCatalog` 才返回整个请求 scope 的 Task/Thread/Claim catalog，也就是模型侧 `team_view` 渲染的 address book 投影。
- Agent view 额外请求 `includeWorkspaceDirectory`：独立目录列出全部 active Project、owners、读者的 `owner` / `following` / `none` 关系和订阅计数，以及 Workspace Member roster。规则版本 9 下 Workspace 参与本身已经授权内容 catalog，目录不再构成门槛；更早版本中它为 `directory only` Project 列出目录而不泄露 Thread、Task 或 Claim。
- 一页读取沿 fact ledger 走到超出 limit 的第一个匹配为止。catalog 读取再多一次对 scope 内 Thread 的目录过滤，以及每个 Task 行一次活 Claim 查询。这些分量必须分开报告，不合并成一个总数：只报返回行数看不出这次读取走过了什么。
- Claim 按 Task 分桶，由重放派生的索引支撑，所以按 Task 的读取（Claim 列表、Thread 画面、Inbox 行、Task board）绝不走账本的全部 Claim。这里每个索引都由重放重建，绝不是第二份 durable 权威。

## Session 持久化与重放
- Bundle 目标为 DSH `0.2.2-rc.2`。Bundle 的 Session persistence 使用当前 DSH schema。随附的 JSONL backend 会自行迁移已发布的旧格式（v0/v1/v2 → V3 → V4），旧格式 Session 数据无需手动处置。这个 DSH Session-schema 策略不会抹掉 Team operation history。Team 有意保留针对旧版、Message-level `occurredAt` 之前 records 的窄 replay normalization。
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
- 换代携带输入而非上下文；具体边界与去重规则统一见下文。
- Pending/error bookkeeping 只在进程内维护。只有进入 transaction 的 compactions 才会写入 durable Session history，绝不写入 Team ledger。
- 终止回合的恢复先读 Harness 的结构化失败，再看措辞。稳定的 code 单独决定结果。`RATE_LIMIT` 是 rate limiting，`TRANSPORT`/`TIMEOUT` 是 transient network，显式 429/503 响应是 rate limiting。其他任何 code（quota、auth、context、请求状态）无论 message 写什么都保持 manual。只有无 code 可用的错误才回落到窄 message 签名。
- `agent/error` 负责终止回合恢复及其连续错误上限。无论走哪条路，失败都保留已记录的 Member diagnostic。
- 在任何 `turn/start` 之前被丢弃的 Team 唤醒，是唯一一类背后没有 `agent/error` 的 error diagnostic。当一条 Team 自己的 Inbox 或 recovery 通知在 Agent 开启回合前离开队列、且不是 Host 自己做的替换或 dispose 时，Host 记一条 `runtime` 类 diagnostic，带上 `source: 'agent/inbox/discarded'`、该 Member 的 `sessionId` 和 `occurredAt`。Host 有意替换或拆除的通知不触发任何东西，所以普通的通知替换从不显示 error。被取消的 splice 不带 durable 原因，因此它和所有 runtime diagnostic 一样只在进程内维护。重启后，在下一次唤醒真正运行或再次取消之前什么都不显示。

### 换代与输入重放

换代归 `team-context-management.ts`，Team 自己的协调器。它从 Host 的唤醒决定出发，而不是从 durable 意图出发，走串行 lifecycle queue 执行，并让新代身份从被退役的 Session 派生，因此崩溃后收敛到同一个后继：

1. 等真正 idle；
2. 在 commit seam 复查 owned-jobs guard 与普通输入队列——排队中的普通消息会让这次换代延后；
3. 在 `agent.runMaintenance` 内以 Host actor 提交幂等的 `team/member-session-recycled` operation，并在存在 live 代时记下 `inputFromSeq`（退役日志的偏移）；
4. retire 旧代：它的 pre-step gate reject 该 step，不发旧代模型请求；随后 dispose + 归档，绝不删除；即使输入已经被 claim，最初的 inbox 插入记录仍在日志中；
5. 激活新 Session，lineage 由 ledger 的 transition 记录承载（它的 header 不写 `parentSession`，那个字段专指 subagent 的创建者）；
6. 从 `inputFromSeq` 起折叠退役日志，按 message id 剔掉新代已经持有的消息，其余用 followup 投递，再从 ledger 重导出 Inbox。

maintenance 是这次 commit 能安全面对换窗中途新输入的原因：loop 停在那里，新消息留在 durable inbox，不会落到正在被退役的那一代。commit 失败则 maintenance 放行，旧代继续运行；commit 成功就退役它，崩溃则留给启动或恢复补完尚未重放的换代。

新代首先收到身份、Project ownership、Workspace 参与和私有记忆索引，加上唤醒它的消息。后续步骤只追加变化或缺失的类别；记忆更新与恢复规则见 [Member 上下文注入](../team-collaboration/memory-and-context.zh.md#member-上下文注入)。不提供 handoff 信封或换代公告。

折叠是 Team 自己的 `contextContinuity` projection unit，在 Team service init 时按 host 注册一次。`context-projection.ts` 拥有 durable checkpoint ref 命名、Team notice 规则、fork cut，以及一代读回的那份折叠状态：带 turn-end 投递状态的 checkpoints、至多一条 legacy rollover 意图、continuation 投递记录，以及被退役那代从未消费的非 Team 输入。它仍然解码的工具名（`context_rollover`、`new_context`、`context_checkpoint`）是给早先版本日志用的解码器，不是 tool alias。

`context-codec.ts` 只写当前构建还产出的那一个信封：quiet checkpoint continuation。识别它、以及识别早先版本写下的两种形状，都在 `context-source.ts`；handoff 的写者只作为那些 legacy 形状的测试 helper 保留。

崩溃恢复从日志派生。被中断的换代按已记录的绑定与被退役的 Session 补完；旧日志里所属 turn 从未 durable 结束的 pending 意图视为 spent 直接丢弃，不会让该代永久无法换窗。

carried-input 重放有界，且以 message id 为准。换代在 commit 时记下 `inputFromSeq`，即退役日志的偏移；折叠只计该边界及其之后的输入。唯一来源是退役 Session 的日志——不出于搬运而把消息内容留在内存里。新代即使已经跑过自己的 turn 也不因此跳过：由边界、新代自己的日志和 inbox 队列决定它还缺哪些消息。只有不带 `inputFromSeq` 的 legacy transition 就沿其已开始的代直接跳过重放。`agent-instructions` 消息由新代重新生成，不作为独立回合重放。

取消的 inbox splice 不记录由谁移除消息。重放必须保住 dispose 清空的输入，因此换代期间显式删除或替换的排队消息也可能被重放。普通 Session cancel 按设计保留待处理输入；这项限制只涉及换代期间编辑队列。

上一代 Session 读不出来时，看问题属于哪一类。两类都走 warn 放行。第一类是日志损坏（`corrupt session log`，Host 会修复 torn tail）。第二类是确定性格式拒绝（`SessionFormatUnsupportedError`，重试无法改变结果）。缺失、IO 和未知原因仍 fail-closed。带输入边界的 wake 换代即使新代已经运行，也仍执行这项检查。Member Session 有没有 durable 持久内容，看 session-persistence inspection 的判定。判定会等进行中的 retirement drain。绝不使用会与 suspend 终末 flush 竞争的裸元数据列表。

唤醒判定本身是 `wake-recycle.ts` 里的一条纯 gate 阶梯：未启用、没有上一代、活动时刻读不出来、缓存可能还热、context 未到水位线，每一档都答 resume，只有冷得够久且 context 够大才换代。[`memory-and-context.zh.md`](../team-collaboration/memory-and-context.zh.md) 拥有阈值与那个配置组。

## 私有记忆、归档与身份效应
- Member preset 根据当前 Host facts 与当前 Session surface 派生身份、Project ownership、Workspace 参与及私有记忆上下文。分类和记忆更新规则见 [Member 上下文注入](../team-collaboration/memory-and-context.zh.md#member-上下文注入)，不建立第二份持久状态。
- `workspaceRulesForAgent` 决定 Member 或当前 manager 读取哪些 [Workspace 规则](../team-collaboration/memory-and-context.zh.md#workspace-规则) 文件；这些文件归 Team 所有，不是账本事实，Host 只读取它们。
- `$DSH_HOME/agent-team/members/` 下的 private-memory directories 是 Member identity 的 Host-owned effects，不是第二权威。Member activation 确保 private-memory directory、`notes/` 和缺失的 `memory.md` 存在。startup 不会清理 ledger 不知道的 `member:` directories。显式 Member removal 会归档这个 Member 的 Session，并移除这个 Member 的 private-memory directory。Team removal path 之外的 entries 保持不动。
- 这项删除，以及 activation 时对旧式 colon 目录的改名，都限定在当前进程自己的 members root 之内。记录里的 `privateMemoryPath` 是一条 durable 绝对事实，指向「当初添加这个 Member 的那个 DSH home」里的目录。因此解析到另一个 home 的进程会拒绝搬移或删除这个目录（并告警），而不是把 Member 的真实私有记忆搬出 Member 自己的 home。
- 归档隐藏 Member 或 Project，但保留完整事实，不等于 remove。目前没有 restore 入口。`archiveMember` 提交 `team/member-archived`。dispose live session，私有 memory 与 Session log 留在磁盘，并把 Session 从分组 surface 归档。`archiveMember` 再以公开 `claims_released` Activity 加上 Attention/marker 清理，释放这个 Member 的 active Claims。被隐藏的 Member 不得让 Task 卡在 in progress，也不得留下幻影 unread 计数。`archiveProject` 提交 `team/project-archived`，对 Project 上所有 Thread 的 owner 施加同样的释放形态。两种归档形态下，更早规则版本派生的 Project 成员关系都作为已存事实保留（隐藏态，非退出）。

  局部的 Project 编辑在账本的串行段落内合并：请求没写的名字或描述，`updateProject` 保留已存的值；重放只比较它自己写明的字段，所以排在并发编辑之后的写，不会把调用方入队前读到的快照写回去。

  Archived 实体不再出现在活跃协作界面和操作中：
  - projection：view projects/threads/tasks/members、mention 候选、Project join、编辑。
  - ref 解析：`resolveTaskRefs`/`resolveThreadRefs` 跳过 Archived 实体，message 正文渲染为纯文本。
  - ref-addressed read：`readThread`、`threadHistory`、`threadObservations`、`listClaims` 以明确的 archived 错误拒绝，绝不伪装成 unknown-ref。

  事实则完整保留在 ledger 中，供重放与未来恢复。这条边界就是 archival 与 remove 的分界。从 archived 状态 Remove 仍可作为数据清理路径。本轮刻意不提供 restore 入口，与 dsh 的 archived session 对齐。Project 归档之前写入的 ledger 省略 `project.state`。记录 schema 在 load 时把 `project.state` 归一化为 `active`。

## Member capabilities 与 skills

### 持久意图与回合边界效果

- Member capabilities 是随全部 lifecycle operation 原样流转的 durable intent。Member capabilities 指 Member 实体上的 `capabilities` 字段，即预留的 `tools.allow` 与 `skills.allow`。commit 时不做已知名白名单校验，保证 Harness 升级后旧 ledger 仍可重放。与已知名的偏差在 activation 时派生为不持久化的 `capabilityWarnings`。`tools.allow` 是有意的接口预留：当前没有 UI 写入路径。编辑是局部更新：字段缺省即保持已存储的值，显式传 `null` 才清除。因此不管理 capabilities 的调用方可以直接省略该字段，其他来源写入的覆盖不会被带掉。`model` 是例外，不可清除，见下面的模型契约。
- Activation 在 preset 校验前限制每个 Member，顺序为 mount → restrict → validate；未配置 `tools.allow` 时也生效。allow-list 只能缩减 preset 基准范围，保留 Team tools（`team_worker` 视开关）与 `working_directory`；范围外的名字被忽略并报告 warning。工具过滤、执行检查、回退与限制见 [Tools and preset](tools-and-preset.zh.md)。对 live Member 编辑 allow-list，在 turn 边界同 Session 换装 restriction。idle Member 立即生效，running Member 的编辑等自己这个回合结束。

  Host row 里的 profile 级 `extraToolGrants` 是另一份按确切已注册工具名的许可：它可以重新放行 allow-list 省略的继承基线名称，也可准入 Agent scope 注册，但不能重开 Team tools、`working_directory` 或 Worker 开关。Host 在 `turn/start` 同步读取并在该轮冻结，后续回合总读取最新已保存名单。

  Team tools 不受任何 allow-list 影响，因此会让 Host 运行代码的 Team tool 自己检查实际生效的工具范围：Agent 发起的订阅 create、update、test、resume 或 replay，只有在该 Member 当前安装的 restriction 放行 `bash` 或 `pwsh` 时才会执行，否则被拒绝；尚未安装 restriction 的 Member 视为没有 shell。见 [`team_subscription`](../team-collaboration/tools.zh.md#team_subscription)。

  `team_message` 的 `attachments` path 是同一种越权形状：它让 Host 读取一个 Member 自己本来能读的 Host 文件。因此 Agent 发起的、带 attachments 的 start、reply 或 post，在该 Member 生效的工具面放行 `read`、`read_image`、`bash` 或 `pwsh` 之一之前，都会以 `attachment_read_required` 被拒绝。

  path 还被约束在调用 Agent 的工作目录内：先做 lexical 检查（不触碰文件系统），再在 `realpath` 之后复检；落在目录之外的 absolute path、`..` 逃逸、或逃逸 symlink 都会让整个 send 被拒，且不写入 cache。Human Remote 路径没有 Member 工具面与工作目录，只保留常规校验。见 [`team_message`](../team-collaboration/tools.zh.md#team_message)。

  每个 Member 各自拥有一条 lifecycle 链，所以该等待只挡住这个 Member 后续的操作，且仍按提交序。管理别的 Member 从不排在它之后，而 ledger 仍是唯一的有序 writer。

  每次边界等待返回后，capability 与 Worker 工具面编辑都同步复查 live handle 和真正 idle。若新一轮已开始，就再次等待，而不是覆盖该轮冻结的许可。shutdown 释放等待，但不会再向退役 context 注册观察器或安装 restriction。

  Host shutdown 释放每一个待定的等待，而不是去等一个可能永不结束的回合；在链之外被销毁的 Session 同样释放它。stop 取消该 Member 在途的回合，然后等 Agent 收敛。所以排在停靠编辑之后的 stop 先到达那个边界（编辑此时已生效），随后通常发现 Agent 已 idle。stop 从不清除或中止已提交的配置：编辑要么在边界生效，要么报告延后应用；两种顺序都让存储的意图在下次 activation 时仍然成立。

  等待按类别记日志，带 Member、Session 与时长：等自己的回合是 `stage 'wait-turn'`，等外部执行（例如 Agent 释放自己的 Session 写路径）是 `stage 'wait-external'`。activation 期间的 restriction 失败只表现为这个 Member 的 activation failure。
- live 应用 Member capability 失败不会放宽面：编辑保留其 ledger commit，不含额外许可的编辑保留旧 restriction，Remote 调用照常暴露失败。同 requestId 重试会重新应用已存储配置且不产生第二次业务提交。profile 许可策略安装失败则收紧到该 Member 的无额外许可基线，绝不恢复到上一份含许可的 restriction；若该基线也失败，下一步会在模型请求前被拒绝。Host 比较的是存储意图与运行时实际已应用的效果，绝不与该次请求自身的历史比较。
- 配置编辑把「效果」与「提交」分开回报：`updateMember` 返回 `effect`，取值 `applied`、`already-applied`、`deferred:no-live-handle` 或 `deferred:generation-changed`（先落账、下次激活生效）。失败不进取值——保持响亮拒绝，同时按失败阶段留一条可路由的 `model-apply` 或 `capability-apply` diagnostic。`detail` 带 requestId、operationId、阶段与原因，Session 结构化放在 `sessionId`，日志用同一组关联 id。
- manager 面对已提交但运行时应用失败的编辑给出不同答案：`member_update` 按失败阶段把 `failed:model-apply` 或 `failed:capability-apply` 作为 effect 答回，并在 `status` 里带上同类别的 Member 自身诊断——它的写已经提交，而调用者是模型、会把拒绝当成重试信号。已存的意图留给下次激活重试，重放同一请求也会重试：效果取自活代实际在跑的状态与当前 Member 行的比较，而不是这次请求出发时的那条记录。
- 生命周期重放只补做自己这次操作欠下的效果：`suspendMember`、`resumeMember` 与 `archiveMember` 在写完之后读取当前 Member 行，并把运行态收敛到那个状态，所以晚到的 suspend 重放不会 dispose resume 刚激活的那一代，重放的 resume 也不会复活被后来的 suspend 停掉的 Member。答案报告同一行，回执仍是原来那一个。

### 模型路由持久化

- Member 始终使用一条显式路由。创建必须给出一条，编辑只能替换、不能清除回 Host 默认；写入者只有两个：Human 的编辑（本节）与该 Member 自己的 Session（下条）。在此契约之前写入的账本记录没有 `model`，仍可读取，并按当时 Host 的默认选择唤醒。
- 模型编辑的落账与回报和其他编辑一样，但新路由是否生效由上游决定：切换后新窗口在压缩之后仍装不下当前 Session 时会被拒绝并保留原路由，pending 选择就等到换回兼容模型为止，而记录在案意图两种情况下都在。
- composer 是另一个入口，且不靠选择事件落账。真正证明切换越过了 Host 的压缩检查、进入一次真实请求的是 Member Session 的 `request/header`，所以 Host 以 `header.config` 的路由写一条 Human 的 `team/member-updated`。只写路由：推理档位是 Session 日志里的事实，activation 对同一条路由重新读取。
- 有三种请求什么都不写。一种是请求的路由与 Member 当前正在跑的路由一致，包括 Team 自己在 activation 时写回的那条，于是写回不会经账本自循环。另一种是被 Host 拒绝的切换：它根本不会记下 header，因此也从不写入。第三种是 Member 已经走过的 header：该 step 固定路由之后发生的选择更新，写回这条 header 的路由会把被替换掉的那条按回去。
- 名册每行的 `capabilityState`（`applied` | `pending`）比较该 Member 存储的 `capabilities` 与运行时已应用的配置；没有运行时的 Member 报 `pending`。它与 `availability`、`presence` 分开，也不表示某个回合的 profile `extraToolGrants` 是否生效。

### 隔离的 skill 目录

- Team skills 使用各 Team preset 内部隔离的 registry。它唯一注册的 provider 是 Team router，由 router 选择确切 Agent 的 filesystem provider；Host 全局 provider 与 runtime skills 不会进入 Team 的发现、加载、显式 `/skill` 调用或模型目录。shipped Session skill catalog 与 `skill` 工具读取同一个 registry。普通 Session 继续使用 Host registry，以及其中配置的全部全局 skills。

  Host runtime 把自己拥有的 Team registry 显式传给 provider 挂载。两者同时存在时，经普通 `agent.ctx` 查找得到的是 Host registry，找不到 Team 的挂载。

  挂载 handle 只能修改自己的 provider 的选择或卸载它。被替换后，旧 handle 无法影响后继。路由与过滤保留「发现未完成」的状态，因此 registry 可以展示已找到的候选项，并重试发现。

  每个 Member provider 只扫两个 Team 自有 root，排除默认 roots。排前的是插件内置的只读 core skills（`packages/agent-team/core-skills/`，同名内置 skill 跨升级保持稳定）。排后的是 Member 可写的 `$DSH_HOME/agent-team/members/<member-directory>/skills/`（Member id 中的 `:` 替换为 `-`）。

  manager Session 由自己的 runtime 提供同构的隔离结构与两处 root：只读的 `packages/agent-team/manager-skills/`（排前，并由同一个 `check:core-skills` 检查）与可写的 `$DSH_HOME/agent-team/manager/skills/`。Member 的 root 与 manager 的 root 互不进入。

  Member catalog 从内置集起始，内置集里有 `member-skill-manager` meta skill。全部 skill 写作/安装/credentials 引导都在这个 meta skill 里面。persona 只陈述私有空间物理事实。安装就是往 Member 自己的目录写。目录形态为 `skills/<name>/SKILL.md` 加可选 references/scripts，或平铺 `.md`。有意不提供上传 Remote，发现由 filesystem watcher 驱动。

  `skills.allow` 通过已挂载 provider 上的 live selection swap 过滤 `list()` 输出。编辑与 tool 编辑在同一 turn 边界换过滤并失效 catalog。过滤是可见性语义，不是安全边界：两个 root 始终被扫描和 watch。Member remove 连同私有目录一起删除。suspend/resume 与 Host restart 恢复相同 catalog。

## Host 服务面（`ctx.agentTeam`）

Host row 只发布一个服务 `ctx.agentTeam`，它被两类消费方以不同方式使用，稳定性承诺也不同。没有 CLI 或 `bin`。Web Client 是唯一的 Human 控制面，所有变更都经 typed Remote 下发。bundle 另有下文的 webhook HTTP 入口，只接收外部服务请求，不是 Human 控制面。

- **Remote 方法**（带 `@Remote` 装饰的，如 `members`、`view`、`addMember`、`updateMember`、`sendMessage`、`readThread`、`inbox`、`humanProfile`）是 Client 契约。它们由声明生成 Typert 产物来定型，所以 Client、模型侧工具和其他消费方编译期对齐同一形状；改动其中任何一个都属契约变更。
- **仅 Host 侧的服务方法**（如 `memberForAgent`、`membersForClient`、`status`，以及激活/生命周期内部实现）供进程内 Host 调用方使用——preset 行、commit listener、启动期的派生逻辑。它们没有兼容承诺，可能随版本调整。

只有 Remote 那一组是契约。`ctx.agentTeam` 上其余部分都是内部实现，改动形状时不会附迁移说明。

preset 行必须在执行时解析 `ctx.agentTeam`，不能在声明期静态捕获：该服务在 Host 插件启动后才提供，import 期就闭包捕获它的行拿到的是空。外部代码里的 `ctx.get('agentTeam')` 同理，那是对内部面的未文档化使用，不是受支持的集成点。

## 订阅调度与无人值守执行

`SubscriptionScheduler`（`subscription-runtime.ts`）管理定时器与失败计数。全局最多同时运行四个脚本，owner 试运行也占名额；同一订阅串行执行，到期时间合并到唯一排队条目。每个订阅每分钟最多发布二十条事件。

准入时重读 ledger，删除或 Project 归档后的试运行、定时运行不得启动。读取失败时记日志并保留排队条目；明确拒绝才出队并答复。终态不再发布，也不保留 checkpoint。

### 私有历史与清理

`subscription-store.ts` 维护私有 `agent_team_subscriptions` domain：

| 状态 | 用途与保留规则 |
| --- | --- |
| checkpoint | 下次到期、连续失败、发布窗口和最后成功时间；重启从中继续。 |
| `runs` | 每个订阅最近五十次运行。 |
| `deliveries` | 自动重试耗尽的 webhook 投递。 |
| `replays` | 每次重放请求的意图与答案。 |
| `admissions` | 仍待执行、接受或记录可重放失败的 webhook，包含接收时的定义和队列满时暂存的批次。 |

这些行不是 Team ledger 事实。删除 checkpoint 不会改写事件，但会改变调度和失败计数。

运行记录包含触发方式、开始时间、耗时、类别、退出码或超时、已接受事件数，以及两路输出各自末尾 8 KiB。摘要同时携带身份：`subscriptionRevision`、`scriptHash`、`runRef`；投递另带 `deliveryRef` 与重试次数。

事件数只计算 ledger 真正接受的内容，不是脚本输出量。试运行、被拒批次和已知事件 id 都不增加计数。试运行也记历史，但 create 的草稿试运行没有已存订阅可归属，因此不记。

删除会在答复前清空全部私有表和 checkpoint；启动时补完中断的清理。Project 归档立即清理同样状态。清理与私有写入共用锁，每段写入都重查终态：要么先写再被清理，要么清理后不写。删除落在两段之间也不会重建行。

有权读取 Project 的人都能看摘要与身份。输出尾部和解释文本只给 Human 与 owner，无论运行成功还是失败，因为脚本使用 Project 凭据。`team_subscription logs` 与 Remote `subscriptionLogs` 读取同一份历史。

### 成功、失败与发布上限

成功以输出被 ledger 持久接受为准。接受、连续失败清零与最后成功时间在同一锁内完成；后续结算只推进下次到期。exit 0 但没有新事件，仍走相同的零事件成功路径。

脚本在锁外运行，不阻塞投递。checkpoint 每次都在锁内读—改—写，不把旧快照整行写回。因此并发失败不会丢在成功清零的读写之间：三条失败投递累计三次，第三次触发暂停。

只有固定 revision 仍为当前 revision 的结果才改变失败计数与最后成功时间。旧结果按原 revision 留在历史中，不清零也不增加当前连续失败。

未发布事件上限为五百条：

- 已达上限的订阅在脚本启动前跳过，不计失败。
- 单批超过五百条，永久拒绝。
- 定时批次使当前队列溢出，记为失败。
- webhook 批次本身未超限、但暂时放不进队列时，保留在 admission 等空位，因为无法重新抓取请求。

定时和 webhook 失败参与计数；试运行既不计数也不清零。resume 只有试运行成功且提交后才清零。连续三次失败由 Host 记录自动暂停，并向每个 owner 的 Main stream 发一个 marker，Human 也在内，不受关注状态影响。

重试耗尽的投递保留稳定 ref、接收时的 revision 与 script hash、该版本脚本与凭据引用、stdin 请求体、最后错误及七天有效期。每个订阅最多十条，可比运行历史活得更久；无论重试或提供方重投多少次，都只计一次失败。

入站写入不经过 scheduler 准入，因此必须自行重查终态；迟到投递不能为已删除订阅或已归档 Project 重建私有行。

### 重放回执与已提交重试

`replay` 默认使用当前定义，也可指定接收时的版本。它通过普通接受路径发布，同样占四个全局名额、按订阅互斥，并遵循关闭收敛。暂停、删除或 Project 归档都拒绝准入。成功重放清零，重放脚本失败不增加计数。

执行前，`replays` 先持久记录 `requestId`、投递、版本与 `running`。记不下意图就不执行。一经记录，id 即已使用：改投递或改版本都算碰撞，即使答案未落盘。已经投递成功的重放不能换新 id 再跑。

重试仍为 `running` 的请求不会自动执行。ledger 已有接受记录就返回该结果；否则说明答案缺失，供调用方显式选择新 id。结算在同一锁内写答案与投递 tombstone，整体排在删除之前或之后。

结算存储失败只记日志，不隐瞒已经投递的结果。答案随投递一同过期。

当前 create/update operation 还保存原始脚本来源、触发选项与 create baseline。重试先校验当前操作者和 Project 权限，再按已存意图返回，不重新读取文件、检查 origin、查凭据或执行。

旧 operation 按已存规范化字段比较。粘贴脚本仍可精确比较；无法核实的旧路径重试会带已提交的 `subscriptionRef` 拒绝，让调用方先检查再决定是否新建请求。

### Webhook 入口与持久准入

bundle 的 `webhook-ingress` 行在 `isolate: { webServer: true }` 下自行挂载独立 WebServer，不共享浏览器 API 监听器。不能在组合中点名 Harness 受保护的 WebServer 模块，否则 bundle 将无法禁用。

监听地址为 `127.0.0.1`，端口取 `DSH_TEAM_WEBHOOK_PORT`，默认 3081。只接受 `/team/hooks/<token>`，不接受嵌套或更长路径。公开访问需部署隧道或反向代理，并配置一致的 `webhook.publicOrigin`。

入口对所有已启用地址以常量时间比较 token 哈希。重置地址、移除 trigger、删除订阅或归档 Project 后，旧地址返回 404。重置只改地址，不改已排队投递。

| 响应 | 条件 |
| --- | --- |
| 202 | admission 行已经持久化。 |
| 404 | token 未知、订阅已删除或 Project 已归档。 |
| 409 | 订阅暂停。 |
| 429 + `Retry-After` | 已有十条投递排队或重试。 |
| 413 | 请求体超过 256 KiB。 |
| 431 | 转发 header 的单个值超过 1 KiB，不静默截断。 |
| 415 | 非 identity 的 `content-encoding`。 |
| 400 | 请求体不是 UTF-8。 |
| 405 | 非 POST。 |
| 5xx | admission 存储失败。 |

大小与编码检查保留提供方签名的原始字节。脚本只收到小写的 `content-type`、`user-agent` 及匹配 `x-*-event`、`x-*-delivery`、`x-*-signature*`、`x-*-timestamp` 的 header；不转发 authorization、cookie、API key 或代理附加头。

脚本从 stdin 读取 `{headers, body}`，环境带 `DSH_TEAM_TRIGGER=webhook`，并以 admission id 作为 `DSH_TEAM_DELIVERY_ID`。同一身份贯穿重试与重放。持久准入后、202 应答前重启，工作仍留在队列中。

关闭时先停止新队列检查，排空 scheduler，等待在途 webhook 检查，再关闭存储。未完成工作留给下次 Host。

失败后按一、五、三十分钟重试。第四次失败转为可重放的 `deliveries` 行；单批超限直接进入该行。重试成功结束投递，不计失败。

Host 先记录重试耗尽与失败计数资格，再写可重放失败。结算中断后续办，不重跑脚本；有资格的投递只计一次，必要时只提交一次自动暂停。暂停允许结算，删除和 Project 归档则丢弃未完成工作。

已提交 resume 开始新一轮计数，即使 checkpoint 写入还需重试。之后的成功或 resume 阻止旧结算再次计数；定义编辑也阻止旧结算为新定义计数或暂停，但保留已计失败。定时器等待尚未完成的计数或暂停结算。

reset 铸造新 token 并增加 `generation`，不改 revision。已接受投递保留接收版本。只有返回地址包含明文 token，ledger 只存哈希。

create/update/reset 的已提交重试，只有原 operation 确实启用了地址才报告 `webhookAddressGone`。update 与前一 revision 比较，保留旧地址的普通更新不会误报，即使两次写入同在一毫秒。

### 脚本执行边界

运行时测试通过 ports 使用假时钟和假执行器。实际运行使用与 Member shell 工具相同的 `ctx.shell`，但 policy 由 Host 从可信 Workspace 构造：以该目录为根的 `workspace-write`、六十秒、65,536 字节 stdout，禁止提权。cwd 是 Workspace，不是 Host cwd；硬编码旧 checkout 路径会在迁移后失败。

Team 设置 `ShellExecSpec.stdoutMaxBytes=1`，促使公开 collector 给出 `spillPath`，再读取完整原始字节、检查上限并删除 spill。provider 的 `maxSpillBytes` 默认 64 MiB；缺失、超限或不完整的 spill 直接拒绝，不用解码文本拼补。

stdout 必须完整、为合法 UTF-8、不超过 65,536 字节，每行一个通过校验的 JSON 对象。这是 Team runner 的限制，不是工具或调用方选项。看似合法的尾部不能冒充完整输出。

当前 shell 家族按行为探测一次并缓存；另一家族的快照直接失败，不在错误 shell 中执行。未挂载执行器报 `executor-missing`；已挂载但 policy probe 无法启动报 `spawn-failed`，保留执行器自己的拒绝原因。没有可用 sandbox backend 就不运行任何订阅。

接受固定 revision 与 script hash，发布遵守上述额度。每次运行通过 `ctx.credentials` 解析凭据，在执行器清理环境后合并。Team 只构造受控的 `DSH_TEAM_*` 信息与声明的凭据引用，不自行转发 Host 进程环境。

### 每个 DSH home 只允许一个 Host

每个 `$DSH_HOME` 最多运行一个 Host。定时器和私有 checkpoint 没有进程锁；两个 Host 会各自调度工作，并让 ledger 投影与 sequence 竞争。并发 profile 必须使用独立 home，不能向已占用的 home 再启动 `dsh web`。

## Worker 委派

每次 Member 委派的 Worker，其授权与执行记录归 Host；准入、激活容量与完成通知归 Harness subagent 服务。两者由 `WorkerRegistry`（`packages/agent-team/src/worker-service.ts`）与 `TeamWorkerProvider`（`packages/agent-team/src/worker-runtime.ts`）接起来。

subagent 服务跟随 Host，而不是跟随 Member：Team 组合的是一处 `@deepseek-ai/dsh-subagent` 挂载加每个已启用引擎一行 provider，Member 的工具调用从它自己的 Agent context 抵达该服务，并把该 live Agent 作为激活的 `parent` 传入。按 Member 各挂一份 provider 会让同一个 projection 在每位 Member 处重复注册，并给每人一棵独立激活树，因此不是本设计。

授权在调用时从 ledger 判定，不看当前页面或目录：目标必须存在且自身一致，调用者必须是它所属 Project 当前的 Agent owner 之一，并且 Host 设置行的 `worker` 组里开关与该引擎都已打开。Human 拥有每个 Project 但不调用 Team 工具，所以不存在 Human 入口。任何拒绝都发生在原生进程启动之前；已接纳的 `requestId` 只对开启它的 Member 与那次委派返回它自己的执行。

那个答案只属于开启该 id 的 Member 与那次委派：同一个 id 的两次并发调用只开一个引擎，换 Member、换 Task、换引擎或换目标复用该 id 会被拒绝，而不是被应答。

### 引擎策略与工具可见性

provider 为每次委派打开一个 OAR 会话，使用操作者显式给出的引擎设置，并把设置行里的 Codex 权限模式带进那次打开：精确 pin 的 OAR 0.95.1 从 Host 进程自己的 `OAR_CODEX_SANDBOX` 读取它——会话的 `env` 只到子进程，库也没有逐会话的选项——所以这个值只在打开调用期间设置，到 app-server 握手返回后恢复——这是本 Host 里另一个 Codex 会话打开时可能看到它的唯一窗口。

该行的开关还决定 Member 表面，而不只是执行：关闭时 `team_worker` 不声明给 Member，实时修改在已有 Session 的下一个 turn 边界生效。同一开关还决定 `team:project-owner` prompt section 里的 Worker 段落，而该段落每次组装都会重新求值。registry 在开关关闭时仍然拒绝发起，所以尚未跟上的表面永远不会变成执行路径，而已在执行的 run 保留自己的 handle。

从未存过该策略的设置行解析为 `danger-full-access`；Claude 不需要自己的策略：两个引擎在嵌入式用法里都无门槛运行——没人值守的批准提示是卡死而不是安全——所以本 bundle 不会给操作者已经委派出去的工作再加一道权限闸。收紧某个 Worker 是操作者的显式选择，这个字段只为它存在：设置页只展示开关与引擎，不展示该策略，所以更窄的 Worker 是手写设置行，而不是页面上的字段。

provider 还保留引擎的原生 session 身份与工作目录，并把只读诊断所需的锚点——原生 turn 与引擎自己记录的绝对路径——捕获在结果对象上。Codex 会自报该路径；Claude 的流里没有，所以它由 CLI 自报的 cwd 与本次执行打开时的环境（`CLAUDE_CONFIG_DIR`，否则 `$HOME/.claude`）推导而来，猜错时只是读不到，而不会去搜别的文件。它直接使用精确 pin 的 `@botiverse/oar`，而不是 Harness 的 OAR provider：Worker 必须暴露该原生身份，且执行记录必须归 Team；该库按需导入，所以没有它的 Host 依然能启动，普通 Session 也不受影响。

委派在写任何东西之前先绑定目标：`taskRef` 定住它的 Thread，只给 `threadRef` 时定住该 Thread 以及它自己的 Task，只给 `projectRef` 则是纯 Project 委派。Thread 或 Task 决定 owner 校验所针对的 Project，把 Task 与不属于它的 Thread 一起给出按矛盾拒绝。所有拒绝都发生在写 started 记录之前、原生进程启动之前。绑定写定后即冻结：之后的页面、目录、成员关系变化或 Task 转派都不会移动一次执行的结果。

绑定带来两种记录形态。

**绑定**的执行写两条 ledger 操作——`team/worker-started` 与 `team/worker-settled`——Thread 上对应 `worker_started` 与 `worker_settled` 两条公开事实。started 事实说明一次执行开始并给出引擎；终态事实再加 `state`，失败或停止时加一行不超过 2000 码点的 `reason`。Worker 的答案永远不公开：它留在终态操作的私有载荷里，与任务正文、工作目录、原生 session 身份和完整 diagnostic 一起，只通过同一次提交唤醒发起者的 Inbox notice 抵达他本人——notice 标明它是外部文本，是数据不是指令。于是任何参与者都能看到执行发生过、怎么结束的，而只有发起该委派的 Member（或 Human）读到它说了什么。激活使用 caller delivery，父 Session 不会收到第二份。

也正因如此，这段文本只存在于记录里：失败或被停止的运行会保留它已经产生的部分——终态说明走到哪里为止，状态词不代替它。

**未绑定**的执行在公开面上保持原样：parent delivery、没有 Thread 事实、不向 Project 发布任何东西。执行记录照样写入——本 Host 启动的每次执行都有 `team/worker-started` 与 `team/worker-settled`——这正是纯 Project 执行之后仍能按 `worker:` 引用查到的原因。

规则版本 6 引入这两个操作。版本 7 在 started 上增加可选的续跑链接、在终态上增加可选的 native turn / input 数组；不带这些字段的版本 6 Worker 记录仍可原样重放。新字段在版本 6 的记录段内被拒绝，而只实现到版本 6 的 build 会在解析 Worker 操作之前先被版本 7 标记拒绝。

`threadWorkerStates` 从执行记录读取状态，即使对应事实不在当前页。记录仍为 `running`、本 Host 却没有活跃执行时，读作 `unconfirmed`。Host 重启或终态尚未落账都可能出现这种情况。不会自动重跑或重试；该读时状态不写入事实，也不触发唤醒。

停止只有一条事务：Member 的 `team_worker` 带 `stop`，与 Human 的 `stopWorker` Remote，进入同一个 `WorkerRegistry.stop`。授权只看打开这次执行的身份——它的 `initiatedBy` Member，或 Human——刻意不重新套用启动条件，所以 owner 变更、Task 转移或关掉开关都不会左右一次停止。事务先 abort 启动信号（发布之前唯一的取消通道），再 dispose 已发布的 activation，然后等引擎自己的证据决定那一次终态写入。`stopping` 是派生的进程内视图：账本仍只有 `running → 终态`，Thread 读取与 Human 列表在停止进行时加这个词，不为它写任何持久内容。

终态由引擎的结果决定，而不是由请求决定。先到的自然完成或失败保留真实状态，停止回答的就是它。

每个终态结果都会等待原生清理，界限为十秒；清理被拒绝或超过这个界限时，执行记为 `failed` 并说明清理未确认。被取消的执行若 dispose 被拒绝，绝不报 `stopped`，因为没人确认的停止是 Host 支撑不了的断言。执行已经产出的部分输出随同一份结果走，所以那一次 Inbox 通知把文本与保留意见放在一起。

卸载是同一事务在 Host 尺度的展开，顺序是：拒绝新委派与续跑；取消所有仍在启动的执行——包括还在写 started 记录的那一个，它被封口而不是去开引擎——并最多花五秒等待这些启动、续跑准入和活动 steer 调用结束，再 dispose 已发布的。仍在读原生历史或写 opening 记录的续跑，因此要么在存储关闭前完成，要么在重查卸载屏障后不写任何东西。

这段启动等待之后，steer 持久化屏障拒绝迟到的 alias 准入和结果写入。每个终态最多等十一秒：原生清理有完整十秒，另留一秒让结果写入持久记录。窗口内清理已确认的取消记为 `stopped`；清理被拒绝或超时记为 `failed`，并保留诊断。

十一秒到达时仍没有终态的执行被封口：保留 `running` 记录，读作 `unconfirmed`，不再接受任何迟到的终态，所以关闭存储不会与一次写入赛跑。等挂起的终态与 steer 写入结束后，才释放 provider 注册；十一秒界限不会取消一个已经开始却不再回答的存储写入。

Human 的入口是「编辑 Agent」弹窗。运行中和未确认的记录优先，最近结束的记录按结束时间补满五行；已结束的记录带诊断入口。`stopWorker` 回执中，`ended` 给出已落账的终态与诊断，`pending` 表示正在清理或写入终态，`unconfirmed` 表示 Host 已失去活跃句柄或写入终态失败。列表中的未确认记录不提供停止控件。未拿到回执的请求不决定执行状态。

### 只读查看一次执行的诊断

查询所需的锚点随执行的终态一起写入，绝不在事后补采。provider 在会话打开时就知道引擎的原生会话，再捕获这次执行接受过的最新 128 个 turn 与原生 input UUID，以及引擎自报的记录绝对路径，并把它们挂在结果对象上——Harness 原样交回该对象，锚点是非枚举属性，而不是模块级映射，所以被封口的执行或迟到的终态不会留下任何待收集的条目。

捕获发生在会话仍然打开的时候：取消或清理开始之前，以及所有已接受输入结束之后。引擎在拆除过程中关闭记录流，事后再采只会什么都读不到。turn 与 input 绑定到本次执行提交的 UUID；恢复出来的会话中更早的 turn 不会被冒认成本次执行的。捕获失败不改变任何结局：终态保留引擎已经确立的状态、诊断、输出与原生会话身份，但没有失败捕获未能确立的 turn 或存储证据。

`readWorkerHistory`（`packages/agent-team/src/worker-inspection.ts`）是唯一的读取方，两个引擎的记录走同一趟有界读取：引擎只决定哪些字段标识会话、turn 与失败，其余规则不变。它拒绝不是引擎自己目录下绝对 `.jsonl` 路径的记录位置——Codex 是 `sessions`，Claude 是 `projects`——超长值整条拒绝，而不是裁成一个没人记录过的路径。

它解析真实路径，把打开句柄的身份与位置所指的文件比对，读取后再核对一次，并要求首条记录写明所记会话：Codex 的 session 头，或 Claude 在第一个 turn 之前写下的 queue 头。本次执行的 turns 是 Codex 绑定到已提交 input 的 span，或 Claude 侧 uuid 属于本次 input ids 的 prompt user 消息。8 MiB 预算花在读取本身，所以超长单行永远不会被解析。

它只返回该次执行自己那些 turn 的记录、逐片段限长，命中凭证形状的文本整条不返回——带引号的 JSON 键值同样如此。Claude 重复的 turn metadata 会去重，避免模型步骤挤掉后面的失败；四个片段上限仍省略了事实时，`truncated` 会如实标出。Claude 把失败的 turn 记成 `api_error` system 行或合成 assistant 消息，重试会重复同一条失败，所以读取方只报最后一条一次，而不是越堆越长。每条原因都是一句有界的话，陈述事实而不回显原生值。读到的任何内容都不会写回 Team。

续跑出来的执行会先跳过前驱的 prompt 前缀；读取在本次执行拥有的全部 turn 完成后结束，或在下一条不是它提交的顶层 prompt 之前结束，所以日后被继续使用的原生会话不会把后续 turn 的模型或失败借给这次执行。

报告是分层的。公开 Thread 保持原有摘要；详细答案——失败发生的阶段、原生标识、有界片段，或记录无法回答的那一个原因（`missing`、`unreadable`、`unpersisted`、`unsupported`、`unmatched`）——只给发起 Member 与 Human。尚未结束的执行只回答摘要，并说明记录在结束后才读取；在记录会话之前就结束的执行如实说明这一点，而不会声称引擎从未打开会话。

### 给 Worker 追加指令或续跑

两个引擎共用同一个 `team_worker` steer 形状。执行仍在运行时，Host 调用 OAR 公开的 `Session.deliver(..., { when: 'now' })`，并传入与 Team request id 不同的原生 input UUID。OAR 按会话状态选择 steer、queue 或新的 prompt，并跨这个状态竞争重试。`prompted` 同样是本次执行的输入：runtime 会一直保持执行到所有已接受输入都被消费，再原子关闭继续接收的窗口并只结算一次。Host 在持久准入首次等待存储之前就取得这个关闭窗口的占用，并在记录结果后释放，因此落账延迟不会让空闲的原生会话在投递前关闭。不会因为最初那个原生 turn 已结束就丢弃已接受输入。

回执写 `submitted`，绝不说模型已经读取或遵循。已知落点时它报告 OAR 把输入放进了哪里，并报告写回执这一刻的执行状态。原生拒绝、停止中的执行、上一个 Host 留下且未确认的执行、不可用的会话一律拒绝，而不是猜测绕过。

链上最新执行已干净结束且 handle 已释放时，steer 通过 `SessionOptions.resume` 恢复所记录的原生会话，并写一条新执行，其 `continuedFrom` 指向前驱。旧终态不可变。新执行固定原引擎、cwd、Project、Thread、Task 与发起 Member，以 steer 指令作为开场输入，而不是重发完整旧任务。

每次激活都为 Harness catalog 与活动控制生成新的外部 `SubagentRun.id`；稳定的原生 session id 则独立随结果锚点传递，用于续跑、结算与诊断，因此两条关联执行不会成为重复的 catalog child。干净失败同样可以这样续跑；停止中、清理未确认、原生记录缺失或不匹配、上一个 Host 留下的 `running` 记录都会拒绝。若最近一次失败续跑没有建立自己的原生会话，之后显式续跑会继承最近可读的前驱锚点，同时仍把这次失败执行记为直接前驱。

续跑会重查当前 Worker 开关、指定引擎开关、Project 是否 active、当前 Project owner 与发起 Member 的 enabled 状态，绝不沿用旧授权。账本保证一个原生会话至多一条运行中执行、每条执行至多一个直接后继，所以并发续跑会并入已建立的执行，不会分叉原生会话。通过旧 ref 发起的 steer 沿不可变链定位最新执行。

授权仍是发起 Member；其他成员按 `worker_steer_forbidden` 拒绝，Human 没有 steer 入口。活动投递表归 `WorkerRegistry`，会话关闭时摘除，Host 释放执行时清空。续跑产生的新执行是持久记录，可继续用自己的 ref 停止、查看或 steer。

幂等回答先于状态检查。每次 steer 在抵达原生投递之前，先作为私有账本 operation 被接纳；它的 refused、ambiguous 或 submitted 结果也先记录，Host 才向调用方报告。同一 request id 重送会返回第一次的回执或拒绝，执行结束或 Host 重建之后也一样；同一 id 换指令、Member 或 Worker 按 `worker_steer_conflict` 拒绝。

同一句话的新 request id 会持久登记为 canonical admission 的 alias，直接返回其结果，不读原生记录也不再次投递；并发的 canonical 与 alias 调用并入同一次接纳。

已接纳却没有确认结果的请求读作 `worker_steer_unconfirmed`，绝不自动重送。原生明确拒绝表示什么都没送到，因此同一句话可以换新 request id 重试；传输不明保持 ambiguous，不重试。后续关联执行可以用新 id 接收同一句话。续跑的 request id 与关联执行都持久化，因此同一决定跨 Host 重启仍然成立。

steer 的 admission 与结果都是私有账本状态：它们不发布 Thread 事实、不推进 Thread revision、不创建 Task 或 Claim，也不改前驱或既有执行记录。续跑另外写自己的 `team/worker-started` 与 `team/worker-settled`。没有 steer 回执或续跑锚点的旧账本可原样回放，历史上的活动 steer 也不能事后补出回执。

## Composer attachments（cache，不是 archive）

Composer attachments 是有界 cache，不是 archive，也不是 ledger bytes。cache 目录是 `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/`，存经过清理的原始名称和 `meta.json` sidecar。

- `putAttachment` 写入 immutable payload：每个文件上限 10 MB，名称中的 path separators 和 control characters 会被剥离。`getAttachment` 为 Client display 读取它们。两者和其他 Host capabilities 一样都是 typed Remote actions。
- `requestId` 是一次上传的幂等键。同一内容的重试返回原结果，Host 重启后也一样。复用该请求 ID 提交不同内容会被拒绝，即使两个请求同时到达。缓存 ID 只由请求 ID 派生。
- Project 与 Thread composer 的附件入口有两个：「+」按钮选择文件，或直接向输入框粘贴。携带文件的粘贴会被拦截，并进入同一 pending-file chips 流。纯文本粘贴保持浏览器原生插入。
- Message 在 ledger 中记录 attachment metadata（`attachmentId`、`name`、`byteSize`、`mediaType`）。存储 body 为每个 attachment 携带一行面向机器的 `[attachment] <absolute path>`，供 Member agents 通过普通 file tools 按 path 读取 bytes。Client 会从 display 中移除这些行，改为根据 metadata 渲染 thumbnails/chips。
- Ledger 是附件记录的唯一权威。Host 启动时及每 24 小时清理一次缓存。已被 Message 引用的附件保留 72 小时，未引用的保留 24 小时。Message 中的 metadata 保留，Client 之后仍显示文件名。上传中断留下缺失或损坏的 metadata 时，仅清理未被引用、且目录最后修改已超过 24 小时的条目。清理会跳过缓存根目录中不符合命名规则的目录和符号链接。
- Members 通过 `team_message` 的可选 `attachments` 共享文件。`attachments` 是 absolute paths。Host 先验证每个 path：absolute、regular file、non-empty、10 MB。再以 extension-derived media type 复制到 cache 的 immutable entry。entry id 由该 message/reply request 及 path 在列表中的位置派生，因此 agent-sent images 与 composer uploads 的渲染一致。任一 rejection 都会拒绝整个 send，不提交也不复制。
- 同一请求重试 send/reply 会复用附件副本，正文中的 `[attachment]` 路径保持不变。共用这些副本的尝试按顺序完成提交和失败清理。发送或回复失败后，只删除没有已提交 Message 引用的副本。复用请求 ID 时，ledger 比较记录的附件 ID 与本次重试解析出的 ID；附件集合不同会被拒绝。
- 清理程序独占该缓存条目后才查看 ledger 引用。已经超过未引用保留期、但刚被引用的附件，仍按已引用附件的期限保留。
- 不需要为手动 path references 增加机制。粘贴到 Message body 的 absolute path 会被 Member agent 像其他文件一样读取，Host 不会触碰不属于自己的内容。

## Human profile 与版本脚注

### Profile 权威与迁移

Human 的显示名与头像引用存放在 Team Host row 自己的 Config。settings namespace 就是这个 row 的 id，user layer。头像 bytes 存放在持久的 `$DSH_HOME/agent-team/human/v1/` store，从不进入带 TTL 的 attachment cache。

改名前的 profile 把整个 row Config 存在旧 id `wowyuarm-agent-team-host` 下：显示名、头像引用，以及 `wakeRecycle`、`memberCompaction` 两组 operational 配置。那一行不再挂载，这些值全部悄悄回落到 schema 默认——运维关掉的 Member compaction 会自己回来。

所以启动时 Host 从 profile 自己的 patch 文档把它们读出来，只把当前 namespace 的 user 层还没有存过的字段逐个写进去；Human 升级后在那边设过的值优先，即使等于 schema 默认。含 `!!js` 表达式的字段留 schema 默认，不把表达式源码当值写回；头像引用只在 bytes 还在 store 里时才搬；与活跃 Member handle 撞名的显示名丢掉不写。

已退役的 `agent-team-human` section 不再是权威。rc.1 的 settings importer 通过一份封闭的内置映射搬运 section。第三方 section 会留在改名后的 legacy document 里。启动时某个字段在当前 namespace 里没存过，就从那里收养它，走设置页同一条写入路径；该 section 只带名字与头像引用，已经重新填过的值优先。

只有 Host row 有这条迁移路径：profile patch 用改名前的 id（`wowyuarm-agent-team-{scope,preset-registry,preset-team-member,client,invariant}`）覆盖其余五行之一的，会被跳过——没有 loader entry 认这个 id，Team 回落到该行的出厂值。手改过 Team preset 或 preset 注册表 `default` 的，升级后要重新应用一次。

### 设置读取与写入

设置页由五个 Agent Team typed Remote 服务。`humanProfile` 提供名字、头像引用与版本脚注 facts，以及绑定本次 Host 实例和设置版本的写入令牌。`putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar` 只收图片，与 attachments 共用 10 MB 上限。已删除的条目读取时抛错，Client 回退到首字母。`toolCatalog` 提供 Host 全局与 live Member scope 注册的工具名发现视图，不读取普通 Agent scope。

改名、更换和移除都要求令牌。旧窗口或重连到新 Host 的窗口须先重读。头像读取只接受存储生成的引用，且只读取头像目录内的普通文件。图片与附件共用 10 MB 上传上限。

Host 先保存完整图片，再提交替换引用。移除写入显式空值，防止继承层或旧配置迁移恢复头像。被替换或移除的图片仍供共用存储的其他 profile 读取。只可清理确认从未提交的新文件；设置写入结果不确定时保留图片。

许可编辑器经公开 settings Remote 读写 Team Host row 的 `extraToolGrants`，携带其 revision，并且只写该字段的一条 `set` operation。它为外部插件工具解除执行限制，不挂载插件或开启 DSH 内置能力；DSH 树内共享任务板的四个工具不作候选。它从不使用 `unset`，所以显式 `[]` 是真正撤销，而不是回落到下层。名单读取失败时不能按空名单保存。目录与 Human 身份读取互相独立：目录失败仍可移除已读取的名称，身份失败也不会收起许可组。

settings 表单与运行时归一化共用 `member-tool-grants.ts` 的结构 schema：由保持确切拼写的非空字符串组成的数组。Team 不另加名称语法、长度上限或许可数量配额；消费者合并重复名称，目录不列保留名。schema 不含 transform 回调，因此 Host 重建可编辑 schema、再序列化给浏览器后仍保留校验，包括缺省与空名单。

### 安装版本与更新检查

脚注携带本 Host 实际运行的那份 bundle 的版本，以及 repository 链接。版本从已安装包自己的 manifest 读取，因此陈述的是 profile 真正装上的版本，而不是每次发版都得记得改的字符串。当后台检查观察到更新的已发布 release，再多一条点名这个版号的更新 tip。

Host 最多每 12 小时在后台读取一次 npm 公开的 `latest` 文档。成功时替换上次结果，失败时保留上次结果。`DSH_AGENT_TEAM_UPDATE_CHECK=0` 停止发起新的检查，仍显示上次确认的结果，也不会取消已发起的检查。

ledger 为 `team_view` 与 @ 匹配读取同一份 profile，一次改名同时到达每个 surface。`human` 是 Human 的永久别名，任何 agent handle 不得占用这个字面。因此 `@human` 跨改名持续送达，而 chip 始终渲染当前显示名。

## 重放与 Inbox 的执行顺序

### 重放执行顺序

1. `replayLocked` 准入后通过 `runTarget` 重读当前订阅，不使用排队时的快照执行。
2. 已有请求 id 若指向另一投递或版本，在脚本执行前拒绝。
3. 已结算意图返回存储的答案；对应投递必须仍存在且未过期。
4. 运行中意图绝不重跑：ledger 已接受输出则修复答案，否则报告未完成尝试。
5. 新请求要求未过期投递，并拒绝 tombstone、重放答案或带 ledger 接受记录的运行中意图所证明的既有成功。
6. 先记录运行中意图，再选择来源或执行脚本；意图写入失败就不执行。
7. `current` 使用当前定义；`received` 替换为投递接收时的 revision、脚本与凭据。
8. 终态导致运行被丢弃时报告未投递；否则已接受或空输出在结算前算成功。
9. 结算持订阅写锁，先写答案再写 tombstone；存储失败只记日志，不隐瞒已投递输出。
10. 删除先于结算时，ledger 已接受的输出仍报告已投递；其他结果一律报告未投递。

### Inbox 投递顺序

1. `deliverInboxNotice` 只读取一次持久通知快照，包含 Thread、Main、提醒与 Worker 材料。
2. 没有未读 Thread、Main 或提醒材料时清除覆盖，不创建通知。
3. 已排队的普通 next-turn 输入强制使用 followup，防止 steer 抢到携带输入之前。
4. 已覆盖事实集不变时，在修改队列或计算尝试次数前返回。
5. 已排队的恢复通知保持原位；新到事实仍未覆盖。
6. 先移除旧 Inbox 通知，再渲染并跟踪替代通知。
7. 替代消息只跟踪已渲染的提醒 occurrence；仅在消息被 claim 时消费，不在入队时消费。
8. 覆盖记录已渲染事实，而非全部候选事实；遗漏的 Thread 与提醒仍然欠投递。
9. 调用 followup 或 steer 之前先计入尝试次数。
10. followup 或 steer 失败时清除覆盖但保留次数；随后重新抛出不变量错误。
11. 通知投递不回滚 ledger 提交；普通投递失败只记日志，持久未读事实仍可恢复。
