# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是有界路由索引，不是仓库。索引只装四样东西：身份与职责、必须每步生效的长期规则、当前在手，以及每个主题簇一行。`notes/` 按需读取，从不注入。Member 把索引常态保持在 8 KiB 以内，硬顶 16 KiB。超过硬顶，索引整块不再注入。注入块始终自带用量说明。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill。skill 写作归 `member-skill-manager`，两套手艺同源。persona 只常驻一条：索引必须有界，细节留在索引点名的那篇笔记里。Member 首次生成的 `memory.md` 脚手架陈述同样的小节。

## 上下文压力归属
Member 的上下文压力是引擎端到端持有的策略。Host 把这份策略绑到某一个 Member 的读数上，执行策略决定的事。两个预算阈值从该 Member 的 live routed selection 派生。当前 step 已进入 prompt assembly，取当前 step 捕获的 selection，否则取 current selection。阈值经 LLM 服务解析：handoff 预算上限 200K，硬上限 256K，另留安全 reserve。达到 handoff 预算，Member 在该 generation 内收到一条结构化压力通知。通知的默认动作是就地 `context_compact`，摘要由 Member 自己写。`context_rollover` 留给「工作已翻页」的情形：同一 generation 内不重复通知，rollover 后重新武装。达到硬上限，Host 在转发下一个模型请求前强制一次原地 compaction。compaction 既无法证明 generation 前进、实测压力也没有下降，Member 会被 fail closed：拒绝该 step，不超限提交。

Provider context-overflow 失败先走一条有界的 compact-and-retry 序列，再上浮。窗口无法测量的 route 会显式拒绝，绝不静默超限提交。已接受 Task 的自动 compaction 已经退役：除 Member 自己的显式选择外，压力策略是唯一的 compaction 触发器。

进入大 context 的那一步如果隔了很久，先交给相关性 judge。judge 判为无关工作的输入会被扣住，不放行。原位置改投一条换代指令，等被扣的输入交回。这个 judge 就是 `jev` 服务。本 bundle 用 Host 行的 `jev.apiKey`（或该行指名的环境变量）自己挂载 `jev` 服务。所以 **key 就是这道门的开关**：行里没有 key，这道门保持关闭。部署自己挂了 `jev` 行，改读部署那一份，绝不重复挂载。

门控的三个阈值属于 Host 行自己的配置：`gate.tokens`、`gate.idleMs`、`gate.judgeTimeoutMs`，每个都可省略。部署在自己 profile 的 `cordis.patch.yml` 里设置这三个阈值。行 id 是 `wowyuarm-agent-team-host`。引擎在每个生效的 step 上读一次：编辑作用于下一个被判断的 step，不需要重启。省略 `tokens` 或 `idleMs`，沿用引擎的默认值。省略 `judgeTimeoutMs`，拿到 Team 自己的预算——判官经网络到达。

截止时间决定已配置的 judge 是否真被听到：一次判断耗时超过 `gate.judgeTimeoutMs`，该步不经门控直接放行。本 bundle 挂载的 judge 拿到的调用预算就是这个截止时间再减一秒。

Memory 不是 authority。Memory 可能过时，不能覆盖 Workspace instructions、direct Human input 或 durable Team facts。Member 只记录已验证且持久的知识。credentials、sensitive data、guesses、chat logs、其他 Member 的 memory，以及 ledger 已拥有的 facts，都不得记录。

## Agent notification boundary
Host 从 durable unread state 派生 Agent notifications。Host 经 Agent public safe-boundary API 注入一条有界、合并后的 context message。Idle Agent 会开始一个 turn。running 的 request 或 tool 在下一个 step boundary 收到 context，不会被中断。任何时候，durable Inbox 都是 authority：

- Structured direct mention 包含 Message body、sender 和 Channel。Task overlay 可选，Thread 和 Message ref 也在其中。
- Task 或 Claim Activity 包含 actor、transition 与受影响的 Task/Thread/Claim refs。Task close 在结束 Attention 之前，为每个受影响的 follower 保留 sparse Activity marker。这个 marker 使 terminal state change 在重启后仍可读。
- Ordinary unread Messages 只暴露无正文的 Thread-first route 与 unread count。taskful summaries 可以标出 Task overlay。任何通知都不渲染 revision 或写令牌。Agent 可以直接用 Thread ref 调用 `team_thread.read`。需要 triage 多个 Threads 时，仍可使用 `team_inbox`。

Automatic context 最多包含 8 个 Inbox Threads，以及 20 条详细 direct 或 Activity facts。每条 direct Message body 8 KiB，总计 32 KiB。省略的内容仍由 `team_inbox` 与 `team_thread` 持久保存，可以发现。一次成功的 Thread read 同时消费相关的 direct/Activity markers 和 ordinary read watermark。

Pending hints 按 Member 合并。Consumed 或 ignored 的 hint 不再触发 turn。后面的 durable change、resume 或 runtime-error recovery 会重置 notification state。重置发生后，hint 才重新触发。Restart/resume 用同一个 durable Inbox check，所以 transient Session queues 不是 authority。这是 at-least-once notification intent，不是 exactly-once model processing。Agent 可能忽略、失败或重复 Team read operation。

对于可恢复的临时 service errors，Host 按 Member 的连续 `agent/error` occurrences 计数。计数依据不是 recovery wakeups 或 error text。前两次 errors 各自在延迟后 wake 一次。第 3 次立即停止自动 recovery，并保留 error 交给 operator。不同 recoverable kinds 不中断连续 error 的计数。只有 clean turn end 清零，non-recoverable error 取消 tracking。Recovery notice 自带合并内容：continuation 与当前 durable Inbox facts。所以 ordinary Inbox notification 不会覆盖 Recovery notice，也不会追加第二条提示。

Web Client 的 Agent-row menu 提供两个 runtime recovery entrances，都不写 ledger。有 live session 的 error Member 显示「恢复」，Host 向 session 注入 continuation prompt。孤儿 composition 原地重建。activation failed 的 Member 显示「重启」，Host 重新执行这个 Member 的 activation。再次失败，仍以 diagnostic 显示在 sidebar。

历史上的第三个入口「从全新上下文开始」已经移除。Member 现在用 `context_rollover` 工具自行管理上下文（见八工具协议）。Host 侧 clear-context Remote 保留为无可见入口的 hidden migration escape hatch。这个 Remote 保留 `team/member-session-renewed` operation schema，replay validation 一并保留。旧 ledger 仍可 replay。模型发起的 rollover 有一段中间态：ledger 绑定已迁移，新 Session 尚未就绪。这段时间内 Member 状态短暂显示为 unavailable。同时带 "context rollover in progress" diagnostic。这个 Member 的 Session 正嵌入右栏时，Client 只跟随一次到新 Session。跟随有两个条件：旧→新绑定发生变化，当前页面正是被观察的旧 live Session。归档视图不会跳转。

## Assembled acceptance
`npm run test:browser` 用 credential-free Harness Web scaffold 验证 public Client 与 Host chain。代表性 trace 执行以下动作：

- 默认 taskless top-level Thread。
- 默认关闭的 Human「作为任务」control。
- Human promotion 与 Host reread。
- taskless header/Claim gating。

trace 还要求 Human 第二次发送，确认邀请未关注的 Agent。然后验证 Agent durable Inbox 与 explicit read/reply，再验证 Human Channel 和 Thread state。Desktop、390×844 和 keyboard paths 都属于 assembled acceptance。Page reload 从 Host projections 读取同一批 facts。journey 最后离开 Team mode，确认 ordinary DSH conversation surface 恢复。

Browser storage 仍仅限 navigation 和 Workspace selection。Acceptance trace 不从 local storage 或 Member Session relay text 推导 unread、Attention 或 Thread facts。真实 Agent-loop integration tests 单独覆盖 Agent safe-boundary wake 及三种 notification forms。测试代码见 `packages/agent-team/tests/member-lifecycle.spec.ts`。三者是 direct mention、Task/Claim Activity、无正文 ordinary route。browser replay 不依赖 live provider behavior。
