# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是有界路由索引，不是仓库。索引只装四样东西：身份与职责、必须每步生效的长期规则、当前在手，以及每个主题簇一行。`notes/` 按需读取，从不注入。Member 把索引常态保持在 8 KiB 以内，硬顶 16 KiB。超过硬顶，索引整块不再注入。注入块始终自带用量说明。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill。skill 写作归 `member-skill-manager`，两套手艺同源。persona 只常驻一条：索引必须有界，细节留在索引点名的那篇笔记里。Member 首次生成的 `memory.md` 脚手架陈述同样的小节。

## Member 上下文注入
Member 每一步的上下文由四个分类块组成：身份、Project ownership、Workspace 参与和私有记忆。每个块都是独立的 surface message；同类的新块在语义上覆盖旧块——旧消息仍留在 Session 日志和 surface 中，直到压缩——没有变化的类别不追加内容。ownership 和参与始终给出完整列表，包括 ownership 撤销为空，以及参与从多个 Workspace 缩为一个。

私有记忆有两种形态。完整索引是基线。`memory.md` 变化后，Member 只收到一条简短提示：先前副本已过时、文件位置和当前预算占用。判断以最新的 memory 事件对照文件当前状态，旧的匹配提示不能掩盖后来的变化。提示不是索引：压缩后只剩提示时，仍会补发最新的完整基线。索引缺失、不可读或超出预算时，说明当前状况及其路径，不再注入内容。

## 上下文生命周期归属
Member 的上下文只有两个机制，且都不由模型发起。

**就地压缩。** preset 挂载 `member-compaction-engine`，它是 Harness `BasicCompactionEngine` 的薄适配层。Team 负责主动请求准入；父类提供摘要模板、工具配对安全切分、持久化事务与 overflow 重试。压缩不换代，也不删除原始日志。

输入触发线是 `floor(min(B, W × 0.8, W − 16384))`，`B` 为 `memberCompaction.tokens`（默认 256000），`W` 为路由窗口。窗口未声明时仍执行绝对预算。1M、2M 模型在 256000 触发，272000 模型在 217600 触发。触发线不扣模型最大输出。准入前计入待发送消息、本次工具声明与 system prompt 增量。

这个计数取上一次请求的 provider 自报 prompt 数，加上此后本 surface 的增量，再补上本步声明而那次请求没有的工具集。只有在没有可比请求时才回落到 meter 的固定密度启发式：失败或中止的尝试会留下 header 却没有 usage，所以计数所属的那份 header 从日志里解析，而不是直接取最新的一份。只按启发式计价会把长 Session 算得远低于 provider 的计数，触发线要等窗口已经用光之后才到。

`memberCompaction` 是 Host 行上的 volatile 配置组（`enabled`、`tokens`）。Team 设置页在「上下文」下只编辑 `tokens`，经共享的配置表单读写：字段按容量书写（`256K`、`1M`），留空则清除覆盖，让这一组回落到组合层与它的 256000 默认值。写入点名 `memberCompaction.tokens` 这条子路径，兄弟 `enabled` 开关不受影响。

输入达到触发线后，Team 先裁剪工具结果，必要时请求一次上游强制缩减。这条路径的原文保留预算为零，不再保留大窗口的 0.16；上游仍可能保留最近的完整消息组。摘要输出独立设为 32768，按模型的策略可以另设。

这份摘要由谁写，在调用前就已选定。显式配置的 `summarizationProvider`/`summarizationModel` 优先，写在哪条路由的策略上都一样；否则当步骤自己的固定路由所指模型能把「这次调用自己的重放输入＋它之后追加的指令＋该路由解析出的摘要上限」严格放进窗口时用它——量的是这次调用的输入而不是整个 Session，所以窗口更小的路由仍能写它读得下的那部分——做不到则用上一次请求提交的路由。步骤自己的路由上若有显式目标，则该目标优先于这条路由的窗口——路由只是它被配置的键。步骤路由取自 `agent/pre-step.modelSelection`，只在那个步骤内有效——同一步的重试与 overflow 恢复仍读得到，之后的手动 `/compact` 读不到——并在步骤结束、被拒绝或抛错时清除。请求路由偏离它时，在写出任何摘要之前就拒绝。

一次失败最多再多付一次摘要，而且只在选中的是步骤自己的路由时才补：写在全局或 committed 路由上的目标是 operator 的固定决定，失败即开路，不换成对话模型；因此一步最多两次自动摘要，无论有多少入口为它计价——失败之后该路由的自动摘要整体暂停，后续轮次不再花费，直到路由或摘要配置改变、或手动 `/compact` 成功。再往后本轮不再写 checkpoint 而是继续，失败的尝试以带错误的 `compaction/end` 留在日志里，所以写不出摘要的成员不会被困住。该路由随后被搁置——后续准入直接放行、不再摘要，直到路由或摘要配置改变、或手动 `/compact` 成功——而真实窗口装不下的输入仍会明确结束 turn。没有摘要失败、只是缩减后仍高于触发线时，同样明确结束 turn。

每次请求的输出额度最多为 `W − 估算输入 − 4096`，不会提高原有额度。实际值写入 request header；解析下一次额度前会移除临时缩减，恢复的 loop 则从声明的 options 开始。输入计价仍是估算，因此保留 provider overflow 恢复。

取消沿用 Agent 的 stop/dispose 语义；只有预算失败会恢复尚未准入的输入。窗口小到容不下 context 预留加最小输出额度（不满 20480 token）时，策略无法自洽，会直接退出，请求交给 Agent 自身的限制。

这是触发线，不是物理上限：工具结果可在下一次请求前越线。`memberCompaction.enabled: false` 恢复上游压力判定，包括输出预留、headroom 与尾部保留策略。适配层只挂在 Team preset，普通 Session 不变。

**换代。** 换代是 Host 在唤醒边界做出的决定，由 Team 自己的协调器（`team-context-management.ts`）执行。它以 Host actor 提交 `team/member-session-recycled`，退役旧 Session（dispose 并归档，绝不删除），再激活一代新的、lineage parent 指向被替换的那一代，随后从 ledger 重导出 Inbox。

新代的身份从被退役的 Session 派生，所以 commit 与激活之间重启会补完同一次换代，而不是另造一代。旧日志里的 pending 意图或 checkpoint 锚点只为 legacy 恢复而读；当前构建不再写其中任何一种。

常规换代只有一个触发点：一次指向 idle Member 的唤醒，无论是通知、DM，还是启动或恢复时的 activation。判定是严格的——这一代必须已经 idle 超过 60 分钟，且实测 context 超过 128000 token——而任何无法确立的事实都答 resume。那是保守的那一侧，因为不该发生的换代会让 Member 丢掉工作轨迹。

`wakeRecycle` 是 Host 行上一个 volatile 配置组（`enabled`、`idleMs`、`minContextTokens`）；Team 设置页不为它渲染表单，`enabled: false` 关掉换代。

冷路径从存储判断，不靠 live Agent：存储中的 Session 由自己的日志重建后看 inbox，里面有 pending 的普通消息就保留那一代、不换代；live 的那一代则在计价前先问自己的队列。

还持有未处理普通非 Team 输入的一代保持连续性。只要还有普通消息在排队，换代就不启动。过了那一关，commit 在 `agent.runMaintenance` 内执行，换窗中途到达的消息留在 durable inbox，不会落到正在退役的那一代；退役中的一代 reject 后续 step，不花一次模型请求。输入即使已经被 claim，最初的 inbox 插入记录仍可用于重放。

跨代的只是已记录边界及其之后的 inbox 输入，以 Message id 传递：重放以此为界，按新代已持有的消息去重，不是一般性的工作上下文搬运。

换代不给新代留下任何提示。新代第一眼看到的，就是每次 turn 都有的常规分类注入——身份、Project ownership、Workspace 参与与私有记忆——加上唤醒它的那条消息。跨代连续性不是一份简报，而是工作过程中持续维护的 `memory.md`，之后自然读回。

两个机制都由 Host 掌控，所以模型完全没有 context 工具：没有 rollover、没有 checkpoint、没有 status，read 上也不附带任何建议。Member 说什么都不能启动、阻止或改变一次换代。

## Agent notification boundary
Host 从 durable unread state 派生 Agent notifications。Host 经 Agent public safe-boundary API 注入一条有界、合并后的 context message。Idle Agent 会开始一个 turn。running 的 request 或 tool 在下一个 step boundary 收到 context，不会被中断。任何时候，durable Inbox 都是 authority：

- Structured direct mention 包含 Message body、sender 和 Project。Task overlay 可选，Thread 和 Message ref 也在其中。
- Direct Task 或 Claim Activity 包含 actor、transition 与受影响的 Task/Thread/Claim refs。Task close 在结束 Attention 之前，为每个受影响的 follower 保留 sparse Activity marker。这个 marker 使 terminal state change 在重启后仍可读。
- Ordinary unread 暴露 Thread-first route、unread count、最多三条最新摘要和更早条目的溢出数量。taskful summaries 可以标出 Task overlay。摘要不绑定完整 Message 或 Activity。任何通知都不渲染 revision 或写令牌。Agent 可以直接用 Thread ref 调用 `team_thread.read`。需要 triage 多个 Threads 时，仍可使用 `team_inbox`。

Member reminder 的 occurrence 只带 note 与 reminderRef：note 是这个 Member 被打断的原因，ref 是 `team_reminder list` 与 `cancel` 读取的那个身份。

未提供的 direct 信号排在 reminder 与普通摘要之前。[attention-and-messaging.zh.md](attention-and-messaging.zh.md) 负责通知的排序、上限和字符预算。

Pending hints 按 Member 合并。Consumed 或 ignored 的 hint 不再触发 turn。后面的 durable change、resume 或 runtime-error recovery 会重置 notification state。重置发生后，hint 才重新触发。Restart/resume 用同一个 durable Inbox check，所以 transient Session queues 不是 authority。这是 at-least-once notification intent，不是 exactly-once model processing。Agent 可能忽略、失败或重复 Team read operation。

对于可恢复的临时 service errors，Host 按 Member 的连续 `agent/error` occurrences 计数。计数依据不是 recovery wakeups 或 error text。前两次 errors 各自在延迟后 wake 一次。第 3 次立即停止自动 recovery，并保留 error 交给 operator。不同 recoverable kinds 不中断连续 error 的计数。只有 clean turn end 清零，non-recoverable error 取消 tracking。Recovery notice 自带合并内容：continuation 与当前 durable Inbox facts。所以 ordinary Inbox notification 不会覆盖 Recovery notice，也不会追加第二条提示。

每次投递与恢复决定都通过 Host logger 留下一行有界记录：Inbox 唤醒写明 Member id、Session、引发它的 requestId 与 operationId，以及本次执行尝试，并说明已排队的通知尚未被模型读取。未读事实未变时不消耗新的执行尝试，也不产生诊断级别以上的行。投递失败记 warn，业务提交仍是最终结果，同时清除签名，让下一次触及该 Member 的提交重新派生同样的未读事实；自动恢复记录其分类、次数、等待、触发、停止与跟踪结束的原因。

手动控制 Member 上下文已经不存在：没有 row action，也没有 Remote 写入口能开一代新的。ledger 保留较早的 transition kind（`team/member-session-renewed`、`team/member-session-rolled-over`）以便已记录的 ledger 仍可 replay，但没有任何代码再写它们。

换代有一段中间态：ledger 绑定已迁移，新 Session 尚未激活。这段时间内 Member 状态显示为 unavailable，并带 "context rollover in progress" diagnostic。这个 Member 的 Session 正嵌入右栏时，Client 只跟随一次到新 Session。归档视图不会跳转。

**验收边界。** 一次 Thread read 若 ack 了某个 Task 的验收，会给读者自己的边界，但只在这次验收结束的是读者自己名下的工作时才触发——它自己的 Claim，或它作为 accountable 的 Task；只是关注该 Thread 的观察者同样会看到这条 unread accept，Host 不会打扰它。提交这次 accept 的 Member 不必再读一次也能拿到同一边界：验收者结构上永远不持有 read 侧所依据的 Claim。

Host 把一条 `<system-reminder>` steer 进发现或提交这次验收的那个 turn，要求 Member 把持久结论写进 `memory.md` 索引及其指向的 note；提醒会点明它当时的身份（contributed／accountable／accepted）。实测 context 达到或超过 128000 token 时，同一边界还会在 Agent 空闲后压缩当前代：验收通常发生在 turn 中，而引擎只压缩空闲 Agent。

边界不传递任何东西，既没有 handoff 也没有公告，所以提醒只在真会发生时陈述后果；preset 未挂载压缩引擎时，提醒不会声称会压缩。

## Assembled acceptance
`npm run test:browser` 用 credential-free Harness Web scaffold 验证 public Client 与 Host chain。代表性 trace 执行以下动作：

- 默认 taskless top-level Thread。
- 默认关闭的 Human「作为任务」control。
- Human promotion 与 Host reread。
- taskless header/Claim gating。
- Human 对 Thread 的 follow/unfollow：显示以 Host observation 为准。
- Human 把 Task 转交给该 Thread 的 follower，以及转交给 Human 自己，含负责人已失去 Project ownership 的已结束 Task 的补回。
- 上面两条既被驱动也被量：所有动作控件同处一条带，高度、圆角、内距、描边与步距各只有一个值；follow 控件的两种状态差的是底色而不是标签。

trace 还要求 Human 写入一条版本 2 的 mention，确认它直接送达、没有邀请确认环节。然后验证 Agent durable Inbox 与 explicit read/reply，再验证 Human Project 和 Thread state。Desktop、390×844 和 keyboard paths 都属于 assembled acceptance。Page reload 从 Host projections 读取同一批 facts。journey 最后离开 Team mode，确认 ordinary DSH conversation surface 恢复。

Browser storage 仍仅限 navigation 和 Workspace selection。Acceptance trace 不从 local storage 或 Member Session relay text 推导 unread、Attention 或 Thread facts。真实 Agent-loop integration tests 覆盖 Agent safe-boundary wake 及三种 notification forms。测试代码见 `packages/agent-team/tests/member-lifecycle.spec.ts`。包括 direct mention、Task/Claim Activity、ordinary digest route。browser replay 不依赖 live provider behavior。

Worker 订阅场景把模型回放接入真实 Agent loop：定时发布唤醒 owner，owner 通过已声明的 `team_worker` 发起两次绑定执行。Human 的定向回复让 owner 只停其中一次，读取原 Thread 的已确认结算，并在另一条仍运行时继续回答。只有模型和 Codex 可执行文件是替身；设置、通知投递、工具执行与普通 DSH 恢复都走真实组合。发布版 CLI 探针另行验证原生引擎行为；回放不能证明模型判断或原生追加指令能力。
