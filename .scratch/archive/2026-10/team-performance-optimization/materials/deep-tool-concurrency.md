# Team tool 并发安全审查

**分析基线：** `dsh-agent-team@bf777c39`，相邻 `deepseek-harness@687f282e`（版本 `0.2.1-rc.2`）。

**结论：** 七个 Team tool 目前都没有声明 `isConcurrencySafe`，所以同一 Agent 的同一模型步骤中，所有 Team tool call 仍按提交顺序逐个执行。按当前实现，能够直接候选并行的是无持久化、无通知、无 Session 改写的投影读取：`team_attention status`、`team_thread history/message`、`team_task board/list` 和 `team_view`。`team_inbox` 看似只读，但会启动 Task reminder 评估，因此暂不应直接放行。`team_thread read` 会提交已读水位，还可能向当前 Agent 注入 acceptance reminder 或触发 compaction；DM、消息写入、Attention 写入和 Task 写入都会修改 durable Team 状态并产生提交后副作用，必须继续独占。

即使选择并行这些纯读动作，也不能先假定会显著降低耗时。当前这些读取都在 Host 的 JavaScript 事件循环中同步扫描内存投影；Harness 的并行分类只让 tool body 的异步等待重叠，不会让同步 CPU 工作并行执行。应先测同一批次串行与并行分组的 wall time，再决定是否修改分类。

## 1. Harness 并发合约

**事实：源码与测试。**

- `ToolDefinition.isConcurrencySafe(args)` 是可选的同步、纯、单目分类器，只能查看当前调用参数，不能读取 Host 状态，也不能比较相邻调用。见 `deepseek-harness/packages/core/tools/src/index.ts` 的 `ToolDefinition.isConcurrencySafe` 与 `ToolRuntime.executionMode`。
- 只有精确返回 `true` 才得到 `parallel`。未声明、参数无效、抛错或返回其他值都按 `exclusive` 处理；不存在另一个由工具声明的 `exclusive` 字段。
- 同一模型消息中的连续 `parallel` 调用组成滚动池，池大小默认 10；任一 `exclusive` 调用是单项屏障。若后一个调用在池填充时被重新分类为 `exclusive`，当前池先排空。见 `deepseek-harness/packages/core/agent-loop/src/tool-calls.ts` 的 `executeToolCalls`、`runGroup`、`fillPool`。
- 只有 dispatch/tool body 重叠。`tools/pre-execute`、`tools/post-execute`、结果提交和 additional context 仍按模型顺序执行；结果也始终按模型调用顺序写入 Session。
- 该合约没有比较 sibling、没有锁、没有资源冲突分析。分类器返回 `true` 是工具对“本次 body 可与任意其他同样声明并行的 body 重叠”的承诺。规范说明见 `deepseek-harness/.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md`。
- 并行调用不得直接修改 parent Session 或其他 parent-owned state。共享服务可以自行串行或用容量控制，但必须能承受并发 dispatch。
- 同一分类器也用于 PTC 的 nested sub-dispatch；PTC 仍保持提交顺序启动、独立有界池和 exclusive 屏障。
- Harness 测试覆盖 fail-closed 分类、参数校验、屏障、动态重分类、滚动池上限、模型顺序结果、middleware 顺序、abort drain 与 scheduler failure。相关测试为 `execution-mode.spec.ts` 和 `agent-loop/tests/tool-calls.spec.ts`。

**对 Team 的直接含义。**

- `parallel` 只解决同一 Agent 同一 tool-call batch 的等待，不协调不同 Agent。
- 对不同 Thread 的两个写也不能仅凭“目标不同”声明并行，因为单目分类器看不到 sibling 的 Thread。Team 写入必须保持 `exclusive`。
- Harness 合约本身不能证明 Team 数据一致性；Team 仍必须依靠 ledger 的全局 `operationTail` 维护 durable operation 顺序。

## 2. 逐 action 审查

| Tool / action | 状态与副作用（事实） | ledger 写队列 | 提交后事件或唤醒（事实） | 当前分类建议 |
| --- | --- | --- | --- | --- |
| `team_inbox` | 读取 Inbox 投影；调用 `inboxForAgent` 时同时启动 `scheduleTaskReminderEvaluation` | 直接查询不入队；随后 reminder 路径写操作入队 | reminder 落账后可发 `agent-team/committed`、变更通知和 Member wake | 暂维持 `exclusive`；待 reminder 副作用改造或证明后才可成为候选 |
| `team_attention status` | 读取 Thread/Main 的 Attention、Thread 摘要和 Task 编号 | 否 | 无 | 可候选 `parallel` |
| `team_attention follow` | 新增 Attention 和对应 Inbox delta | 是 | 提交事件、scope invalidation、可能 wake | 必须 `exclusive` |
| `team_attention unfollow` | 删除 Attention，并按规则清理 direct markers | 是 | 提交事件、scope invalidation、可能 wake | 必须 `exclusive` |
| `team_thread history` | 读取指定窗口内的事实、anchor、Claims 和 Task cards；不推进已读水位 | 否 | 无 | 可候选 `parallel` |
| `team_thread message` | 原样读取一条 Message，并附 Thread 摘要和 Attention | 否 | 无 | 可候选 `parallel` |
| `team_thread read` | 无未读时不写；有未读时提交 `team/thread-read` 已读水位，返回本次看到的批次 | 是，存在写时入队 | 私有读取不推进共享 projection cursor；但 committed receipt 仍走 `emitCommitted`。此外 `afterAcceptanceRead` 可向当前 Agent `followup` reminder，甚至安排 compaction | 必须 `exclusive` |
| `team_dm` | 先写 audit-only `team/dm-sent`，再向 recipient 的 live Session relay | 是 | idle recipient `followup` 完整 turn；busy recipient `steer`；wake 失败不回滚 DM | 必须 `exclusive` |
| `team_message post` | Main stream unread gate；写 Main Message、direct/main unread markers | 是 | 提交事件、Project invalidation、followers/mentions/被回复作者 wake | 必须 `exclusive` |
| `team_message start` | 创建 Thread，可选创建 Task；创建者 establish Attention，mentions 产生 direct markers | 是 | 提交事件、Project/Thread invalidation、相关 Member wake | 必须 `exclusive` |
| `team_message reply` | 先查 unread，再查 `baseRevision`；写 Message、Thread revision 和 Inbox delta；附件在 ledger 写入前准备 | 是 | 提交事件、Project/Thread invalidation、followers 与 direct recipients wake | 必须 `exclusive` |
| `team_task board` | 读取开放/完成任务和当前关系 | 否 | 无 | 可候选 `parallel` |
| `team_task list` | 读取单个 Task 的 Claims 和 Thread 状态 | 否 | 无 | 可候选 `parallel` |
| `team_task promote` | 先查 unread，再查 revision；创建 Task 和责任 Activity，推进 Thread revision | 是 | 提交事件、scope invalidation、责任相关 Member wake | 必须 `exclusive` |
| `team_task claim/done/release` | 先查 unread，再查 revision；修改 Claim、Task 状态、Thread revision 和 Inbox markers；首次 Claim 可启动自身 Attention | 是 | 提交事件、scope invalidation、相关 Member wake | 必须 `exclusive` |
| `team_task accept/close/reopen` | 先查 unread，再查 revision；修改 Task resolution、可能批量修改 Claims、推进 Thread revision 并清理/重建 markers | 是 | 提交事件、scope invalidation、验收或责任相关 Member wake | 必须 `exclusive` |
| `team_task transfer` | 先查 unread，再查 revision；修改 accountable，可能给目标建立 Attention 并写责任 marker | 是 | 提交事件、scope invalidation、目标 Member wake | 必须 `exclusive` |
| `team_view` | 读取 Workspace、Project、Member、Thread/Task catalog 和 presence snapshot | 否 | 无 | 可候选 `parallel` |

### 2.1 纯读候选

**事实：** `team_attention status`、`team_thread history`、`team_thread message`、`team_task board`、`team_task list` 和 `team_view` 都只调用 ledger 内存投影的同步查询，或者只读取 current live handle 的状态；源码中这条路径没有 `enqueue`、`table.put`、`emitCommitted`、`agent.followup` 或 `agent.steer`。

**推断：** 这六种调用具备成为 action-sensitive `isConcurrencySafe` 候选的基础，但仍要满足以下条件后再收益：

1. 同一 JS 进程内的同步扫描不会并行完成，必须先用真实 Host 数据和真实调用组合测量；
2. 多个返回值是各自执行时刻的投影快照，不承诺相同 revision；
3. 模型不应依赖这些独立读取之间存在原子快照，需要时保留顺序或重新读取。

### 2.2 `team_inbox` 暂不放行

**事实：** `team_inbox` 的查询身体只读，但 `AgentTeam.inboxForAgent` 在任何查询前调用 `scheduleTaskReminderEvaluation()`。该评估器和提醒写入有自己的队列，提醒提交后会调用 `emitCommitted`，进而可能失效 surface、发送 Inbox notice，或 steer/followup 一个 Agent。

**推断：** 这使 `team_inbox` 不是严格无副作用的 tool body。若把它分类为 parallel，它会与另一个 pure Team read 重叠，并可能在读取期间启动一组与调用结果无关的后台写入和 Session wake。第一阶段应保留 exclusive；只有在以下方案之一落实后才重新评估：把 reminder evaluation 从 Inbox query 分离，或证明并测试该异步副作用可与所有 parallel Team reads 安全重叠。

### 2.3 `team_thread read` 不能按“读工具”放行

**事实：** `team_thread.read` 在存在 unread 时提交 `team/thread-read`，所以它既是读也是写。它通过 `AgentTeamLedger.readThread` 入全局 operation queue。即便该操作不推进共享 projection version，Host 仍调用 `emitCommitted`。`readThreadForAgent` 随后调用 `afterAcceptanceRead`，在读到本人经历的工作被验收时可向当前 Agent 排入 reminder，并按 context budget 安排一次 compaction。

**推断：** 两个 `team_thread read` 若并行，ledger 写虽会被串行化，但结果会取决于谁先取得队列位置，且 Session side effect 可能在一个 tool dispatch 期间改写同一 parent Agent。单目分类器无法从参数判断“本次 read 是否会写水印或触发 acceptance boundary”，因此必须返回 false。`archived`、权限、未读和可见面条件也不能在分类器里安全探测。

### 2.4 所有写 action 保持串行

**事实：** `team_attention` 的 follow/unfollow、`team_message` 的 post/start/reply、`team_dm`、以及 `team_task` 的全部 mutation 都写 durable ledger；它们还会产生 Inbox、Attention、revision、delivery 或 wake。写入通过同一个 `operationTail` 排队。

**事实：** 每个写 request 使用 `agent-team:tool:<agentId>:<callId>`。ledger 在队列内部先查 `state.byRequest`：相同 request 和相同 payload 返回原操作，`committed` 为 false；相同 request 改 payload 报 collision。`operation-protocol.spec.ts` 对每个 durable operation 都有顺序重复请求及 collision 覆盖。

**事实：** Thread 写先检查 unread，再比较 `baseRevision`，见 `AgentTeamLedger.deferredThreadWrite`。因此同一 Thread 的并发写即使 revision 相同，也只有一个能按该基础提交；另一个会得到 `unread_required` 或 `stale_revision`，不会覆盖已提交更新。

**推断：** operation queue 能保护数据结构，却不能改变 Harness 的 parent-state 合约，也不能把两个写安全地变成“无顺序”。post-commit fan-out、Session steer/followup 和 event ordering 都需要保持可解释的模型调用顺序，所以这些 action 都应继续作为 singleton barrier。

### 2.5 DM 是写与投递两个阶段

**事实：** `dmForAgent` 先提交 audit-only `team/dm-sent`，再查找 recipient 的 live handle，经过 `wakeGateFor`，然后对 idle Agent 用 `followup`、对 busy Agent 用 `steer`。失败返回 `AgentTeamDmDeliveryError`，工具转换为 `delivered: false`；durable DM 仍存在。

**事实：** 同一 request 的重试在 `sendDm` 返回 `committed: false` 时直接返回既有结果，不再执行 relay。新的 callId 会被视为新的 DM。

**推断：** DM 不能并行。持久化顺序可由 operation queue 保证，但不同 DM 的 live relay 可能跨 Agent、等待 Session swap，并与对方当前 turn 交错；把多个 DM 并行不会提供一致的送达顺序，且会放大对同一 recipient 的 steer 次数。

## 3. 投影快照与提交顺序

**事实：源码。**

- `AgentTeamLedger.enqueue` 使用单一 `operationTail`；队列中的每个 operation 完成后才允许下一个 operation 开始。
- 写 operation 先 `await table.put(...)`，成功后调用 `applyAndAdvanceProjectionVersion` 同步修改 live projection。因此队列中的下一个写看到前一个已经 durable 且已应用的快照。
- `inbox`、`view`、`taskBoard`、`listClaims`、`threadHistory`、`readMessage`、`attentionStatus` 等纯读不经过 `operationTail`。它们在 event loop 上同步读取当前 projection。
- 一个纯读不会看到一次“已经执行一半”的 `applyTo`；但由于它不等待正在 `table.put` 的另一个 Agent 写操作，它可能看到该写提交前的最后一个 durable 快照。
- 同一 Agent 模型步骤中，若写动作保持 `exclusive`，排在写前的 pure reads 在写前运行，排在写后的 pure reads 在写完成后运行。不同 Agent 的独立 tool-call batch 没有共同的 exclusive barrier。
- 模型历史按原 tool-call 顺序提交结果，不等于各调用读取了同一 projection version。两个并行 pure read 返回不同 revision 属于允许的并发快照语义。

**需要明确的产品语义：**

- 当前可承诺的是“每个读取返回一个已提交的投影快照”和“所有写按 ledger 队列顺序提交”。
- 当前不能承诺“同一步骤中多个读取拥有同一 revision”，也不能承诺“读取总能看到调用发出后、另一个 Agent 尚未完成的最新写”。
- 若调用方要求 read-after-write，应把写保持为 exclusive barrier，或在写返回后重新读取；不能依赖两个 sibling read 的模型结果顺序。

## 4. 提交后事件与唤醒顺序

**事实：源码。**

- `emitCommitted` 的顺序是：`agent-team/committed` listener、按 ledger scope 的 Client invalidation、participation notice、affected Members 的 Inbox wake。
- `affectedMembersOf` 包含 operation 改动的 Inbox/Attention 对象、受触及 Thread 的 followers，以及 member actor 自身。
- 对普通消息、Thread 启动、Claim、Task 与 Attention 写，post-commit 路径可能 `steer` 或 `followup` 多个 Agent。
- 通知正文由 recipient 当前 durable unread 状态重新派生，不是原 operation payload 的固定副本。因此快速连续提交可以合并到一次 wake，也可以由后一次提交替换尚未消费的 Inbox hint。
- wake 失败只记录并清理本次 coverage；已提交操作保留。下一次触及同一 Member 的提交会从 durable unread 重新派生并重试。
- generation swap 中不会把 notice 投进即将退役的 Session；swap 成功后由后继 Session 的 Inbox 重新派生负责覆盖。
- 非 invariant 的 listener/wake 异常不会把已提交 Remote call 改成失败；`AgentTeamInvariantError` 例外，会向调用方抛出。
- Client change stream 明确允许合并：暂停的 consumer 只需得到最新变更位置，并不要求每个 commit 一次唤醒。

**推断：** 并发写入即使 durable sequence 正确，也不应承诺 notice、steer 或完整 Agent turn 与 operation 一一对应。正确性应以“最终 durable unread/Attention/revision 正确，且至少能重新派生”为准；若产品需要严格 event 与 commit 一对一并按序送达，当前设计不满足。

## 5. 现有测试覆盖

**事实：已有覆盖。**

- Harness：`execution-mode.spec.ts` 固定 fail-closed 分类与参数校验；`agent-loop/tests/tool-calls.spec.ts` 固定并行池、exclusive barrier、动态重分类、模型顺序结果、middleware 顺序、abort drain 和 `maxParallelToolCalls=1`。
- `operation-protocol.spec.ts` 对全部 durable operation kind 覆盖 schema、顺序同 request 重试、payload collision、legacy 读取，以及 scope/Inbox intent。
- `thread-read-progress.spec.ts` 覆盖无进展不写、逐批 draining、slim receipt 和重启后水位；属于顺序执行覆盖。
- `main-stream.spec.ts` 覆盖 Main unread gate、分页确认、Attention、marker 与 follower wake；属于顺序执行覆盖。
- `change-scopes.spec.ts` 覆盖无进展 read 不推进 version、不误唤醒；Thread/Project/Workspace scope 隔离；aborted waiter 不影响后续提交；暂停 consumer 合并多个 commit。
- `post-commit-delivery.spec.ts` 覆盖 wake 失败后 commit 仍成功、后续重派生、未变化 facts 不重复消耗投递、listener 失败与 invariant 失败的区别，以及消息触达对象。
- `member-wake-safety.spec.ts` 与 `member-wake-swap.spec.ts` 覆盖待处理输入、swap 失败修复、legacy carried input、无法计量 context 和 idle/hot/cold generation 唤醒。
- `member-execution-isolation.spec.ts` 有同一个 add request 并发只激活一次，以及两个不同 add request 可并发执行的测试；这不是七个 Team tool 的覆盖。
- `tool-agent-team` 现有测试主要覆盖 action 路由、参数拒绝、输出和渲染，没有 `isConcurrencySafe` 分类或并发调用测试。

**事实：缺口。** 当前没有任何测试同时提交两个 Team read/write action，验证 barrier、投影快照、operation sequence 和 wake 合并；也没有测试同一 request 在两个 Team tool 调用中真正 `Promise.all` 竞争。

## 6. 启用候选并行前需要的测试

### 6.1 分类与调度

1. 对七个工具建立 action truth table：仅纯读 action 返回 explicit `true`，缺少/非法 action、所有写 action、`team_thread read` 返回 `false`。
2. 通过真实 `ToolRuntime.executionMode` 验证分类器不读 Host、不产生 I/O；模型 schema 不出现 `isConcurrencySafe`。
3. 用 gated fixture 发送 `[safe-read, safe-read, write, safe-read]`，固定三组：两个 read 同时开始、write 等两者结束、末尾 read 等 write 完成。
4. 即使两个写指向不同 Thread/Project，也验证各自仍形成 exclusive barrier。
5. 设置 `maxParallelToolCalls=1`，确认配置仍能恢复全串行；设置上限 2，验证 rolling pool 不会超过上限。
6. 验证乱序结束时 `tool/result` 和 additional context 仍按模型调用顺序提交，且 abort 后未启动调用得到 synthetic result。

### 6.2 Host 并发与一致性

7. 两个不同 Agent 并发提交不同 Thread 的写：两者都提交，sequence 连续且各 Thread revision 只受影响于自己的写入。
8. 两个写对同一 Thread 使用同一 `baseRevision`：先取得队列位置的提交，后一个得到 `stale_revision`；若后一个还有 unread，优先得到 `unread_required`。不得出现 lost update。
9. 相同 requestId、相同 payload 并发执行：只新增一条 operation，所有结果引用相同 receipt，只有首个结果为 committed。
10. 相同 requestId、不同 payload 并发执行：最多一条提交，另一条发生 request collision；不得出现两条 durable record。
11. read acknowledgement 与 reply 依提交顺序产生两种确定结果：read 在先时 reply 可基于新水位；reply 在先时 read 随后确认该回复。测试不得依赖无序 Promise completion。
12. 一个写正在 `table.put` 时启动 pure read：read 可返回 pre-commit 快照，但不能读到半应用状态；写 await 完成后启动 read 必须读到新快照。
13. 同一批次两个 pure reads 跨另一个 Agent 的一次写运行：允许返回不同 revision，但每份结果必须内部一致，不能出现 Task、Thread、Claims 或 Inbox 互相矛盾的混合快照。
14. 对每个 mutation 的 `baseRevision`、unread gate、authority、request replay 分别使用两个真实 Agent 竞争，而不是只调用 mock Host。

### 6.3 提交后事件与 Session wake

15. 两个消息提交快速连续完成时，recipient 的最终 unread、Attention 和 revision 正确；允许 notice 合并，但不得持久事实丢失。
16. 第一个 wake 失败、第二个提交紧接到达时，第二个 wake 从当前 unread 重派生，覆盖两次事实；不得要求重放第一条 operation。
17. 同一 Agent 的读写并发批次中，不得让 `team_inbox` 启动的 reminder evaluation 在另一个 parallel read 期间意外 steer 当前 Agent；若未来并行 `team_inbox`，这是必需门槛。
18. generation swap 与两个连续提交交错时，old Agent 不收到重复 notice，后继 Agent 最终能看到全部 unread；记录 wake 次数与最终 facts。
19. DM 在 idle、busy、swap、无 live handle 四种状态下分别验证：durable record 只有一条；投递成功或结构化失败；同 request 不重复 relay；新 callId 明确产生新 DM。
20. 两个 DM 并发发往同一 recipient 时，固定 durable DM 顺序；若当前产品不要求 relay 顺序，应把这个事实写入测试名和设计说明，避免未来误引入 exactly-once 假设。

### 6.4 性能门槛

21. 同一真实 Team corpus 比较三组相同调用的 p50/p95：当前全 exclusive、仅纯读 action 并行、以及故意让一个读取 async 延迟的实验分支。记录 body、结果处理、总 wall time 与 event-loop delay。
22. 用 1/10/100/1,000 个 Thread/Task 和 1/4/16 个 Agent 重复 burst。只有分组确实减少端到端 p95，且正确性与 wake 次数没有回退，才保留 classifier。

## 7. 建议

**第一阶段不建议修改生产分类。** 先把 end-to-end benchmark 和上述 Host 并发测试补到足以回答三个问题：

1. 当前 Team 读取中是否存在真正可重叠的异步等待；若主体是同步扫描，`parallel` 不会带来预期收益。
2. 同一 Thread 的并发写是否只产生一个提交和一个确定的 stale/unread 结果。
3. 连续提交的 wake 是否能合并而不漏掉 durable facts。

**若基准显示 wall-time 收益，最小安全改动是 action-sensitive 分类：** `team_attention.status`、`team_thread.history`、`team_thread.message`、`team_task.board`、`team_task.list` 和 `team_view` 返回 true；其余 action 返回 false。`team_inbox` 暂保持 false。

**长期方向。** 将 reminder evaluation 与 `team_inbox` 的纯查询解耦后，可重新评估 Inbox 并行。`team_thread.read` 若未来要并行，必须先让 read acknowledgement 与 acceptance reminder/compaction 分离，并为同 Agent 多 Thread 读取规定顺序与快照语义；在此之前，ledger 的串行写队列只是防损坏，不足以证明 Harness 并发安全。

## 8. 本次验证

- `npx vitest run` 运行本仓库 8 个相关测试文件（operation protocol、Thread read、Main stream、change scope、post-commit delivery、wake safety/swap、Member execution isolation）：264 tests 通过。
- 在相邻 Harness 运行 `pnpm exec vitest run packages/core/tools/tests/execution-mode.spec.ts packages/core/agent-loop/tests/tool-calls.spec.ts`：34 tests 通过。
- 在最终基线上，单独运行 `packages/agent-team/tests/task-reminders.spec.ts`：12 tests 通过；运行 `packages/agent-team/tests/member-lifecycle-core.spec.ts`：46 tests 通过。这只能证明现有顺序测试覆盖通过，不能证明 reminder evaluation 可以安全地与 parallel Team read 重叠。
- 本次没有运行新的性能基准，因此没有新增毫秒级收益结论。
