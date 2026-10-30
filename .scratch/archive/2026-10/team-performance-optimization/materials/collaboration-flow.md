# dsh-agent-team 协作流程端到端性能研究

**状态：** 只读调研，未改生产代码。

**检查日期：** 2026-10-28。

**代码基线：** `a91e84a06fb9d2cef7cf3ea25b974dc390f3c850` 加当前工作树。工作树中 `packages/agent-team/src/{index,ledger,inbox-delivery}.ts`、相关测试、文档和 `packages/client-agent-team/src/client/slots.ts` 有未提交改动；本文按当前工作树分析，不把 `HEAD` 当成完整行为。

**范围：** Agent Member 发出消息、另一 Member 被唤醒、读取并完成一次可观察处理，以及成员空闲、回收、恢复和 Host 重启对该链路的影响。Client 的 Thread/Inbox 页面只在与协作链路共享 Host 读路径时提及。

## 1. 证据口径与结论

本文使用三种标记：

- **事实**：由当前源码、当前测试或已有测量直接支持。
- **推断**：从代码路径和复杂度推导出的性能风险，尚无完整运行数据。
- **未测量**：当前资料没有覆盖，不能当作已成立的问题或已通过的容量结论。

主要结论：

1. **事实：协作链路是“durable commit → 同步 post-commit 扇出 → Session notice → 模型主动读”的两段式流程。** Ledger 先成为唯一事实源，然后 Host 从 durable Inbox/Attention 重新派生通知。通知入队不等于模型已经读取，模型通常还要再调一次 `team_thread read` 才拿到正文和写 token。见 `AgentTeam.commitMessageAs()`、`emitCommitted()`、`notifyMember()`、`deliverInboxNotice()` 和 `AgentTeamLedger.notificationFacts()`。
2. **事实：所有有进展的 Thread/Main 读和所有消息写共用同一个 ledger `operationTail`。** 因而“读未读”和“发消息”会互相排队；读虽然有进展就落一条瘦 receipt，但仍是写操作。见 `AgentTeamLedger.enqueue()`、`readThread()`、`reply()` 和 `postMainMessage()`。
3. **事实：通知构造存在重复派生。** `unreadForFrom()` 为 Inbox 行算一次，`notificationFacts()` 又为返回的 item 算一次；`deliverInboxNotice()` 先算 delivery plan，`notificationText()` 再算一次。Main 未读也会在 Inbox 和 `mainNotificationFacts()` 中分别派生。
4. **推断：当前最可能的协作尾延迟不在 SQLite 单次 `put`，而在每次提交后对整个受影响成员集合的同步派生与串行 fan-out，以及 idle 冷成员的 wake gate/回收。** 20k 旧规模证据里单次 Host commit 中位约 16–21 ms，而每个通知成员仍可能扫描其全部候选 Inbox、目标 Thread facts 和所有 Project 的 Main 未读。
5. **未测量：没有真实两 Member 的 `send → notice queued → inbox claimed → read commit → reply commit → idle` p50/p95/p99。** 现有 20k 规模装置没有活 LLM；活模型评测没有测延迟；旧 drain/浏览器数字不是当前 Agent-to-Agent 链路。

## 2. 状态链

### 2.1 从发送到处理的主路径

```text
A 的 team_message reply
  -> AgentTeam.replyForAgent()
  -> 解析 attachment
  -> 等 AgentTeamLedger.operationTail
  -> 校验 actor / revision / unread / mention / parent / Task
  -> SQLite put(operation)
  -> live projection apply
  -> ledger commit 返回
  -> emitCommitted(receipt)
       -> agent-team/committed listeners
       -> Client change invalidation
       -> Task reminder evaluation 调度
       -> affectedMembersOf()
       -> 对每个受影响成员串行调用 notifyMember()
  -> 从 durable Inbox/Attention 派生 notice 和 delivery plan
  -> B 的 Agent inbox splice(next-step 或 next-turn)
  -> busy: 下个 model step 消费 steer
  -> idle 热: wake gate 放行后入队
  -> idle 冷: 可能先测上下文并 recycle Session
  -> B 的下一次 model request
  -> B 调 team_thread read
  -> 再次进入全局 ledger queue；有进展则写 read receipt
  -> B 得到 facts、revision、remainingUnreadCount
  -> 若 remaining > 0，可能再读一页
  -> B 调 team_message reply/action
  -> 回复 commit，并再次向 follower/mention 扇出
  -> B 的整个 turn 结束并 idle
```

对应入口和符号：

- Tool：`packages/tool-agent-team/src/index.ts` 的 `teamInbox`、`teamAttention`、`teamThread`、`teamMessage`。
- Host：`packages/agent-team/src/index.ts` 的 `startThreadForAgent()`、`postMainMessageForAgent()`、`replyForAgent()`、`readThreadForAgent()`、`commitMessageAs()`、`emitCommitted()`、`notifyMember()`。
- Ledger：`packages/agent-team/src/ledger.ts` 的 `startThread()`、`postMainMessage()`、`reply()`、`readThread()`、`affectedMembersOf()`、`notificationFacts()`。
- Harness：`../deepseek-harness/packages/core/agent-loop/src/agent.ts` 的 `followup()`、`steer()`、`preStep()`；`inbox.ts` 的 `ReactLoopInbox.claim()`、`mutate()`。

### 2.2 每种状态的 durable 边界

| 状态 | 持久/进程内 | 当前写入或派生点 | 对唤醒的作用 | 恢复行为 |
| --- | --- | --- | --- | --- |
| Ledger operation 与 live projection | durable + 内存投影 | `table.put()` 后 `applyAndAdvanceProjectionVersion()` | 所有协作事实的权威来源 | 构造时 replay；companion 后续全量校验 |
| Thread followers（Attention） | durable，投影索引 | `changeAttention()`、Thread start/reply 的 Inbox delta | 决定普通 Thread 更新是否成为 unread | replay 重建 |
| Main stream Attention | durable，投影索引 | Main Attention mutation、Project owner grant | 决定普通 Main post/新 discussion 是否成为 unread | replay 重建 |
| direct mention / reply marker | durable，投影索引 | `messageInboxDelta()` | 即使未 follow 也通知一次 | replay 重建 |
| activity / responsibility marker | durable，投影索引 | Task/Claim 变更产生的 Inbox delta | 让责任事件直接到达相关成员 | replay 重建 |
| read watermark / receipt | durable | `team/thread-read`、`team/main-stream-read` | 清 unread、提供下一次写 token | replay 重建；有进展才追加 |
| notice coverage / attempt | 进程内 `inboxNoticeDeliveries` | 成功入队或失败后更新 | 防止同一 durable unread 连续重复投递 | Host 重启后丢失，故是至少一次投递 |
| pending Team wake | 进程内 `pendingTeamWakes` | `trackTeamWake()` / `agent/inbox/claimed` | 区分 Host 主动替换 notice 与异常取消 | 重启后由 durable unread 重新派生 |
| running/idle/presence | Harness/进程状态 | `agent/status` 监听器、`MemberIdleTracker.status()` | busy 走下一 step；idle 可触发 wake gate | 重启后状态重新建立 |
| idle 时长 | 进程内 `MemberIdleTracker` | `agent/status` 时间点 | reminder 与 recycle 决策输入 | Host 重启后从空状态开始 |
| Session transition intent | durable ledger + Session log | `recycleMemberSession()`、context projection | 记录旧/新 Session 与 input replay 起点 | 启动时 `finishMemberTransition()` 再 activation |
| automatic recovery episode | 进程内 `RecoveryCoordinator` | `agent/error`、clean turn | 第一次、第二次错误各安排一次 120s wake，第三次 stand down | Host 重启后 episode 不保留 |

Thread 侧的 durable 状态在 `packages/agent-team/src/ledger.ts:2192` 起由 operation 的 `inbox` delta 统一驱动；`affectedMembersOf()` 在 `packages/agent-team/src/ledger.ts:2718` 汇总 delta 成员、所有 Thread followers、Main recipients 和 operation actor。

### 2.3 wake、coalesce 与消费边界

**事实：** `notifyMember()` 在成员 running 时直接 `notifyMember()` 投递；在 idle 且 transition 或上下文需要计量时，转到 `notifyMemberAtWake()` 异步等待 `wakeGateFor()`。`deliverInboxNotice()` 对普通成员使用 `agent.steer()`，只在已有 ordinary `next-turn` 输入等顺序约束下使用 `agent.followup()`。见 `packages/agent-team/src/index.ts:2729-2733`、`:2824-2825`。

**事实：** Harness `steer()` 写 `next-step`，`followup()` 写 `next-turn`；`preStep()` 每次 claim 全部 `next-step`，turn boundary 再 claim 一条 `next-turn`。见 `agent.ts:163-169`、`:267-272` 和 `inbox.ts:109-113`。

**事实：** running 成员连续收到更新时，已有 Team Inbox hint 会被移除并按最新 durable facts 重算；测试 `member-lifecycle-core.spec.ts:1128-1160` 证明两条更新在下一 step boundary 合并成一句 “2 unread updates”。这能限制**最终 notice 数量**，但不减少每次 commit 的 fan-out 和派生工作。

**事实：** 普通 follower 更新的 notice 只给 unread 数量和新时间，不给正文；direct mention 的 notice 会带最多 8 KiB 的单条正文，但仍要求 `team_thread read` 来清 unread 和获得下一写 token。见 `packages/agent-team/src/index.ts:2949-2972`、`packages/agent-team/src/surface-visibility.ts:17`。

**事实：** Thread read 每次最多返回 20 条 unread；`remainingUnreadCount` 非零时，模型需要再读一页。见 `packages/agent-team/src/ledger.ts:4305-4306`、`:4348` 和 `packages/tool-agent-team/src/index.ts:599-604`。

## 3. 端到端等待构成

### 3.1 必须分开的完成点

“处理完”至少要分成以下七点，不能只看最终 `idle`：

| 时间点 | 含义 | 当前可观察信号 |
| --- | --- | --- |
| `A tool start` | A 的模型决定调用 `team_message` | `tool/call` Session event |
| `A commit ack` | ledger 已落盘、projection 已 apply，且同步 post-commit 已返回 | `tool/result`；它晚于 DB commit |
| `notice queued` | Host 已把 notice 写入 B 的 Harness inbox | `agent/inbox/spliced`，以及现有 “Team Inbox notice queued” 日志 |
| `notice claimed` | B 的下一次 step/turn claim 到 notice | `agent/inbox/claimed` |
| `B read committed` | B 已读到 facts，并提交自己的 read watermark（如有进展） | `team/thread-read` operation + `tool/result` |
| `B handled` | B 完成了基准定义的终态动作，例如 reply/claim/done | 对应 operation + `tool/result` |
| `B turn idle` | B 整个 Agent 没有待处理 step，并非单条消息完成 | `agent/status` 的 running → idle |

**事实：** 当前日志明确写 “notice queued ... not yet read by the model”，见 `packages/agent-team/src/index.ts:2832`。`post-commit-delivery.spec.ts` 也证明 recipient wake 失败时发送方仍得到 committed 结果。

### 3.2 时间账

对“A 发一条，B 读取并回复”的基准，应记录：

```text
T_e2e =
  A 模型生成与 tool 参数时间
  + attachment 解析和 request 准备
  + ledger queue wait
  + pre-commit 校验与扫描
  + SQLite put + projection apply
  + post-commit listener / invalidation / reminder 调度
  + affected-member fan-out
  + notice 派生、渲染与 B inbox splice
  + B 的调度延迟（busy step、idle warm、idle cold/recycle）
  + B 模型看到 notice 后的决策时间
  + B 的 team_thread read queue wait + scan + receipt put
  + 可能存在的多页 read 与每一步模型往返
  + B 模型生成 reply 与 tool 参数时间
  + reply 的 pre-commit / put / apply
  + reply 后的同步 fan-out
```

`B turn idle` 另记，不并入上面，因为 B 可能在完成后被自己 read 留下的 remaining unread、后续消息或 recovery 再次唤醒。

### 3.3 串行点

**事实：** `AgentTeamLedger.operationTail` 把每个 `reply()`、`postMainMessage()`、`startThread()`、有进展的 `readThread()` 和 `readMainStream()` 依次执行。见 `packages/agent-team/src/ledger.ts:631`、`:6414-6418`。

**事实：** `emitCommitted()` 不在 ledger `operationTail` 内，但它在 Host 的 `commitMessageAs()` await 返回后同步运行。`affectedMembersOf()` 返回后，`for ... of` 逐个执行 `notifyMember()`；`afterCommit()` 只隔离异常，不并行化。见 `packages/agent-team/src/index.ts:2590-2626`、`:2662-2668`。因此该成员集合的派生和入队延迟包含在 A 的 tool result 时间中。

**事实：** 当受影响成员没有 live handle 时，Host 对每个成员启动 transition repair；每个成员有自己的 lifecycle queue，多个成员可并行进入不同队列，但会争用同一个 Host event loop、Session 存储和 ledger 写队列。见 `packages/agent-team/src/index.ts:2623-2654`。

**推断：** “一个 Thread 50 个 follower” 和 “一个 Main stream 50 个 follower” 的成本不是 50 次简单 `steer()`。每个成员还要重新派生 unread facts、Main 未读、delivery plan 和 notice；如果成员冷，还可能进入 Session transition。

### 3.4 重复读取

**事实：** `inboxForWorkspaces()` 在 `packages/agent-team/src/ledger.ts:1895-1955` 遍历该成员的 Inbox candidate Threads，并对每个候选调用 `unreadFor()`。之后 `notificationFacts()` 在 `:2132-2142` 对返回的 `inbox.items` 再调用一次 `unreadFor()`。

**事实：** `unreadForFrom()` 扫描目标 Thread 的全部 facts（`:4384-4395`）；`remainingUnreadAfter()` 为计算剩余数量再扫描同一 Thread 的全部 facts（`:4430-4446`）。一批 read 只返回 20 条，但 remaining 的数量按整条 Thread 计算。

**事实：** `deliverInboxNotice()` 先调用 `notificationFacts()` 和 `mainNotificationFacts()`，再调用 `inboxDeliveryPlan()`；`notificationText()` 在 `:2931` 再次调用 `inboxDeliveryPlan()`。`mainNotificationFacts()` 在 `:1395-1406` 对每个 Project 都调用 `mainUnreadFrom()`，而 `memberInbox()` 已经派生过 Main 未读。

**事实：** `mainUnreadFrom()` 从 Main head 反向扫到 watermark，并物化、排序完整 unread 集合（`:4949-4966`）。`mainStreamRecipientsFrom()` 每次扫描全部 `projection.mainAttention.values()` 后按 Project 过滤（`:4721-4729`）。

**事实：** `threadHistory()` 当前通过 `factsByThread` 取该 Thread 的 facts，再 filter/slice（`:2211-2224`）；它不是全账本扫描。但 `team_thread read` 对 discussion 还会额外调用 `threadHistoryForAgent({beforeSequence: 1, limit: 1})` 取得 task cards（`packages/tool-agent-team/src/index.ts:599-604`），并调用 `taskNumberOf()` 解析 Task ref。`team_attention` 的 Thread status/follow/unfollow 也会额外调用 thread history 和 Task ref resolution（同文件 `:402-417`）。这些是同一 tool call 内额外的 Host 派生，不是新模型轮次。

### 3.5 放大、风暴和尾延迟

| 位置 | 事实 | 风险判断 |
| --- | --- | --- |
| 高频 Thread 更新 | `emitCommitted()` 每次按受影响成员 fan-out；running 成员的 notice 会合并，但每次 commit 仍重建 | **推断：** 突发消息产生派生风暴，最终 notice 只有一句 |
| follower 数量 | `affectedMembersOf()` 把 touched Thread 的全部 followers 加入集合 | **推断：** commit 后同步阶段随 follower 数增长 |
| Main Attention 数量 | `mainStreamRecipientsFrom()` 每次全扫 Main Attention 表 | **推断：** 大 Workspace 的 Main post 有共享扫描热点 |
| 单 Member 未读量 | Inbox 先扫所有候选 Thread 做 totals/ranking，再重复取 selected item facts | **推断：** 单读者千级积压会放大每次 notice 构造 |
| 长 Thread | read 和 remaining count 各扫整条 Thread | **事实：** 复杂度与 Thread facts 线性；**未测量：** 当前 live notice/read 在该维度下的尾延迟 |
| Task 数量 | 每个非 reminder commit 都调度 reminder evaluation；`planTaskReminders()` 遍历每个 open Task，并检查 active Claims | **事实：** 与消息无关的 Task 总量会进入公共 Host 路径；**推断：** 大任务板会拖慢后续 Host 工作 |
| invariant companion | commit 后 `setImmediate()` 合并全量 replay；不阻塞当前 commit result，但占用同一 event loop | **历史事实：** 20k ops 时 replay 中位约 0.18–0.20 s、最大 event-loop lag 约 0.36 s；当前规模未重测 |
| idle 冷成员 wake | 先读/构造 Session、判断空闲和上下文；必要时测 token、commit recycle、取消旧 Agent、归档旧 Session、创建/恢复新 Agent、replay carried input、重新派生 Inbox | **事实：** 同一成员 transition 串行；**推断：** 多成员同时冷唤醒会形成尾延迟和存储竞争 |
| Host 启动 | ledger replay 后 `for (const member ...) await finishMemberTransition/activateMember`，成员逐个处理 | **推断：** 50/100 成员启动时间会包含串行 activation 和 Session replay；**未测量** |
| 模型 tool 轮次 | notice → 可能先 `team_inbox` → `team_thread read`（可能多页）→ reply；每次都是模型与 Host 串行往返 | **事实：** 语料有 186 次 `unread_required`、35 次 `stale_revision`；**未测量：** 这些拒绝增加的墙钟时间 |
| reply 回环 | reply 会使原发送者/其他 follower 获得新的未读，模型可能继续回复 | **事实：** 回复同样触发 fan-out；**推断：** 没有终止规则时会产生 ping-pong 风暴 |

`planTaskReminders()` 的逐 Task 路径在 `packages/agent-team/src/task-reminders.ts:57-84`；调度入口在 `packages/agent-team/src/index.ts:2555-2578`、`:2601`。

### 3.6 recycle、启动和恢复

**事实：** 默认 wake recycle 是 `enabled=true`、`idleMs=1h`、`minContextTokens=128000`，见 `packages/agent-team/src/wake-recycle.ts:20`。

**事实：** idle 冷成员先走 cheap gate；通过后再计量上下文。没有 live Agent 时会读取 stored Session、`Session.create()` 并 `tokenMeter.measure()`，见 `packages/agent-team/src/index.ts:532-569`。

**事实：** recycle 的 `executeMemberTransition()` 在同一成员 lifecycle queue 中串行执行 idle wait、queued-input 检查和 job 检查、ledger recycle commit、旧 Agent cancel、旧 Session archive、新 Agent activation、carried input replay 和 Inbox 重新派生，见 `packages/agent-team/src/index.ts:1196-1255`。

**事实：** 启动顺序是 ledger initialize/replay、读取一次 persisted Session 列表、逐个 Member 完成 transition/activation；activation 可能再次评估 wake recycle，并 fold Session、replay carried input、重新派生 Inbox。见 `packages/agent-team/src/index.ts:774-816`、`:2283-2394`。

**事实：** 自动 recovery 的等待是 120 s，连续第 3 次可恢复错误就 stand down；每次错误到 wake 的墙钟下限是 `RECOVERY_DELAY_MS`，见 `packages/agent-team/src/recovery.ts:121-176`。recovery episode 是进程内状态。

**事实：** `MemberIdleTracker` 也是进程内状态；Host 重启后没有旧 idle duration，见 `packages/agent-team/src/member-idle.ts`。

**推断：** 重启恢复至少会把 durable unread 重新派生为 notice，因此存在至少一次投递风险。由于 read 和 reply 使用 request id/idempotency，**未经测试不能把重复 notice 直接等同于重复模型处理或重复回复**。

## 4. 事实、推断、未测量项清单

| 类型 | 内容 | 依据 |
| --- | --- | --- |
| 事实 | 每个有进展的 read 都进入全局 ledger 写队列并追加 receipt | `readThread()` `:2145-2172`、`enqueue()` `:6414-6418` |
| 事实 | post-commit fan-out 对受影响成员串行执行 | `emitCommitted()` `:2616-2626` |
| 事实 | 一个 Thread reply 的受影响集合包含全部 followers | `affectedMembersOf()` `:2733-2735` |
| 事实 | 普通 Thread 更新 notice 不含正文，模型仍需 read | `notificationText()` `:2969-2972`、read 测试 |
| 事实 | 有进展的 read 每次最多确认 20 条 | `prepareReadReceiptFrom()` `:4305-4306` |
| 事实 | 通知路径重复派生 Inbox/unread/plan/Main 未读 | `inboxForWorkspaces()`、`notificationFacts()`、`deliverInboxNotice()`、`notificationText()` |
| 事实 | busy Member 的多条更新可在下一 step 合并；idle follower notice 不带正文 | `member-lifecycle-core.spec.ts:1128-1160`、`:1379-1402` |
| 事实 | wake 失败不回滚已提交消息，后续从 durable unread 重试 | `post-commit-delivery.spec.ts:87-209` |
| 推断 | 长 Thread、大 follower 集、大 Main Attention 集会放大 commit 同步阶段 | 上述扫描和 fan-out 路径 |
| 推断 | 高频发送会形成“派生风暴”，即便最终 notice 被合并 | 每 commit 重新派生 + step boundary 合并 |
| 推断 | 多成员同时冷 wake 会产生 Host event-loop、Session 文件和 lifecycle 竞争 | 每个成员 transition 内部串行，不同成员可并发 |
| 推断 | 全局写队列使发送、回复和多页 read 互相排队 | 单一 `operationTail` |
| 推断 | 重启后至少一次投递可能造成重复 read，但不应先假定重复模型处理 | coverage/idle 为进程内，ledger/read 为 durable |
| 未测量 | 两 Member live send→wake→read→reply 的 p50/p95/p99 | 无对应装置 |
| 未测量 | `A commit ack`、`notice queued`、`notice claimed`、`read commit`、`reply commit` 的分段耗时 | 日志只给状态，不形成完整关联链 |
| 未测量 | follower/Main Attention/Thread facts/单读者未读量的规模曲线 | 20k 装置没有 fan-out 组合 |
| 未测量 | 2/10/50 成员同时 cold recycle 的墙钟和 event-loop lag | 无对应实验 |
| 未测量 | 重启导致重复 notice 与重复模型动作的比率 | 无故障注入实验 |
| 未测量 | 当前构建的 20/100/400 未读 drain 墙钟 | 旧装置和旧 replay 成本，不可直接外推 |

## 5. 现有测试与历史结论

### 5.1 当前行为测试

当前工作树运行了以下测试：

```text
npx vitest run \
  packages/agent-team/tests/inbox-delivery.spec.ts \
  packages/agent-team/tests/wake-recycle.spec.ts \
  packages/agent-team/tests/post-commit-delivery.spec.ts \
  packages/agent-team/tests/recovery.spec.ts
```

结果：4 个文件、63 项测试全部通过；两次运行分别为 1.84 s 和 1.11 s（后者为最终复核）。它们覆盖：

- 普通 Thread/Main 更新都立即进入 unread；相同 facts 的重复派生不再次投递。
- busy 成员在下一 step 合并多条更新，notice 不含被合并正文。
- idle follower 从 durable unread 唤醒；direct mention notice 可带正文。
- 已 commit 后 wake 失败不会反向让发送失败；后续 commit/activation 可重试。
- 自动 recovery 前两次各安排 wake，第三次 stand down。
- cold/large generation 的 recycle 决策和默认阈值。

这些是状态与语义测试，不是性能测试。`post-commit-delivery.spec.ts` 主要证明“不丢事实、失败可重试”，没有记录 fan-out 时间。

### 5.2 历史性能证据

| 来源 | 已有结论 | 使用限制 |
| --- | --- | --- |
| `.scratch/archive/2026-09/team-perf/materials/phase0/findings.md` | 11,695 ops 冻结件里 read 占 77% 体积；7,079 条 read 中 2,607 条（36.8%）是空 delta；全量校验和 replay 曾是主要 Host 热点 | 历史记录形状，当前已落地 no-op read 跳过、瘦 receipt、索引等 |
| 同一材料 | 400 条未读旧 drain 约 13.75 s；same-turn 约 118 ms；真浏览器 Thread 打开 763 ms，其中 659 ms 为 replay | 说明“每轮让出 event loop → 再次 replay”的放大机制；当前 replay/记录形状已变，旧绝对值不能直接当现状 |
| `.scratch/archive/2026-10/state-requests-diagnostics/issues/06-scale-and-failure-acceptance.md` | 20k ops、2 Workspace、6 Member、1,000 Task、17,950 replies；boot 681.6 ms、显式 validate 186.6 ms、长 Thread history 0.29 ms、长 Thread read commit 10.6 ms、48 并发 Host commits 735.5 ms；companion replay 中位 191 ms、event-loop max lag 358 ms | 该装置的 Member Session 是桩，没有 live LLM、Remote 或 UI；不是协作端到端测量 |
| `.scratch/archive/2026-10/state-requests-diagnostics/issues/06...` | Inbox badge/page 在 11 条未读时约 6 ms；瓶颈是全部候选遍历和 totals，不是返回行预览 | 只测了较小未读候选；千级未读未测 |
| `.scratch/archive/2026-10/team-tools-model-eval/materials/2026-10-28-corpus-findings.md` | 7,239 次 Team tool calls，摩擦 468 次（6.5%）；`unread_required` 186 次、`stale_revision` 35 次 | 这是调用结果分布，不是延迟；包含旧构建和历史模型 |
| `.scratch/archive/2026-10/team-tools-model-eval/materials/2026-10-28-live-eval-findings.md` | 144 次 live tool calls，140 ok，4 次抛错；无空串、无 read 页大小拒绝、无多项目参数 | 样本小，且没有 wall-clock、token load 或完整 Agent-to-Agent 场景 |

**结论：** 历史证据足以说明读记录、replay、Client drain 和 Host 大规模写曾造成显著放大；它不足以回答“当前两个真实 Member 协作要多久”。

## 6. 可观测协作基准设计

### 6.1 三层装置

必须分开报告三类时间，不能混成一个数字：

1. **Host 固定策略基准**：使用真实 Host、ledger、SQLite、Harness 和多个 Member Session，但用 scripted model adapter 固定调用 `team_thread read`、`team_message reply`。测协作机制、fan-out、队列和 Session transition。
2. **Live model 基准**：真实 LLM 和真实 tool schema，给每个 Agent 明确规则、最多 12 个 model steps、明确终止 sentinel。只用于测模型选择、真实 tool 轮次和总体验。
3. **故障注入基准**：固定 scripted policy，在 commit、wake、transition、restart 的指定边界注入失败。用于确认恢复和重复处理边界。

三层都使用临时 profile 或隔离 Host，避免碰默认 stable profile。

### 6.2 基准主场景

建立 `PING`/`ACK` 消息：

- A、B 同属一个 Project，初始都 follow 同一 Thread。
- A 发出带唯一 `runId` 的 reply；B 收到 notice 后必须 `team_thread read`，再回复 `ACK <runId> done`。
- B 完成后主动结束 turn；A 的基准 turn 也结束，并明确不回复 `ACK`，避免把 ping-pong 算进基线。
- 以 `ACK` commit 作为 B “已处理”；另记 B turn idle 和 A tool result，不用 idle 代替消息完成。

每个场景都记录以下五条时间线：

```text
commit_ack = tool_result(A) - tool_call_start(A)
notify = notice_claim(B) - A_commit_ack
read_to_reply = reply_commit(B) - first_read_commit(B)
handled = reply_commit(B) - tool_call_start(A)
steward_idle = B_status_idle - reply_commit(B)
```

### 6.3 场景矩阵

先做单维扫描，再对一个最差组合做联合压力。不要一次铺完整笛卡尔积。

| 维度 | 档位 | 目的 |
| --- | --- | --- |
| B 运行状态 | busy、idle warm、idle cold 且会 recycle | 区分 step 合并、wake gate、Session swap |
| Thread follower 数 | 1、5、20、100 | 测 sync fan-out 与每成员派生 |
| Main Attention 数 | 1、10、50 | 测 `mainStreamRecipientsFrom()` 和 Main 未读 |
| Thread facts | 20、500、5,000 | 测 read/remaining count |
| 单读者未读 | 1、20、100、400 | 测多页 read 和写 token 阻塞 |
| Member 规模 | 6、30、100 | 测启动、同进程并发、Host queue |
| Workspace/Project | 1 Workspace/1 Project、2/10、4/40 | 测跨 scope 派生、Main candidates |
| 同步发送 | 1、10、100 条在同一 100 ms 窗口 | 测 burst、coalesce、event-loop lag |
| 同时 cold wake | 2、10、50 | 测 transition 并发和存储竞争 |
| 并发发送/读取 | 1、2、8、32 | 测全局 write queue 与死锁/ starvation |
| 恢复故障 | wake throw、半完成 transition、重启、1/2/3 次模型错误 | 测至少一次投递和 120 s recovery |

至少拆出以下独立场景：

- `S0` 二成员普通 follower reply。
- `S1` B 仅通过 mention/reply marker 被唤醒，不 follow。
- `S2` Task 责任事件唤醒，不走 Main broadcast。
- `S3` 大 follower 集的单条 reply，固定所有成员 warm/idle。
- `S4` 单 Thread 100 条 burst，B busy 与 idle 各跑一次。
- `S5` B 有 20/100/400 条 unread，测多页 read。
- `S6` B 冷、上下文过阈值，触发一次 recycle。
- `S7` 10/50 Member 同时冷唤醒；分 warm cache 和实测 token 两档。
- `S8` 48/100 concurrent Host commits，区分 send、read、Task mutation 的混合比例。
- `S9` Host 在 commit 后、notice 前重启；确认重复 notice 与重复模型动作率。
- `S10` 1/2/3 次 429/503/transport error，分别测 120 s 前、后和 stand down。

### 6.4 埋点与关联

**现有可挂钩信号：**

- `agent-team/committed`：receipt 已在 ledger 中，但该事件发生在 Host fan-out 之前。
- `agent/inbox/spliced`、`agent/inbox/inserted`、`agent/inbox/claimed`、`agent/inbox/discarded`。
- `agent/status`、`tool/call`、`tool/result`、`agent/error`、`turn/end`。
- 现有 “Team Inbox notice queued” 日志，包含 cause、attempt、delivery lane。

**基准需要新增的观测点**（可在 benchmark wrapper 或后续生产中实现，不能靠日志猜）：

| 观测点 | 关联键 | 记录值 |
| --- | --- | --- |
| `ledger_enqueue` / `ledger_start` | `requestId`、operationId、memberId | queue wait，当前 queue depth |
| `db_put_start/end` | operation kind/id | SQLite 耗时和字节 |
| `projection_applied` | operation id | live projection 耗时 |
| `fanout_start/end` | receipt operation id | affected count、每个 recipient 的派生耗时 |
| `notice_derived` | memberId、cause operation id | Inbox candidates、Thread facts scanned、Main rows scanned、notice bytes、plan trigger |
| `notice_queued` | notice message id、memberId | target 为 `next-step` 或 `next-turn` |
| `notice_claimed` | notice message id、turn/step | claim 延迟、claimed 数量 |
| `model_request` | memberId、turn/step | 该 step 的 prompt/context 字节，不记录正文 |
| `tool_execute` | memberId、call id、tool name | tool 墙钟、参数形状 |
| `read_commit` / `reply_commit` | operation id、thread revision | 锁等待、put、apply、bytes |
| `transition` | memberId、old/new Session | context measure、recycle wait、archive、activation、carried replay |
| `recovery` | memberId、episode id | scheduled/woke/stood-down、120 s wait |

所有事件带 `runId`、`scenarioId`、`workspaceId`、`memberId`、`messageRef`、`threadRef`、`requestId`、`noticeId`，仍遵守现有规则：不打印 message body 或敏感 attachment 路径。

### 6.5 指标

每次实验结果至少报告：

- 端到端 `A tool start → B reply commit` 的 p50/p95/p99/max。
- `commit ack`、queue wait、DB put、projection、fan-out、notice queued、notice claimed 的分段 p50/p95/p99。
- 每受影响的 Member 平均/最大派生成本。
- Inbox candidate Thread 数、Thread facts 读取数、Main Project/Attention rows 扫描数、notice 字节。
- 每次 flow 的 notice 数、read 次数、model steps、tool calls、失败/重试数。
- Host event-loop delay p99/max、ledger queue depth、SQLite busy/retry、存储字节增长。
- recycle 计数、context measure 次数、stored Session replay 字节、carried input 重放事件数。
- 重启后重复 notice/read/model action 的比率。

模型耗时、Harness 调度、Team Host、SQLite 和 invariant replay 分开报告；只给总 wall clock 无法定位优化点。

### 6.6 正确性边界

性能通过之前先固定以下不变量：

1. 同一 `requestId` 只产生一个 public operation；重试不重复消息。
2. B 只有在 read 有进展时才推进水位；空 read 不写 ledger。
3. 每次 reply 的 `baseRevision` 必须来自 fully drained Thread 或自己的最后提交。
4. wake 失败不能回滚已提交消息；后续 commit/activation 能从 durable unread 重试。
5. Host 在 commit 后 crash 再启动，最终可以收件；允许 at-least-once notice，但不应产生重复 public Message。
6. recycle 被 queued input、blocking job 或未完成 turn 阻止时，不得丢消息或谎报完成。
7. 所有模型重试有 turn/step/墙钟上限；测试不能因为 ping-pong 无限跑。

### 6.7 故障与并发边界

必须独立跑这些边界，不从正常均值推断：

- SQLite put 前失败、put 变慢、projection apply 后抛错。
- `agent-team/committed` listener 抛普通错误和不变量错误。
- recipient notice 构造失败、`steer()`/`followup()` 抛错。
- 受影响成员 busy、idle、transition 中、没有 live handle、blocking job。
- 多成员同时 recycle，及同一个成员连续到达多条 notice。
- 两个成员同时 read/write 同一 Thread，触发 stale revision 或 unread gate。
- 模型返回 1/2/3 次可恢复错误，验证 120 s 恢复状态机。
- Host 在 ledger commit、recycle commit、activation、notice queue 各阶段中断后重启。

## 7. 优先级建议

### P0：先建立真实分段基线

先做 `S0` 的 scripted 二成员基准，同时在两个真实 LLM 上跑一个最小 live 场景。必须拿到 commit、notice、claim、read、reply 的分段数据，再决定改 fan-out、batch 还是模型 tool 流程。当前没有两成员 live p95，任何总优化收益判断都过早。

### P0：删除通知路径的重复派生

高收益且局部：一次构造成员通知所需数据，在一个对象中复用 Inbox items、Thread unread facts、Main unread、delivery plan 和 rendered/undelivered 结果。重点消除：

- `inboxForWorkspaces()` 与 `notificationFacts()` 的二次 `unreadFor()`；
- `deliverInboxNotice()` 与 `notificationText()` 的二次 plan；
- `memberInbox()` 与 `mainNotificationFacts()` 的重复 Main 派生；
- read 的 `unreadForFrom()` 与 `remainingUnreadAfter()` 双扫。

这会直接减少每个 fan-out recipient 的成本，且不改变可见语义。

### P1：按规模曲线决定 fan-out 索引和批处理

先测 1/5/20/100 followers 和 1/10/50 Main Attention。若 commit 同步阶段明显随集合增长，再增加 Project → Main recipients 索引、Thread follower 批量快照，并考虑把同一 event-loop 批次的通知合并。不要先按理论复杂度写复杂 registry。

### P1：给 cold wake/recycle 加并发边界

先测 2/10/50 成员同时冷唤醒。若 Session replay、context measurement、archive 和新 Agent activation 造成 p99 尖峰，再加入有界并发或批量调度；同一个成员仍必须由现有 lifecycle queue 保证串行。

### P1：单独测启动恢复

20k 旧装置只测了 ledger 投影和 Host 读，不包含多个成员真实 activation。用 6/30/100 Member、已有 persisted Session、pending unread 和半完成 transition 测 boot 分解，区分 ledger replay、Session list、逐成员 activation 和新 notice 扇出。

### P2：多页 read 与 drain 合并

Agent 的 `team_thread read` 每次只拿 20 条，模型要顺序多轮；Human Client drain 也按 20 条一轮。历史 400 条 drain 的 20 轮重放说明 yield 边界重要，但当前瘦 receipt 和 deferred replay 已改变成本。重测 20/100/400，再决定是否合并读取；任何 durable read 合并都要先定义 requestId、retry 和 watermark 合同。

### P2：重启和 recovery 的重复投递实验

先测量重复 notice、重复 read 和重复模型动作，再决定是否优化 coverage。不能把 at-least-once delivery 直接改成 at-most-once，也不能在未测的情况下承诺“重启零重复”。

## 8. 具体符号索引

- 工具入口：`packages/tool-agent-team/src/index.ts`，`teamInbox`、`teamAttention`、`teamThread`、`teamMessage`。
- Host 入口：`packages/agent-team/src/index.ts`，`startThreadForAgent()`、`postMainMessageForAgent()`、`replyForAgent()`、`readThreadForAgent()`、`commitMessageAs()`、`emitCommitted()`、`notifyMember()`、`notifyMemberAtWake()`、`deliverInboxNotice()`、`notificationText()`、`executeMemberTransition()`、`activateMember()`。
- Ledger：`packages/agent-team/src/ledger.ts`，`operationTail`、`enqueue()`、`reply()`、`postMainMessage()`、`readThread()`、`readMainStream()`、`prepareReadReceiptFrom()`、`prepareReadFrom()`、`unreadForFrom()`、`remainingUnreadAfter()`、`affectedMembersOf()`、`mainStreamRecipientsFrom()`、`mainUnreadFrom()`、`notificationFacts()`、`mainNotificationFacts()`。
- Inbox 派生：`packages/agent-team/src/inbox-delivery.ts`，`planInboxDelivery()`。
- Reminder：`packages/agent-team/src/task-reminders.ts`，`planTaskReminders()`；`packages/agent-team/src/index.ts`，`scheduleTaskReminderEvaluation()`、`evaluateTaskReminders()`。
- Recycle/idle：`packages/agent-team/src/wake-recycle.ts`，`DEFAULT_WAKE_RECYCLE`；`packages/agent-team/src/index.ts`，`cheapWakePlan()`、`planWakeForMember()`、`measureLiveContext()`、`measureStoredContext()`、`recycleColdGeneration()`、`wakeGateFor()`；`packages/agent-team/src/member-idle.ts`，`MemberIdleTracker`。
- Recovery：`packages/agent-team/src/recovery.ts`，`RecoveryCoordinator`、`RECOVERY_DELAY_MS`、`RECOVERY_MAX_CONSECUTIVE_ERRORS`。
- Harness：`../deepseek-harness/packages/core/agent-loop/src/agent.ts`，`followup()`、`steer()`、`preStep()`；`../deepseek-harness/packages/core/agent-loop/src/inbox.ts`，`ReactLoopInbox.claim()`、`ReactLoopInbox.mutate()`。
- 当前行为测试：`packages/agent-team/tests/inbox-delivery.spec.ts`、`wake-recycle.spec.ts`、`post-commit-delivery.spec.ts`、`recovery.spec.ts`、`member-lifecycle-core.spec.ts`。
