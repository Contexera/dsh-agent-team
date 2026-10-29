# Attention、mention 与消息

[English](attention-and-messaging.md) | 中文

## Thread Attention 与 Inbox
Thread Attention 是一个 Member 对一个 Thread 的 durable private state。它记录当前 attention period 的开始位置、连续 read watermark，以及这个 period 由什么建立。创建顶层 Thread（作者随之关注）、在 taskful Thread 上创建 Claim、被指定为 accountable——由转交、promote 或 reopen——或显式 follow 都会开始 Attention；规则版本 1 的 mention 也会开始它，那是版本 2 不再产生的唯一来源。

source 是这一行里唯一不涉及权限也不涉及进度的字段：它让结果能说出读者为什么 follow，而不是猜。每个结果渲染什么由 [tools.zh.md](tools.zh.md) 负责；字段存在之前写下的行，其原因由写入它的 operation 推导，规则记录在 [host-authority.zh.md](../architecture/host-authority.zh.md)。

taskless Thread 可以直接 unfollow。taskful Thread 只有在 Agent 的 Task overlay 没有 active Claim 时才能 unfollow。Unfollow 结束当前 Attention period，并丢弃这个 period 的 unread work。之后再次 follow 会从当前 Thread tail 开始，放弃的 history 不会重新变成 unread。

Attention active 时，三类事实会成为 ordinary unread facts。第一，其他 Members 的 Messages。第二，taskful Thread 上的 Claim changes。第三，Task accept/close/reopen activities。Mention 为收件人创建 durable direct marker。发送者自己的 mutation 不会成为自己的 unread。Promotion 为当前 followers 携带 durable Activity markers。Promotion 的 `promote` activity 像其他 Task transitions 一样作为 follower unread fact 到达。由 `team_thread.read` 渲染。Follow、unfollow 和 read operations 不是 public Thread facts，不推进 Thread revision。close 结束 Attention；reopen 不恢复旧 periods，但新的 reopen 会为 accountable 恢复当前 Thread follow，accountable 是操作者或已经 follow 时除外。

`read` 既返回未读工作，也补定位背景。读者当前上下文已不再持有讨论时，它补上缺失的 anchor，并给出未读窗口之前最多四条 fact 中筛出的 Message，当前已完整可见的背景不重复；任何一次 read 都可能补，不只是首次。背景只用于定位，不是本次新确认的工作。`history` 是唯一翻查更旧 facts 的入口，`message` 逐字读回一条 Message；二者都不确认未读。完整读取规则见 [tools.zh.md](tools.zh.md)。

Human Client 默认打开 Projects workspace。Human navigation 沿 Workspace → Project → Thread 进行。Task 是 taskful Thread 上的 card/header overlay，不是独立的 navigation level。Inbox（收件箱）是 Team 内的一个全局页。由侧栏卡片/窄轨图标进入，合并各 Workspace 的 Inbox 调用。读者看到整片未读，mention 只在其中计数。打开 Inbox 页不执行 Thread read。只有打开 Thread 才推进水位，并清除 direct marker 与私有 reminder marker。私有 Task 提醒是直接通知，不是 mention 或公开 Activity；查看 Inbox 或看板不会消费它。打开 Thread 会执行 durable Human Thread read 并滚动到最后一条。有界 read 后若仍有 unread facts，Client 自动续读清零。不存在显式的 continue-reading action。

Inbox 调用返回有界队列：最多 `limit` 个未读 Thread（1–100，默认 50），`hasMore` 说明该页之外是否还有 Thread。Client 在列表结尾把这一判断渲染出来。读掉一个 Thread 就把它从队列里排掉，因此整页藏起来的行无需 cursor 也能重新可达——该 projection 有意不携带 cursor。

当前 Thread surface 展示 public revisioned facts，并且仅在存在时展示 Task status、Claims 和 runtime risk。Thread 的两个面都渲染同一个 follow/unfollow 控件：按下状态读自 Host 的当前关注者集合中属于 Human 自己 memberId 的那一条，写入走 Human `changeAttention` Remote，不做乐观翻转；Human-only 的 follow/unfollow observations 历史本身不作渲染。

这个集合装的是每个对该 Thread 开着 Attention 的 Member，所以控件问的从来不是「有没有人在关注」：集合里只有别人时，读出来和空集合一样是未关注。memberId 来自 Host 自己的投影；它还没到达时，控件的状态保持未回答，而不是猜一个——猜就会把别人的 Attention 读成 Human 的。同一个集合仍然整体参与 composer 的 mention 候选排序，所以这次修的是从集合里读出属于 Human 的那一行，而不是换掉这个集合。
状态是每次从 Host 重读得出的，不是一次定死。控件收到的每一次 observation 都成为当前状态，所以另一个面或另一个客户端改出的关注变化会到达按钮，不需要 Human 去点它。一次写入的 requestId 只服务一个回答，用过即弃，并按 action 与 Thread 限定：留着的 id 会让 Host 用幂等缓存里早先那次的结果回答下一次写入，于是按钮显示的关注状态与 Host 自己的关注者集合并不一致。

这个控件先说自己处在哪个状态，再说自己要做什么。已关注的 Thread 显示按下底色（shipped 的选中语汇，让两种状态差的是一条描边之外的东西）；写入失败不会翻转它，因此读者刚按下的那个按钮仍然显示 Host 最后一次回答的状态。可见动词很短，而无障碍名保留完整短语——正因如此它才能和 Task 自己的动作共用一条带。写入进行中时，该名取长句式而不是空闲那句：读屏读的不是收短后的可见词，名字不变就等于不宣布这次写入的进度。

History paging 永远不确认新 work。Thread 打开期间到达的 updates 无论读者滚动位置一律自动确认。滚离底部的读者只会看到无读取语义的纯跳转提示。

## Agent 投递
Host 根据当前 Inbox 计算投递等级。投递等级是运行时状态，不是写在 Message 或 Activity 上的 durable 事实。现在只有一个投递等级：每条未读事实都会打断。

| 未读事实 | Agent 接收者 | 投递等级 |
| --- | --- | --- |
| Thread mention 或回复、责任 Activity、Main stream marker、有效的 Task reminder | 任意 | immediate |
| Thread ordinary fact | 该 Thread 的 follower | immediate |
| Main stream ordinary fact，包括新讨论 | Attention 覆盖它的读者 | immediate |

Attention 决定 ordinary 工作是否存在，不决定它传播得多快：Thread 的普通更新只因读者 follow 了该 Thread 才到达，Main stream 的普通更新只因读者对该 Main stream 的 Attention 仍有效才到达。Project owner 身份不再选择更慢的等级，因此 follow 了某 Thread 的读者会被它的第一条普通更新打断，而不再 follow 的读者不再在那里累积 ordinary 未读。

`covered` 签名保证同一批 durable facts 的重复派生不会花掉第二次尝试。它只保存在进程内，因此 Host 重启后同一批 facts 可能再次送达——保证 at-least-once，而不是 durable 的投递记录。已入队但尚未被读取的通知会被替换而不是叠加，因此同一 Thread 上的一串提交只留下一条携带最新未读集合的通知。

Activity 通知渲染事件自身的不可变字段——actor、对象，以及记录的 Claim refs 或 transfer 两端——绝不用当前 Task/Claim 状态补写。送达或阅读它只是上下文，不是确认：未读状态要等显式 `team_thread read` 才改变。被字符预算或事实上限缩短的通知，仍会完整绑定它实际渲染的每一条完整事件；只有被截断或省略的那一条才只用于导向，不能满足任何写入的上下文检查。

## Main stream Attention

Main stream 携带自己的 Attention，按 Member × Project 键而不是 Thread ref：它是每个 Thread 之外的会话，给它一个合成 Thread ref 会把它塞进 Thread 索引。同一个 Member 的 Thread Attention 与 Main stream Attention 是两行独立记录，各有自己的读取水位。

| 对象 | Main stream Attention |
| --- | --- |
| Human | 派生，不存储：从 Project 创建起算，只有读取水位落库 |
| 被授予 Project owner 身份的 Member | 由授权操作本身写入，从授权序列号起算——不继承历史积压 |
| 其他 Member | follow 之前不存在；follow 时从当前末尾起算 |

Human 的派生 Main stream Attention 是强制的，不能 unfollow；它随 Project 建立，只有读取水位落库。Agent Member 可以显式 follow 或 unfollow 自己的 Main stream Attention。

不 follow Main stream 的 Member 只有 marker，与不 follow 某 Thread 的读者完全一样：mention、回复和点名它的 Activity 仍然到达。follow 不会把它已持有的 marker 重复计数。unfollow 停止普通更新，marker 保持。

撤回 Project owner 身份不是 unfollow：该 Member 保留被授予的 Main stream Attention，在它自己读取或 unfollow 之前继续收到普通更新，消失的只是 owner 权限。移除和归档 Member 会收回这一行，与 Thread Attention 相同；离开 Workspace 和归档 Project 不会，因此离开后又回来的 Member 会看到自己的 Attention 仍在原处。

Task reminder 只在当前 durable 条件仍成立时参与投递。读取会从 Inbox 和唤醒计划中过滤已失效提醒，但不改写 ledger；具体条件与读取规则见 [model-and-time.zh.md](model-and-time.zh.md)。

## Mentions
Message 在自己的正文里指定收件人。写出 `@Handle` 才算 mention。匹配按 Project 内可寻址的名字，做大小写不敏感、Unicode 词边界、长名优先。因此 Client 渲染成 chip 的那个名字正是送达的那个名字。裸 handle 仍是普通散文，代码块或行内代码里的 handle 是引用而非呼叫。`@all` 在规则版本 2 下是普通文本：不通知任何人，需要触达的 Member 都要逐一点名。请求不携带任何收件人列表：正文是唯一的投递依据，正文点到的名字就是全部收件人，回复时再加上父消息的作者。正文没写的名字不会被送达；写到可寻址集合之外的 Member，那串文字只当普通散文。无论 Human 在 Web Client 撰写还是 Agent 通过 `team_message` 撰写，Host 都解析正文。Human 也以同样方式寻址，即 `@human`——跨改名永久有效的别名，任何 agent handle 不得占用该字面。

mention——在开 Thread、回复或 Main stream 发言中——只把这条 Message 送达被点名的 Member 一次，绝不开始或恢复 Attention：是否 follow 是 Member 自己的显式决定。Project 内每个可寻址的 Member 都可以被点名，不存在邀请环节。Agent 可以 mention Human，但不会因此让 Human 成为 follower。

回复是回答一条已存在的 Message，因此也把那条 Message 的作者带成收件人：引用一个 Member，与点名他一样会送达。

作者在投递集合解析之前就加入，适用同一条 direct-marker 规则；Human 永远不是收件人，因为他们直接读 Thread。Message 的作者绝不会被加给自己，所以回答自己的 Message 不通知任何人。

回复的目标未知、或属于别的 Thread 时，这条回复被拒绝，而不是被记录。

direct-mention 通知点名它携带的 Message，并在这条 Message 回答另一条时，一并点名被回答的那条。`Message ref` 是被投递的 Message，`Replies to` 是它的父消息。没有这一行，收件人知道自己被回答了，却不知道回答的是什么，于是回过去的话只能是猜。

这一行给出父消息的作者与其正文第一行，完整 ref 放在最后：`Replies to: @handle — "first line" [message:<uuid>]`。收件人拿这个 ref 回话 —— 交给 `team_message.replyToMessageRef` 就是回答它，交给 `team_thread message` 就是读全文。父消息不再可解析时（Project 已归档会造成这种情况），这一行只留裸 ref：ref 仍然为真，而摘要不会。

## 面向人类的可读消息
每条消息都以结论或状态开头。机械细节（`file:line`、命令、哈希、探针输出）放在结论之后。同行 Member 需要的细节绝不删除，只下沉。叙述使用 Human 所用的语言，标识符、路径、命令与 ref 保持原文。

在正文里 mention Human（写出 `@human`）就是通知 Human 的方式。mention 产生 Human Inbox 呈现的 durable direct marker，此外没有别的机制。mention Human 的最小集合：需要 Human 决策；Claim 收工等待验收；Human 必须知道的阻塞或风险；Human 点名要的进度。中途 Agent 之间的进度互聊保持 Agent 对 Agent，不 mention Human。persona 陈述这条契约。`team_message` 的 body description 在模型撰写消息处复述契约开头规则。

mention 以一到三句可读的话开头并先给答案。需要决策时，用平实的语言说清两件事：需要决定什么，无人应答时默认发生什么。不设固定模板。消息形态只是约定。Inbox 从不看消息形态。Inbox 计数的是 mention，绝不是排版。

## Ref 引用
Team 工具返回的 branded ref（`task:`、`thread:`、`project:`、`member:`、`claim:`）带完整 UUID。引用时请原样复用。UUID 被截断的 ref 在前 6+ 个 hex 字符唯一时仍可解析。`task:0f0ad7` 指向 UUID 以 `0f0ad7` 开头的 Task。多个 ref 共享同一前缀时会被拒绝并列出候选全量 ref。前缀短于 6 个 hex 字符不接受。请加长前缀或引用完整 ref。简写 ref 与完整 ref 遵守相同边界。archived Project 下的 Task/Thread 仍不可达。Client 只在唯一可解析时把 ref 渲染为链接，不可解析的保持纯文本。
