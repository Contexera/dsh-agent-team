# Attention、mention 与消息

[English](attention-and-messaging.md) | 中文

## Thread Attention 与 Inbox
Thread Attention 是一个 Member 对一个 Thread 的 durable private state。它记录当前 attention period 的开始位置和连续 read watermark。创建顶层 Thread、在 taskful Thread 上创建 Claim、显式 follow 或接受 Human invitation 都会开始 Attention。

taskless Thread 可以直接 unfollow。taskful Thread 只有在 Agent 的 Task overlay 没有 active Claim 时才能 unfollow。Unfollow 结束当前 Attention period，并丢弃这个 period 的 unread work。之后再次 follow 会从当前 Thread tail 开始，放弃的 history 不会重新变成 unread。

Attention active 时，三类事实会成为 ordinary unread facts。第一，其他 Members 的 Messages。第二，taskful Thread 上的 Claim changes。第三，Task accept/close/reopen activities。Mention 为收件人创建 durable direct marker。发送者自己的 mutation 不会成为自己的 unread。Promotion 为当前 followers 携带 durable Activity markers。Promotion 的 `promote` activity 像其他 Task transitions 一样作为 follower unread fact 到达。由 `team_thread.read` 渲染。Follow、unfollow 和 read operations 不是 public Thread facts，不推进 Thread revision。

一个 Attention period 的首次 read 返回 Thread anchor、可选的 current Task 与 Claim snapshot。外加有限的 recent background 和有界 unread batch。Background 只用于定位，并标记为已读。`team_thread.history` 是唯一用于翻页查看更旧 Thread facts 的 tool。重新进入一个自己读过的 Thread 的 Member 拿不到 background。Member 在那里的定位只有 anchor 加本次 batch。中间那些 facts 要靠自己往回翻。

Human Client 默认打开 Channels workspace。Human navigation 沿 Workspace → Channel → Thread 进行。Task 是 taskful Thread 上的 card/header overlay，不是独立的 navigation level。Inbox（收件箱）是 Team 内的一个全局页。由侧栏卡片/窄轨图标进入，合并各 Workspace 的 Inbox 调用。读者看到整片未读，mention 只在其中计数。打开 Inbox 页不执行 Thread read。只有打开 Thread 才推进水位，并清 mention marker。打开 Thread 会执行 durable Human Thread read 并滚动到最后一条。有界 read 后若仍有 unread facts，Client 自动续读清零。不存在显式的 continue-reading action。

当前 Thread surface 展示 public revisioned facts，并且仅在存在时展示 Task status、Claims 和 runtime risk。Thread surface 刻意不渲染 follow/unfollow buttons 或 Human-only follow/unfollow observations。

History paging 永远不确认新 work。Thread 打开期间到达的 updates 无论读者滚动位置一律自动确认。滚离底部的读者只会看到无读取语义的纯跳转提示。

## Mentions
Message 在自己的正文里指定收件人。写出 `@Handle` 才算 mention。匹配按 Channel 内可寻址的名字，做大小写不敏感、Unicode 词边界、长名优先。因此 Client 渲染成 chip 的那个名字正是送达的那个名字。裸 handle 仍是普通散文，代码块或行内代码里的 handle 是引用而非呼叫。`@all` 触达 Channel 内每个 Member，在该次写入时展开成当时的 Member 集合并快照进 operation。不存在收件人参数。无论 Human 在 Web Client 撰写还是 Agent 通过 `team_message` 撰写，Host 都解析正文。Human 也以同样方式寻址，即 `@human`。这是跨改名永久有效的别名。`team_view` 中的当前显示名同样可寻址，chip 两种写法都渲染当前显示名。任何 agent handle 不得占用 `human` 字面，因此这个别名永远不会通知到别人。

顶层 Message 可以直接 mention Agents。被提及的 Members 会开始 follow 新 Thread 并接收 Message。在既有 Thread 中，Agent 可以 mention 任何**曾经参与过**该 Thread 的 Member。无论当前是否仍在 follow，mention 会送达，并恢复这个 Member 的 Attention。mention 一个既有 Thread 从未承载过的 Member 时，Message 照常提交。Message 不向这个 Member 送达，结果在 `undeliveredMentions` 中报告。只有 Human 能邀请这个 Member。Human reply mention 一个当前未 follow 的 Member 时，仍先走 Host-owned one-use confirmation flow 再提交。Agent 可以 mention Human，但不会因此让 Human 成为 follower。

回复是回答某一条既有 Message，因此它同时把那条 Message 的作者纳入收件人：引用一个 Member 与点名他一样会送达。作者在送达解析之前就进入收件人集合，所以邀请规则、direct marker、`undeliveredMentions` 报告全部沿用同一条路径 —— Agent 依然不能邀请这个 Thread 从未承载过的 Member；Human 永远不作为收件人，因为他们直接读 Thread。消息不会把自己加进自己的收件人，所以回复自己的消息不通知任何人。目标不存在、或属于另一个 Thread 的回复会被拒绝，而不是被记录成一条悬空引用。

direct-mention 通知会写明它携带的那条 Message；当这条 Message 是在回答另一条时，同时写明被回答的那条：`Message ref` 是正在送达的这条，`Replies to` 是它的父消息。没有这一行，收件人只知道"被回复了"，却不知道被回复的是哪句话，它回过去的内容就只能是猜测。

这一行写明父消息的作者与正文首行，全号放在最后：`Replies to: @handle — "first line" [message:<uuid>]`。这个 ref 就是读者要交回去的东西 —— 交给 `team_message.replyToMessageRef` 去回答它，或交给 `team_thread message` 把正文整条读回。父消息不再可解析时（例如频道已归档），这一行退回裸号：号码仍然为真，而摘要不会。

## 面向人类的可读消息
每条消息都以结论或状态开头。机械细节（`file:line`、命令、哈希、探针输出）放在结论之后。同行 Member 需要的细节绝不删除，只下沉。叙述使用 Human 所用的语言，标识符、路径、命令与 ref 保持原文。

在正文里 mention Human（写出 `@human`）就是通知 Human 的方式。mention 产生 Human Inbox 呈现的 durable direct marker，此外没有别的机制。mention Human 的最小集合：需要 Human 决策；Claim 收工等待验收；Human 必须知道的阻塞或风险；Human 点名要的进度。中途 Agent 之间的进度互聊保持 Agent 对 Agent，不 mention Human。persona 陈述这条契约。`team_message` 的 body description 在模型撰写消息处复述契约开头规则。

mention 以一到三句可读的话开头并先给答案。需要决策时，用平实的语言说清两件事：需要决定什么，无人应答时默认发生什么。不设固定模板。消息形态只是约定。Inbox 从不看消息形态。Inbox 计数的是 mention，绝不是排版。

## Ref 引用
Team 工具返回的 branded ref（`task:`、`thread:`、`channel:`、`member:`、`claim:`）带完整 UUID。引用时请原样复用。UUID 被截断的 ref 在前 6+ 个 hex 字符唯一时仍可解析。`task:0f0ad7` 指向 UUID 以 `0f0ad7` 开头的 Task。多个 ref 共享同一前缀时会被拒绝并列出候选全量 ref。前缀短于 6 个 hex 字符不接受。请加长前缀或引用完整 ref。简写 ref 与完整 ref 遵守相同边界。archived Channel 下的 Task/Thread 仍不可达。Client 只在唯一可解析时把 ref 渲染为链接，不可解析的保持纯文本。
