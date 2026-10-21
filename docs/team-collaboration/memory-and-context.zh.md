# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是有界路由索引，不是仓库。索引只装四样东西：身份与职责、必须每步生效的长期规则、当前在手，以及每个主题簇一行。`notes/` 按需读取，从不注入。Member 把索引常态保持在 8 KiB 以内，硬顶 16 KiB。超过硬顶，索引整块不再注入。注入块始终自带用量说明。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill。skill 写作归 `member-skill-manager`，两套手艺同源。persona 只常驻一条：索引必须有界，细节留在索引点名的那篇笔记里。Member 首次生成的 `memory.md` 脚手架陈述同样的小节。

## 上下文生命周期归属
Member 的上下文只有两个机制，且都不由模型发起。

**就地压缩。** preset 挂的是本 bundle 的 `team-compaction-engine`，一个 `BasicCompactionEngine` 子类，唯一差别是摘要模板：7 节按「后继者无法重建的东西」排序，所以摘要只点名文件、说明为什么重要，而不复述内容；同时写清有谁在等这件事。`auto` 打开，1M window 上触发比 0.256（即 256K 水位线），`modelPolicies` 让别的窗口落在同一水位；`retainRatio` 0.08 保留约 7 万 token 的原文尾部，于是一次压缩清掉约 18 万，而不是每隔一步就压。压缩绝不换代，也绝不取消 owner。

**换代。** 换代是 Host 的决定，由 Team 自己的协调器（`team-context-management.ts`）在真正 idle 的边界执行：它自己记录这次迁移（`team/member-session-recycled`，Host actor），退役旧 Session（dispose 并归档，绝不删除），再激活一代新的、lineage parent 指向被替换的那一代。携带的非 Team 输入作为独立 turn 跟随，随后从 ledger 重导出 Inbox。协调器响应 Member Session 里 durable 的 pending 意图，因此 commit 与激活之间重启会补完欠下的换窗；旧日志里所属 turn 从未 durable 结束的意图视为 spent 直接丢弃，不会让该代永久无法换窗。

换代不给新代留下任何提示。新代第一眼看到的，就是每次 turn 都有的常规注入——身份、`memory.md`、Workspace 列表——加上唤醒它的那条消息。跨代连续性不是一份简报，而是工作过程中持续维护的 `memory.md`，之后自然读回。

两个机制都由 Host 掌控，所以模型完全没有 context 工具：没有 rollover、没有 checkpoint、没有 status，read 上也不附带任何建议。Member 说什么都不能启动、阻止或改变一次换代。

## Agent notification boundary
Host 从 durable unread state 派生 Agent notifications。Host 经 Agent public safe-boundary API 注入一条有界、合并后的 context message。Idle Agent 会开始一个 turn。running 的 request 或 tool 在下一个 step boundary 收到 context，不会被中断。任何时候，durable Inbox 都是 authority：

- Structured direct mention 包含 Message body、sender 和 Channel。Task overlay 可选，Thread 和 Message ref 也在其中。
- Task 或 Claim Activity 包含 actor、transition 与受影响的 Task/Thread/Claim refs。Task close 在结束 Attention 之前，为每个受影响的 follower 保留 sparse Activity marker。这个 marker 使 terminal state change 在重启后仍可读。
- Ordinary unread Messages 只暴露无正文的 Thread-first route 与 unread count。taskful summaries 可以标出 Task overlay。任何通知都不渲染 revision 或写令牌。Agent 可以直接用 Thread ref 调用 `team_thread.read`。需要 triage 多个 Threads 时，仍可使用 `team_inbox`。

Automatic context 最多包含 8 个 Inbox Threads，以及 20 条详细 direct 或 Activity facts。每条 direct Message body 8 KiB，总计 32 KiB。省略的内容仍由 `team_inbox` 与 `team_thread` 持久保存，可以发现。一次成功的 Thread read 同时消费相关的 direct/Activity markers 和 ordinary read watermark。

Pending hints 按 Member 合并。Consumed 或 ignored 的 hint 不再触发 turn。后面的 durable change、resume 或 runtime-error recovery 会重置 notification state。重置发生后，hint 才重新触发。Restart/resume 用同一个 durable Inbox check，所以 transient Session queues 不是 authority。这是 at-least-once notification intent，不是 exactly-once model processing。Agent 可能忽略、失败或重复 Team read operation。

对于可恢复的临时 service errors，Host 按 Member 的连续 `agent/error` occurrences 计数。计数依据不是 recovery wakeups 或 error text。前两次 errors 各自在延迟后 wake 一次。第 3 次立即停止自动 recovery，并保留 error 交给 operator。不同 recoverable kinds 不中断连续 error 的计数。只有 clean turn end 清零，non-recoverable error 取消 tracking。Recovery notice 自带合并内容：continuation 与当前 durable Inbox facts。所以 ordinary Inbox notification 不会覆盖 Recovery notice，也不会追加第二条提示。

每次投递与恢复决定都通过 Host logger 留下一行有界记录：Inbox 唤醒写明 Member id、Session、引发它的 requestId 与 operationId，以及本次执行尝试，并说明已排队的通知尚未被模型读取。未读事实未变时不消耗新的执行尝试，也不产生诊断级别以上的行。投递失败记 warn，业务提交仍是最终结果，同时清除签名，让下一次触及该 Member 的提交重新派生同样的未读事实；自动恢复记录其分类、次数、等待、触发、停止与跟踪结束的原因。

Web Client 的 Agent-row menu 提供两个 runtime recovery entrances，都不写 ledger。有 live session 的 error Member 显示「恢复」，Host 向 session 注入 continuation prompt。孤儿 composition 原地重建。activation failed 的 Member 显示「重启」，Host 重新执行这个 Member 的 activation。再次失败，仍以 diagnostic 显示在 sidebar。

历史上的第三个入口「从全新上下文开始」已经移除：Host 在唤醒边界换代。Host 侧 clear-context Remote 保留为无可见入口的 hidden migration escape hatch。这个 Remote 保留 `team/member-session-renewed` operation schema，replay validation 一并保留。旧 ledger 仍可 replay。换代有一段中间态：ledger 绑定已迁移，新 Session 尚未激活。这段时间内 Member 状态短暂显示为 unavailable。同时带 "context rollover in progress" diagnostic。这个 Member 的 Session 正嵌入右栏时，Client 只跟随一次到新 Session。跟随有两个条件：旧→新绑定发生变化，当前页面正是被观察的旧 live Session。归档视图不会跳转。

## Assembled acceptance
`npm run test:browser` 用 credential-free Harness Web scaffold 验证 public Client 与 Host chain。代表性 trace 执行以下动作：

- 默认 taskless top-level Thread。
- 默认关闭的 Human「作为任务」control。
- Human promotion 与 Host reread。
- taskless header/Claim gating。

trace 还要求 Human 第二次发送，确认邀请未关注的 Agent。然后验证 Agent durable Inbox 与 explicit read/reply，再验证 Human Channel 和 Thread state。Desktop、390×844 和 keyboard paths 都属于 assembled acceptance。Page reload 从 Host projections 读取同一批 facts。journey 最后离开 Team mode，确认 ordinary DSH conversation surface 恢复。

Browser storage 仍仅限 navigation 和 Workspace selection。Acceptance trace 不从 local storage 或 Member Session relay text 推导 unread、Attention 或 Thread facts。真实 Agent-loop integration tests 单独覆盖 Agent safe-boundary wake 及三种 notification forms。测试代码见 `packages/agent-team/tests/member-lifecycle.spec.ts`。三者是 direct mention、Task/Claim Activity、无正文 ordinary route。browser replay 不依赖 live provider behavior。
