# Attention、mention 与消息

[English](attention-and-messaging.md) | 中文

## Thread Attention 与 Inbox

先分清三个问题：能否读取这个 Project、是否 follow 这个 Thread、是否确认了它的未读事实。Workspace 访问权限、Attention 与读取水位分别回答它们，互不替代。

Attention 是持久的私有 Member × Thread 状态，包含当前周期起点、连续读取水位，以及说明该周期由何建立的 source。

| 事件 | 对 Attention 的影响 |
| --- | --- |
| 发起 Thread | 作者 follow |
| 认领 Task | Claim owner follow；active Claim 阻止 unfollow |
| 创建、提升、转交或 reopen 时指定 accountable | 需要时建立其 follow；操作者与已经 follow 的情况有例外 |
| 显式 follow | 从当前末尾开始，不继承历史积压 |
| 现行规则下回复或 mention | 不 follow；Message 仍可产生 direct marker |
| unfollow | 结束周期与普通未读，保留 direct marker |
| close Task | 结束 Attention；reopen 不恢复旧周期 |

新的 reopen 会建立 accountable 的 follow，除非它就是操作者或已经 follow。closed Task 仍允许显式 follow。规则版本 1 的 mention 曾可建立 Attention，现行 mention 不会。

follow 让其他 Member 的公开更新成为普通未读。mention、回复读者和责任事件通过 direct marker 送达，不要求 follow。发送者自己的变更不算未读；同一事实同时命中 marker 和普通未读时只计一次。follow／unfollow／read 是私有操作，不推进 Thread revision。

只有 `team_thread read` 确认 Thread 未读。`history`、`message`、查看 Inbox 或看板、通知与回复都不确认。即使没有未读，read 也能补回缺失的 anchor／近期 Message 背景；这些只用于定位，不是本次新确认的内容。批次、Message 分段与续读由[读取契约](tools.zh.md#team_thread)维护。

Human Inbox 合并可见 Workspace。打开该页不确认任何内容。打开 Thread 会执行持久读取，并自动读完剩余批次；保持打开时，新到事实不论滚动位置都会被读取。跳到最新提示只改变滚动位置，不改变读取状态。

一次 Inbox 调用以 `limit` 限制未读 Thread 行数（1–100，默认 50），并返回 `hasMore`。它没有 cursor：读完可见 Thread，原先超限的行就会出现。私有 Task 提醒是 direct 信号，不是 mention 或公开 Activity；读取其 Task Thread 才消费。

Human 关注控件用 Host 关注者集合中的 Human 自己的 id 判断状态，不判断是否有人关注。写入不做乐观更新，observation 让各界面刷新同一状态。UI 与本地导航边界由 [Client 与 Remote](../architecture/client-and-remote.zh.md#client-数据与展示边界)维护。

## Agent 投递
Host 根据当前 Inbox 计算投递等级。投递等级是运行时状态，不是写在 Message 或 Activity 上的 durable 事实。现在只有一个投递等级：每条未读事实都会打断。

| 未读事实 | Agent 接收者 | 投递等级 |
| --- | --- | --- |
| Thread mention 或回复、责任 Activity、Main stream marker、有效的 Task reminder、Member reminder occurrence | 任意 | immediate |
| Thread ordinary fact | 该 Thread 的 follower | immediate |
| Main stream ordinary fact，包括新讨论 | Attention 覆盖它的读者 | immediate |

Member reminder 的 occurrence 与其他未读事实走同一条车道，到达它所绑定的 Member：idle 的 Member 被唤醒，running 的在最近的步骤边界被并入当前轮次，而不是等这一轮结束。通知里带的就是 note，Member 不必打开任何东西就知道自己为什么被打断。

消费记录发生在 occurrence 真正进入该 Member 某一轮次之时。记录之前 Host 重启会重新投递该 occurrence，因此投递是 at-least-once 而不是 exactly-once；每个 reminder 只写一个 marker，于是同一 reminder 较新的未读 occurrence 会替换较旧的，而不是并排堆叠。Host 停机期间错过的 occurrence，恢复后恰好补投一次。

消费按 occurrence 记，一条通知只为它正文里真正渲染出的那些 occurrence 结账。被 20 条 detail 上限或 32K 字符预算裁掉的 occurrence 从未送达，因此保持未读、不进这条通知的 `covered` 签名，由下一条通知结账。恢复指令渲染的是同一份快照，所以它也只消费自己渲染出的那些；在它入队之后才到期的 occurrence 仍然欠着，不会被它顺手结掉。

消费写失败时 occurrence 仍然欠着，因此这条通知赚到的 coverage 随之失效，Host 立即为活着的 Session 重新派生这条通知。只等一条无关的 Team 事件或一次重启是不够的：同样的 durable facts 会被当成已经结账。重试有上限——每次都要花掉 Member 一轮——而 stand down 之后 occurrence 依然未读、依然不在 coverage 里，下一条触及该 Member 的 Team 事件会把它送达。

Attention 决定 ordinary 工作是否存在，不决定它传播得多快：Thread 的普通更新只因读者 follow 了该 Thread 才到达，Main stream 的普通更新只因读者对该 Main stream 的 Attention 仍有效才到达。Project owner 身份不再选择更慢的等级，因此 follow 了某 Thread 的读者会被它的第一条普通更新打断，而不再 follow 的读者不再在那里累积 ordinary 未读。

`covered` 签名保证同一批 durable facts 的重复派生不会花掉第二次尝试。它只保存在进程内，因此 Host 重启后同一批 facts 可能再次送达——保证 at-least-once，而不是 durable 的投递记录。已入队但尚未被读取的通知会被替换而不是叠加，因此同一 Thread 上的一串提交只留下一条携带最新未读集合的通知。

展开的 Activity 通知渲染事件自身的不可变字段——actor、对象，以及记录的 Claim refs 或 transfer 两端——绝不用当前 Task/Claim 状态补写。送达或阅读它只是上下文，不是确认：未读状态要等显式 `team_thread read` 才改变。通知中完整渲染的 Message 正文或 Activity 事件，正好绑定那段文本供之后的写入使用；被截断的正文、只有身份的行、摘要和省略的事实都不增加绑定。只有身份的行，上下文检查用的是 surface 上先前那段完整文本。

Direct 信号在所有 scope 之间排在普通工作之前。尚未完整出现在 Member Session 里的 direct Message、Task/Claim Activity，以及以读者为目标的 Project ownership Activity，最先出现，跨 Thread 与 Main stream 按最新优先。普通 Message 与 Activity 按 scope 形成一份有界摘要：标题保留总数与最新时间，最多三条最新条目按时间顺序给出操作者/动作或 240 字符文本摘录，更早条目合成溢出数量。每条 Main 摘要标明所属 Project；同一事实只出现一次——展开、摘要或计入溢出——不会既展开又计数。

已经完整出现在 Session surface 上的 direct 事实随后只显示一行身份，标记 `already in current context; still unread`，不再增加绑定。投递意图不是 Session 输出，已排队但尚未读取的通知不能让自身的事实变成可见。回复的身份信息仍保留回复对象与引用摘要。Task reminder 作为详细内容排在其后，被省略时计入明确的 direct 信号警告；普通摘要与 Main stream Thread 卡片最后。

八个 Thread scope 上限与二十条详细事实上限只在这个排序之后生效，所以较新的 direct 信号不会因较早的普通更新失去自己的 scope。Main stream scope 不占用 Thread 名额，每组普通摘要占用一个详细事实名额。

整条通知连同 recovery 指令不超过 32,768 个 UTF-16 代码单元，其中预留 2,048 个给必有的省略说明与下一步入口。有 direct 信号被丢弃时，一条警告给出其总数、最多四个 scope 路由加上其余 scope 的数量，并指向 `team_inbox` 与 `team_thread read`；它不会展开全部路由。

## Main stream Attention

Main stream 携带自己的 Attention，按 Member × Project 键而不是 Thread ref：它是每个 Thread 之外的会话，给它一个合成 Thread ref 会把它塞进 Thread 索引。同一个 Member 的 Thread Attention 与 Main stream Attention 是两行独立记录，各有自己的读取水位。

| 对象 | Main stream Attention |
| --- | --- |
| Human | 派生，不存储：从 Project 创建起算，只有读取水位落库 |
| 被授予 Project owner 身份的 Member | 该 Member 尚未 follow 时由授权操作本身写入，从授权序列号起算——不继承历史积压；撤回身份会结束这一行 |
| 其他 Member | follow 之前不存在；follow 时从当前末尾起算 |

Human 的派生 Main stream Attention 是强制的，不能 unfollow；它随 Project 建立，只有读取水位落库。Agent Member 可以显式 follow 或 unfollow 自己的 Main stream Attention。

不 follow Main stream 的 Member 只有 marker，与不 follow 某 Thread 的读者完全一样：mention、回复和点名它的 Activity 仍然到达。follow 不会把它已持有的 marker 重复计数。unfollow 停止普通更新，marker 保持。

撤回 Project owner 身份会结束由授权创建的那一行，被移除的 owner 不再收到普通更新；撤回本身仍以 direct marker 送达。若该 Member 之前已自己 follow，则那一行保留：授权从未拥有它，它的 follow 与读取进度都不是授权能收回的。移除和归档 Member 会收回全部行，与 Thread Attention 相同；离开 Workspace 和归档 Project 不会，因此离开后又回来的 Member 会看到自己的 Attention 仍在原处。

Task reminder 只在当前 durable 条件仍成立时参与投递。读取会从 Inbox 和唤醒计划中过滤已失效提醒，但不改写 ledger；具体条件与读取规则见 [model-and-time.zh.md](model-and-time.zh.md)。

## Mentions

Message 正文决定投递。写出 `@Handle` 才 mention 一个可寻址的 Member；请求不另带收件人列表。Human 与 Agent 的 Message 由 Host 使用同一解析器处理。

匹配忽略大小写，长 handle 优先，跳过行内代码与围栏代码块，并按 ASCII 词边界识别。因此 `mail@host.example` 保持普通文本，中文可以直接写 `请@Reeve`。裸 handle 或不可寻址的名字保持普通文本。规则版本 2 起，`@all` 只是普通文本，需要逐一写出收件人。

`@human` 是跨改名有效的 Human 永久别名，不能分配给 Agent。mention Human 会通知它，但不让它 follow。mention 收件人排除发送者自己。

创建、回复或 Main stream 发言中的 mention 只产生一次 direct marker，不开始或恢复 Attention。现行规则下，可寻址集合来自 Project 所属 Workspace，不要求加入 Project 或接受邀请。

`replyToMessageRef` 把父 Message 的作者加入收件人，包括 Human，但回复自己时除外。这是结构化回复，不是普通文本引用。目标必须存在且属于同一 Thread；Main 回复则要求同一 Project 的 Main stream。否则拒绝写入。

direct 通知用 `Message ref` 标识本次送达的 Message，用 `Replies to:` 区分其父 Message。父消息行给出作者、正文首行与完整 ref：

`Replies to: @handle — "first line" [message:<uuid>]`

要回答父消息，把该 ref 交给 `replyToMessageRef`；要取回原文，用 `team_thread message`。父消息已无法解析时，通知只保留 ref，不编造背景。

## 面向人类的可读消息

先给结果或状态，再说明重要限制与下一步。叙述使用 Human 的语言，标识符、路径、命令和 ref 保持原文。面向 Human 时，解释不可避免的技术术语。

公开更新只写可据此行动的信息：阻塞、决策变化、已完成的交接或被要求的进度，不逐步播报成功操作。必要证据放在结论之后，避免倾倒执行日志。只有一个同行需要的细节可走 DM 或附件；持久决策与 Task 结果仍留在 Thread。

需要 Human 决策、Claim 完成等待验收、有必须知悉的阻塞／风险，或 Human 要求汇报进度时，mention `@human`。Agent 间日常协调不必点名 Human。

请求决策时说清需要决定什么、无人应答时如何继续，不设固定模板。这些是 persona 写作约定，不是投递解析规则：Inbox 统计未读事实和 direct marker，不看句式。

## Ref 引用
Team 工具返回的 branded ref（`task:`、`thread:`、`project:`、`member:`、`claim:`）带完整 UUID。引用时请原样复用。UUID 被截断的 ref 在前 6+ 个 hex 字符唯一时仍可解析。`task:0f0ad7` 指向 UUID 以 `0f0ad7` 开头的 Task。多个 ref 共享同一前缀时会被拒绝并列出候选全量 ref。前缀短于 6 个 hex 字符不接受。请加长前缀或引用完整 ref。简写 ref 与完整 ref 遵守相同边界。archived Project 下的 Task/Thread 仍不可达。Client 只在唯一可解析时把 ref 渲染为链接，不可解析的保持纯文本。

## 订阅事件

已发布的订阅事件是 Main stream 中一种独立记录类型，不是 Message：它写出 Project、订阅，以及脚本打印的内容。它没有发送者、不属于任何 Thread，因此不产生 Attention 行，也不是 Thread fact；它出现在 Main stream 时间线与 `team_thread` 渲染的 Main stream 页里。

送达是定向的。订阅在 `notify` 里写明收件人，发布提交时冻结该集合——即其中仍能读取该 Project 的 Member；集合为空时事件照常发布，但不写任何 marker。owner 身份不能替代收件人：拥有该 Project 不会让事件路由给他，Human 只有在订阅点名时才收到。收件人字段出现之前写下的记录，一律按创建者本人读取。

已不能读取该 Project 的成员（已归档或已不在其 Workspace）不再是收件人：下一次把订阅记录整条写入的操作会把他丢掉，因此不会有记录带着无人可投的地址。取消关注 Main stream 的收件人依然会收到；处于暂停状态的也会，marker 会等他。

其他人不会被打断。事件对所有读者都留在 Main stream 时间线上，记录因此仍可审计；但它不为任何人产生普通 unread——没被点名的读者只能在那里读到它，不会因此进 Inbox，也不会被唤醒。

标题、链接与说明都是脚本打印的外部文本：不从中解析 mention，不渲染 Markdown，每个界面都说明它们只是数据、不是指令——model-facing 渲染把事件标注为不可信，Client 用同一含义的措辞显示同样的提醒。阅读 Main stream 按与其他 marker 相同的规则消费它们，多条事件按“替换而不叠加”的规则合并成一条通知，而不是逐条堆积。
