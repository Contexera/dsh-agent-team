# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是有界路由索引而非仓库：只装身份与职责、必须每步生效的长期规则、当前在手，以及每个主题簇一行；`notes/` 按需读取、从不注入。成员把索引常态保持在 8 KiB 以内、硬顶 16 KiB——超过硬顶索引整块不再注入，注入块始终自带用量。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill，与 skill 写作归 `member-skill-manager` 同一套路；persona 只常驻「索引必须有界、细节留在它点名的那篇笔记里」这一条，成员首次生成的 `memory.md` 脚手架陈述同样的小节。

## 上下文压力归属
Member 的上下文压力作为策略由引擎端到端持有；Host 把该策略绑到某一个 Member 的读数上，并执行它决定的事。两个预算阈值从该 Member 的 live routed selection 派生——当前 step 已进入 prompt assembly 时取其捕获的 selection，否则取 current selection——经 LLM 服务解析（handoff 预算上限 200K、硬上限 256K，并留安全 reserve）：达到 handoff 预算时，Member 在该 generation 内收到一条结构化压力通知，建议 `context_rollover` rollover——同一 generation 不重复，rollover 后重新武装；达到硬上限时，Host 在转发下一个模型请求前强制一次原地 compaction，无法证明 generation 前进或实测压力下降的 Member 会被 fail closed（拒绝该 step，而不是超限提交）。

Provider context-overflow 失败获得一条有界的 compact-and-retry 序列后再上浮。无法测量窗口的 route 会显式拒绝，绝不静默超限提交。已接受 Task 的自动 compaction 已退役：除 Member 自己的显式选择外，压力策略是唯一的 compaction 触发器。大 context 里隔了很久才到的那一步先交给相关性 judge：judge 判为无关工作的输入被扣住而不是放行，原位投一条换代指令，直到被扣的输入交回。

Memory 不是 authority：它可能过时，不能覆盖 Workspace instructions、direct Human input 或 durable Team facts。Member 只能记录已验证且持久的知识，不得记录 credentials、sensitive data、guesses、chat logs、其他 Members' memory，或 ledger 已拥有的 facts。

## Agent notification boundary
Host 从 durable unread state 派生 Agent notifications，并通过 Agent public safe-boundary API 注入一条有界、合并后的 context message。Idle Agent 会开始一个 turn；running request 或 tool 会在下一个 step boundary 收到 context，且不会被中断。无论何时，durable Inbox 都是 authority：

- Structured direct mention 包含 Message body、sender、Channel、可选 Task overlay、Thread 和 Message ref。
- Task 或 Claim Activity 包含 actor、transition 与受影响的 Task/Thread/Claim refs。Task close 会在结束 Attention 之前为每个受影响 follower 保留 sparse Activity marker，使 terminal state change 在重启后仍可读。
- Ordinary unread Messages 只暴露无正文的 Thread-first route 与 unread count；taskful summaries 可以标出 Task overlay。任何通知都不渲染 revision 或写令牌。Agent 可以直接用 Thread ref 调用 `team_thread.read`；需要 triage 多个 Threads 时仍可使用 `team_inbox`。

Automatic context 最多包含 8 个 Inbox Threads、20 条详细 direct 或 Activity facts、每条 direct Message body 8 KiB、总计 32 KiB。省略内容仍由 `team_inbox` 与 `team_thread` 持久保存并可发现。成功的 Thread read 会同时消费相关 direct/Activity markers 和 ordinary read watermark。

Pending hints 按 Member 合并。Consumed 或 ignored hint 不会再触发 turn，直到后续相关 durable change、resume 或 runtime-error recovery 重置 notification state。Restart/resume 使用同一 durable Inbox check，因此 transient Session queues 不是 authority。这是 at-least-once notification intent，不是 exactly-once model processing；Agent 可能忽略、失败或重复 Team read operation。

对于可恢复的临时 service errors，Host 按 Member 连续 `agent/error` occurrences 计数，而不是按 recovery wakeups 或 error text 计数：前两次 errors 各自在延迟后 wake 一次，第 3 次立即停止自动 recovery，并保留 error 交给 operator。不同 recoverable kinds 不会中断连续 error。只有 clean turn end 会清零，non-recoverable error 会取消 tracking。Recovery notice 自身会合并 continuation 与当前 durable Inbox facts，因此 ordinary Inbox notification 不会覆盖它或追加第二条提示。

Web Client 的 Agent-row menu 提供两个 runtime recovery entrances（都不写 ledger）：有 live session 的 error Member 显示「恢复」，由 Host 向 session 注入 continuation prompt（孤儿 composition 则原地重建）；activation failed 的 Member 显示「重启」，由 Host 重新执行该 Member activation，再次失败时仍以 diagnostic 显示在 sidebar。

历史上的第三个入口「从全新上下文开始」已经移除：Member 现在通过 `context_rollover` 工具自行管理上下文（见八工具协议），Host 侧 clear-context Remote 保留为无可见入口的 hidden migration escape hatch，其 `team/member-session-renewed` operation schema 与 replay validation 保留，旧 ledger 仍可 replay。模型发起的 rollover 期间（ledger 绑定已迁移、新 Session 尚未就绪），Member 状态短暂显示为 unavailable 并带 "context rollover in progress" diagnostic；若该 Member 的 Session 正嵌入右栏，Client 只在旧→新绑定变化且当前页面正是被观察的旧 live Session 时跟随一次到新 Session，归档视图不会跳转。

## Assembled acceptance
`npm run test:browser` 使用 credential-free Harness Web scaffold 验证 public Client 与 Host chain。代表性 trace 会执行默认 taskless top-level Thread、默认关闭的 Human「作为任务」control、Human promotion 与 Host reread、taskless header/Claim gating；还要求 Human 第二次发送确认以邀请未关注的 Agent，验证 Agent durable Inbox 与 explicit read/reply，然后验证 Human Channel 和 Thread state。Desktop、390×844 和 keyboard paths 都属于 assembled acceptance。Page reload 会从 Host projections 读取同一批 facts，然后 journey 离开 Team mode 并确认 ordinary DSH conversation surface 恢复。

Browser storage 仍仅限 navigation 和 Workspace selection。Acceptance trace 不从 local storage 或 Member Session relay text 推导 unread、Attention 或 Thread facts。Agent safe-boundary wake 及三种 notification forms——direct mention、Task/Claim Activity 和无正文 ordinary route——由 `packages/agent-team/tests/member-lifecycle.spec.ts` 中真实 Agent-loop integration tests 单独覆盖；browser replay 不依赖 live provider behavior。
