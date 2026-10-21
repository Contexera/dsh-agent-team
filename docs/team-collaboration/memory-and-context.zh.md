# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是有界路由索引，不是仓库。索引只装四样东西：身份与职责、必须每步生效的长期规则、当前在手，以及每个主题簇一行。`notes/` 按需读取，从不注入。Member 把索引常态保持在 8 KiB 以内，硬顶 16 KiB。超过硬顶，索引整块不再注入。注入块始终自带用量说明。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill。skill 写作归 `member-skill-manager`，两套手艺同源。persona 只常驻一条：索引必须有界，细节留在索引点名的那篇笔记里。Member 首次生成的 `memory.md` 脚手架陈述同样的小节。

## 上下文生命周期归属
Member 的上下文只有两个机制，且都不由模型发起。

**就地压缩。** preset 挂的是 Harness 自己的 `@deepseek-ai/dsh-compaction-basic`，不做改动，`auto` 打开，配 Team 的比例：`thresholdRatio` 0.256、`retainRatio` 0.08、`headroomTokens` 65536。摘要模板、routed summarization target 与上限都保持上游的。压缩绝不换代，也绝不取消 owner。

Team 配的是比例，不是固定窗口：触发线是 `min(W × 0.256, W − output − 65536)`（`W` 为窗口 token 数），`retainRatio` 0.08 把消息预算的这个份额留作原文尾部。只有当剩余容量更大时比例才是生效的那一项——1M 窗口上阈值就是 256K，尾部保留约 7 万——更小的窗口、或为输出预留很多的窗口，按更低的那条值压缩。部署方用自己的其他模型时，在 profile 层加 per-model `modelPolicies` 来守住自己的水位线；bundle 不假设任何窗口大小。

**换代。** 换代是 Host 在唤醒边界做出的决定，由 Team 自己的协调器（`team-context-management.ts`）执行。它以 Host actor 提交 `team/member-session-recycled`，退役旧 Session（dispose 并归档，绝不删除），再激活一代新的、lineage parent 指向被替换的那一代，随后从 ledger 重导出 Inbox。

新代的身份从被退役的 Session 派生，所以 commit 与激活之间重启会补完同一次换代，而不是另造一代。旧日志里的 pending 意图或 checkpoint 锚点只为 legacy 恢复而读；当前构建不再写其中任何一种。

常规换代只有一个触发点：一次指向 idle Member 的唤醒，无论是通知、DM，还是启动或恢复时的 activation。判定是严格的——这一代必须已经 idle 超过 60 分钟，且实测 context 超过 128000 token——而任何无法确立的事实都答 resume。那是保守的那一侧，因为不该发生的换代会让 Member 丢掉工作轨迹。

`wakeRecycle` 是 Host 行上一个 volatile 配置组（`enabled`、`idleMs`、`minContextTokens`）；Team 设置页不为它渲染表单，`enabled: false` 关掉换代。

冷路径从存储判断，不靠 live Agent：存储中的 Session 由自己的日志重建后看 inbox，里面有 pending 的普通消息就保留那一代、不换代；live 的那一代则在计价前先问自己的队列。

还持有未处理普通非 Team 输入的一代保持连续性。只要还有普通消息在排队，换代就不启动。过了那一关，commit 在 `agent.runMaintenance` 内执行，换窗中途到达的消息留在 durable inbox，不会落到正在退役的那一代；退役中的一代 reject 后续 step，不花一次模型请求。输入即使已经被 claim，最初的 inbox 插入记录仍可用于重放。

跨代的只是已记录边界及其之后的 inbox 输入，以 Message id 传递：重放以此为界，按新代已持有的消息去重，不是一般性的工作上下文搬运。

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

手动控制 Member 上下文已经不存在：没有 row action，也没有 Remote 写入口能开一代新的。ledger 保留较早的 transition kind（`team/member-session-renewed`、`team/member-session-rolled-over`）以便已记录的 ledger 仍可 replay，但没有任何代码再写它们。

换代有一段中间态：ledger 绑定已迁移，新 Session 尚未激活。这段时间内 Member 状态显示为 unavailable，并带 "context rollover in progress" diagnostic。这个 Member 的 Session 正嵌入右栏时，Client 只跟随一次到新 Session。归档视图不会跳转。

## Assembled acceptance
`npm run test:browser` 用 credential-free Harness Web scaffold 验证 public Client 与 Host chain。代表性 trace 执行以下动作：

- 默认 taskless top-level Thread。
- 默认关闭的 Human「作为任务」control。
- Human promotion 与 Host reread。
- taskless header/Claim gating。

trace 还要求 Human 第二次发送，确认邀请未关注的 Agent。然后验证 Agent durable Inbox 与 explicit read/reply，再验证 Human Channel 和 Thread state。Desktop、390×844 和 keyboard paths 都属于 assembled acceptance。Page reload 从 Host projections 读取同一批 facts。journey 最后离开 Team mode，确认 ordinary DSH conversation surface 恢复。

Browser storage 仍仅限 navigation 和 Workspace selection。Acceptance trace 不从 local storage 或 Member Session relay text 推导 unread、Attention 或 Thread facts。真实 Agent-loop integration tests 单独覆盖 Agent safe-boundary wake 及三种 notification forms。测试代码见 `packages/agent-team/tests/member-lifecycle.spec.ts`。三者是 direct mention、Task/Claim Activity、无正文 ordinary route。browser replay 不依赖 live provider behavior。
