# 九工具协议

[English](tools.md) | 中文

每个成功或被拒绝的 Team tool result 都通过正常 model loop 返回。这里没有 context 工具：Member 不能自己换代、记录锚点或就地压缩。超大的 Session 由 preset 的默认压缩引擎就地压缩；冷下来的一代由 Host 在唤醒边界换代（见 [`memory-and-context.zh.md`](memory-and-context.zh.md)）。

## `team_view`

`team_view` 是 address book：Workspace 内全部 active Project、读者参与的 Projects 中的顶层 Threads，以及完整 Workspace Member roster。这是当前的地址簿，不是工作队列；unread work 归 `team_inbox`。

每个 Project 行携带读者的 `owner` / `member` / `directory only` 关系和 active/paused 订阅计数；ledger 有 Project owner 之后（规则版本 2），还列出 owners（`@human` 在前）。`directory only` 不授予 Project 内容、写入、Attention 或未读投递。订阅详情仍由 `team_subscription list` 回答，不把目录展开成 dashboard。

Threads 是唯一分页目录。行按 newest-first 排列，携带 threadRef、Project ref、bounded anchor subject。taskful Threads 在行内呈现 Task standing：Task ref、编号、status/resolution。绝无第二个 Task 索引，也不渲染 revision 或消息数，因为两者都不改变下一个合法动作。该区域明确只覆盖读者的 Project memberships。用 `projectRef` 过滤一个 `directory only` Project 时，结果返回它的目录行，但说明 Thread 行需要 membership，而不是谎称这个 Project 没有 Thread。

在途工作不属于地址簿：首页末尾指向 `team_task board`，订阅详情指向 `team_subscription list`。

cursor 只延续 Thread 行。continuation 页只渲染 Threads。翻页可达全部获授权的顶层 Threads，含 taskless 与不在首页的 taskful。页脚把 cursor 称为 Thread cursor，说明是否还有更旧的 Thread anchors。

## `team_inbox`

`team_inbox` 返回有 unread work 的 Threads 的有界、无正文 summaries，另为每个对读者有 Main stream 未读的 Project 列一行（其 Main stream Attention 覆盖的普通未读与每个读者的 marker）。Direct requests 排在 ordinary unread work 之前，之后按最新相关 sequence 排序。列出结果不改变 read state。header 给出 unread/direct 总数与展示的 Threads 数。有界列表之外仍有未读，header 给出截断结论。每个条目显示精确的 unread/direct 计数、Project ref 与 taskful 时的 Task standing。这是读者自己的 unread 队列。要看在途的工作（无论是否有未读），用 `team_task board`。页脚把正文阅读与确认指向 `team_thread read`。渲染不携带 revision 与写令牌。当前 read 才是必需的变更基础，并提供令牌。

## `team_thread`

`team_thread` 读取 Thread 或 Project 的 Main stream。Thread 优先用 `threadRef`；有 Task 时，`read` 和 `history` 也接受 `taskRef`。两个 ref 可以同时给出，但必须指向同一个 Thread。`message` 必须带 `threadRef`，即使同时给了 `taskRef`。Main stream 用 `projectRef`，不能同时带任一 Thread 字段。

`read` 返回一个按 chronology 排列的 unread batch，推进 durable watermark。batch 缺省最多 20 条 fact。确认范围只覆盖这次调用真正交付的内容：渲染结果会超过输出上限时，工具少选几条 fact，Host 只提交这个被选中的前缀。正文已完整出现在当前上下文中的未读 Message 可以省略正文，仍计入本次确认。

没有选中任何 fact 且没有 reminder 可确认的 read 什么都不推进，不追加 operation；只有 reminder 的 read 仍会确认这些 reminders。已提交读的相同重试返回该次读的**原 receipt**，画面则取自当前 projection。读从不承诺冻结画面。

Thread 的选择界限是持久的：receipt 存储 `selectedThroughSequence`，replay 据此重建同一次确认，界限之后的 facts 保持未读。相同重试只返回该 receipt、它记录的 `readThroughSequence` 与当前剩余未读数，不重新展开未读 facts，也不会再次确认。写入该字段之前的 receipt 仍按缺省 batch 解释。Human 的读取、Remote 参数与读取语义都不变。

Thread 的 `read` 还会为上下文已不再持有讨论的读者补背景：anchor 缺失时补上，再加未读批次之前最多四条 fact 中筛出的 Message——没有未读时取 tail 之前。Main stream 的 `read` 补同样的近期 Message 背景，但没有 anchor。当前 Session 中已完整可见的背景不重复，也不存在独立的持久已读库：可见性只来自当前 Session surface。

背景只用于定位，不是本次新确认的工作，任何一次 read 都可能补；判断不依赖永久的“曾读过”标记。缺少背景时先 read（Thread 与 Main stream 同理）；`history` 用于更旧的 public facts，`message` 按 ref 逐字读回一条 Message，包括原文不在你手上这一页里的引用。二者都不确认未读。

`beforeSequence` 与 `limit` 为 `history` 翻页，Host 把 `limit` 约束在 1–100、缺省 20。`message` 拒绝它们。`read` 忽略它们：读的批次本就有界——Host 的读请求里没有这两个字段——而拒绝一次带着它们的读只是白费那次调用，因为把每个可选槽位都填满的模型会去要一个它并不需要的页大小。读想要的是下一页未读，页脚会说明还剩多少。输出上限只约束 `read` 与 `message`，不约束 `history` 分页。

`read` 与 `message` 共用一个结果总上限：32768 个 UTF-16 单位，含包装。单条 Message 正文可以超过该总上限继续分段，只要不超过读取容量：`min(262144, model contextWindow − 16384)` 个 UTF-16 单位。该容量是刻意保守的“一单位对一 token”限制，不是实际 token 计数；模型容量未知时取 262144。

超过总上限但不超过该容量的正文按有序分段返回。超过容量的正文不确认任何内容：结果要求发送者拆成更短的 Messages，或让读者换用更大上下文的模型；重复调用也无法补完。续读受该容量限制，不是无限的。

三个 action 不共享一个最大化渲染：读展示 Thread，也只有读展示 Thread。这里没有任何 Attention action，因为 Attention 是另一个问题、另一套参数口袋——见 `team_attention`。

`message` 渲染 ref、带时刻与发送者的 sequence，然后是正文。放得下的正文完整、不裁剪地渲染；这个 action 存在的意义就是让读者回答一条它没有收到的 Message，超长正文按下面的分段规则处理。

会超过输出上限的结果改为携带正文的一段：同一条 Message 的有序字符区间，每段说明当前上下文是否已持有整段正文。`message` 从不确认未读。

唯一的续读方式是重复同一个 `message` 请求，地址与 `messageRef` 不变；Host 从当前 surface 的第一个缺失段继续，不新增 offset 参数。

`read` 遵循同一规则：遇到未完整的 Message 就停下，不越过它确认；只有先前可见片段加本次输出覆盖整段正文时，这条 Message 才计入确认。Session 裁剪或压缩会使片段失效，因此重复 read 或 message 会重新补齐。正文中的 `[attachment]` 路径只提供文件读取入口；Message 完整不代表附件已读。

read 按顺序渲染以下部分，最后是页脚：

1. 结果：确认与剩余的 unread 计数；
2. Thread 身份与 following 状态；
3. 导向：anchor 不是返回 fact 时，给 bounded anchor subject；
4. 只含 active Claims：当前 collision surface，每 Claim 一行（claim ref、owner、direction）；
5. 本次 read 携带的已确认 Task reminders；
6. `Background — not newly acknowledged` 下的 Host 提供的背景：anchor 缺失时补上，再加此前最多四条 fact 中筛出的 Message，当前 Session 已可见的不再重复；
7. 按 sequence 排列的已确认 facts，带行内 unread/direct 标记。正文已完整可见的已确认 Message，用 `body already in current context; omitted` 代替正文。完整事件已在当前上下文中的已确认 Activity 只显示身份和 `complete event already in current context; omitted`。派生 Task 卡在 `Current Task cards — not Thread reading` 下按创建 sequence 渲染，带当前 status 与 accountable owner；卡片是当前状态，不是 Thread reading；
8. `Incomplete Message — not acknowledged`：未读或背景 Message 放不下时返回的有界片段。未读 Message 要等先前可见片段加后续输出覆盖整段正文后才不再未读；背景仍只是背景，不是本次新确认的内容。Activity 只有一行且不能分段：超出固定输出上限的 Activity 不确认任何内容，换更大的上下文模型也无法让它装入；结果会说明这个边界，请 Human 直接检查该事件。

页脚给出 read-through sequence 与剩余 unread 计数。若这次 read 身后仍留有 Thread facts，再补一句那些 facts 的数量。重返的读者借此看到自己没在看的跨度有多大，不把本次 batch 当成整个 Thread。

Main stream 的 `read` 渲染同样的结果与背景规则。页面先选最早的未读条目，再补缺失的近期背景；read 只确认实际交付的前缀，并报告 read-through sequence。Task 卡或读者自己的消息不能遮住更早的未读内容。

Thread 卡渲染在 `Thread cards — Main entry acknowledged, not its Thread` 下：卡片是它所指向 Thread 的当前状态，确认卡片的 Main 条目绝不等于该 Thread 已读。Main stream 的 `message` 按 ref 读回一条条目，分段与续读规则相同。Human 对 Main stream 的读取不变。

history 页渲染历史结果与 Thread 身份。首页给 full anchor，continuation 页给 bounded subject。渲染选中的 facts、该 sequence 窗口内的派生 Task 卡与 cursor/hasMore 页脚，绝无当前 Claims 或上下文建议。每条 activity fact 都只从该事件本身得出结构：activity ref、actor、Task 与 Thread refs，以及这条 activity 记录的 Claim refs 或 transfer 两端。绝不是裸 kind，也不用当前 Task/Claim 状态补历史。当一次 `read` 确认的是一个仍处于 done 状态 Task 的未读验收时，这些事实就写在 facts 里，read 不对读取者的上下文给出任何建议：没有 rollover 工具，也没有代际选择，就没有动作可陈述。

## `team_attention`

`team_attention` 只回答是否关注这个 Thread 或这个 Project 的 Main stream，以及该不该继续关注。`status` 报告当前状态且不改变任何东西；`follow` 开始接收来自那里的普通更新；`unfollow` 停止接收。三者参数完全相同：地址与路由 Workspace。Thread 用 `threadRef` 作 primary identity，`taskRef` 是 compatibility alias，两者只有在指向同一个 Thread 时才能同时出现；`projectRef` 改指 Main stream，与任一 Thread 字段同时出现都会被拒绝，而不是静默取其中一个。

读者已关注时，每个结果还会说出这份 Attention 由什么建立——开了这个 Thread、领了它的 Task、是它的 accountable、拥有这个 Project、在里面被点名，或自己选择关注。Claim 的结果与 Thread start 会说明它们代读者刚建立的 Attention，因此读者不必再问就知道自己现在关注了。

Attention 不是 reading。这三个 action 都不渲染 facts、不确认未读、不交写令牌；读也从不改变你是否关注。结果形状只携带地址、scope、Thread 的 Task standing 与 following 状态，别无其他，因此 Attention 结果不可能漂移成展示内容。

每条结果都说出动词本身不携带的那个后果。follow 意味着来自那里的普通更新会打断你。unfollow 意味着它们停止，而点名你的 mention、对你的回复和需要你处理的责任事件仍然到达——并且 unfollow 不释放任何 Claim、不放下你 accountable 的 Task，所以它是订阅变化，不是退出工作。读者自己在该 Task 上持有 active Claim 时会拒绝 Thread 的 unfollow，直到它 done 或 released。行本身的归属见 [Attention 与消息](attention-and-messaging.zh.md)。

与 `team_thread` 的拆分正是让读路径完全不带 Attention 逻辑的原因：三个 action 共享同一个参数口袋，而不是借用读的口袋——那里有 `messageRef`、`beforeSequence`、`limit` 三个它们永远用不上的参数。

## `team_message`

`team_message.start` 创建 Project 顶层 Thread。默认 taskless，也接受明确 task intent 以原子创建 Task。`team_message.reply` 向既有 Thread 追加明确的 reply。二者都接受 `attachments` 中的可选 absolute file paths。Host 验证每个 path，把 bytes 复制到 attachment cache。收件人看到 thumbnails/chips 与一行 cached path。任一 path 验证失败都会拒绝整个 send。commit 的 start/reply 渲染一个 committed-verb 结果：Thread created 或 reply added。结果携带 Message ref、新 Thread ref（taskful 时含 Task ref），以及恰好一个 next-write token hand-off。新建 Thread 立即可寻址，下一次变更也拿到了基础。

规则版本 2 起，`team_message` 还有 `post`，在 Project 的 Main stream 发言（`projectRef`、`body`，可选 `replyToMessageRef`，须为同一 Project 的 Main stream Message）。它不需要写入 token。持有未读 Main stream 条目的写入者，必须在当前上下文中完整持有每一条——Team 通知或绑定实际渲染 Message/Activity 的工具结果——或者带 `projectRef` 显式 read；否则得到 `main_unread_required`。

`start` 带 `kind: 'discussion' | 'task'`（已移除的 `asTask` 写法会被拒绝并指回 `kind`，绝不静默丢弃），只有 Project owner 能开：其他人得到 `project_owner_required`，提示改用 `post`；非 member 得到 `not_project_member`。Task start 另接受 `accountable` 与 `sourceThreadRefs`；两者在讨论 start 与 `post`/`reply` 上都被拒绝而非丢弃，commit 的 start 回报实际记录的负责人。

`team_thread` 的 `read`、`history`、`message` 只寻址一个 scope：Thread 用 `threadRef`（该 Thread 有 Task 时也可用别名 `taskRef`），Main stream 用 `projectRef`；同时给两个 scope 会被拒绝。`message` 必须带 `threadRef` 或 `projectRef`，只有 `taskRef` 不能读回一条 Message。Main stream 的行为与确认规则见上文 `team_thread` 一节。

类型化拒绝（`unread_required`、`stale_revision`、`main_unread_required`）以 `Not committed` 开头，保留 refs、计数和有界的待处理事实。Message 与 Activity 结果完整，且 revision 基线可识别时，会提供令牌供重新考虑；Main stream 结果不提供令牌（它本来就没有）。部分结果与未知基线指向 `read`。这既不确认未读，也不保证下一次写入成功。完整规则见 [Mutation fences](boundaries.zh.md#mutation-fences)。

mention 一个该 Thread 从未承载过的 Member 同样不是拒绝：规则版本 2 下 Message 照常提交，每个可寻址的收件人都会收到，没有未送达余量需要报告，也没有邀请步骤。规则版本 1 会记录它无法送达的名字；该记录现在只作为 Host 在 replay 旧账本时的历史解释存在，面向模型的结果不再报告它。

有下一步的恢复措辞来自唯一一份注册表（`packages/agent-team/src/recovery-hints.ts`），不是每个调用点各写一遍，因此路由会点名它要传的值。注册表不宣称每个错误都有下一步：没有恢复路径的故障说明缺少什么，而不是编造一条路由。一个测试强制这一点：它遍历 Host 与 tool 包两侧面向模型的源码，拒绝写在注册表之外的路由句。

`reply` 另外接受 `replyToMessageRef`，点名本 Thread 上被回答的那条 Message。Host 用 ledger 解析它，未知的 ref 或属于别的 Thread 的 ref 一律拒绝，因此存下来的回复永远有一个读者能被带到的父消息。

这条链接记录在 Message 上，渲染为读者可以跳回的引用。它也会通知父消息作者，包括 Human，不必重复写对方的 handle；回复自己的 Message 不会把自己加入收件人。投递规则见 [Attention 与消息](attention-and-messaging.zh.md)。

## `team_dm`

`team_dm` 向同一 Workspace 内一个 enabled Agent Member 发送私有 direct message。它只接受 `memberRef` 与 `body`，别无其他——没有 Thread、没有 Task、没有写令牌、没有附件——因为 DM 寻址的是人，不是会话。多带的参数会被拒绝而不是被忽略，因此伸手去拿 Thread 写入形状的模型会被告知：你想要的其实是 Thread reply。

DM 是纯送达。ledger 追加一个 audit-only 的 `team/dm-sent` operation，requestId 幂等。收件人的 live session 以 relay-form 的 user message 收到正文，走 steer 车道：idle 收件人由此开一个 turn，busy 收件人在最近的 step 边界收下，因此 DM 不会排在另一个待办 turn 后面。DM 不创建 Project、Thread、revision、Attention 或 Inbox markers，也不唤醒任何 change waiters。Human 不能被 DM。

每条结果的第一行都说明它是哪一种：已送达，还是只记录在案、没有可唤醒的 live session。没有自动重投，因此只记录在案的 DM 绝不被盲目重发。

DM 只用于快速澄清与状态同步。任务工作、决策和任何需要团队可见或可追溯的内容一律走 Thread。同一对象往来超过约 3 轮应转 Thread，因为每条 DM 消耗收件人一次完整 agent turn。

## `team_reminder`

`team_reminder` 的动作为 `create`、`list`、`cancel`，三个动作都只关于调用方自己的 reminder。一个 reminder 只有一个接收者，因此工具不接受收件人参数，actor 由 Host 从调用 Agent 自身推导；Human 要查看或撤回某个 Member 的 reminder，走 Web Client 的 Member 详情，不用这个工具。

`create` 取 `scheduleKind` 与该种类自己的字段——`once` 配 `at`（ISO 8601 时刻）、`every` 配 `minutes`（整数分钟，至少 10）、`cron` 配 `expression`（五个字段，按固定 UTC+8 读取，无夏令时）——并且总要 `note`：这个 reminder 是做什么的，最多 2000 字符。schedule 只报种类而不给该种类的字段会被拒绝，而不是被猜一个；发给 `list` 或 `cancel` 的 schedule 字段同样被拒绝而不是被丢掉，因为 cancel 上的 schedule 指向的是调用方并没有选中的那个 reminder。

单个 Member 最多 50 个 active reminder；间隔下限和永不到期的判定由 ledger 在创建时执行，replay 因此保持确定。`list` 报告调用方自己的全部 reminder 及其 state 与 occurrence 事实——待读取、上次、下次；`cancel` 按 `reminderRef` 撤回一个。两者都只读调用方自己那一份。

reminder 的 ref 由创建它的那次工具调用派生，ref 形状保留的两个字符按百分号转义，因此嵌套子调用的 id 也得到一个 durable schema 能解析回来的 ref。request id 已存在时的 create 只有在规范化后的 schedule 与 note 都相同才交回原 operation；时间被移动或 note 被改写都是 collision，不会静默交回原来那个。

到期的 occurrence 以私有通知进入调用方的 Team Inbox 并唤醒它，Host 在它真正进入某一轮次时按 occurrence 记录 consumed——一条通知只为它正文里渲染出的那些 occurrence 结账。Host 停机期间错过的 occurrence 恢复后恰好补投一次，同一循环 reminder 未读的 occurrence 由下一次替换而不是叠加。Member suspended 期间 reminder 继续计时、恢复时送达；archived 或 removed 时全部取消——这个效果由 [`domain-model.zh.md`](../domain-model.zh.md) 的 Member Lifecycle 表派生，不存在第二次清理 Operation。

## `team_task`

`team_task` 的动作为 `board`、`list`、`claim`、`done`、`release`、`accept`、`close`、`reopen`、`transfer`、`promote`。

`board` 渲染 Host 的 Task board 投影：读者可见 Project 的全部 open Task，按待处理、进行中、待验收分组、按最新活动排序；再列每个 Project 最近完成的 5 个 Task。每行携带 Task ref 与编号、Project、Thread ref、live Claim 上的 Members、读者与它的关系（`accountable`、`executor` 或 `project-owner`）、负责人、读者是否可验收、有界主题与最新活动时刻。

`projectRef` 限定一个 Project；`mine` 只保留读者负责或持有 live Claim 的 Task。

`finishedTruncated` 说明 Host 是否还压着更早的已了结工作；渲染结果会把它写出来，所以一页永远不会被读成整列。

看板是当前状态，不是未读：读取不改变 read state，也不带写令牌。工具引导在读者遇到 Workspace 意外改动、或准备 claim 之前指向这里，让在途工作被识别为在途而非冲突。

`promote` 把讨论 Thread 转为 Task，需要 `threadRef` 与该 Thread 的 `baseRevision`，可选 `accountable`，只有 Project owner 可以执行（否则 `project_owner_required`）。

`list`、`claim`、`done`、`release` 只管理 Agent 自己在真实 Task 上的 Direction Claims。taskless Threads 没有 Claim mutation path。Direction 是一句说明 Agent 工作角度的话，帮助其他人发现冲突并追踪进展。execution plans 和 acceptance checklists 应写在 Thread messages 中。Claim 成功后会自动开始 Attention。`list` 渲染 Task/Thread 身份与当前 collision surface：只有 active Claims，或显式的空。渲染结果不带写令牌，也不提供 Thread 事实或变更基础。commit 的 mutation 点名动作（Claim created、completed 或 released）。先渲染权威的受影响 Claim：ref、结果 state、owner、direction。再渲染 Task/Thread 身份，以及恰好一个 next-write token hand-off。

拒绝与 message 拒绝使用相同形式及[完整性与令牌规则](boundaries.zh.md#mutation-fences)；每次尝试仍重新检查 Task 权限。

`accept`、`close`、`reopen`、`transfer` 了结的是 Task 而非 Claim，权限由 Host 判定：`accept` 属于 Human、Project owner，或该 Task 自己的 accountable，且在该 Task 上持有过任何 Claim 的一律不行，Agent 只能在 in_review 时验收；`close`、`reopen`、`transfer` 属于 Human 与当前负责人。工具只转发 action 与写令牌，不重新推导该权限。

`transfer` 取 `target`——任意 enabled Project member 的 memberRef、`@Handle` 或唯一 memberRef 前缀，或 `human`——只转移责任，Claim 仍留在其 owner 手上；新 accountable 从此刻起参与该 Thread，并会收到这个 Task 现在要求它做什么。commit 的了结结果点名动作、结果 status 与 resolution、负责人，以及它完成或释放的 Claims。`self_acceptance_forbidden` 或 `accountable_owner_required` 拒绝的出路来自 Host 的 recovery registry，并补上 Task 的当前状态与负责人——那只有拒绝之后调用方自己才读得到。

## `team_subscription`

`team_subscription` 创建并维护某个 Project 的订阅：一段由 Host 在没有 Session 的情况下、以该 Project 的身份运行的脚本——按间隔、收到 webhook 时，或两者兼有。动作有 `list`、`create`、`update`、`test`、`pause`、`resume`、`delete`、`baseline`、`logs`、`deliveries`、`replay`、`reset_webhook`。

只有该 Project 的 owner 可以修改、试运行或重放投递（否则返回 `project_owner_required`）。任何 Workspace Member 都可以用 `list` 读取 Agent 侧元数据，其中不含 script、credential 引用和 webhook arm；运行历史仍只向 Project member 开放，owner 输出权限如下所述。

`create` 与 `update` 用 `intervalMinutes` 指定定时、用 `webhook: true` 指定地址，也可以两者都要，两者都不给会被拒绝。`update` 里两者的省略语义不同：不给 `intervalMinutes` 就是去掉定时，而不给 `webhook` 表示地址照旧，只有显式 `false` 才会卸下它——不认识 webhook 的调用方不该把正在用的提供方连接切断。启用触发需要部署已配置公网地址（Host 行的 `webhook.publicOrigin`）。

启用或重置的那次调用会带回完整地址，而那也是唯一能读到它的时刻：账本只存 token 的哈希，所以同一请求的重试、之后的 `list`、订阅页面都不会再显示它。`reset_webhook` 按调用方读到的 `expectedRevision` 移动地址；旧地址立即失效，而已入队的投递继续处理。

`logs` 读最近的运行记录——每个订阅保留 50 条，最新在前——带触发方式、开始时间、耗时、结构化类别、事件数、退出码或超时、这次运行固定的 revision，webhook 运行还带发起它的投递与 attempt。事件数是这次运行真正被账本接受的数量，所以只打印了订阅早已知道的 id 的运行计 0。

webhook 运行若在未发布队列里找不到空位也不会丢：已校验的事件随这条投递保存，之后某一趟会原样接受它们，且不消耗投递的重试次数——只有一次运行自己就印出超过 500 条事件的，才会变成 `deliveries` 里的一条。

Project 的 owner 与 Human 还能看到每次运行的原因和两路输出各自末尾 8 KiB——成功的运行同样如此；其他成员只看到摘要，因为脚本是在该 Project 的凭据下跑的。`deliveries` 只对 owner 列出（因为投递带着它到达时的请求体）自动重试用尽的 webhook 投递，带稳定 ref、接收时的 revision、最后一次错误与到期时间。每条在重试用尽时只计 1 次失败，所以三条这样的投递和三次失败的运行一样会暂停订阅。

`replay` 重跑一条，默认用当前脚本（这样修好的脚本能处理旧请求），也可以 `version: received` 用该投递接收时的定义。它是一次运行：占用运行位、受同一订阅互斥约束，暂停、删除或已归档的订阅在入场时被拒绝。

重放会发布脚本打印的内容，绝不计为订阅的失败。重复调用保持同一 request id，该 id 之后回答的是第一次调用的结果。一个 id 只命名一个意图：用它指另一条投递、或同一条投递的另一个版本，按请求碰撞拒绝；已经重放成功的投递不会被新的 id 再跑一遍。

`create` 与 `update` 用 `scriptPath` 给脚本——按调用者自己的工作目录解析，也就是它 shell 工具所用的目录——或用一个没有文件可指时给的 `scriptContent`。Host 读取文件、存下不超过 16 KiB 的快照，并用正式运行的同一套方式试运行一次：同一个执行器、同一份显式 sandbox policy、60 秒上限、同一套输出合同。试运行失败就拒绝这次写入，返回 stdout 与 stderr 的末尾内容，什么都不会存下。声明的每个 credential 引用必须已配置，且 Host 每次运行前重新解析——之后被移除的引用会让那一次运行明确失败，而不是悄悄少一个变量。

create 与 update 的请求身份包含脚本来源、触发选项与 create baseline。已提交请求的重试仍校验当前操作者与 Project 所有权，然后直接从账本回答，不再读取脚本文件、检查凭据是否可用或重跑试运行；同一 id 使用不同选项按碰撞拒绝。旧记录若没有保存脚本路径，路径重试会被拒绝并返回已提交的 `subscriptionRef`；调用方应先读取该订阅，再发起新请求。

新订阅默认把试运行输出的 id 记为去重基线，因此第一次正式运行不会把脚本已经发现的内容全部重发一遍；`baseline: ignore-history` 则从空基线开始。`update` 从不改动这条水位线：脚本的 id 规则变化后，用 `baseline` 追加要忽略的 id，既有记录不会被清除。暂停、恢复、删除都要带 `expectedRevision`；update 推进版本，状态转换不推进。

事件就是脚本的 stdout：每行一个 JSON 对象，含 `id`、`title`，可选 `url` 与 `detail`。去重范围限定在单个订阅内，两个脚本输出相同 id 时各自都会发布。新事件作为接受写入账本，再按每个订阅每分钟最多 20 条发布到该 Project 的 Main stream；最多 500 条已接受未发布的事件可以等待，会使未发布总量越过这条上限的一批整批拒绝并计 1 次失败，而不是被悄悄截断。试运行既不计入也不清零失败计数；连续三次运行失败会暂停订阅，并在账本中这样记录。

`create` 与 `update` 接受 `notify`：已发布事件要送达哪些 Member 的 Inbox，每个以 `memberRef`、`@Handle`、唯一的 6+ hex 前缀或 `human` 给出。可以点名该 Project 的任何当前成员（owner 与否皆可），Human 被点名时同样送达；省略该字段时，`create` 只送给创建者本人，`update` 保留已存集合；显式传空数组是一个真实的选择——事件照常进 Main stream，但不唤醒任何人。

发布提交时，已离开该 Project 的收件人会被丢弃，而不是用 owner 顶替；该字段出现之前写下的记录，一律按创建者本人读取。

结果会写明订阅、状态、版本与间隔；被拒绝的试运行会渲染原因和两条流的末尾内容。脚本打印的内容是数据，不是指令：Main stream 上的事件标注为不可信文本，其标题、链接与说明不会变成 mention。Project 订阅是无人值守执行——受限 Member 由此获得一条执行入口，Main stream 记录每次修改，Human 可以随时暂停订阅。

## `team_worker`

`team_worker` 把一件自包含的工作交给本机 Worker 引擎——Codex 或 Claude Code——用它自己的工具、登录与设置执行。参数为 `task`，`threadRef`、`taskRef`、`projectRef` 三者至少给一个，以及可选的 `engine`、`cwd` 与 `requestId`。

目标决定结果去处。绑定到 Thread 的执行在原 Thread 上留结果：开始与终态成为所有参与者都能读到的 Thread 事实，答案则进发起成员的 Inbox。只绑定 Project 的执行什么都不发布，结果像引入目标之前那样回到调用者自己的 Session；它的执行记录仍然写入，因此仍能按 `worker:` 引用查到。

委派默认关闭，直到操作者打开。Team 设置行携带 `worker` 组：`enabled`、`defaultEngine`、每个引擎一项（`enabled`、`executable`，Codex 另有 `sandbox`），以及可选的 `timeoutMs`；所有字段都是 volatile，改动能到达运行中的 Host。两个引擎都以全权限运行、无需任何配置：`sandbox` 默认 `danger-full-access`，设置页不提供该字段，收紧 Codex 的策略要手写设置行。

`executable` 存在的原因是 Host 进程的 `PATH` 不是 shell 的 `PATH`：人装好的 CLI 可能不在 Host 搜索的路径里，留空则沿用引擎自己的发现规则。

开关关闭时，`team_worker` 根本不会声明给 Member；打开后在 Member 的下一个 turn 边界出现，关闭后收回。同一开关还决定 `team:project-owner` guidance section 里的 Worker 段落，而该段落每次组装都会重新求值。已在执行的 run 无论开关如何都保留自己的 handle：开关只拦新的委派，而 registry 在关闭时仍然拒绝发起。

以下情况一律在写 started 记录之前、启动任何原生进程之前拒绝：没有给出目标（`worker_target_required`）；指定的 Thread（`worker_thread_unknown`）、Task（`worker_task_unknown`）或 Project（`worker_project_unknown`）不属于本 Team；Task 不在与它一起给出的 Thread 里（`worker_target_conflict`）；调用者当前不是目标所属 Project 的 owner（`worker_owner_required`）。

其余拒绝来自设置与这次执行本身：开关关闭（`worker_disabled`）；指定的引擎不是 Worker 引擎（`worker_engine_unknown`）或未启用（`worker_engine_disabled`）；任务文本为空（`worker_task_required`）；无法解析出绝对工作目录（`worker_cwd_required`）；Harness subagent 服务未挂载（`worker_unavailable`）；或该 `requestId` 已被另一个委派用掉（`worker_request_conflict`）。拥有一个 Project 不授予另一个 Project 的授权，Team preset 之外的普通 DSH Session 也不会获得这个工具。

`engine` 只覆盖这一次委派的 `defaultEngine`；引擎不可用会说明原因，不会自动改用其他引擎、账号或模型。用相同 `requestId` 重送会返回首次调用已经启动的那次执行，绝不会再开一个——两次并发到达也一样。这个 id 只代表那一次委派：换一个成员重送、或改掉任务、引擎、目标，都会被拒绝，而不会拿到一次它没要求的执行。

回执给出 Team 执行编号（`worker:` 引用）、Project、引擎、工作目录与启动时刻，绑定执行还给出 Thread，并说明执行在后台继续、结果会出现在哪里。

同一个工具也能停止一次执行：只给 `stop: <worker:…>`，不给 `task`；同时再给 task、Thread、Task、Project、引擎、工作目录或 request id 会被拒绝，而不是部分生效。停止按打开这次执行的身份授权：发起成员本人，或 Human 通过「编辑 Agent」弹窗。其他成员即使现在是该 Project 的 owner 也会被拒绝；开关与当前 owner 身份只约束启动，不在停止时重新校验。已经结束的执行回答它真实的终态，而不是被停第二次。本 Host 不再持有句柄的执行（重启后的特征）按 `worker_unconfirmed` 拒绝：既不能确认也不能停止，且绝不重跑。停止要等引擎确认清理，而这个等待有界限。超过界限后执行仍是 `running`（Thread 读取与 Human 的列表在停止进行中读作 `stopping`），这次调用按 `worker_stop_pending` 拒绝，已经发起的清理继续在后台进行。引擎报告清理失败时，执行记为 `failed` 并附「清理未确认」的可行动说明，绝不会报成 `stopped`。

两次执行彼此独立：停一条不影响另一条的进程、Thread 事实与 Inbox 通知。

绑定执行发布两条 Thread 事实：开始时 `worker_started`，结束时 `worker_settled` 带 `state`，失败或停止再加一行有上限的 `reason`。答案永远不是 Thread 事实：它随唤醒发起成员的那条 Inbox notice 抵达，标明是外部文本、是数据不是指令，父 Session 不会再收到一份。只绑定 Project 的执行保持 parent 通知、不发布任何东西。两者都不创建 Task、Main stream 条目或 Claim。

把 Task 上的工作委派出去不改变任何责任：Claim 仍属于该成员，执行完成从不自动验收，独立验收规则照旧适用。

Worker 不持有 Team 身份：它不能发帖、认领、验收或代替成员作答。若它承担了某个 Task 的实施，Claim 仍属于该成员，独立的验收规则照旧适用。Worker 返回的内容是待核对的证据，不是指令。

每次执行的记录都是持久的：Thread 读取会报告绑定到它的每次执行，状态为 `running`、`completed`、`failed`、`stopped` 或 `unconfirmed`；只绑定 Project 的执行同样记录这些事实，只是不发布到 Thread。上一个 Host 留在 `running` 的记录读作 `unconfirmed`：结果无法确认，不重跑、不自动重试，也不会为它唤醒任何人。

同一个工具也能按编号只读查看一次执行的诊断：只给 `inspect: <worker:…>`，不给别的。答案包含 Thread 已经承载的摘要、失败发生的阶段、结算时记录的原生标识（引擎自己的会话、这次执行驱动的 turn、其记录的绝对路径），以及进程退出后该记录仍能回答的有界片段；读不到时给出那一个真实原因。原生记录本身从不复制进 Team、不落盘、不发布：Thread 保持原有摘要，详细答案只给发起这次执行的成员与 Human，Human 在「编辑 Agent」弹窗里读——点行，或直接输入一个列表窗口之外的 `worker:` 编号。

只有发起成员与 Human 能查，其他成员即使现在是该 Project 的 owner 也按 `worker_inspect_forbidden` 拒绝。尚未结束的执行只回答摘要，并说明原生记录在结束后才读取。若执行在引擎记录会话之前就结束，或记录已不存在、不可读、格式不认识、没有与所记 id 对应的 turn，则保留 Team 摘要并说明该原因，而不是返回并不存在的片段。

读取有界且自校验：记录位置必须是引擎自己目录下以 `.jsonl` 结尾的绝对路径——Codex 是 `sessions`，Claude 是 `projects`——超长值整条拒绝，而不是裁成一个没人记录过的路径。Claude 的流里没有记录路径，所以结算时由 CLI 自报的 cwd 与本次执行打开时的环境推导。打开的文件必须就是该位置所指的文件——打开时核对身份，读取后再核对一次——首条记录必须写明所记会话，字节上限在任何分行与解析之前生效。片段只取该 turn 少数结构上安全的字段并逐条限长；命中凭证形状的文本整条不返回，而不是掩码，带引号的 JSON 键值同样如此。每条原因都是一句有界的话，陈述事实而不回显原生值；引擎记录的任何内容都不会写回 Team。

Human 的「编辑 Agent」弹窗列出本 Host 仍持有的执行、上一个 Host 留在 `running` 的未确认记录，以及按结束时间排序的最近 20 条已结束执行——早启动、刚结束的长执行仍在这个窗口内——每条都显示真实终态，并各自提供诊断入口。任何执行都仍可按 `worker:` 编号读取，所以这个列表是窗口，不是唯一的门。

同一个工具还能给仍在执行的 Worker 补一句指令：给 `steer: <worker:…>` 和 `instruction`，不给别的。

这句指令进入引擎正在跑的那一个 turn：不开第二个 turn、不为下一轮排队、也不会到达别的执行。回执只说「已提交」，不说「已收到」——引擎把输入接管进了当前 turn，而 turn 若在下一次模型请求之前结束，指令会随之消失。答案写出时若停止或结束已经发生，回执会把这个状态说出来，因此已接受的补指令不会被报成一次干净的成功。

只有发起这次执行的成员能补，其他成员按 `worker_steer_forbidden` 拒绝；这一版 Human 没有补指令入口。已结束的执行按 `worker_steer_ended` 回答它真实的终态；停止在途的执行直接拒绝，不往一个正在收尾的 turn 里投递（`worker_steer_stopping`）；本 Host 已不再持有的执行按 `worker_unconfirmed` 拒绝。这一版只对 Codex 开放，因为它的控制会指明引擎正在驱动的那个 turn；Claude Code 的「接受」覆盖的窗口比当前 turn 更宽，所以按 `worker_steer_unsupported` 拒绝，而不是借一个引擎并不提供的保证。引擎自己不肯接管时，回答它给出的代码与有界原因（`worker_steer_refused`），而不是成功。

同一句指令只送一次。用同一 request id 重送，会拿回第一次的回执——执行仍在跑时如此，结束后也如此——且不会再到达引擎；换一个新的 request id 重送同一句话同样如此；用已用过的 request id 送不同指令按 `worker_steer_conflict` 拒绝。

这条活动控制归本 Host 的执行注册表所有：引擎会话打开时建立，该执行结束时摘除，Host 释放执行时清空，因此它不跨重启、也不会让任何原生标识变成句柄。补指令不写任何 Team 事实——不改 Thread 记录、不改 Task、不改 Claim——这次执行仍只有原来那一个终态与那一次回传。

卸载插件会拒绝新的委派，先取消仍在启动的执行（包括还在写 started 记录的），等待本 Host 仍持有的执行清理并落终态后再关闭存储；到界限仍未确认的执行保留 `running` 记录并封口，关闭存储后不会再写入迟到的终态。
