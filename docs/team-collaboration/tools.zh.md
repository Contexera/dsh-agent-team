# 七工具协议

[English](tools.md) | 中文

每个成功或被拒绝的 Team tool result 都通过正常 model loop 返回。这里没有 context 工具：Member 不能自己换代、记录锚点或就地压缩。超大的 Session 由 preset 的默认压缩引擎就地压缩；冷下来的一代由 Host 在唤醒边界换代（见 [`memory-and-context.zh.md`](memory-and-context.zh.md)）。

## `team_view`

`team_view` 是 address book：有界的获授权 Project、顶层 Thread 与 Member 摘要。这是当前的地址簿，不是工作队列。unread work 归 `team_inbox`。Threads 是唯一分页目录。行按 newest-first 排列，携带 threadRef、Project ref、bounded anchor subject。taskful Threads 在行内呈现 Task standing：Task ref、编号、status/resolution。绝无第二个 Task 索引，也不渲染 revision 或消息数。revision 和消息数都不改变下一个合法动作。

ledger 有 Project owner 之后（规则版本 2），每个 Project 行还列出 owners（`@human` 在前）和读者的角色（`owner` 或 `member`）。

在途工作不属于地址簿：首页末尾指向 `team_task board`。

cursor 只延续 Thread 行。continuation 页只渲染 Threads。翻页可达全部获授权的顶层 Threads，含 taskless 与不在首页的 taskful。页脚把 cursor 称为 Thread cursor，说明是否还有更旧的 Thread anchors。

## `team_inbox`

`team_inbox` 返回有 unread work 的 Threads 的有界、无正文 summaries，另为每个对读者有 Main stream 未读的 Project 列一行（其 Main stream Attention 覆盖的普通未读与每个读者的 marker）。Direct requests 排在 ordinary unread work 之前，之后按最新相关 sequence 排序。列出结果不改变 read state。header 给出 unread/direct 总数与展示的 Threads 数。有界列表之外仍有未读，header 给出截断结论。每个条目显示精确的 unread/direct 计数、Project ref 与 taskful 时的 Task standing。这是读者自己的 unread 队列。要看在途的工作（无论是否有未读），用 `team_task board`。页脚把正文阅读与确认指向 `team_thread read`。渲染不携带 revision 与写令牌。当前 read 才是必需的变更基础，并提供令牌。

## `team_thread`

`team_thread` 只负责 Thread reading。`threadRef` 是 primary identity。`taskRef` 仅是 released Clients 在 taskful Threads 上使用的 compatibility alias。

`read` 返回一个按 chronology 排列的 unread batch，推进 durable watermark。batch 缺省最多 20 条 fact。确认范围只覆盖这次调用真正交付的内容：渲染结果会超过输出上限时，工具少选几条 fact，Host 只提交这个被选中的前缀。正文已完整出现在当前上下文中的未读 Message 可以省略正文，仍计入本次确认。

没有选中任何 fact 且没有 reminder 可确认的 read 什么都不推进，不追加 operation；只有 reminder 的 read 仍会确认这些 reminders。已提交读的相同重试返回该次读的**原 receipt**，画面则取自当前 projection。读从不承诺冻结画面。

Thread 的选择界限是持久的：receipt 存储 `selectedThroughSequence`，replay 据此重建同一次确认，界限之后的 facts 保持未读。相同重试只返回该 receipt 与当前未读画面，不会再次确认。写入该字段之前的 receipt 仍按缺省 batch 解释。Human 的读取、Remote 参数与读取语义都不变。

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
7. 按 sequence 排列的已确认 facts，带行内 unread/direct 标记。正文已完整出现在当前上下文中的已确认 Message，用 `body already in current context; omitted` 代替正文。派生 Task 卡在 `Current Task cards — not Thread reading` 下按创建 sequence 渲染，带当前 status 与 accountable owner；卡片是当前状态，不是 Thread reading；
8. `Incomplete Message — not acknowledged`：未读或背景 Message 放不下时返回的有界片段。未读 Message 要等先前可见片段加后续输出覆盖整段正文后才不再未读；背景仍只是背景，不是本次新确认的内容。

页脚给出 read-through sequence 与剩余 unread 计数。若这次 read 身后仍留有 Thread facts，再补一句那些 facts 的数量。重返的读者借此看到自己没在看的跨度有多大，不把本次 batch 当成整个 Thread。

Main stream 的 `read` 渲染同样的结果与背景规则。页面先选最早的未读条目，再补缺失的近期背景；read 只确认实际交付的前缀，并报告 read-through sequence。Task 卡或读者自己的消息不能遮住更早的未读内容。

Thread 卡渲染在 `Thread cards — Main entry acknowledged, not its Thread` 下：卡片是它所指向 Thread 的当前状态，确认卡片的 Main 条目绝不等于该 Thread 已读。Main stream 的 `message` 按 ref 读回一条条目，分段与续读规则相同。Human 对 Main stream 的读取不变。

history 页渲染历史结果与 Thread 身份。首页给 full anchor，continuation 页给 bounded subject。渲染选中的 facts、该 sequence 窗口内的派生 Task 卡与 cursor/hasMore 页脚，绝无当前 Claims 或上下文建议。每条 activity fact 都是结构化的：actor、Task ref，以及这条 activity claim、完成、接受或 release 的 Claim refs。绝不是裸 kind。当一次 `read` 确认的是一个仍处于 done 状态 Task 的未读验收时，这些事实就写在 facts 里，read 不对读取者的上下文给出任何建议：没有 rollover 工具，也没有代际选择，就没有动作可陈述。

## `team_attention`

`team_attention` 只回答一个问题：我是否在关注这个 Thread 或这个 Project 的 Main stream，以及该不该继续关注。`status` 报告当前状态且不改变任何东西；`follow` 开始接收来自那里的普通更新；`unfollow` 停止接收。三者参数完全相同：地址与路由 Workspace。Thread 用 `threadRef` 作 primary identity，`taskRef` 是 compatibility alias；`projectRef` 改指 Main stream——三者只能给一个，同时带 Thread 与 `projectRef` 的调用会被拒绝，而不是静默取其中一个。

读者已关注时，每个结果还会说出这份 Attention 由什么建立——开了这个 Thread、领了它的 Task、是它的 accountable、拥有这个 Project、在里面被点名，或自己选择关注。Claim 的结果与 Thread start 会说明它们代读者刚建立的 Attention，因此读者不必再问就知道自己现在关注了。

Attention 不是 reading。这三个 action 都不渲染 facts、不确认未读、不交写令牌；读也从不改变你是否关注。结果形状只携带地址、scope、Thread 的 Task standing 与 following 状态，别无其他，因此 Attention 结果不可能漂移成展示内容。

每条结果都说出动词本身不携带的那个后果。follow 意味着来自那里的普通更新会打断你。unfollow 意味着它们停止，而点名你的 mention、对你的回复和需要你处理的责任事件仍然到达——并且 unfollow 不释放任何 Claim、不放下你 accountable 的 Task，所以它是订阅变化，不是退出工作。该 Task 上持有 active Claim 时会拒绝 Thread 的 unfollow，直到它 done 或 released。行本身的归属见 [Attention 与消息](attention-and-messaging.zh.md)。

与 `team_thread` 的拆分正是让读路径完全不带 Attention 逻辑的原因：三个 action 共享同一个参数口袋，而不是借用读的口袋——那里有 `messageRef`、`beforeSequence`、`limit` 三个它们永远用不上的参数。

## `team_message`

`team_message.start` 创建 Project 顶层 Thread。默认 taskless，也接受明确 task intent 以原子创建 Task。`team_message.reply` 向既有 Thread 追加明确的 reply。二者都接受 `attachments` 中的可选 absolute file paths。Host 验证每个 path，把 bytes 复制到 attachment cache。收件人看到 thumbnails/chips 与一行 cached path。任一 path 验证失败都会拒绝整个 send。commit 的 start/reply 渲染一个 committed-verb 结果：Thread created 或 reply added。结果携带 Message ref、新 Thread ref（taskful 时含 Task ref），以及恰好一个 next-write token hand-off。新建 Thread 立即可寻址，下一次变更也拿到了基础。

规则版本 2 起，`team_message` 还有 `post`，在 Project 的 Main stream 发言（`projectRef`、`body`，可选 `replyToMessageRef`，须为同一 Project 的 Main stream Message）。它不需要写入 token；持有未读 Main stream 的写入者得到 `main_unread_required`，须先读。

`start` 带 `kind: 'discussion' | 'task'`（已移除的 `asTask` 写法会被拒绝并指回 `kind`，绝不静默丢弃），只有 Project owner 能开：其他人得到 `project_owner_required`，提示改用 `post`；非 member 得到 `not_project_member`。Task start 另接受 `accountable` 与 `sourceThreadRefs`；两者在讨论 start 与 `post`/`reply` 上都被拒绝而非丢弃，commit 的 start 回报实际记录的负责人。

`team_thread` 的 `read`、`history`、`message` 接受 `threadRef` 或 `projectRef`（Main stream），二选一。Main stream 的行为与确认规则见上文 `team_thread` 一节。

类型化拒绝（`unread_required`、`stale_revision`）以 `Not committed` 开头，保留 refs、计数和有界的待处理事实。结果完整、只含身份明确的 Message，且 revision 基线可识别时，会提供当前令牌供重新考虑；部分结果与未知基线指向 `read`。这既不确认未读，也不保证下一次写入成功。完整规则见 [Mutation fences](boundaries.zh.md#mutation-fences)。

mention 一个该 Thread 从未承载过的 Member 同样不是拒绝：规则版本 2 下 Message 照常提交，每个可寻址的收件人都会收到，没有未送达余量需要报告，也没有邀请步骤。（规则版本 1 下同一次写入会报告它无法送达的名字；该路径只为 replay 旧账本而存在。）

每一处拒绝——类型化结果、抛出的参数形状错误、Host 拒绝——都点名下一步动作与该动作要传的值，且这些措辞来自唯一一份注册表（`packages/agent-team/src/recovery-hints.ts`），不是每个调用点各写一遍。注册表是被强制的，不是建议：一个测试遍历 Host 与 tool 包两侧面向模型的源码，拒绝写在注册表之外的路由句，因此新加的拒绝不可能带着一个模型无路可走的故障上线。

`reply` 另外接受 `replyToMessageRef`，点名本 Thread 上被回答的那条 Message。Host 用 ledger 解析它，未知的 ref 或属于别的 Thread 的 ref 一律拒绝，因此存下来的回复永远有一个读者能被带到的父消息。

这条链接记录在 Message 上，渲染为读者可以跳回的引用，并把父消息作者加进收件人。回答一个同侪的到达方式因此与 mention 相同，不必重复写他的 handle。Human 永不被加入，因为他们直接读 Thread。

Team 行设置里的开关决定这个参数是否可用。开关关闭时，携带 ref 的 reply 会被拒绝。

## `team_dm`

`team_dm` 向同一 Workspace 内一个 enabled Agent Member 发送私有 direct message。它只接受 `memberRef` 与 `body`，别无其他——没有 Thread、没有 Task、没有写令牌、没有附件——因为 DM 寻址的是人，不是会话。多带的参数会被拒绝而不是被忽略，因此伸手去拿 Thread 写入形状的模型会被告知：你想要的其实是 Thread reply。

DM 是纯送达。ledger 追加一个 audit-only 的 `team/dm-sent` operation，requestId 幂等。收件人的 live session 以 relay-form 注入的 user message 收到正文。idle 收件人开新 turn，busy 收件人 steer 进当前 turn。DM 不创建 Project、Thread、revision、Attention 或 Inbox markers，也不唤醒任何 change waiters。Human 不能被 DM。

每条结果的第一行都说明它是哪一种：已送达，还是只记录在案、没有可唤醒的 live session。没有自动重投，因此只记录在案的 DM 绝不被盲目重发。

DM 只用于快速澄清与状态同步。任务工作、决策和任何需要团队可见或可追溯的内容一律走 Thread。同一对象往来超过约 3 轮应转 Thread，因为每条 DM 消耗收件人一次完整 agent turn。

## `team_task`

`team_task` 的动作为 `board`、`list`、`claim`、`done`、`release`、`accept`、`close`、`reopen`、`transfer`、`promote`。

`board` 渲染 Host 的 Task board 投影：读者可见 Project 的全部 open Task，按待处理、进行中、待验收分组、按最新活动排序；再列每个 Project 最近完成的 5 个 Task。每行携带 Task ref 与编号、Project、Thread ref、live Claim 上的 Members、读者与它的关系（`accountable`、`executor` 或 `project-owner`）、负责人、读者是否可验收、有界主题与最新活动时刻。

`projectRef` 限定一个 Project；`mine` 只保留读者负责或持有 live Claim 的 Task。

`finishedTruncated` 说明 Host 是否还压着更早的已了结工作；渲染结果会把它写出来，所以一页永远不会被读成整列。

看板是当前状态，不是未读：读取不改变 read state，也不带写令牌。工具引导在读者遇到 Workspace 意外改动、或准备 claim 之前指向这里，让在途工作被识别为在途而非冲突。

`promote` 把讨论 Thread 转为 Task，需要 `threadRef` 与该 Thread 的 `baseRevision`，可选 `accountable`，只有 Project owner 可以执行（否则 `project_owner_required`）。

`list`、`claim`、`done`、`release` 只管理 Agent 自己在真实 Task 上的 Direction Claims。taskless Threads 没有 Claim mutation path。Direction 是一句说明 Agent 工作角度的话，帮助其他人发现冲突并追踪进展。execution plans 和 acceptance checklists 应写在 Thread messages 中。Claim 成功后会自动开始 Attention。`list` 渲染 Task/Thread 身份与当前 collision surface：只有 active Claims，或显式的空。渲染结果不带写令牌，也不提供 Thread 事实或变更基础。commit 的 mutation 点名动作（Claim created、completed 或 released）。先渲染权威的受影响 Claim：ref、结果 state、owner、direction。再渲染 Task/Thread 身份，以及恰好一个 next-write token hand-off。

拒绝与 message 拒绝使用相同形式及[完整性与令牌规则](boundaries.zh.md#mutation-fences)；每次尝试仍重新检查 Task 权限。

`accept`、`close`、`reopen`、`transfer` 了结的是 Task 而非 Claim，权限由 Host 判定：`accept` 属于 Human，或从未在该 Task 上持有过 Claim 的 Project owner，且仅在 in_review 时；`close`、`reopen`、`transfer` 属于 Human 与当前负责人。工具只转发 action 与写令牌，不重新推导该权限。`transfer` 取 `target`——当前 Project owner 的 memberRef、`@Handle` 或唯一 memberRef 前缀，或 `human`——只转移责任，Claim 仍留在其 owner 手上。commit 的了结结果点名动作、结果 status 与 resolution、负责人，以及它完成或释放的 Claims。`self_acceptance_forbidden` 或 `accountable_owner_required` 拒绝的出路来自 Host 的 recovery registry，并补上 Task 的当前状态与负责人——那只有拒绝之后调用方自己才读得到。
