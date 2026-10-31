# 研究线 2：七个 Team tool 的模型调用性能

- 检查日期：2026-10-28
- `dsh-agent-team` 基线：`bf777c39ecc1ff912a3b473d85f575dd0758bdd5`
- 相邻 Harness 基线：`687f282e8625c6b8d11ff58211a90524be2e4317`
- 范围：七个模型可见 Team tool 的请求、参数解析、Host access、ledger/storage、提交后 fan-out、结果渲染和 Session 返回
- 写入范围：只重写本材料；没有修改生产代码、测试或其他文件
- 工作树原有修改：`scripts/team-ui.ui-preview.ts`，不属于本研究

**结论标记**

- **事实**：当前源码、测试或本轮实际命令直接确认。
- **推断**：由已确认的调用路径、复杂度或 Harness 契约推导，尚无当前耗时样本。
- **未测量**：缺少当前版本的毫秒、provider token、队列等待、事件循环延迟或实际模型成功率数据。

## 结论

**事实**：七个工具的模型可见定义合计 `19,125` UTF-8 bytes。用 Harness 当前 `estimateToolsTokens()` 计算为 `4,765` tokens。这是每个启用 Team preset 的模型请求都要携带的 schema 成本。最大两项是 `team_message` 和 `team_task`。

**事实**：一次成功调用不只是一段 handler。它至少经过参数 JSON 解析、参数快照与冻结、pre/tool/post waterfall、Team 参数归一化、Host 身份和 Workspace 解析、projection 查询或全局串行写队列、`table.put()` 与 projection apply、提交后 fan-out、完整 structured output 快照和 schema 校验、render、render 快照以及多次最终 materialize。Session 最后只保存 render 文本，但本次调用内仍会复制、校验和冻结完整 structured value。

**事实**：七个工具都没有声明 `isConcurrencySafe`。Harness 对未声明工具按 `exclusive` 处理，所以同一模型回复中的多个 Team call 目前按顺序执行。即使以后把纯读标成 parallel，这些 Team 读取的主体仍是 JavaScript 事件循环里的同步投影扫描，不会因此并行使用多核；收益只能是异步等待重叠，当前路径中这样的等待很少。

**事实**：最明显的上下文膨胀点是 `unread_required` 和 `stale_revision`。它们携带全部阻挡事实，而普通的 `team_thread read` 每批最多 20 条。静态样本中，400 条 unread fact 的 structured value 为 `81,636` bytes，实际 render 为 `49,030` UTF-8 bytes；Session 最终保存的是后者，但 structured value 仍承担快照、校验和冻结成本。

**事实**：当前主要算法放大点都可以定位到具体函数：

1. Thread read 在同一次结果派生中多次扫描同一 Thread。
2. 每个 unread fact 的可见面检查都会重新读取当前 Session surface。
3. 每个受影响的 live Member 都重新派生 Thread 和 Main 通知材料。
4. Task board 对每个 Task 扫描全部 Claims，形成 `Task × all Claims`。
5. `team_view` 重复取 roster，并对 Project owner 和 Task/Thread 关系做线性查找。
6. 每次 Team commit 后都可能排队一次全 ledger replay 校验。
7. 每个 Task mutation 成功后都可能重读完整 Claim archive，即使 render 不显示它。

**推断**：当前最值得优先处理的是同一输入上的确定性重复：通知 read set、Thread 扫描、surface probe、Claim 索引和 directory 后处理。完整 rejection facts、schema 尾部压缩和纯读并发应往后放，因为它们分别涉及模型往返、工具描述质量和实际并发收益，必须先有端到端数据。

**未测量**：没有当前版本的 handler、Host、SQLite、fan-out、queue wait、invariant replay、render、Session append、provider 首 token 或模型恢复轮次统计。不能用静态 bytes 推定毫秒收益，也不能把历史 replay 数字当成当前结果。

## 1. 完整调用链

```text
Agent.preStep
  -> systemPrompt.assemble
     -> project visible tool schemas
     -> detached parameter snapshots
  -> model emits tool call
  -> parseArguments
  -> ctx.tools.execute
     -> argument snapshot + deepFreeze
     -> tools/pre-execute
     -> tools/execute waterfall
        -> Team tool execute
        -> Host access and authorization
        -> direct projection read OR ledger enqueue
           -> table.put
           -> apply projection
        -> committed fan-out / notification / wake
        -> structured result
        -> output snapshot + schema validation + freeze
        -> Team render + render snapshot
        -> post-execute + final materialize
     -> tools/result
  -> Session append tool/result content
  -> next model step
```

### 1.1 请求和工具 schema

**事实**：Agent loop 在每个 step 的 `preStep()` 调用 `systemPrompt.assemble()`，见 `../deepseek-harness/packages/core/agent-loop/src/agent.ts:267-288`。

**事实**：system prompt assembly 从 tool providers 重新收集 schema，并对每个参数对象执行 `structuredClone()`，见 `../deepseek-harness/packages/core/system-prompt/src/index.ts:633-650,668-675`。ToolRegistry 自己的 `schemas()` 也先投影成 detached schema。

**推断**：静态 schema 的本地 clone/sort 成本通常远小于 provider 侧的每请求 token 成本，但仍应作为独立细分记录。它的主要价值是确认每次 step 是否异常复制大 schema，而不是靠微基准替代真实模型测量。

Harness 对模型可见 schema 和历史的契约写得很直接：

- 可见定义是每个请求的固定成本，见 `../deepseek-harness/packages/core/tools/README.md:164-176`。
- 工具参数和结果会在 compaction 前反复发送，见同文件 `:211-223`。
- schema 或工具顺序变化会使 KV cache 从变化位置失效。

### 1.2 参数进入 Harness

**事实**：`executeToolCalls()` 对每个调用执行一次 `parseArguments()`：空字符串变成 `{}`，合法 JSON 走 `JSON.parse()`，非法 JSON 保留原文交给后续校验，见 `../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:72-81,104-110`。

**事实**：进入 dispatch 后，ToolRuntime 用 `snapshotJsonValue()` 复制参数，检查无损 JSON，再 `deepFreeze()`，见 `../deepseek-harness/packages/core/tools/src/index.ts:1449-1453`。

**事实**：Team 每个 execute 又先运行 `blankToAbsent()`，会再复制一次参数对象并把空地址参数删掉，见 `packages/tool-agent-team/src/index.ts:199-217`。

**推断**：普通 Team 参数很小，这部分不是首要热点。例外是长 `body`、attachment 地址列表和模型生成的异常大参数；它们会增加 JSON parse、复制和后续错误结果体积。

### 1.3 调度和执行

**事实**：Agent loop 只把 classifier 精确返回 `true` 的调用放进 parallel pool；未声明、返回其他值或抛错都按 `exclusive`，见 `../deepseek-harness/packages/core/tools/src/index.ts:1304-1319` 与 `../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:83-100`。

**事实**：Team 的注册点是 `packages/tool-agent-team/src/index.ts:1346-1353`。七个定义均未传 `isConcurrencySafe`。

**事实**：`tools/pre-execute` 在 dispatch 前运行，`tools/execute` 包住实际 tool body，`tools/post-execute` 在结果整理阶段运行，见 Harness `core/tools/src/index.ts:1512-1545,1609-1617,1649-1666`。

### 1.4 Team handler 和 Host access

**事实**：每个 Team execute 从 `exec.agent` 取得 service，再通过 `workspaceOf()` 和 Host 方法解析 Member/Workspace 权限，例如 `team_thread` 的入口见 `packages/tool-agent-team/src/index.ts:583-634`。

**事实**：`service(agent)` 是 `agent.ctx.get('agentTeam')`；`workspaceOf()` 又取一次 service 并解析 Workspace，见 `packages/tool-agent-team/src/host-access.ts:10-14,36-54`。

**事实**：`memberForAgent()` 线性遍历 live handles，见 `packages/agent-team/src/index.ts:846-851`。Member 数通常只有几十，但一次 execute 内不应多次做同一解析。`team_view` 当前显式调用两次 `members()`，见 `packages/tool-agent-team/src/index.ts:1307-1325`。

**推断**：身份解析是低阶线性成本。它的主要问题不是单次几微秒，而是被同一请求的多个 Host 辅助读取重复调用，导致基准难归因。

### 1.5 读路径、写队列和持久化

**事实**：纯投影读，如 Inbox、Task board、history、attention status 和 view，直接读取已经应用的 projection，不进入 ledger 写队列。

**事实**：会写的 operation 进入 `AgentTeamLedger.enqueue()`。所有 operation 共用单一 `operationTail`，见 `packages/agent-team/src/ledger.ts:632,6492-6495`。

**事实**：写流程通常是 `await table.put(operation)`，成功后调用 `applyAndAdvanceProjectionVersion(operation)`。reply、DM、Claim 和 Task 的代表位置分别为 `ledger.ts:1237-1239,1831-1833,1510-1512,1627-1629`。

**事实**：Thread read 只有在存在 unread/reminder 进展时才写 `team/thread-read`；无进展时返回同一图片但不提交，见 `ledger.ts:2146-2172`。

**事实**：当前没有 queue depth、wait duration、operation phase 或 storage duration 指标。

### 1.6 提交后 fan-out

**事实**：`emitCommitted()` 依次处理 commit listener、Client change invalidation、reminder 调度和 `affectedMembersOf(operation)` 的逐 Member notice/wake，见 `packages/agent-team/src/index.ts:2590-2627`。

**事实**：warm Member 的 `notifyMember()` 会同步进入 `deliverInboxNotice()`；需要等待 generation gate 的 idle Member 转入异步 `notifyMemberAtWake()`，见 `index.ts:2729-2775`。

**事实**：`agent-team/committed` 表示 operation 已提交并开始 fan-out，不表示所有 notice 都已经送达。

**推断**：发送方工具调用的墙钟可能包含大量与接收方数量、未读规模和 wake gate 有关的同步工作。基准必须把 commit、fan-out、notice queued 和接收方实际 claim turn 分开。

### 1.7 成功结果返回

**事实**：`createSuccessResult()` 对 tool body 返回的完整 value 执行 `snapshotToolValue()`、output schema validation、`deepFreeze()`、Team render 和 render snapshot，见 Harness `core/tools/src/index.ts:1839-1869`。

**事实**：正常成功路径随后还会在 `finishScheduledExecution()` 中再次 materialize 候选结果，应用最终 content，再 materialize 一次，见 `:1677-1690`。因此大 structured value 不会因为 render 小就免费。

**事实**：Session 只追加模型可见的 `tool/result` message content、error info 和 presentation meta，不保存 structured `value`，见 `../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:263-289`。

**推断**：结果性能必须同时报告三类 bytes：

```text
structuredValueBytes
renderContentBytes
sessionToolResultBytes
```

只看其中一项会把“本次 JSON 处理”“长期上下文成本”和“Session 落盘”混在一起。

## 2. 七个工具的动作矩阵

| Tool / action | Host 主路径 | 写/提交后效果 | 主要固定或增长成本 |
| --- | --- | --- | --- |
| `team_inbox` | `inboxForAgent()` -> `memberInbox()` / `inbox()` | 查询本身不写；同时启动 reminder evaluation | 候选 Thread unread、Main unread、Task/Claim reminder facts、通知页投影 |
| `team_attention status` | `attentionStatusForAgent()` + `threadHistoryForAgent()` | 无 | 为少量 standing 构造完整 Thread history snapshot；reply context；Task number |
| `team_attention follow/unfollow` | `changeAttentionForAgent()` | ledger write、inbox delta、commit fan-out | 写队列；提交后再次取完整 history snapshot |
| `team_thread read` | `readThreadForAgent()` | 有进展时写 read receipt 和 private attention delta | 多次全 Thread 扫描；surface probe；reply context；discussion Task cards；Task number |
| `team_thread history` | `threadHistoryForAgent()` + attention status | 无 | 全 Thread filter 后 slice；reply context；Task cards；再次 attention/Task number |
| `team_thread message` | `readMessageForAgent()` + 全 history snapshot + attention status | 无 | 只为一条 Message，却构造 orientation、Task cards 和 reply context |
| `team_dm` | `sendDm()` -> audit operation -> recipient relay | durable DM；idle recipient `followup`、busy `steer` | 全局写队列；synchronous wake gate；接收方完整模型 turn；全 ledger DM history 倒扫 |
| `team_message post` | `postMainMessageForAgent()` | Main write、markers、fan-out | Main unread gate；recipient 派生；整页通知重算；无界 rejection facts |
| `team_message start` | `startThreadForAgent()` | Thread/create Task、Attention、markers、fan-out | 授权、附件、inbox delta、多 Member notice |
| `team_message reply` | `replyForAgent()` | Message、revision、markers、fan-out | unread/stale gate；mention/reply recipient；surface probe；多 Member notice |
| `team_task board` | `taskBoardForAgent()` -> `taskBoardFor()` | 无 | 全 Task 扫描；每个 Task 扫描全部 Claims；live owners；Task number |
| `team_task list` | `listClaimsForAgent()` | 无 | 单 Task claim archive 和 Thread 状态 |
| `team_task promote` | `promoteThreadForAgent()` | Task、Activity、revision、fan-out | unread/stale gate；Task/Claim projection |
| `team_task claim/done/release` | `changeClaimForAgent()` + `listClaimsForAgent()` | Claim、Task status、revision、markers、fan-out | mutation 后再次读取 Claim archive；committed render 不显示 archive |
| `team_task accept/close/reopen` | `changeTaskForAgent()` + `listClaimsForAgent()` | Task resolution、Claims、revision、fan-out | mutation 后 Claim archive 重读；Task/Claim 状态派生 |
| `team_task transfer` | `transferTaskForAgent()` + `listClaimsForAgent()` | accountable、Attention/marker、revision、fan-out | mutation 后 Claim archive 重读 |
| `team_view` | `viewForAgent({ includeCatalog: true })` + tool 后处理 | 无 | 全 Workspace ordered facts catalog；两次 roster；Project owner filter；Task × Thread `find()` |

## 3. 固定成本

### 3.1 七个工具定义

本轮重新通过 `apply()` 注册七个定义，取 `{name, description, parameters}` 后测量：

| Tool | JSON chars | UTF-8 bytes |
| --- | ---: | ---: |
| `team_inbox` | 860 | 860 |
| `team_thread` | 3,219 | 3,243 |
| `team_attention` | 1,743 | 1,747 |
| `team_message` | 5,861 | 5,889 |
| `team_dm` | 2,061 | 2,069 |
| `team_task` | 4,186 | 4,204 |
| `team_view` | 1,105 | 1,105 |
| 合计 | 19,043 | 19,125 |

**事实**：Harness 的当前 estimator 为 `ceil(JSON.stringify(tools).length / 4) + 4`，见 `../deepseek-harness/packages/llm/token-meter/src/estimate.ts:93-102`。对当前 canonical array 重新实测为 `4,765` tokens。

**事实**：`team_message` 和 `team_task` 合计占 schema UTF-8 bytes 的约 `52.8%`。

**推断**：schema 是稳定请求前缀，可能被 provider KV cache 复用。单纯缩短描述会减少每请求输入 token，也可能减少模型对工作流的提示；不应在完整模型评测前把它列为第一优先。

### 3.2 每次调用的固定处理

每个成功调用都要承担：

1. 模型参数 JSON parse。
2. Harness args snapshot 和 freeze。
3. Team args 复制和空白归一化。
4. tool pre/execute/post waterfalls。
5. Host 身份、Member 和 Workspace 解析。
6. 完整 structured result snapshot。
7. output schema validation。
8. structured value freeze。
9. render。
10. rendered content snapshot。
11. 至少一次、正常路径最多三次 final materialization。
12. Session `tool/result` append。

**推断**：args 通常远小于 result 和 schema。固定处理的主要缩放变量是 `structuredValueBytes`，尤其 Thread history、board、view 和 rejection facts。

### 3.3 ledger replay 和后台固定成本

**事实**：ledger 构造时调用 `replay()`；`validateRecords()` 从空 projection 校验一遍，随后 live state 再 apply，见 `packages/agent-team/src/ledger.ts:2807-2832`。`validate()` 同样调用 `sortedRecords()` 和完整 `validateRecords()`，见 `:2556-2568`。

**事实**：invariant plugin 在每个 commit 后用一个合并的 `setImmediate()` 调度 `validateLedger()`，见 `packages/agent-team/src/invariant.ts:40-69`。它不阻止当前 commit Promise 返回，但会占用后续同一 event-loop 的工作。

**推断**：warm 单调用基准必须在 invariant、reminder、initial notification 和 generation transition 全部静置后开始；还要另做一组“紧接 commit 的下一次调用”，测量 replay 与后台任务造成的尾延迟。

## 4. 重复读取、projection 和 replay

### 4.1 Thread read 多次扫描同一个 Thread

**事实**：read 的主路径是：

- `prepareReadReceiptFrom()` 调 `unreadForFrom()`，得到整批 unread，见 `ledger.ts:4295-4307`。
- `prepareReadFrom()` 取 anchor；首次 read 为 background 再遍历 Thread，见 `:4332-4348`。
- `remainingUnreadAfter()` 为结果中剩余 unread 数再遍历同一 Thread，见 `:4431-4447`。
- `earlierFactCount` 为 watermark 之前 facts 再次遍历同一 Thread，见 `:4362-4363`。
- `unreadForFrom()` 自己从头遍历该 Thread 的所有 facts，见 `:4385-4395`。

**推断**：一次 read 至少包含多次 `O(F)` 扫描，F 是该 Thread fact 数。若首次 read 还有背景、reminder markers、reply context，常数继续增加。这里的确定性重复可以用一个 per-call `ThreadReadScan` 收敛：一次扫描同时产出 unread、remaining markers、earlier count 和背景候选。

### 4.2 history、status 和 message 的重复构造

**事实**：`threadHistory()` 先 `threadFacts().filter(sequence < before)`，再 `slice(-limit)`，见 `ledger.ts:2212-2225`。读 1 条也会先产生该 Thread 的完整过滤数组。

**事实**：`derivedTaskCards()` 遍历全部 Tasks，寻找包含该 Thread 的 source，见 `ledger.ts:2232-2240`。

**事实**：`team_attention status` 为了 Task standing/number 调用完整 `threadHistoryForAgent(..., limit: 1)`，见 `packages/tool-agent-team/src/index.ts:434-437`。follow/unfollow 在 mutation 后又做同样调用，见 `:439-444`。

**事实**：`team_thread message` 读取单条 Message 后仍取完整 history snapshot 和 attention，见 `:607-623`。

**事实**：Host 的 `readThreadForAgent()` 和 `threadHistoryForAgent()` 都会对结果 facts 做 reply-context projection，见 `packages/agent-team/src/index.ts:1828-1836,1970-1984`。

**推断**：这些路径应增加轻量 standing/summary 查询，避免为了几个字段构造完整 history、anchor mentions、claims、cards 和 reply decoration。收益随 Thread fact 数线性增长。

### 4.3 visible-surface probe 的乘积放大

**事实**：Thread mutation 在 `deferredThreadWrite()` 中先取全部 unread；若存在 unread，就调用 `visibleSurfaceExempts()`，对每条 fact 调一次 Host probe，见 `ledger.ts:5306-5323`。

**事实**：`surfaceVisibilityProbe()` 每次 probe 都调用 `visibleTeamTexts(agent)`；后者从 Session surface 读取 Team-authored `user/message`，见 `packages/agent-team/src/surface-visibility.ts:24-34,42-64`。

**事实**：`visibleTeamTexts()` 只读取 `user/message`。普通 `tool/result` 不是 surface，所以 rejection 内已经显示的事实不能让下一次 write 自动豁免。

**推断**：最坏路径近似：

```text
unread facts
× visible Team message nodes
× substring searches
```

`every()` 遇到第一个未豁免 fact 会提前停止，因此实际调用次数取决于顺序。应先计数 probe calls、surface nodes 和 text search 次数；第一版优化可以每次 mutation 只构建一次 visible texts，并用 body cache 复用重复文本匹配。这个改动不改变豁免规则。

### 4.4 Inbox 和通知 fan-out

**事实**：`emitCommitted()` 对 `affectedMembersOf(operation)` 中每个 live Member 调用 `notifyMember()`，见 `index.ts:2616-2625`。

**事实**：`deliverInboxNotice()` 为每个 Member 调用：

- `notificationFacts()`；
- `mainNotificationFacts()`；
- `inboxDeliveryPlan()`；
- `notificationText()`。

见 `index.ts:2773-2800`。

**事实**：`notificationFacts()` 先构建完整 `memberInbox()`，再对最终页中的每个 Thread 调用 `unreadFor()`，见 `ledger.ts:2132-2143`。

**事实**：`mainNotificationFacts()` 遍历全部可见 Projects，并为每个 Project 重算 Main unread，见 `ledger.ts:1395-1408`。

**事实**：`notificationText()` 为了 role 再次调用 `inboxDeliveryPlan()`，见 `index.ts:2916-2935`。

**推断**：一个广播到 N 个 followers 的 commit 会重复进行 N 套同一投影结构的派生。各 Member 的 marker 不同，不能简单共享最终通知，但可以共享不可变的基础 Inbox/Main projection，并按 Member 叠加 marker 与 delivery policy。优先做一个只在单次 fan-out 内有效的 `NotificationReadSet`，避免引入跨 commit 旧缓存。

### 4.5 Task board 和 Claims

**事实**：`taskBoardFor()` 遍历全部 Tasks，并对每个 Task 调 `hasActiveClaim()`、`liveClaimOwners()` 和 Project ownership 判断，见 `ledger.ts:1971-2021`。

**事实**：`hasActiveClaimFrom()` 把全部 projection Claims 复制成数组，再 `.some()` 查找当前 Member/Task，见 `ledger.ts:5369-5371`。因此 T 个 Task、C 个 Claim 时，board 存在 `O(T × C)` 扫描。

**事实**：`liveClaimOwners()` 对每个 Task 走该 Task 的 Claims，这是较小的 `O(Σ C_task)`；真正的乘积放大来自 `hasActiveClaimFrom()`。

**事实**：Task transfer、accept/close/reopen 和 claim/done/release 在 mutation 后无条件调用 `listClaimsForAgent()`，见 `packages/tool-agent-team/src/index.ts:1185,1201,1215`。committed render 不显示完整 archive，但 structured `claims` 是兼容契约，测试锁在 `packages/agent-team/tests/member-lifecycle-core.spec.ts:907-921`。

**推断**：把 `hasActiveClaimFrom()` 改成直接查 `claimsByTask[taskRef]` 且有 active 前缀索引，是第一项低风险算法修复。Claim archive 重读应移到 rejection 分支，前提是修改或明确 committed structured contract；不能只因 render 不显示就删除字段。

### 4.6 `team_view`

**事实**：`viewForAgent({ includeCatalog: true })` 的 ledger catalog 会扫描 ordered facts、Threads、Tasks、members、owners 和 Claims，见 `ledger.ts:2403-2528`。

**事实**：tool 后处理又：

- 调两次 `host.members()`，见 `packages/tool-agent-team/src/index.ts:1309,1324`；
- 每个 Project 对 `view.owners.filter()`，见 `:1317`；
- 每个 Task 对 `view.threads.find()`，见 `:1335-1338`。

**事实**：tool 返回 `tasks`、Thread 的 `revision` 和 `messageCount`，但 render 不展示这些字段，见 `:1273-1296,1327-1339`。

**推断**：同一 execute 可以一次构造 member map、owner-by-project map、thread revision map，并让 catalog 只产生 address-book 所需字段。它不会改变 durable authority，但能同时减少 CPU、structured result 和 schema validation 压力。

### 4.7 DM

**事实**：DM 先 durable commit，再尝试 wake；wake 失败返回结构化 delivery error，不回滚 DM，见 `packages/agent-team/src/index.ts:1928-1957`。

**事实**：`dmHistoryBetween()` 先从全部 Members 找 sender session，再从最新 operation 倒扫整个 ledger，见 `ledger.ts:1846-1860`。

**推断**：一次成功 DM 对发送方是本机写加 gate；对接收方则启动一个完整模型 turn。后者的成本通常远大于 ledger 写。基准必须把 `dm tool result` 和 `recipient DM turn` 分开，不能只测发送工具。

## 5. 字符串和上下文膨胀

### 5.1 实测 rejection 样本

本轮直接用当前 `team_message` render 构造 400 条 unread，每条 body 100 个字符，得到：

| 项 | chars | UTF-8 bytes |
| --- | ---: | ---: |
| structured value JSON | 81,636 | 81,636 |
| rendered text | 49,025 | 49,030 |

按 Harness 的粗密度估算，render 约为 `12,261` tokens。这个数字只用于看相对规模，不是 provider tokenizer 的实际结果。

**事实**：普通 Thread read 的 unread 批次固定为最多 20，见 `ledger.ts:4305-4313`；首次 read 的 background 最多 12，见 `:4336-4350`。

**事实**：`unreadRequired()` 和 `staleRevision()` 没有对应的 fact 数上限；所有 unread 或变更 facts 都进入 structured value 和 render。写入门顺序在 `ledger.ts:5306-5310`。

**事实**：`unread_required` 仍然要求先用 `team_thread read` 确认 unread；rejection 携带 facts 不等于已经 acknowledgment。现有测试明确保留 read route，见 `packages/tool-agent-team/tests/team-rejection-payload.spec.ts:132-145`。

**推断**：由于 unread rejection 之后仍要执行 read，把所有 unread fact 再完整展示一遍很可能无法减少这次读。高频长 backlog 下，“20 条样本 + remaining count + current revision + read route”可能更合理；`stale_revision` 则要进一步区分是直接重试足够，还是同时存在 unread。这个改动必须跑模型恢复评测，因为过少上下文会增加错误重试。

### 5.2 长期上下文

**事实**：模型参数、rendered result 和 additional context 在 compaction 前反复参与请求，见 Harness tools README `:211-223`。

**事实**：Team result pruner 只在 compaction 路径运行，配置阈值为 `8192` chars，见 `cordis.patch.yml:218-223` 和 `packages/agent-team/src/member-compaction.ts:117-137`。它不是每次 tool result 后自动截断。

**事实**：通知正文有自己的预算：最多 `32 * 1024` chars、最多 8 个 Thread section、最多 20 条 details，单 message body 还有独立上限，见 `packages/agent-team/src/index.ts:2916-3000`。

**推断**：最容易长期污染上下文的是成功的 `team_task board`、`team_view`、大 `team_thread history/message`、大 `read` 和 rejection。输出 schema 会校验完整 value，render 应只保留下一次决策需要的字段，structured value 也应避免带上 render 不用的深层对象。

## 6. 错误、重试和幂等

**事实**：Team request ID 固定为 `agent-team:tool:${agent.id}:${callId}`，见 `packages/tool-agent-team/src/index.ts:195-196`。

| 情况 | 当前行为 | 成本风险 |
| --- | --- | --- |
| 同 callId、同 payload 再执行 | ledger 的 `byRequest` 路径返回已有结果，不再 `put/apply`，通常 `committed:false` | 仍经过 Harness、Team handler、部分授权和结果处理；不会再次 fan-out |
| 同 callId、不同 payload | request collision error | 一次失败模型步骤和错误结果历史 |
| 同业务意图、新 callId | 被视为新请求，会再写一条 operation | reply/DM/Task mutation 可能重复业务效果 |
| `unread_required` | 返回普通成功结果，不提交；facts、current revision 和 read route 在同一 render | 一次模型步骤；read 后通常还需一次写重试 |
| `stale_revision` | 返回普通成功结果，不提交；给 current revision | 一次模型步骤，随后可重试；若有 unread，仍会先被 unread gate 拦 |
| tool body 抛错 | Harness 转为 `Error: <message>` tool result | 一次模型步骤；错误文本进入历史 |
| DM 已 commit、wake 失败 | DM 仍 durable，工具返回 `delivered:false`，提示不要盲目重发 | 新 callId 重发会产生第二条 DM；没有 autoredelivery |
| post-commit notice 失败 | operation 和发送方成功结果保留；后续 commit 从 durable unread 重派生 | 发送调用不能靠失败回滚；接收方恢复成本未测 |

**事实**：reply 的幂等检查位于 actor、Thread、reply parent 和 recipient 解析之后，见 `ledger.ts:1187-1208`；Main post 也先派生 parent 和 recipients，见 `:1247-1260`。Task/Claim/DM 多数先查 `byRequest`。

**事实**：相同 Thread read request 重试仍会执行 `prepareRead()` 和 `readPicture()`，即使操作不会重复提交，见 `ledger.ts:2146-2153`。

**推断**：幂等保证的是 durable operation 不重复，不是工具处理免费，也不是跨 callId 的语义去重。模型看到 rejection 后选择重试，其总成本至少是两次模型步骤加一次必要的 read；优化应比较“完成一个合法写所需的总时长”，不是单次 handler 时间。

## 7. 测试、基准和 Harness 契约

### 7.1 可直接复用的测试接缝

**事实**：Harness 的 `ctx.tools.execute()` 覆盖完整 registry pipeline，现有 waterfall 测试见 `../deepseek-harness/packages/core/tools/tests/tools.spec.ts:1150-1175`。

**事实**：Team Host 的真实测试夹具位于 `packages/agent-team/tests/helpers/host-harness.ts:43-89` 和 `team-host-fixture.ts:77-128`。

**事实**：`member-lifecycle-core.spec.ts:1092-1126` 通过 Scripted adapter 走过真实模型循环，验证 rejection 作为普通 tool result 进入下一次模型 step，并检查 Session 中的 `tool/result`。

**事实**：关键行为测试包括：

- `thread-read-progress.spec.ts`：20 条批次、drain、无进展不写和重启水位。
- `post-commit-delivery.spec.ts`：wake 失败不回滚 commit、后续重新派生。
- `surface-probe.spec.ts`：只读取 Team-authored user messages、截断 body 不免除。
- `team-rejection-payload.spec.ts`：rejection facts、current revision 和 read route。
- `member-lifecycle-core.spec.ts:907-921`：Claim mutation structured archive。
- `team-tools-render.spec.ts`：模型可见文本。

**事实**：现有 `storage-bench.spec.ts` 只直接调用 `KvUnit.putRecord()` 比较 JSON 和 SQLite 的裸写，不经过 Team service、ledger replay、projection、fan-out 或工具结果处理。运行入口是：

```bash
DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts
```

### 7.2 当前缺口

**事实**：

- 没有覆盖七个 Team tool 的端到端延迟 benchmark。
- 没有 queue wait、ledger replay、fan-out 或结果规范化的分段指标。
- 没有 Team tool concurrency classifier 测试。
- 没有 100/1,000/10,000 operations 下的 board、view、thread read 曲线。
- 没有 same-callId 和 new-callId 重试的模型总耗时对比。
- 没有 provider 实际 token 和 KV cache 对比。

### 7.3 Harness 契约对基准的要求

**事实**：工具结果到达模型的是 render content，不是 structured value。Team 的 structured value 可用于业务契约和测试，但不能证明模型看到了哪些字段。

**事实**：并行分类只影响 tool body 的 dispatch 重叠；结果和 additional context 仍按模型顺序提交。

**事实**：`agent-team/committed` 是 fan-out 的起点。异步 cold wake 可能在 tool result 之后继续。

**推断**：基准必须把“工具调用”“通知入队”“接收方 claim”“接收方下一次 tool result”分开，不能用一个 `tool/result` 时间戳代表整条协作链。

## 8. 可跑基准设计

### 8.1 第一层：七个工具的确定性本地基准

建议新增一个手工启用的 test，例如未来的 `packages/tool-agent-team/tests/tool-call-pipeline-bench.spec.ts`，通过 `DSH_BENCH_TOOL_PIPELINE=1` 开启。报告阶段不创建该文件。

每组样本独立 child process，使用：

- 临时 `DSH_HOME`；
- 临时 SQLite；
- 单个 vitest worker；
- 固定 corpus builder；
- 2 次预热，至少 10 个正式样本；夜间跑 30 个；
- 写操作每个样本复制同一关闭后的 corpus 基线，避免前一个 mutation 改变后一个样本；
- 不调用真实 provider，先测本机确定路径；另做小规模模型评测测量 provider 和恢复轮次。

采样点：

```text
t0 outer.execute 开始
tDispatch tools/execute 进入
tCommit agent-team/committed 进入
tResult tools/result
tSessionResult 配对 session/event tool/result
tEnd outer.execute 完成
tIdle 可选的 Host 本地任务静置标记
```

每条 JSONL 至少带：

```text
traceId, callId, rootCallId, requestId
operationId, sequence, toolName, action
agentId, memberId, workspaceId, projectRef, threadRef, taskRef
operations, members, followers, projects, threads, facts, tasks, claims, unread
structuredValueBytes, renderBytes, sessionResultBytes
outcome, committed, attempt
```

### 8.2 规模矩阵

基础规模：

| 维度 | 值 |
| --- | --- |
| operations | 0 / 100 / 1,000 / 10,000 |
| Members | 1 / 8 / 32 |
| Workers/Projects | 1 / 4 |
| Threads | 20 / 100 / 1,000 |
| 单 Thread facts | 20 / 100 / 1,000 |
| unread | 1 / 20 / 400 |
| body | 20 chars / 8 KiB / 64 KiB |
| Tasks | 10 / 100 / 1,000 |
| Claims | 10 / 100 / 1,000 |
| visible Team Session messages | 1 / 20 / 100 |

工具场景：

1. `team_inbox`：空、20 unread、100 Threads、32 Members；reminder off/on。
2. `team_attention status`：20 和 1,000 facts；Task 和 discussion。
3. `team_thread read`：first read、caught-up read、20 unread、400 unread、有 reply context、有 Task cards。
4. `team_thread history`：第一页、深处 cursor、limit 1/20/100。
5. `team_thread message`：短 body、8 KiB、64 KiB、1,000 fact Thread。
6. `team_dm`：warm recipient、cold recipient、busy recipient、1/100/10,000 prior operations。
7. `team_message`：post/start/reply；1/8/32 followers；0/1/32 mentions；短/8 KiB/64 KiB body；unread/stale rejection。
8. `team_task board`：10/100/1,000 Tasks，10/100/1,000 Claims，`mine` off/on。
9. `team_task list` 和全部 mutation：committed、unread rejection、stale rejection、same-callId replay。
10. `team_view`：1/32 Members，100/1,000 Threads，100/1,000 Tasks，多 Project owner。

调度场景：

- 同一模型步骤 1 个 read；4 个相同 read 串行；4 个经实验 classifier 并行的 read。
- pure read / write / pure read 的模型顺序，验证 write 屏障。
- `maxParallelToolCalls=1` 与默认值。

后台场景：

- invariant on/off 独立进程；
- commit 后立即下一 call；
- 等 invariant 完成后下一 call；
- reminder tail 忙/空闲；
- 32 Member fan-out，其中 warm/cold/busy/transitioning 各一组。

重试场景：

- 同一 callId、同 payload 重复 `ctx.tools.execute()`；
- 同一 requestId 并发两次；
- 新 callId 发送同一 payload；
- unread 拒绝后 read 再接一次 write；
- stale 拒绝后直接重试；
- DM wake 失败后同 callId 和新 callId。

### 8.3 输出和判读

每个场景输出 p50/p95/max，不把不同阶段的 p95 相加作为总 p95。报告以下派生值：

```text
dispatchMs = tResult - tDispatch
commitFanoutMs = tResult - tCommit
outerMs = tEnd - t0
sessionDurabilityMs = tSessionResult - tResult
resultNormalizationRatio = renderBytes / structuredValueBytes
queueWaitMs（需要生产内部 span）
replayMs（需要生产内部 span）
nextToolTailMs = 下一 call tDispatch - 上一 tEnd
```

第一轮粗基准只回答：

1. 每个工具随 operation/fact/Task/Member 数量如何增长。
2. structured value 与 render 的差距是否显著。
3. invariant replay 是否延长紧接 commit 的下一 call。
4. fan-out 随 follower 数如何增长。
5. 同步读取的平行调度是否有真实收益。

只有粗基准显示 fan-out、queue 或 replay 某项占比明显，才值得给生产内部加 off-by-default span。

### 8.4 模型层小基准

本机 benchmark 不能测 provider 的实际 token 和模型选择。另跑一组固定模型、固定工具顺序、固定 prompt 的小样本：

- 只比较 schema A/B；
- 只比较 rejection “全部 facts”与“有界 facts + remaining + token + read route”；
- 记录输入 token、缓存命中、首 token、总耗时、调用次数、最终成功率；
- 每个样本至少包含成功写、unread recovery 和 stale recovery。

**推断**：这组模型评测决定 schema 和 rejection 截断是否值得做。即使本地 render bytes 降很多，如果模型多读一次或多重试一次，总时延可能更差。

## 9. 优化优先级

### P0：建立当前基线

1. 先落地上面的确定性 tool pipeline benchmark。
2. 加粗粒度的 queue/replay/fan-out 观测，不先重写业务。
3. 固定 Node/SQLite/Harness 版本、corpus seed 和 warmup 规则。

完成标准：能看见 7 个工具、写后下一 call、32 Member fan-out 和 10k operation 的 p95 曲线。

### P1：不改变输出的确定性复用

1. 每个 commit 为所有 recipient 构建一次只读通知基础 projection，再叠加各自 marker 和 delivery policy。
2. Thread read 用一次扫描同时得到 unread、remaining、earlier count 和背景候选；history 用序列索引替换全量 filter。
3. 每次 mutation 只构建一次 visible Team texts，并对相同 body 做结果缓存；不改变 surface-exempt 判定。
4. Task claims 改为按 Task 索引并直接判断 active claim，去掉 `Task × all Claims`。
5. `team_view` 只取一次 roster，使用 owner/thread map，去掉每个 Project/Task 的重复线性查找。
6. Claim/Task mutation 的 archived Claim 读取移到 rejection 分支；先解决 structured `claims` 兼容契约。

这些改动的共同特点是可以保留现有 render、durable facts、权限和提交顺序。

### P2：有界 rejection 和后台成本

1. 比较 rejection 全 facts 与有界 facts 的模型总完成时间。
2. 根据真实占比决定是否优化 invariant replay；不能只在本地删除校验。
3. 把 todo reminder、replay 和 fan-out 的成本计入写后下一 call，而不只看当前 tool result。
4. 对大 board/history/view，评估减少 render 不用字段是否属于兼容变化。

### P3：schema 和并发分类

1. 用 provider token、KV cache 和模型成功率评测决定是否压缩约 19 KiB schema。
2. 纯读 classifier 只在有异步等待或 Host 外部读取可重叠时才有收益；同步 JS 扫描不会因 `parallel` 并行。
3. 若实现 classifier，白名单只包含 `team_attention status`、`team_thread history/message`、`team_task board/list` 和 `team_view`。`team_inbox` 仍会启动 reminder，`team_thread read` 会写水位并可能触发 acceptance follow-up，继续 exclusive。
4. 所有写 action 保留 exclusive，不能靠单目 classifier 推断 sibling 目标。

## 10. 本轮验证

已执行的静态测量：

- 通过 Team `apply()` 注册当前七个工具，统计 name/description/parameters 的 chars、UTF-8 bytes，并套用 Harness 当前 estimator。
- 直接调用当前 `team_message` render，测量 400 条 unread、每条 100 字符的 structured/render 大小。
- 核对 Team 与相邻 Harness 的当前 HEAD、关键源码、测试和现有手工 storage benchmark。

本轮行为测试：

```bash
npx vitest run packages/agent-team/tests/thread-read-progress.spec.ts packages/agent-team/tests/post-commit-delivery.spec.ts packages/agent-team/tests/surface-probe.spec.ts packages/agent-team/tests/member-lifecycle-core.spec.ts packages/tool-agent-team/tests/team-tools-render.spec.ts packages/tool-agent-team/tests/team-rejection-payload.spec.ts packages/agent-team/tests/storage-bench.spec.ts
```

结果：Team 侧 `6` 个文件通过、`1` 个按设计跳过；`143` tests passed，`1` skipped。跳过的是只在 `DSH_BENCH_STORAGE=1` 时运行的裸存储 benchmark。

本轮 Harness 契约测试：

```bash
corepack pnpm exec vitest run packages/core/tools/tests/execution-mode.spec.ts packages/core/agent-loop/tests/tool-calls.spec.ts
```

结果：`2` 个文件、`34` tests passed。

未运行当前版本的耗时 benchmark，因此本文没有声称任何优化会节省具体毫秒或 provider token。
