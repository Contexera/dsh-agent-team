# Team 协作通知路径的重复派生

分析日期：2026-10-28\
源码基线：`bf777c39ecc1ff912a3b473d85f575dd0758bdd5`\
范围：Agent Team 的 Thread / Main stream commit、post-commit 扇出、Inbox 通知构造与投递。只读分析，未修改生产代码或其他材料。

## 1. 结论

当前通知正确性来自 durable ledger，代价主要来自每次投递都从完整 projection 重新派生通知材料。最明确、可重复的浪费有以下四类：

1. `notificationFacts()` 先通过 `memberInbox()` 为全部候选 Thread 计算 unread，再只为最终页中的 Thread 重算一次 unread。
2. `memberInbox()` 已经为总数派生 Main unread，但 `notificationFacts()` 丢弃这部分结果；`deliverInboxNotice()` 随后又调用 `mainNotificationFacts()`，从所有 Project 重新派生完整 Main 未读和时间线条目。
3. `deliverInboxNotice()` 先计算一次 `planInboxDelivery()`，`notificationText()` 为了取得 Thread role 又计算一次同样的 plan。
4. Session recycle 在调用 `notifyMember()` 前先用 `notificationFacts()` 和 `mainNotificationFacts()` 做空判断，真正投递时又完整派生一遍。

建议先增加一个有明确生命周期的 `NotificationReadSet`：Ledger 负责基于当前 projection 一次性派生某个 Member 的 Thread 和 Main 通知材料，Host 在同一投递调用内复用它。`covered`、attempt、queued notice 替换和失败重试仍留在 Host。这个 seam 不建立第二事实源，也不改变 durable authority。

跨 commit 的 debounce、持久缓存、50→8 的裁剪和并行冷唤醒不能作为同等级的“去重”直接做。它们会改变通知入队时刻、attempt 计数或失败边界，必须先有规模测量和明确契约。

## 2. 当前调用链

当前源码没有名为 `postCommit` 的符号。用户所说的 post-commit 路径由以下两层组成：

- `commitMessageAs()` 在 ledger 返回后调用 `emitCommitted()`；
- `emitCommitted()` 用 `afterCommit()` 隔离 listener、Client invalidation、participation notice 和逐 Member 的 notice fan-out。

```text
team_message / Remote
  -> startThreadAs | postMainMessageAs | replyAs
  -> commitMessageAs
     -> resolveMessageAttachments
     -> ledger.startThread | postMainMessage | reply
        -> durable put
        -> apply projection
     -> emitCommittedOutcome
        -> emitCommitted(receipt)
           -> agent-team/committed listener
           -> emitChanged(changeScopesOf(operation))
           -> scheduleTaskReminderEvaluation
           -> affectedMembersOf(operation)
              -> for each affected Member
                 -> notifyMember
                    -> wake gate / transition check
                    -> deliverInboxNotice
                       -> ledger.notificationFacts
                       -> ledger.mainNotificationFacts
                       -> inboxDeliveryPlan
                       -> notificationText
                          -> inboxDeliveryPlan 再次计算
                       -> beginInboxDelivery
                       -> agent.steer | agent.followup
```

### 2.1 调用与输出

| 调用 | 输入 | 输出或效果 | 当前实现引用 |
| --- | --- | --- | --- |
| `team_message.execute()` | 模型参数 `action`、`body`、地址、写 token、附件与 `callId` | 调用 Host 的 start/post/reply，并渲染为工具结果 | `packages/tool-agent-team/src/index.ts:880-930` |
| `commitMessageAs()` | actor、含 requestId/body/attachmentPaths 的 request、ledger commit 回调 | 解析附件，取得 ledger result；committed 时同步执行 post-commit effects，最后返回 result value | `packages/agent-team/src/index.ts:2141-2161` |
| `emitCommittedOutcome()` | `{ committed, value }` | 仅对 committed 且带 receipt 的结果调用 `emitCommitted()` | `packages/agent-team/src/index.ts:2123-2126` |
| `emitCommitted()` | receipt | 同步 dispatch listener 和 invalidation；异步安排 reminder；对每个受影响 Member 同步启动 notice 或 transition repair | `packages/agent-team/src/index.ts:2590-2626` |
| `afterCommit()` | label 与同步 effect | 普通异常记录 warn；`AgentTeamInvariantError` 继续抛给调用方 | `packages/agent-team/src/index.ts:2657-2668` |
| `affectedMembersOf()` | operation | 去重后的 Member id 数组 | `packages/agent-team/src/ledger.ts:2718-2752` |
| `notifyMember()` | live Agent、cause、可选 `sequenced` | 选择 warm delivery 或 wake gate；无字面返回值 | `packages/agent-team/src/index.ts:2729-2750` |
| `notificationFacts()` | memberId，可选 Workspace 请求 | 最终 Inbox 页中每个 Thread 的 `{ item, facts, reminders }` | `packages/agent-team/src/ledger.ts:2132-2144` |
| `mainNotificationFacts()` | memberId | 每个有未读的 Project 及其完整 Main 未读条目 | `packages/agent-team/src/ledger.ts:1395-1408` |
| `inboxDeliveryPlan()` | Thread 通知材料、Main 通知材料、上次 delivery 状态 | `{ trigger, signature, delivered, threads }` | `packages/agent-team/src/index.ts:2711-2715`、`packages/agent-team/src/inbox-delivery.ts:58-86` |
| `notificationText()` | Thread 通知材料、readerId、Main 通知材料 | 有界文本、已渲染 Thread 集合、未渲染 Thread 集合；内部再次调用 `inboxDeliveryPlan()` | `packages/agent-team/src/index.ts:2916-3000` |
| `beginInboxDelivery()` | memberId、plan、本次未能渲染的 Thread 集合 | 记录 `covered`、attempt 和 `undelivered`；返回递增后的 attempt | `packages/agent-team/src/index.ts:3100-3107` |
| `steer/followup` | 一条 Team notice `UserMessage` | 将 notice 放入下一 step 或下一 turn；成功只表示已入队 | `packages/agent-team/src/index.ts:2809-2832` |

### 2.2 `affectedMembersOf()` 的具体来源

`affectedMembersOf()` 的结果已经用 `Set` 去重，来源是：

1. operation 自带 inbox delta 中新增或移除的 Attention、direct marker、activity marker、reminder marker、Main marker 所属 Member；
2. operation 触及的每个 Thread 的当前全部 followers；
3. Workspace join/leave 的 Member；
4. Main message，以及新建 discussion（不是新建 Task）时，扫描全部 `mainAttention.values()` 得到的该 Project 读者；
5. operation actor。

来源见 `packages/agent-team/src/ledger.ts:2718-2752`、`:2755-2804`、`:4724-4732`。Thread follower 数是明确线性项；Main recipient 路径每次扫描整个 `mainAttention`，不是按 Project 建索引。

## 3. 重复派生清单

记 `C` 为候选 Thread 数，`K` 为 Inbox 返回页中的 Thread 数（默认上限 50），`F_i` 为第 i 个 Thread 的 fact 数，`P` 为 Member 可参与的 Project 数，`S_p` 为 Project p 的 Main source 数，`A` 为全局 Main Attention 行数。

| 编号 | 重复内容 | 次数与复杂度 | 当前依据 |
| --- | --- | --- | --- |
| D1 | 候选 Thread 的 unread | `inboxForWorkspaces()` 对全部候选算一次；`notificationFacts()` 对最终页再算一次，即约 `O(Σcandidate F_i + Σselected F_i)` | `ledger.ts:1896-1957`、`:2132-2144`、`:4381-4396` |
| D2 | 最终页的 Thread 扫描 | `unreadForFrom()` 遍历 `factsByThread`；只返回最多 50 个 Thread，但其中每个都可能扫描全部 fact | `ledger.ts:4385-4395`、`:4455-4461` |
| D3 | Main 未读 | `notificationFacts()` 经 `memberInbox()` 调 `mainInboxItems()` 算一遍仅为 totals；Host 随即调 `mainNotificationFacts()` 再完整算一遍。若单 Member 有 P 个可读 Project，约两次 `O(Σ S_p + unread markers)` | `ledger.ts:1890-1894`、`:2024-2042`、`:1395-1408`、`index.ts:2773-2775` |
| D4 | Main 时间线条目 | 第一次只物化每 Project 的最新一行摘要后被丢弃；第二次物化全部未读 entry | `ledger.ts:2024-2042`、`:1404-1405`、`:5022-5042` |
| D5 | delivery plan | `deliverInboxNotice()` 计算一次，`notificationText()` 再计算一次；每次都扫描 Thread facts/reminders、Main entries、JSON 序列化 | `index.ts:2790`、`:2931`、`inbox-delivery.ts:58-86` |
| D6 | plan 内 Thread role 查找 | 渲染最多 8 个 Thread，每个再用线性 `find` 搜 plan；可变为 Map。当前规模小，不是首要热点 | `index.ts:2934-2939` |
| D7 | fact 过滤 | 每个 Thread 先遍历所有 facts 挑 direct/activity，再 `filter()` 一遍挑 ordinary；Main entries 也先挑 direct/thread-card，再挑 ordinary | `index.ts:2949-2973`、`:2980-2999` |
| D8 | recycle 预检 | `executeMemberTransition()` 先派生 Thread 和 Main 判断是否为空；调用 `notifyMember()` 后 `deliverInboxNotice()` 再派生一轮。单 Member 会经历两轮，每轮内部又含 D1/D3 | `index.ts:1247-1253`、`:2729-2749`、`:2773-2775` |
| D9 | 不需要的通知字段 | 为构造通用 Inbox item，候选路径计算 Task numbering、preview、live Claim owners、Main totals；模型 notice 不使用其中多数字段 | `ledger.ts:1899`、`:1942-1957`、`:5355-5363` |
| D10 | main recipient 扫描 | Main post 或 discussion start 的受影响 Member 派生扫描整个 `mainAttention.values()`；只有新 Task 不进入该分支 | `ledger.ts:2744-2749`、`:4724-4732` |

### 3.1 单次 commit 中的放大顺序

以 Human 回复一个已有 Thread、两条 Member 都 follow 为例：

1. ledger 提交并 apply inbox/projection；
2. `affectedMembersOf()` 先读 operation delta，再扫描该 Thread follower 集；
3. Host 依次通知每个 Member；
4. 每个 Member 的 `notificationFacts()` 对候选 Thread 扫描 unread，之后对返回页再扫一次；
5. 每个 Member 的 `memberInbox()` 还物化一份不会被使用的 Main 摘要；
6. `mainNotificationFacts()` 再从 Project/Main 索引派生完整 Main 未读；
7. delivery 路径生成 plan 两次；
8. 若为 idle 且命中 wake 检查，中间还插入 `wakeGateFor()` 等待，之后才真正投递。

这不是“每个成员只做一次字符串检查”，而是每个受影响 Member 的未读 projection 都被重新扫一遍。`affectedMembersOf()` 只压缩了重复 Member id，没有复用 Member 的派生结果。

### 3.2 Thread 与 Main 的相对成本

- Thread 成本由候选 Thread 数和每个 Thread 的 fact 数决定。虽然 `inboxCandidateThreads()` 使用 derived indexes，未读判定仍遍历每个候选 Thread 的完整 fact 列表，见 `ledger.ts:2118-2129`、`:4385-4395`。
- Main 的 `mainUnreadFrom()` 通常从尾部反向遍历到该读者的 watermark，再对命中项排序，见 `ledger.ts:4952-4969`；积压越大，单次成本越高。
- 当前没有 Thread/Main unread 规模的耗时数据。不能据此排序两者。可确定的是 D1、D3、D5、D8 都是同一输入上的确定性重复，消除后不改变输出；实际能节省多少毫秒必须测。

## 4. 建议的内部复用 seam

### 4.1 形状

在 `AgentTeamLedger` 内部增加只读派生结果 `NotificationReadSet`，由 Host 在同一个同步 fan-out / 单次通知内复用：

```ts
interface NotificationReadSet {
  readonly ledgerSequence: number
  readonly memberId: AgentTeamMemberId
  readonly threads: readonly InboxThreadUnread[]
  readonly main: readonly InboxMainUnread[]
}
```

`threads` 与当前 `notificationFacts()` 的输出相同；`main` 与当前 `mainNotificationFacts()` 的 `{ project, entries }` 再投影为 `InboxMainUnread`。Host 的 `deliverInboxNotice()` 只调用一次 `readSet(memberId)`，再用同一份 Thread/Main 材料计算 plan、identity 和 text。

这个 seam 的职责边界应当是：

- Ledger 继续从 append-only operation 重建出的 projection 派生材料，并负责当前可见性、排序、默认 50 行裁剪和完整 facts；不能把 Host 的 `covered` 状态写回 ledger。
- Host 继续拥有 delivery policy：pending recovery 检查、wake gate、attempt、notice 替换、steer/followup 和失败重试。
- 输出必须 immutable；它只是本次读取的快照，不成为新的权威副本。

第一版可以让 read set 的缓存只在一次 `emitCommitted()` 扇出或一次显式通知调用内存在。这样无需长期维护全局缓存，也不会把旧 Session 或旧 reader 状态带到下一次投递。

### 4.2 不重复的职责

`notificationFacts()` 和 `mainNotificationFacts()` 目前是两个内部读取入口。实施时应收敛到 read set，Host 不再连续调用旧入口。可以保留公开行为测试所需的轻量包装，但生产投递不能继续走“通用 Inbox 派生一次、Main 再派生一次”的双入口。

若希望同时改善普通 Inbox API，可把 `inboxForWorkspaces()` 中“候选 unread → 最终 selected rows”的中间结果保留下来，让 `notificationFacts` 和普通 Inbox 共用。不要为了复用而在 Host 拼接多个 Ledger 私有结果；派生规则应留在 Ledger 内。

### 4.3 一个可用调用形态

```text
notification batch
  -> ledger.indexSequence
  -> member A read set
     -> threads once
     -> main once
     -> plan once
     -> text once using the same plan
  -> member B read set
  -> ...
```

`notificationIdentity()` 可直接从 read set 得出，不需要独立重扫；`notificationText()` 接收已有 plan，不能再次调用 `inboxDeliveryPlan()`。

## 5. 失效与并发规则

### 5.1 必须使用的 revision

若 read set 在单个调用后仍保留，最小正确 key 是：

```text
(memberId, latestAppliedLedgerSequence, presentationEpoch)
```

- 必须使用“最新已 apply 的 operation sequence”，不能直接使用 `projectionSequence()`。后者只记录会唤醒公开 projection subscriber 的 commit；Thread/Main read 的 change scope 为空，因此不会推进它，见 `ledger.ts:2596-2608`、`:3760-3771` 和 `tests/change-scopes.spec.ts:321-345`。而 read 正会改变该 Member 的 notification material。
- `presentationEpoch` 至少覆盖不经过 ledger operation 的 Human display handle 变化。Ledger 的通用 Inbox item 会使用当前 `humanHandle`，见 `ledger.ts:751-754`、`:2055-2057`。单调用 seam 不跨过这种可变点，因此第一版不必引入复杂 epoch。
- coverage key 应继续使用 `covered + undelivered`，不能只用 Thread 数或 newest sequence。现实现据此处理未渲染 Thread、reminder 和 Main signature，见 `inbox-delivery.ts:58-86`。
- Session generation 不是原始 ledger read set 的 key，但渲染/投递状态依附 live Agent；`inboxNoticeDeliveries` 在 generation 切换时清理，见 `index.ts:1163-1177`、`:3089-3092`。

若要跨 commit 保留缓存，只按 `affectedMembersOf()` 做 member-level 失效仍不够：read、Attention 变弱、Human handle 变化和 projection 内部的派生查找都可能影响结果。先用全局 `latestAppliedLedgerSequence` 保证正确；member-level dirty version 属于后续测量项。

### 5.2 batching

`affectedMembersOf()` 已经在单个 operation 内去重。低风险批处理的边界是一次 commit：先得到 Member 集，再为每个 Member 建 read set，绝不让跨 Member 的失败互相污染。

跨 commit 的同一 tick / 短延迟合并可以作为第二阶段，但需要满足：

1. 先保留每个 Member 的最新 dirty revision，flush 时按最新 projection 派生；
2. 不改变“每个未读事实立即触达”的文档契约（`docs/team-collaboration/attention-and-messaging.md:30-41`）；
3. attempt 计数、日志和同 Thread 多 commit 的通知替换行为必须有新的验收口径。现有测试明确断言连续两次 reply 产生两个同步 notice attempt，见 `tests/post-commit-delivery.spec.ts:181-204`。

因此，跨 commit debounce 不应与 read-set 复用一起落地。现有 `covered` signature 已经避免 unchanged facts 二次投递；它保留的是“有变化就立即尝试”的语义。

### 5.3 异步边界

`notifyMemberAtWake()` 会先等待 `wakeGateFor()`。gate 可能完成 generation swap 并产生新的 ledger operation，所以：

- gate 前取得的 read set 不能直接用于 gate 后投递；
- gate 返回后必须检查当前 live Agent，再按最新 ledger revision 取得 read set；
- 不能把 in-flight Promise 当作长期缓存；失败 Promise 必须删除。

当前代码在 gate 后重新读取 live Agent，见 `index.ts:2752-2770`。新 seam 要保留这个重新派生点。

### 5.4 失败隔离

- warm Member：`emitCommitted()` 对每个 Member 分别进入 `afterCommit()`；单个 Member 的普通派生/投递失败只记录 warn，不阻止其他 Member，见 `index.ts:2616-2626`、`:2662-2668`。
- read-set 构造失败时不得写 `covered`，也不得把空结果解释为“没有未读”。
- plan/text 失败时不得调用 `beginInboxDelivery()`；当前顺序正是 render 后才开始记录 attempt，见 `index.ts:2790-2817`。
- steer/followup 失败时继续保留当前语义：operation 已提交且保留，attempt 已计，coverage 被清空，下一次相关事实触发重试，见 `index.ts:2826-2830`、`tests/post-commit-delivery.spec.ts:87-150`。
- invariant divergence 仍应由 `afterCommit()` 释放到调用方；缓存不得吞掉这类错误。

另有两个现状边界应在实施时处理或单独立项：`affectedMembersOf()` 本身在逐 Member `afterCommit()` 之外调用；cold transition 路径启动异步工作后，末尾再次调用 `notifyMember()` 没有外层 catch。前者会把不属于某个 Member 的派生异常传回已提交调用方，后者可能形成 rejected Promise。它们不是 dedup 本身，但 read-set seam 不应扩大这两个问题。

## 6. 实施优先级

### 6.1 可直接实施的低风险优化

| 优先级 | 改动 | 为什么低风险 | 应有验证 |
| --- | --- | --- | --- |
| P0 | 增加单成员 read-set，让 Host 一次取得 Thread 和 Main 通知材料，去掉 `notificationFacts()` 后的二次 selected unread 和 `memberInbox()` 产生的废弃 Main 摘要 | 保持同一 projection、同一默认 50 选择规则和同一 notice 内容；只删除同库存派生 | `post-commit-delivery.spec.ts`、`inbox-delivery.spec.ts`、`surface-agreement.spec.ts` |
| P0 | `deliverInboxNotice()` 把已算出的 plan 传给 `notificationText()`，删除文本渲染内的第二次 plan | plan 是纯函数，已有输入相同；只需把 role 投影传入 | `inbox-delivery.spec.ts:51-111`、`post-commit-delivery.spec.ts:181-239` |
| P1 | recycle 的空判断改用一次 read-set，之后把这同一 read-set 交给通知；或去掉预检，让通知路径成为唯一空判断点 | 不改变“无未读不投递”，避免同 Member 连做两轮 | `session-recycling.spec.ts`、`wake-recycle.spec.ts` |
| P1 | 专用 notice 投影不计算任务编号、live Claim owners、recent rows、Main inbox totals 等不会被 notice 使用的字段 | 只要产出字段与当前 notice 相等，就是减少无用物化；需以现有通知测试逐字守住 | `post-commit-delivery.spec.ts:152-329`、`surface-agreement.spec.ts` |
| P2 | 用 Map 替换 8 次 `plan.threads.find`，单循环同时收集 direct/ordinary 或 Main direct/ordinary | 算法与输出不变；字符串预算仍需严格按原顺序执行 | `inbox-delivery.spec.ts`、现有 notice 文本测试 |

表中 P0/P1 是逻辑风险级别，不表示代码改动行数。read-set 会涉及 Ledger 和 Host 两侧，但契约边界清楚；可先做 `plan` 复用验证模式，再做 read-set。

### 6.2 必须先测量的优化

| 改动 | 需要先回答的问题 | 不能直接做的原因 |
| --- | --- | --- |
| 跨 commit debounce / union dirty members | 50、200、1,000 follower 下每次 fan-out 多长；第二个 commit 后的即时延迟对模型有何影响 | 当前测试断言每次 commit 同步入队；延后 flush 会改变 attempt 数和唤醒时刻 |
| 进程级长期 read-set 缓存 | projection 变化后重复进入的比率、命中率、global revision 失效比例、内存 | `projectionSequence()` 不含 read progress；全局 revision 每次操作都失效，member-level 失效更复杂 |
| 只派生前 8 个 Thread，不再构造默认 50 | 第 9–50 个 Thread 对 signature、`undelivered` 和重试的实际贡献 | `covered` 当前覆盖最多 50 行，直接砍到 8 可能永久漏掉未进入 signature 的未读 |
| fan-out 并行化 | live warm 路径是否仍有真实异步；cold wake 的存储与 lifecycle 竞争 | 当前 live 通知本身是同步调用；cold 路径已由不同 lifecycle queue 异步启动，简单 `Promise.all` 不能消除同步扫描 |
| 增量 unread index | 长 Thread、千级未读、main backlog 的 p95；内存增量 | 现 `unreadForFrom()` 每次都按 Thread 遍历；建新索引会扩大 replay/invariant 责任，属于存储设计变更 |
| Main Attention 按 Project 分桶 | `mainAttention` 规模和 main post fan-out p95 | `mainStreamRecipientsFrom()` 当前全表扫描；改名或并行不能解决扫描 |
| in-flight wake 合并 | 同一 Member 在 wake gate 期间收到多 commit 的比率与 attempt 语义 | 合并后只发最终 notice，可能省重复投递，但会改变每次 commit 都尝试的现有行为 |

### 6.3 不优先处理

- `notificationIdentity()` 的两次线性扫描只处理每 Member 的 Thread/Project 列表，远小于 fact 扫描；可随 read-set 顺手生成，不值得单独设计缓存。
- `affectedMembersOf()` 的 `Set` 去重已经避免同一 Member 多次通知；外层再做一个 Member Map 对单次 operation 没有收益。
- `notificationText()` 的 32 KiB 字符预算、最多 20 个 detailed facts、最多 8 个 Thread section 是输出契约，不能为性能随意改。

## 7. 需要守住的 notice 语义

1. 每个 unread fact 都立即触达；没有“普通更新稍后投递”的分级，见 `docs/team-collaboration/attention-and-messaging.md:30-41`。
2. running Member 的多次更新可在下一 step 合并；idle Member 从 durable unread 唤醒，见 `tests/member-lifecycle-core.spec.ts:1128-1160`、`:1379-1402`。
3. direct mention 的通知携带正文；普通更新只给无正文的 Thread 更新数量，见 `tests/surface-agreement.spec.ts:80-146`。
4. 同一 facts 的 unchanged rederivation 不再消耗 attempt；新 fact 才重新投递，见 `tests/post-commit-delivery.spec.ts:210-239`、`tests/inbox-delivery.spec.ts:51-94`。
5. queued notice 替换而不是叠加；失败不回滚 commit，后续相关 commit 从 durable unread 重试，见 `tests/post-commit-delivery.spec.ts:87-150`。
6. Main 普通更新会通知 Attention 覆盖该 stream 的读者，新 discussion 也会；新 Task 不执行这条 Main 广播，见 `tests/post-commit-delivery.spec.ts:277-300`。
7. notice 内容不包含可复用的 revision/write token；detail 的裁剪和不可见 Thread 的 `undelivered` 语义不能因复用而丢失。

## 8. 建议的验收与测量

在进入跨 commit 缓存或 fan-out 改造前，至少采集：

- 单 Thread、单 Member live：commit ack、notice queued、Member running 的耗时；
- 同一 Thread、40/200 commit 连发：`affectedMembersOf`、read set、plan、render、steer 各自的累计调用次数和墙钟；
- Thread facts 1k/10k、单读者候选 1/50/500、Main sources 1k/10k/100k 的规模曲线；
- follower 1/10/50/200 的同一 commit fan-out；
- 2/10/50 个 idle 或 cold Member 同时处理既有 unread 的尾延迟；
- 失败注入：通知派生失败、snapshot 失败、plan 失败、steer 失败、wake gate 失败，验证只影响当前 Member，不改 ledger。

第一轮静态实现只需证明：在同一 ledger revision 下，旧两次派生和新一次 read-set 的 notice 文本、`covered`、`undelivered`、attempt 与 steer/followup 次序完全一致；然后再测它是否值得跨 Member 批处理。

## 9. 本次验证

在源码基线 `bf777c39ecc1ff912a3b473d85f575dd0758bdd5` 上运行了与本报告直接相关的当前测试：

```text
npx vitest run \
  packages/agent-team/tests/inbox-delivery.spec.ts \
  packages/agent-team/tests/post-commit-delivery.spec.ts \
  packages/agent-team/tests/change-scopes.spec.ts \
  packages/agent-team/tests/surface-agreement.spec.ts \
  packages/agent-team/tests/main-stream.spec.ts

5 files passed, 62 tests passed
```

```text
npx vitest run packages/agent-team/tests/member-lifecycle-core.spec.ts

1 file passed, 46 tests passed
```

这些测试确认了当前通知、失败重试、scope 与 Main stream 语义，但没有提供本报告所讨论扫描项的耗时或调用次数。报告中“可直接实施”的判断是源码等价性与失败边界判断；“应先测量”的项目没有性能收益数字。
