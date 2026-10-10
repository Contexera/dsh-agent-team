# 八工具协议

[English](tools.md) | 中文

每个成功或被拒绝的 Team tool result 都通过正常 model loop 返回。`context_rollover` 与 `context_checkpoint` 会结束 Agent turn——换窗后不得再接旧代工作，checkpoint 在 checkpoint 所属 turn 结束时 resolve。其余 Team tools 不结束 turn，Agent 自行决定：继续读取、重试、开展项目工作、发送协作更新或结束。

## `team_view`

`team_view` 是 address book：有界的获授权 Channel、顶层 Thread 与 Member 摘要。这是当前的地址簿，不是工作队列。unread work 归 `team_inbox`。Threads 是唯一分页目录。行按 newest-first 排列，携带 threadRef、Channel ref、bounded anchor subject。taskful Threads 在行内呈现 Task standing：Task ref、编号、status/resolution。绝无第二个 Task 索引，也不渲染 revision 或消息数。revision 和消息数都不改变下一个合法动作。

首页 Members 之后跟一个 `active task threads` 段。本 Workspace 内读者获授权 Channel 中所有 in_progress / in_review 的 Task Thread，按最新活动排序。每行携带 threadRef、Channel ref、status、Task 编号。live Claims 上的 Members、bounded anchor subject 与最新活动时刻也在行内。

纳入条件只看 Task 是否活跃，不看读者是否参与。读者未读的 Thread 也不排除。这段独立于 unread 队列，回答「谁已经在做什么」。工具引导在读者遇到 Workspace 意外改动、或准备 claim/commit 之前指向此段，让在途工作被识别为在途而非冲突。这段不是 unread 队列。未读工作仍归 `team_inbox`。

cursor 只延续 Thread 行。continuation 页只渲染 Threads。翻页可达全部获授权的顶层 Threads，含 taskless 与不在首页的 taskful。页脚把 cursor 称为 Thread cursor，说明是否还有更旧的 Thread anchors。

## `team_inbox`

`team_inbox` 返回有 unread work 的 Threads 的有界、无正文 summaries。Direct requests 排在 ordinary unread work 之前，之后按最新相关 sequence 排序。列出结果不改变 read state。header 给出 unread/direct 总数与展示的 Threads 数。有界列表之外仍有未读，header 给出截断结论。每个条目显示精确的 unread/direct 计数、Channel ref 与 taskful 时的 Task standing。这是读者自己的 unread 队列。要看他人在途的工作（无论是否有未读），用 `team_view` 的 active-task-threads 段。页脚把正文阅读与确认指向 `team_thread read`。渲染不携带 revision 与写令牌。当前 read 才是必需的变更基础，并提供令牌。

## `team_thread`

`team_thread` 负责个人 Attention 和 Thread reading。`threadRef` 是 primary identity。`taskRef` 仅是 released Clients 在 taskful Threads 上使用的 compatibility alias。`read` 原子返回一个按 chronology 排列的 unread batch，推进 durable watermark。读者没有 unread 时，read 什么都不推进，不追加 operation，也不携带 receipt。已提交读的相同重试返回该次读的**原 receipt**，画面则取自当前 projection。读从不承诺冻结画面，重试展示的就是此刻的未读。`history` 返回有界的旧 public facts，不改变 read state。`follow` 与 `unfollow` 修改个人 Attention。

五个 action 不共享一个最大化渲染。`status`、`follow`、`unfollow` 只回答 Attention 问题：一行结果携带 Thread ref、可选 Task standing 与 following 状态，没有 timeline。read 先渲染结果：确认与剩余的 unread 计数。再渲染 Thread 身份与 following 状态。再导向：返回 facts 携带 Host 提供的 background，给 full anchor；否则给 bounded anchor subject。anchor 本身在返回 fact 时绝不重复渲染。read 接着只渲染 active Claims：当前 collision surface，每 Claim 一行（claim ref、owner、direction）。然后是带行内 unread/direct 标记、按时间排列的 facts。页脚给出 read-through sequence 与剩余 unread 计数。若这次 read 身后仍留有 Thread facts，再补一句那些 facts 的数量。重返的读者借此看到自己没在看的跨度有多大，不把本次 batch 当成整个 Thread。

history 页渲染历史结果与 Thread 身份。首页给 full anchor，continuation 页给 bounded subject。渲染选中的 facts 与 cursor/hasMore 页脚，绝无当前 Claims 或 advice。每条 activity fact 都是结构化的：actor、Task ref，以及这条 activity claim、完成、接受或 release 的 Claim refs。绝不是裸 kind。当一次 `read` 确认的是一个仍处于 done 状态 Task 的未读验收时，结果附带一段 `contextAdvice`。`contextAdvice` 携带四样东西：读取 Member 的实测用量、当前路由的预算、任务边界阈值 `min(128_000, effective handoffAt)`、唯一动作。唯一动作三选一：保留当前上下文；验收收尾后 fresh rollover；已达 handoff 预算时就地压缩。建议只是推荐。Host 绝不在验收时自动 checkpoint、rollover 或 compact。测量失败降级为显式 `unavailable` 文案，不反转已提交的 read。history 与重复 read 不带建议。

## `team_message`

`team_message.start` 创建 Channel 顶层 Thread。默认 taskless，也接受明确 task intent 以原子创建 Task。`team_message.reply` 向既有 Thread 追加明确的 reply。二者都接受 `attachments` 中的可选 absolute file paths。Host 验证每个 path，把 bytes 复制到 attachment cache。收件人看到 thumbnails/chips 与一行 cached path。任一 path 验证失败都会拒绝整个 send。commit 的 start/reply 渲染一个 committed-verb 结果：Thread created 或 reply added。结果携带 Message ref、新 Thread ref（taskful 时含 Task ref），以及恰好一个 next-write token hand-off。新建 Thread 立即可寻址，下一次变更也拿到了基础。

类型化拒绝结果（`unread_required`、`stale_revision`）以 `Not committed` 开头。保留重读与审慎重试所需的结构化 refs 与计数，不渲染数字 revision 与写令牌。拒绝不携带变化后的事实，不是安全的变更基础。恢复路径是 read-and-reconsider。mention 一个该 Thread 从未承载过的 Member 不是拒绝。Message 照常提交，结果里报告未送达的名字。

`team_message.dm` 向同一 Workspace 内一个 enabled Agent Member 发送私有 direct message。DM 是纯送达。ledger 追加一个 audit-only 的 `team/dm-sent` operation，requestId 幂等。收件人的 live session 以 relay-form 注入的 user message 收到正文。idle 收件人开新 turn，busy 收件人 steer 进当前 turn。DM 不创建 Channel、Thread、revision、Attention 或 Inbox markers，也不唤醒任何 change waiters。Human 不能被 DM。收件人无 live session 或唤醒失败时，operation 保持 durable。发送方收到结构化的 delivery error，而非静默丢失。不做自动重投。DM 只用于快速澄清与状态同步。任务工作、决策和任何需要团队可见或可追溯的内容一律走 Thread。同一对象往来超过约 3 轮应转 Thread，因为每条 DM 消耗收件人一次完整 agent turn。

## `team_claim`

`team_claim` 列出 Claims，并允许 Agent 仅在真实 Task 上创建、完成或 release 自己的 Direction Claims。taskless Threads 没有 Claim mutation path。Direction 是一句说明 Agent 工作角度的话，帮助其他人发现冲突并追踪进展。execution plans 和 acceptance checklists 应写在 Thread messages 中。Claim 成功后会自动开始 Attention。`list` 渲染 Task/Thread 身份与当前 collision surface：只有 active Claims，或显式的空。渲染结果不带写令牌，因为当前 `team_thread read` 仍是必需的变更基础。commit 的 mutation 点名动作（Claim created、completed 或 released）。先渲染权威的受影响 Claim：ref、结果 state、owner、direction。再渲染 Task/Thread 身份，以及恰好一个 next-write token hand-off。

拒绝结果（`unread_required`、`stale_revision`）与 message 拒绝共享同一形式：`Not committed`、本地 refs/计数、先读后重试的恢复路径，且无数字 revision。

## `context_rollover`

`context_rollover` 为调用的 Member 安排一次进入全新上下文的 rollover。Agent 传入私有 `handoff`，及可选 `relatedFiles`。传入 `checkpointRef` 则改为回返到已记录的 checkpoint。`checkpointRef` 在工具与参数两级 description 上做了 copy hardening。普通续代与压力换窗必须省略，只有引用 `context_status` 结果中列为 restorable 的精确 ref 时才提供。绝不合成或猜测。工具只做校验并返回 `status: 'scheduled'`，同时结束当前 turn。工具体本身不做任何 lifecycle 或 Inbox 副作用。

Host 只在成功的 `tool/result` 持久落盘后才反应。Host 等待所属 turn 结束并真正 idle，再提交一个幂等的 `team/member-session-rolled-over` operation。该 operation 是 Member actor，仅限自身。它记录旧/新 Session id、成功的 handoff result sequence 和 trigger，绝不写入 handoff 正文。然后 dispose 旧 Agent、归档旧 Session，再激活一个全新 Session，以 handoff 作为第一份 model-facing context。Member 身份、模型、私有记忆、skills、Claims 和 Attention 全部保留。不带 `checkpointRef` 时新 Session 不继承旧的事件/chunk 历史。带 ref 时以记录 checkpoint 的精确 completed-turn 前缀作 seed。标记为 seeded，继承历史保持惰性。ledger 绝不记录 handoff 正文。意图之后到达的非 Team 输入在新一代恰好投递一次。过期的 Team Inbox notices 被丢弃，并从 ledger 重新派生。

失败或悬空的调用不会安排任何事。已落盘的失败 result 在 projection 中消费配对的 open call。provider 在后续 retry 复用同一 call id，折叠 retry 自己的新参数，绝不命中失败调用的旧参数。带 `checkpointRef` 的回返在 tool 时经过与换窗同一 resolver 的完整当前态 prevalidation。七种 ref 以 model-visible 的 error result 拒绝：伪造、未 resolve、无法归属、不缩减、不可测量、超预算、被多个 active Claim 阻塞。拒绝不返回异步换窗必然失败的假 `scheduled`。可变 guard 集包括 jobs、route limits、lineage 增长，在 lifecycle commit seam 复查。通过 tool 时校验的 rollover 仍可能在 seam 失败，旧代保持可恢复。后续 turn 的显式 fresh rollover 会替换已消耗的 intent 并恢复这个 Member。请求与新 Session 身份由该 Member 绑定的 Session 加 tool call id 稳定派生。因此结果落盘与换窗之间崩溃后重放会收敛到同一代。

Member 持有无法在切换中存活的 jobs 时，rollover 会被拒绝：任何 running/stopping job，以及任何已结束但输出从未上报的 job。拒绝文案点名这些 jobs，并要求先收集或停止。Host 重启落在 rollover 的 durable commit 与新 Session 激活之间，从上一 Session 的 durable intent 重建 handoff。Host 不会把这个 Member 当作空白 Session 对待。即使新 Session 在崩溃前从未落盘，ledger 记录的上一 Session 也是 lineage 来源。重建是幂等的：自身日志已含 handoff 的一代不会再收到第二条。

## `context_checkpoint`

`context_checkpoint` 为调用的 Member 记录一个命名的当前上下文 checkpoint。与 `context_rollover` 一样，工具体不做 lifecycle 副作用。durable checkpoint 就是 Session projection 折叠的成功 `tool/call`+`tool/result` 对。返回的 ref 由 Member Session 身份加 tool call id 确定性派生。模型可以在结果存在前引用。跨代重复的 provider call id 也不会碰撞。checkpoint 在所属 turn 结束时 resolve。模型把它作为一个完整工作单元的最后动作来记录。turn 结束后，Host 调度一条 quiet continuation message，让 Member 朝记录的锚点继续工作。投递跨重启恰好一次。projection 的 delivery record 是 durable 的，已送达 continuation 的 checkpoint 不会被重新调度。

## `context_status`

`context_status` 返回该 Member 跨当前 Session 与已归档祖先 lineage 的上下文代际有界结构视图。视图包括已记录的 checkpoints，以及 handoff、Team-boundary 和 compaction 边界。各自锚定一个已完成 turn，并记录 quiet continuation 是否已送达。每个锚点附带事实已进入 Member 上下文的 Threads。锚点只从已送达的 Session 事实派生，绝不使用未读 ledger activity。

结果同时报告该 Member 相对 handoff 预算与 hard limit 的用量。在该 Member 的 preset 作用域能定价时，结果还报告此刻发起 compaction 会替换多少内容。

工具定义来自引擎（`createContinuityTools`）而非 Team。Team 只提供其背后的 adapter，以及拼进 description 的词汇表。工具面与引擎自己的文案不会各自漂移。

fresh 的 `context_rollover`（不带 `checkpointRef`）从不需要先读 status。status 用于选定 checkpointRef 回返，或确认 fresh handoff 是更好路径。

Team 边界锚定在效果而非推送上。committed 的 `team_message` 里，start 的 Thread 从结果持久化的 presentation meta 归属，reply 从 call arguments 归属。成功的 `team_claim` 变更、成功的 follow/unfollow 各锚定一个边界。label 按动作类别：`Team message`、`Team task claim change`、`Team attention change`。typed rejection（`unread_required`、`stale_revision`）、失败调用、dm、读路径（`team_inbox`、`team_view`、`team_thread read`）从不产边界。推送侧仅锚定每个 Thread 首次送达的通知。保留的「工作刚到手」锚点的 label 是该次送达首次引入的 Thread refs（`First arrival: …`），而非 notice 自身的泛化文案。同 Thread 的后续重发与纯提醒（recovery notice，以及 progress-nudge 系统移除前记录的历史 notice）不产出任何边界。

同时满足两个条件，Team 边界才是可选择的默认 checkpoint。第一，经锚点保留的前缀仍停留在单一 Thread 内：恰好一个 Thread 的事实经锚点进入 Member 上下文。第二，回返能把工作集缩到 handoff 预算之下。Thread 归属来自已送达通知正文、claim 变更经 ledger 解析的 Task overlay、以及 committed 消息调用的 ref。前缀跨多 Thread、或不含任何 Thread 的边界，以 reason 说明。handoff 与 compaction 边界永远不是回返目标：它们关闭的是上下文，不是开启话题。判定依据是保留前缀，而非边界自身的贡献。规则本身是引擎的共享锚点策略，两个界面共用同一次判定；Team 只声明只有自己的词汇能说清的那部分——它的哪些边界类型关闭的是上下文而非话题（`boundaryRestorableFor`）——以及 reason 使用的名词。因此时间线给出的 ref 就是 `context_rollover` 接受的 ref，而不是两份相同规则碰巧一致。默认边界的 ref 带 Session 作用域，连续代际在同一事件 seq 锚定也不会碰撞。仅结构信息，不含任何 transcript 正文。

渲染由引擎负责。对不可返回的行，Team 以不可返回行自身 ref 的短稳定 `anchor` 摘要作答，而不给出 ref 本身。名称与价格相同的行仍可区分，且任何不可选择的行都不会携带可引用的字符串。只有 restorable 行上打印的 `ref` 才能交给 `context_rollover`。带 `checkpointRef` 的 `context_rollover` 调用会把 Member 回返到 checkpointRef 所指 checkpoint 的精确 completed-turn 前缀。seed 是截至 checkpoint 的 `turn/end` 的 durable 前缀，构造上即平衡。子 Session 在 seed 来源处 parent，继承的 checkpoints 保持为惰性历史。子代不会触发继承的 intent。回返在 `context_rollover` 工具 prevalidation 的相同条件下被拒绝：未 resolve、无法实质缩减工作集、超预算，或多个 active Claim（即无法证明回退停留在单一 Thread 内）。每种拒绝情形下，fresh handoff 都是文档化的替代路径。上下文回返只是重读历史，绝不声称回滚外部影响。

seed 成本按来源 Session 自身重放的测量逐节点定价，retained 数值是所保留前缀的真实成本，而非日志的占比——前缀里一次超大的 tool result 就按它本身计价。无法测量成本的来源不可选择，预算无法证明。祖先锚点的 discarded 数值近似为当前代的全部 usage。当某一级祖先无法读取，遍历就在这一级停止。结果携带 `incompleteFrom`：这一级的 id 与失败原因。历史完整到最后一个列出的来源，且可证明在此之外不存在。这只是关于历史的事实，绝不是关于 Member 可用性的事实。

## `context_compact`

`context_compact` 就地缩短调用 Member 的当前代：引擎用一段摘要替换较早历史中的一段。保留调用 Member 最新的工作原文。`context_compact` 绝不切换代际，也绝不回返到锚点。这两件事由 `context_rollover` 负责。

Team 从该 Member 自己的 preset 作用域回答引擎的两个问题。第一，由哪个 compaction 引擎服务。第二，surface 值多少。范围由压力策略读取的同一 meter 定价，因此 compaction 实际替换的内容与 `context_status` 承诺的内容不会互相矛盾。

preset 未挂载 compaction 引擎的 Member 会被告知该能力在此作用域不可用。这绝不是静默 no-op。没有可安全替换内容的上下文会报告未改变。
