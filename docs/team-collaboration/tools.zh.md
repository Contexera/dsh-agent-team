# 十工具协议

[English](tools.md) | 中文

每个成功或被拒绝的 Team tool result 都通过正常 model loop 返回。这里没有 context 工具：Member 不能自己换代、记录锚点或就地压缩。超大的 Session 由 preset 的默认压缩引擎就地压缩；冷下来的一代由 Host 在唤醒边界换代（见 [`memory-and-context.zh.md`](memory-and-context.zh.md)）。

## 可选参数槽位

Team schema 接受省略可选字段。对于会填满未使用槽位的模型，各工具只把对该动作不携带指令的值视为未传；这不等于一律把空字符串、零、`false` 或 `[]` 丢弃。具体例外见下方对应动作。`null` 也不能替代省略：声明的字符串、数字、布尔和数组类型会在执行前拒绝它。

[可选槽位矩阵](../../packages/tool-agent-team/tests/optional-slot-matrix.spec.ts) 覆盖每个已注册工具及其 action 枚举，在 Host 边界比较干净调用与填槽调用：调用了哪些操作、传了什么参数。Worker 的启动引擎、订阅接收者和 webhook 撤回等有实际含义的值必须作为明确的基线选择，而不是占位值。

## `team_view`

`team_view` 是 address book：Workspace 内全部 active Project、它们的顶层 Threads，以及完整 Workspace Member roster。这是当前的地址簿，不是工作队列；unread work 归 `team_inbox`。

每个 Project 行携带读者的 `owner` / `following` / `none` 关系——规则版本 9 之前为 `owner` / `member` / `directory only`——和 active/paused 订阅计数；ledger 有 Project owner 之后（规则版本 2），还列出 owners（`@human` 在前）。

规则版本 8 起，Project 行还写明它的 Agent owners 各自负责什么——与 ownership context 和 Client 显示的是同一份文本——授权里没有记录的写作 `unspecified`（Client 中显示为「未说明」），这是授权本身的事实，不是非得补齐才能使用这一行的缺口。若该 Project 没有任何 owner 记录过，这一行不增加内容，因此版本 8 之前写下的 ledger 回答与从前完全一致。规则版本 9 下 `none` 不授予也不剥夺任何东西：Workspace 参与者看到同样的 catalog；更早版本中 `directory only` 不授予 Project 内容、写入、Attention 或未读投递。订阅详情仍由 `team_subscription list` 回答，不把目录展开成 dashboard。

Threads 是唯一分页目录。行按 newest-first 排列，携带 threadRef、Project ref、bounded anchor subject。taskful Threads 在行内呈现 Task standing：Task ref、编号、status/resolution。绝无第二个 Task 索引，也不渲染 revision 或消息数，因为两者都不改变下一个合法动作。该区域覆盖读者可读的 Project——规则版本 9 下为参与 Workspace 的全部 Project，更早版本为读者的 Project 成员关系。

在途工作不属于地址簿：首页末尾指向 `team_task board`，订阅详情指向 `team_subscription list`。

cursor 只延续 Thread 行。continuation 页只渲染 Threads。翻页可达全部获授权的顶层 Threads，含 taskless 与不在首页的 taskful。页脚把 cursor 称为 Thread cursor，说明是否还有更旧的 Thread anchors。

## `team_inbox`

`team_inbox` 返回有 unread work 的 Threads 的有界、无正文 summaries，另为每个对读者有 Main stream 未读的 Project 列一行（其 Main stream Attention 覆盖的普通未读与每个读者的 marker）。Direct requests 排在 ordinary unread work 之前，之后按最新相关 sequence 排序。列出结果不改变 read state。

header 给出 unread/direct 总数与展示的 Threads 数。有界列表之外仍有未读，header 给出截断结论。每个条目显示精确的 unread/direct 计数、Project ref 与 taskful 时的 Task standing。这是读者自己的 unread 队列。要看在途的工作（无论是否有未读），用 `team_task board`。

页脚把正文阅读与确认指向 `team_thread read`。Inbox 结果不携带 revision 或写令牌。排空未读的 read 提供 next-write token；其他合格来源见[变更栅栏](boundaries.zh.md#mutation-fences)。

## `team_thread`

`team_thread` 读取 Thread 或 Project 的 Main stream。Thread 优先用 `threadRef`；有 Task 时，`read` 和 `history` 也接受 `taskRef`。两个 ref 可以同时给出，但必须指向同一个 Thread。`message` 必须带 `threadRef`，即使同时给了 `taskRef`。Main stream 用 `projectRef`，不能同时带任一 Thread 字段。

`read` 返回一个按 chronology 排列的 unread batch，推进 durable watermark。batch 缺省最多 20 条 fact。确认范围只覆盖这次调用真正交付的内容：渲染结果会超过输出上限时，工具少选几条 fact，Host 只提交这个被选中的前缀。正文已完整出现在当前上下文中的未读 Message 可以省略正文，仍计入本次确认。

没有选中任何 fact 且没有 reminder 可确认的 read 什么都不推进，不追加 operation；只有 reminder 的 read 仍会确认这些 reminders。已提交读的相同重试返回该次读的**原 receipt**，画面则取自当前 projection。读从不承诺冻结画面。

Thread 的选择界限是持久的：receipt 存储 `selectedThroughSequence`，replay 据此重建同一次确认，界限之后的 facts 保持未读。相同重试只返回该 receipt、它记录的 `readThroughSequence` 与当前剩余未读数，不重新展开未读 facts，也不会再次确认。写入该字段之前的 receipt 仍按缺省 batch 解释。Human 的读取、Remote 参数与读取语义都不变。

这个界限是读取位置，不是写令牌。它按 Thread 的事实头部——最后一条公开 fact 的 sequence——校验，因为未读批次最远只能带到那里。

不改变 Thread 状态的公开 fact，例如绑定 Worker 执行的开始与终态，落在 Thread revision 之后。所有 Thread 写入 fences 的令牌仍是那个 revision（见 [Mutation fences](boundaries.zh.md#mutation-fences)），所以两个数不必相等；超过该 Thread 自身事实头部的选择——包括从别的 Thread 抄来的 sequence——仍然拒绝。

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

`attachments` path 指向的是 Member 自己本可读的文件，因此带 attachments 的 start、reply 或 `post` 要求 Member 生效工具面中有 file-reading 或 shell tool——`read`、`read_image`、`bash` 或 `pwsh` 之一——否则以 `attachment_read_required` 拒绝。每个 path 还必须留在 Member 工作目录内：目录之外的 absolute path、`..` 逃逸或逃逸 symlink 会在复制任何文件之前被拒绝。Human composer 路径只保留常规校验。

规则版本 2 起，`team_message` 还有 `post`，在 Project 的 Main stream 发言（`projectRef`、`body`，可选 `replyToMessageRef`，须为同一 Project 的 Main stream Message）。它不需要写入 token。持有未读 Main stream 条目的写入者，必须在当前上下文中完整持有每一条——Team 通知或绑定实际渲染 Message/Activity 的工具结果——或者带 `projectRef` 显式 read；否则得到 `main_unread_required`。

`start` 带 `kind: 'discussion' | 'task'`（已移除的 `asTask` 写法会被拒绝并指回 `kind`，绝不静默丢弃），只有 Project owner 能开：其他人得到 `project_owner_required`，提示改用 `post`；不参与该 Workspace 的 Member——或写操作中未 enabled 的 Member——得到 `not_project_member`。Task start 另接受 `accountable` 与 `sourceThreadRefs`；两者在讨论 start 与 `post`/`reply` 上都被拒绝而非丢弃，commit 的 start 回报实际记录的负责人。

规则版本 10 下，Task start 的 `accountable`——以及下文 `promote` 的——接受的目标与 `transfer` 完全相同，解析方式也相同，因此指定推进 Task 的 Member 只需一次写入，不必先开再转。被指定的 Member 以 `accountable` 为原因开始关注该 Thread，并被这次创建唤醒；作者仍以 `thread-author` 关注。不传时由创建者负责。

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

`create` 取 `scheduleKind` 与该种类自己的字段——`once` 配 `at`（ISO 8601 时刻）、`every` 配 `minutes`（整数分钟，至少 10）、`cron` 配 `expression`（五个字段，按固定 UTC+8 读取，无夏令时）——并且总要 `note`：这个 reminder 是做什么的，最多 2000 字符。schedule 只报种类而不给该种类的字段会被拒绝，而不是被猜一个；发给 `list` 或 `cancel` 的 schedule 内容——`at`、`minutes`、`expression` 或 note——同样被拒绝而不是被丢掉，因为 cancel 上的 schedule 指向的是调用方并没有选中的那个 reminder。

选择器本身不是内容：`scheduleKind` 只决定 create 读哪个字段，所以它在 `list` 与 `cancel` 上像空槽一样丢弃默认的 `once`，而写明其它种类仍会被拒绝。空槽在任何动作上都视为未传，因此把每个可选槽位都填满的模型发来 `note: ''` 时，不会把一次 cancel 变成 create。

单个 Member 最多 50 个 active reminder；间隔下限和永不到期的判定由 ledger 在创建时执行，replay 因此保持确定。`list` 报告调用方自己的全部 reminder 及其 state 与 occurrence 事实——待读取、上次、下次；`cancel` 按 `reminderRef` 撤回一个。两者都只读调用方自己那一份。

reminder 的 ref 由创建它的那次工具调用派生，ref 形状保留的两个字符按百分号转义，因此嵌套子调用的 id 也得到一个 durable schema 能解析回来的 ref。request id 已存在时的 create 只有在规范化后的 schedule 与 note 都相同才交回原 operation；时间被移动或 note 被改写都是 collision，不会静默交回原来那个。

到期的 occurrence 以私有通知进入调用方的 Team Inbox 并唤醒它，Host 在它真正进入某一轮次时按 occurrence 记录 consumed——一条通知只为它正文里渲染出的那些 occurrence 结账。Host 停机期间错过的 occurrence 恢复后恰好补投一次，同一循环 reminder 未读的 occurrence 由下一次替换而不是叠加。Member suspended 期间 reminder 继续计时、恢复时送达；archived 或 removed 时全部取消——这个效果由 [`domain-model.zh.md`](../domain-model.zh.md) 的 Member Lifecycle 表派生，不存在第二次清理 Operation。

## `team_task`

`team_task` 的动作为 `board`、`list`、`claim`、`done`、`release`、`accept`、`close`、`reopen`、`transfer`、`promote`。

`board` 渲染 Host 的 Task board 投影：读者可见 Project 的全部 open Task，按待处理、进行中、待验收分组、按最新活动排序；再列每个 Project 最近完成的 5 个 Task。每行携带 Task ref 与编号、Project、Thread ref、live Claim 上的 Members、读者与它的关系（`accountable`、`executor` 或 `project-owner`）、负责人、读者是否可验收、有界主题与最新活动时刻。

`projectRef` 限定一个 Project；`mine` 只保留读者负责或持有 active Claim 的 Task。

`finishedTruncated` 说明 Host 是否还压着更早的已了结工作；渲染结果会把它写出来，所以一页永远不会被读成整列。

看板是当前状态，不是未读：读取不改变 read state，也不带写令牌。工具引导在读者遇到 Workspace 意外改动、或准备 claim 之前指向这里，让在途工作被识别为在途而非冲突。

`promote` 把讨论 Thread 转为 Task，需要 `threadRef` 与该 Thread 的 `baseRevision`，可选 `accountable`，只有 Project owner 可以执行（否则 `project_owner_required`）。

`claim`、`done`、`release` 只管理 Agent 自己在真实 Task 上的 Direction Claims；`list` 列出该 Task 上所有 active Claims。taskless Threads 没有 Claim mutation path。Direction 是一句说明 Agent 工作角度的话，帮助其他人发现冲突并追踪进展。execution plans 和 acceptance checklists 应写在 Thread messages 中。Claim 成功后会自动开始 Attention。

`list` 渲染 Task/Thread 身份与当前 collision surface：只有 active Claims，或显式的空。渲染结果不带写令牌，也不提供 Thread 事实或变更基础。commit 的 mutation 点名动作（Claim created、completed 或 released）。先渲染权威的受影响 Claim：ref、结果 state、owner、direction。再渲染 Task/Thread 身份，以及恰好一个 next-write token hand-off。

拒绝与 message 拒绝使用相同形式及[完整性与令牌规则](boundaries.zh.md#mutation-fences)；每次尝试仍重新检查 Task 权限。

`accept`、`close`、`reopen`、`transfer` 了结的是 Task 而非 Claim，权限由 Host 判定：`accept` 对 Human 开放；Agent 必须是 Project owner 或该 Task 自己的 accountable、从未持有该 Task 的任何 Claim，且只能在 `in_review` 时验收；`close`、`reopen`、`transfer` 属于 Human 与当前负责人。工具只转发 action 与写令牌，不重新推导该权限。

`transfer` 取 `target`——该 Task 所在 Workspace 中任意 enabled Member 的 memberRef、`@Handle` 或唯一 memberRef 前缀，或 `human`——只转移责任，Claim 仍留在其 owner 手上；新 accountable 从此刻起参与该 Thread，并会收到这个 Task 现在要求它做什么。commit 的了结结果点名动作、结果 status 与 resolution、负责人，以及它完成或释放的 Claims。`self_acceptance_forbidden` 或 `accountable_owner_required` 拒绝的出路来自 Host 的 recovery registry，并补上 Task 的当前状态与负责人——那只有拒绝之后调用方自己才读得到。

## `team_subscription`

管理无人值守的 Project 脚本，支持 interval、webhook 或两者结合。每个动作都需要 `projectRef`，必要时带路由用的 `workspace`。

| 动作 | 其他输入 |
| --- | --- |
| `list` | 无；返回不含脚本、credential ref 或 webhook secret 的 Agent 侧元数据 |
| `create` | `name`、一个脚本来源、至少一个 trigger；可选 `credentials`、`notify`、`baseline` |
| `update` | `subscriptionRef`、`expectedRevision`、`name`、一个脚本来源与 trigger；可选 `credentials`、`notify` |
| `test` | `subscriptionRef`；运行已存定义，不更新它 |
| `pause`、`resume`、`delete`、`reset_webhook` | `subscriptionRef`、`expectedRevision` |
| `baseline` | `subscriptionRef`、非空 `ids`；追加忽略 id，绝不清空 |
| `logs` | `subscriptionRef`；可选 `limit`（1–50，默认 50） |
| `deliveries` | `subscriptionRef`；列出自动重试已耗尽的失败 webhook delivery |
| `replay` | `subscriptionRef`、`deliveryRef`；可选 `version: 'current' | 'received'`（默认 `current`） |

Project owner 管理、测试和重放订阅；`deliveries` 包含请求正文，仅限 owner。Workspace 参与者可以列出元数据；运行摘要要求 Project 读取权限。owner 与 Human 还能看到原因和 stdout／stderr 各自最后 8 KiB，成功运行也一样。

`create`、`update`、`test`、`resume` 与 `replay` 还要求 Agent 实际工具面中有 `bash` 或 `pwsh`。否则在读取或运行脚本前以 `subscription_shell_required` 拒绝。owner 身份不绕过该执行边界。

脚本来源必须恰好是 `scriptPath` 或 `scriptContent` 之一。相对路径按调用者工作目录解析，位于该目录内的绝对路径也有效。词法逃逸与指向目录外的 symlink 被拒绝。Host 保存至多 16 KiB 的快照，并用生产执行器对 create／update 试跑，限时 60 秒。试跑失败返回原因和输出尾部，不存任何定义。credential ref 必须已配置，每次运行重新解析；工具最多接受八项 `REF` 或 `REF=ENV_NAME`，不接受 secret 值。

trigger 为 `intervalMinutes`（至少 5）、`webhook: true` 或两者。update 省略 `intervalMinutes` 会移除 timer；省略 `webhook` 保留已有地址，`false` 才解除。最终定义仍须至少有一个 trigger。空 `credentials: []` 会移除 credential，不是保留。

启用／重置 webhook 要求 Host row 的 `webhook.publicOrigin`。完整地址只在该次调用返回；后续 list／重试无法取回，因为只存 token hash。应立即注册给 provider。重置让旧地址失效，但不取消已经排队的 delivery。

脚本每行 stdout 打印一个 JSON 对象：`id`、`title`，可选 `url` 与 `detail`。按订阅与 event id 去重。create 默认 `baseline: 'current-output'`，忽略试跑看到的 id；`'ignore-history'` 从空集开始。update 保留原水位。状态转换不增加 revision，update 会增加；过时的 `expectedRevision` 被拒绝。

`notify` 用 member ref、handle 或至少 6 位十六进制唯一前缀指定 enabled／suspended Workspace Member 或 Human。create 省略时只发给创建者，update 省略时保留收件人。`[]` 表示仅时间线，不产生 Inbox marker 或唤醒。发布时丢弃已无 Project 访问权限的收件人，不用 owner 替代。外部事件文本是数据，不是指令，也不解析 mention。

空 `workspace`、`scriptPath` 与 `scriptContent` 视为省略；零 `intervalMinutes`／`limit` 也一样。有实际含义的 `notify: []`、`credentials: []`、`webhook: false` 与 revision 值不会被丢弃。

每个订阅每分钟最多发布 20 个事件，最多 500 个已接受事件等待发布。连续三次运行失败会暂停；试跑不改变失败计数。webhook 队列压力可以延后接受已验证输出，而不重跑脚本。

replay 按要求使用当前定义或收到请求时的版本。paused／deleted／archived 目标拒绝重放。它发布输出，但不计为订阅失败。一个工具调用身份只代表一个 delivery／version；重试返回原结果，改变意图则冲突，已成功重放的 delivery 不会因新 id 再跑一次。

已提交 create／update 的重试会重查当前 actor 与 owner，然后返回回执，不重读文件或重跑试验。同一调用 id 下更换脚本来源／选项会冲突。调度、沙箱策略、队列接纳、私有历史与 webhook 传输限制由 [Host authority](../architecture/host-authority.zh.md#订阅调度与无人值守执行)维护。

## `team_worker`

把可独立交接的工作委派给本地 Codex 或 Claude Code。Worker 使用自己的工具、登录与设置，看不到父会话。任务文本需包含目标、背景、范围与所需证据。调用 Member 仍负责核验结果，并保留原有 Task Claim 责任。

| 模式 | 参数 |
| --- | --- |
| 启动 | `task` 加上 `threadRef`、`taskRef` 或 `projectRef`；可选 `engine`、`cwd`、`requestId` |
| 停止 | 只传 `stop: <worker:…>` |
| 诊断 | 只传 `inspect: <worker:…>` |
| 追加指令 | `steer: <worker:…>` 与 `instruction`；可选 `requestId` |

`workspace` 是可接受的路由槽位，但 Worker 授权取自目标或已记录执行，不靠它改变 cwd 或选择 actor。控制调用容忍无意义填充的 `engine: 'codex'`；其他引擎或有实际含义的启动字段会被拒绝。

启动要求 Host Worker 开关开启、引擎启用，并且调用者当前拥有目标 Project。开关关闭时不声明该工具。显式目标必须一致：Task 属于 Thread，两者也须属于显式指定的 Project。缺少、未知、冲突或无权访问的目标都在启动原生进程前拒绝。

`engine` 为 `codex` 或 `claude`，省略时用 Host 默认值。不自动改用其他引擎、账号或模型。`cwd` 必须能解析为绝对工作目录，省略时默认调用 Session 的目录。

启动立即返回 `worker:` ref、Project、引擎、cwd 与开始时刻，工作在后台继续。不要轮询。相同意图重复使用 `requestId` 会返回原执行，并发启动也一样；复用该 id 却更换 Member、任务、引擎或目标会冲突。

绑定 Thread／Task 的执行发布 `worker_started` 与 `worker_settled` 事实，不发布答案。答案作为不可信外部文本到达发起 Member 的 Inbox，不再另发父会话通知。只绑定 Project 的执行不公开发布，保留父通知路径。两者都不创建 Task、Main 条目或 Claim，不改变 Thread revision，也不验收工作。

stop 仅授权发起 Member；Human 另有 Web 停止入口。关闭新委派或失去 Project owner 身份不会撤销已有停止句柄。结果等待清理与持久终态：`worker_stop_pending` 表示操作仍在继续，`worker_stop_unrecorded` 表示终态未获持久确认。已经结束时返回真实状态。

inspect 只授权发起者与 Human，不授权新任 Project owner。结果包含已存摘要、原生标识，以及已结束执行的原生记录中的有界片段；无法读取时说明原因。运行中／未确认执行不提供已结束片段。原生记录不复制进 Team 存储，也不向同行发布。

steer 向同一原生会话提交一条指令；运行中的引擎可在当前或后续 turn 接收。`submitted` 不表示模型已读，也不保证落入固定 turn。只有发起 Member 能 steer，Human 没有该入口。

链上最新执行干净结束后，包括干净失败，可以续跑为新执行，返回新 ref 与 `continuedFrom`；前驱不变。续跑重查 Member、Project owner／状态、开关、引擎与原生记录。停止中、未确认或上个 Host 留下的 running 执行不会复活。并发续跑进入同一个后继。

steer 重试使用持久请求身份。相同 id 返回首次回执／拒绝，不再投递；更换指令、Member 或 Worker 会冲突。新 id 的同文请求会成为 pending／submitted／ambiguous 接纳的 alias。原生明确拒绝表示未投递，允许新 id 重试；ambiguous 或 unconfirmed 不是盲目重试的理由。

执行状态为 `running`、`completed`、`failed`、`stopped`，上个 Host 的 running 记录投影为 `unconfirmed`。不确定时不自动重跑。设置、原生诊断防护、steer 接纳与卸载清理由 [Host authority](../architecture/host-authority.zh.md#worker-委派)维护。

## Team manager 工具面

manager 不是 Member，使用独立的 `team-manager` preset。其九个工具为 `team_overview`、`team_models`、`member_create`、`project_create`、`project_owner`、`project_update`、`member_update`、`member_state` 与 `member_workspace`，从不声明给 Member。

参数、当前 manager 授权与提交后重试规则由 [Team manager preset](../architecture/tools-and-preset.zh.md#team-manager-preset)维护。不要从 Member 工具推断其可选字段行为：省略或空值的含义由各 schema／action 决定。
