# 七工具协议

[English](tools.md) | 中文

每个成功或被拒绝的 Team tool result 都通过正常 model loop 返回。这里没有 context 工具：Member 不能自己换代、记录锚点或就地压缩。超大的 Session 由 preset 的默认压缩引擎就地压缩；冷下来的一代由 Host 在唤醒边界换代（见 [`memory-and-context.zh.md`](memory-and-context.zh.md)）。

## `team_view`

`team_view` 是 address book：有界的获授权 Project、顶层 Thread 与 Member 摘要。这是当前的地址簿，不是工作队列。unread work 归 `team_inbox`。Threads 是唯一分页目录。行按 newest-first 排列，携带 threadRef、Project ref、bounded anchor subject。taskful Threads 在行内呈现 Task standing：Task ref、编号、status/resolution。绝无第二个 Task 索引，也不渲染 revision 或消息数。revision 和消息数都不改变下一个合法动作。

ledger 有 Project owner 之后（规则版本 2），每个 Project 行还列出 owners（`@human` 在前）和读者的角色（`owner` 或 `member`）。

在途工作不属于地址簿：首页末尾指向 `team_task board`。

cursor 只延续 Thread 行。continuation 页只渲染 Threads。翻页可达全部获授权的顶层 Threads，含 taskless 与不在首页的 taskful。页脚把 cursor 称为 Thread cursor，说明是否还有更旧的 Thread anchors。

## `team_inbox`

`team_inbox` 返回有 unread work 的 Threads 的有界、无正文 summaries，另为每个对读者有 Main stream 未读的 Project 列一行（owner 的普通未读与每个读者的 Main stream marker）。Direct requests 排在 ordinary unread work 之前，之后按最新相关 sequence 排序。列出结果不改变 read state。header 给出 unread/direct 总数与展示的 Threads 数。有界列表之外仍有未读，header 给出截断结论。每个条目显示精确的 unread/direct 计数、Project ref 与 taskful 时的 Task standing。这是读者自己的 unread 队列。要看在途的工作（无论是否有未读），用 `team_task board`。页脚把正文阅读与确认指向 `team_thread read`。渲染不携带 revision 与写令牌。当前 read 才是必需的变更基础，并提供令牌。

## `team_thread`

`team_thread` 只负责 Thread reading。`threadRef` 是 primary identity。`taskRef` 仅是 released Clients 在 taskful Threads 上使用的 compatibility alias。

`read` 原子返回一个按 chronology 排列的 unread batch，推进 durable watermark。读者没有 unread 时，read 什么都不推进，不追加 operation，也不携带 receipt。已提交读的相同重试返回该次读的**原 receipt**，画面则取自当前 projection。读从不承诺冻结画面，重试展示的就是此刻的未读。`history` 返回有界的旧 public facts，不改变 read state。`message` 按 ref 逐字读回一条 Message，用来回答那些原文不在你手上这一页里的引用。

`beforeSequence` 与 `limit` 是仅 `history` 可用的参数。`read` 只负责清空未读、不能翻页，因此其他 action 携带它们会被拒绝，并给出 `action: history` 的出路。

三个 action 不共享一个最大化渲染：读展示 Thread，也只有读展示 Thread。这里没有任何 Attention action，因为 Attention 是另一个问题、另一套参数口袋——见 `team_attention`。

`message` 渲染 ref、带时刻与发送者的 sequence，然后是整段正文。这个 action 存在的意义就是让读者回答一条它没有收到的 Message，所以一个字都不裁剪，导向语也不变。

read 先渲染结果：确认与剩余的 unread 计数。再渲染 Thread 身份与 following 状态。再导向：返回 facts 携带 Host 提供的 background，给 full anchor；否则给 bounded anchor subject。anchor 本身在返回 fact 时绝不重复渲染。read 接着只渲染 active Claims：当前 collision surface，每 Claim 一行（claim ref、owner、direction）。然后是带行内 unread/direct 标记、按时间排列的 facts。页脚给出 read-through sequence 与剩余 unread 计数。若这次 read 身后仍留有 Thread facts，再补一句那些 facts 的数量。重返的读者借此看到自己没在看的跨度有多大，不把本次 batch 当成整个 Thread。

history 页渲染历史结果与 Thread 身份。首页给 full anchor，continuation 页给 bounded subject。渲染选中的 facts 与 cursor/hasMore 页脚，绝无当前 Claims 或上下文建议。每条 activity fact 都是结构化的：actor、Task ref，以及这条 activity claim、完成、接受或 release 的 Claim refs。绝不是裸 kind。当一次 `read` 确认的是一个仍处于 done 状态 Task 的未读验收时，这些事实就写在 facts 里，read 不对读取者的上下文给出任何建议：没有 rollover 工具，也没有代际选择，就没有动作可陈述。

## `team_attention`

`team_attention` 只回答一个问题：我是否在关注这个 Thread，以及该不该继续关注。`status` 报告当前状态且不改变任何东西；`follow` 开始接收该 Thread 的更新；`unfollow` 停止接收。三者参数完全相同：Thread 地址与路由 Workspace。`threadRef` 是 primary identity，`taskRef` 是 compatibility alias。

Attention 不是 reading。这三个 action 都不渲染 Thread 的 facts、不确认未读、不交写令牌；读一个 Thread 也从不改变你是否关注它。结果形状只携带地址、Task standing 与 following 状态，别无其他，因此 Attention 结果不可能漂移成展示 Thread 内容。

与 `team_thread` 的拆分正是让读路径完全不带 Attention 逻辑的原因：三个 action 共享同一个参数口袋，而不是借用读的口袋——那里有 `messageRef`、`beforeSequence`、`limit` 三个它们永远用不上的参数。

## `team_message`

`team_message.start` 创建 Project 顶层 Thread。默认 taskless，也接受明确 task intent 以原子创建 Task。`team_message.reply` 向既有 Thread 追加明确的 reply。二者都接受 `attachments` 中的可选 absolute file paths。Host 验证每个 path，把 bytes 复制到 attachment cache。收件人看到 thumbnails/chips 与一行 cached path。任一 path 验证失败都会拒绝整个 send。commit 的 start/reply 渲染一个 committed-verb 结果：Thread created 或 reply added。结果携带 Message ref、新 Thread ref（taskful 时含 Task ref），以及恰好一个 next-write token hand-off。新建 Thread 立即可寻址，下一次变更也拿到了基础。

规则版本 2 起，`team_message` 还有 `post`，在 Project 的 Main stream 发言（`projectRef`、`body`，可选 `replyToMessageRef`，须为同一 Project 的 Main stream Message）。它不需要写入 token；持有未读 Main stream 的写入者得到 `main_unread_required`，须先读。

`start` 带 `kind: 'discussion' | 'task'`（已移除的 `asTask` 写法会被拒绝并指回 `kind`，绝不静默丢弃），只有 Project owner 能开：其他人得到 `project_owner_required`，提示改用 `post`；非 member 得到 `not_project_member`。

`team_thread` 的 `read`、`history`、`message` 接受 `threadRef` 或 `projectRef`（Main stream），二选一。Main stream 的 read 渲染最新条目及点名读者的条目，确认整条流直到头部，并把 Thread 卡片渲染为当前状态。

 类型化拒绝结果（`unread_required`、`stale_revision`）以 `Not committed` 开头。保留重读与审慎重试所需的结构化 refs 与计数，并渲染挡住这次写入的事实——`unread_required` 是未读批次，`stale_revision` 是过期令牌之后的增量——形状与 `team_thread read` 返回的完全一致，同时把当前 revision 作为下次写入的写令牌交回。因此被拒的写入方在拒绝本身里就知道什么变了、该用哪个令牌，重试无需中间再读一次即可提交。恢复路径仍是 read-and-reconsider：拒绝里的事实是那道门，不是替代确认的手段。mention 一个该 Thread 从未承载过的 Member 不是拒绝。Message 照常提交，结果里报告未送达的名字。

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

`team_task` 的动作为 `board`、`list`、`claim`、`done`、`release`、`promote`。

`board` 渲染 Host 的 Task board 投影：读者可见 Project 的全部 open Task，按待处理、进行中、待验收分组、按最新活动排序；再列每个 Project 最近完成的 5 个 Task。每行携带 Task ref 与编号、Project、Thread ref、live Claim 上的 Members、读者与它的关系（`executor` 或 `project-owner`）、有界主题与最新活动时刻。

`projectRef` 限定一个 Project；`mine` 只保留读者持有 live Claim 的 Task。

看板是当前状态，不是未读：读取不改变 read state，也不带写令牌。工具引导在读者遇到 Workspace 意外改动、或准备 claim 之前指向这里，让在途工作被识别为在途而非冲突。

`promote` 把讨论 Thread 转为 Task，需要 `threadRef` 与该 Thread 的 `baseRevision`，只有 Project owner 可以执行（否则 `project_owner_required`）。

`list`、`claim`、`done`、`release` 只管理 Agent 自己在真实 Task 上的 Direction Claims。taskless Threads 没有 Claim mutation path。Direction 是一句说明 Agent 工作角度的话，帮助其他人发现冲突并追踪进展。execution plans 和 acceptance checklists 应写在 Thread messages 中。Claim 成功后会自动开始 Attention。`list` 渲染 Task/Thread 身份与当前 collision surface：只有 active Claims，或显式的空。渲染结果不带写令牌，因为当前 `team_thread read` 仍是必需的变更基础。commit 的 mutation 点名动作（Claim created、completed 或 released）。先渲染权威的受影响 Claim：ref、结果 state、owner、direction。再渲染 Task/Thread 身份，以及恰好一个 next-write token hand-off。

拒绝结果（`unread_required`、`stale_revision`）与 message 拒绝共享同一形式：`Not committed`、本地 refs/计数、挡住这次写入的事实、先读后重试的恢复路径，以及当前 revision 作为下次写入的写令牌。
