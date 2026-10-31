# 七 个 Team tool 的模型调用链与性能基线设计

**状态：** 调研材料，2026-10-28\
**范围：** `team_inbox`、`team_attention`、`team_thread`、`team_dm`、`team_message`、`team_task`、`team_view`\
**结论：** 七个工具共用 Harness 的同一条模型 tool-call 管线。当前可以证明的主要固定成本是 native tool 声明、参数/结果 JSON 快照与校验、结果渲染、每次提交后的全账本审计，以及若干重复的 Host 读取；模型重试造成的额外完整回合目前只有历史行为数据，没有 token 或延迟基线。

证据标记：

- **事实（源码）**：由当前工作树源码或测试直接证明。行号是本次检查时的定位，符号名优先于行号。
- **事实（本地测量）**：本次只读运行得到的数字。测量方法、单位和边界同时给出。
- **事实（历史数据）**：归档 scratch 中的真实日志或活模型结果，不能代表当前构建。
- **推断**：由已证实结构和一般执行模型推出，尚未用本项目基准测量。
- **未测量**：当前没有能支持结论的数据。

## 1. 调用链

### 1.1 模型请求到工具调度

**事实（源码）。** 模型 assistant message 出现 `tool-call` 后，`../deepseek-harness/packages/core/agent-loop/src/agent.ts` 的 step 循环把整批调用交给 `executeToolCalls`。`../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts` 中的 `executeToolCalls` 先对每个 `block.arguments` 执行 `parseArguments`，随后逐项调用 registry 的 `executionMode`。

七个 Team tool 都由 `packages/tool-agent-team/src/index.ts` 的 `defineTool` 创建，并通过 `apply` 逐项注册。它们的定义没有 `isConcurrencySafe`。因此 `../deepseek-harness/packages/core/tools/src/index.ts` 的 `executionMode` 走 fail-closed 分支，返回 `{ kind: 'exclusive' }`。同一个模型 step 即使发出多个 Team 调用，也会按 `exclusive` barrier 逐个执行。

### 1.2 registry 的固定处理

**事实（源码）。** 每个 Team 调用依次经过：

1. `executeToolCalls` 调度 `runGroup`，并把 `tool/call` 写进 Session。
2. `ToolRuntime.createExecution` 用 `snapshotJsonValue` 复制参数，再用 `deepFreeze` 冻结。
3. `prepareExecution` 执行 `tools/pre-execute`，再进入 `dispatchToolBody`。
4. `defineTool.execute` 在 `packages/tool-agent-team/src/index.ts` 的包装层再次用编译出的参数 schema 调 `validate`。随后才进入具体工具的 `execute`。
5. 具体工具执行 `blankToAbsent`、动作专属检查、`Host` 调用和模型视图投影。
6. 成功值回到 `ToolRuntime.createSuccessResult`：再次 `snapshotToolValue`、校验 output schema、`deepFreeze`，调用 `output.render`，再用 `snapshotProjection` 复制渲染结果。`team_message` 还有 `presentationMeta`。
7. `postExecute` 执行 `tools/post-execute`；`finishScheduledExecution` 前后调用两次 `materializeFinalResult`。`createSuccessResult` 已物化一次，所以最终 presentation 至少经过三轮 materialization；value 只在 `createSuccessResult` 中深拷贝一次，后续 materialization 会再次复制 content、meta 和 additional contexts。
8. `tool-calls.ts` 的 `appendToolResult` 只把最终 `content`、错误信息和可选 `meta` 写入 `tool/result`；`ToolExecutionSuccess.value` 明确不进入持久事件。
9. 下一模型请求重新组装上下文，包含这次工具调用和结果。

**事实（源码）。** 参数和结果校验针对的是完整 JSON 值，不只对文本字段。结果越大，第 6、7 步的复制、校验和冻结成本越高。`team_message` 的 `presentationMeta` 还多复制一个投影；其余六个工具没有声明它。

### 1.3 Host access、ledger 和 storage

**事实（源码）。** `packages/tool-agent-team/src/index.ts` 的工具执行层只做模型契约适配。真正的授权和读写落在 `packages/agent-team/src/index.ts`，常用入口包括：

- `startThreadForAgent`
- `postMainMessageForAgent`
- `readMainStreamForAgent`
- `replyForAgent`
- `changeAttentionForAgent`
- `changeClaimForAgent`
- `promoteThreadForAgent`
- `changeTaskForAgent`
- `transferTaskForAgent`
- `taskBoardForAgent`
- `inboxForAgent`
- `readThreadForAgent`
- `dmForAgent`
- `viewForAgent`

这些入口先用 `memberCall` 拒绝对非 Member、非接纳状态或错误 Workspace 的调用，再进入 `AgentTeamLedger`。`memberCall` 调用 `memberForAgent`；后者在 `packages/agent-team/src/index.ts` 中线性遍历 `handles`。每个需要识别调用 Agent 的入口至少支付一次这个查找。

**事实（源码）。** 正常读取直接查内存投影。以 `packages/agent-team/src/ledger.ts` 的 `AgentTeamLedger` 为例，`inbox`、`threadHistory`、`taskBoard`、`view` 都不做整本账本 replay。

**事实（源码）。** 写入走每个 ledger 方法内部的 `enqueue`。`enqueue` 把操作串到 `operationTail`，写路径先 `await this.table.put(...)`，成功后才调用 `applyAndAdvanceProjectionVersion` 更新内存投影。`packages/agent-team/src/index.ts` 的 `openTeamStorage` 让 Team 使用独立 SQLite backend，路径为 `storages/agent_team.sqlite`，WAL 模式；`packages/agent-team/src/spec.ts` 的 `agentTeamDomainSpec` 定义唯一 `operations` 表。

**事实（源码）。** 每次持久提交会发布 `agent-team/committed`。`packages/agent-team/src/invariant.ts` 的 `watchCommits` 用 `setImmediate` 合并多次提交，然后调用 `ctx.agentTeam.validateLedger()`。`AgentTeamLedger.validate` 调 `validateRecords(sortedRecords())`。`sortedRecords` 本身会按 sequence 排序、做 legacy normalization，并应用到一个 scratch projection；`validateRecords` 再应用到另一个 scratch projection。一次 post-commit 审计因此至少包含一次全表读取/排序和两遍全操作 projection。冷启动 `replay` 在此基础上还增加一遍 live projection。

**事实（源码）。** 审计被推迟到当前 I/O turn 后，所以不必说它阻塞了写入响应本身；其 CPU 仍在同一进程和事件循环中，可能影响紧接着的下一步请求。实际影响见“未测量”。

### 1.4 结果返回与跨 Agent 副作用

**事实（源码）。** `appendToolResult` 建立 `tool/result` 事件，并把结果文本作为下个请求的消息内容。`cordis.patch.yml` 把 `team-member` preset 设为 native tool presentation。`../deepseek-harness/packages/core/tools/src/index.ts` 的 `wireSchemas` 在 native 模式通过 `schemaOf(definition, false)` 暴露所有可见工具的 name、description 和 parameters；`../deepseek-harness/packages/core/system-prompt/src/index.ts` 的 `assemble` 还会对每个参数 schema 做 `structuredClone`。

**事实（源码）。** `cordis.patch.yml` 为成员挂载 `dsh-compaction-tool-result-pruner`，参数为 `thresholdChars: 8192`、`headChars: 4096`、`tailChars: 1024`。`packages/compaction/compaction-tool-result-pruner/src/index.ts` 的 `pruneSession` 只在 `compaction-basic` 的 overflow 或 pressure compaction 中调用。它不保证每次大结果立即缩短；结果会先作为下一轮模型输入。

**事实（源码）。** 消息和多数 Team mutation 在 ledger 返回后，Host 同步执行 `emitCommittedOutcome`/`emitCommitted`。`emitCommitted` 通过同步的 `afterCommit` 依次派发 `agent-team/committed` listener、Client invalidation、Task reminder 调度，并遍历 `affectedMembersOf(operation)` 调用 `notifyMember`。因此 tool 自身的 wall time 包含受影响成员的通知构造与入队，而不能只看 ledger `put`。各 `afterCommit` effect 的异常被降级为日志。

**事实（源码）。** `team_dm` 与 Team notice 会跨 Agent 注水。`dmForAgent` 先持久化 DM，再查找 live handle；idle recipient 用 `followup` 获得完整新 turn，busy recipient 用 `steer` 并入当前 turn。对方离线时返回 `AgentTeamDmDeliveryError`/`delivered: false`，记录保留，但没有自动重投。`team_dm` 的 description 明确写明每次 DM 会让 idle recipient 支付一个完整 agent turn。

## 2. 七个工具的实际路径

| 工具 | 模型调用进入 Host 的主路径 | 本次调用是否写 ledger | 主要重复/放大点 |
| --- | --- | --- | --- |
| `team_inbox` | `inboxForAgent` -> `memberInbox` -> `inboxForWorkspaces` | 否 | 为每个候选 Thread 扫事实；随后 `mainInboxItems` 再扫 Project 与 Main facts；`taskNumbers` 先扫 Task 编号 |
| `team_attention` | Main: `mainAttentionStatusForAgent` 或 `changeAttentionForAgent`；Thread: `attentionStatusForAgent` / `changeAttentionForAgent` | status 否；follow/unfollow 是 | Thread 状态总是再取一份 `threadHistoryForAgent({ beforeSequence: 1, limit: 1 })`，再通过 `resolveTaskRefs` 单独求 Task 编号 |
| `team_thread` | `readThreadForAgent`、`threadHistoryForAgent`、`readMessageForAgent`、`readMainStreamForAgent` | `read` 有未读时写 receipt；已读时无写；`history`/`message` 不写 | `read` 多次扫同一 Thread；taskless `read` 再取 history 生成 Task cards。`history` 再取 attention。`message` 再取 history snapshot 和 attention |
| `team_dm` | `dmForAgent` -> `sendDm` -> `emitCommitted` -> relay / wake | 是 | `dmHistoryBetween` 从最新 operation 反向扫账本，遇到先前 DM 才停；idle recipient 另起完整 turn |
| `team_message` | `postMainMessageForAgent`、`startThreadForAgent` 或 `replyForAgent` | 成功时是；业务拒绝时不提交 | 多动作共享一个大 schema；成功结果有 `presentationMeta`；被 unread/stale 拒绝时返回 gating facts，换一次正确执行会形成额外模型 step |
| `team_task` | board: `taskBoardForAgent`；list: `listClaimsForAgent`；变更: `changeClaimForAgent` / `changeTaskForAgent` / `transferTaskForAgent` / `promoteThreadForAgent` | board/list 否；变更成功时是 | board 对每个 Task 查 live Claim；所有变更 outcome 在工具层再调一次 `listClaimsForAgent`。claim/done/release 的 committed value 和所有 rejection 带完整 archive，transfer/accept/close/reopen 的 committed value 不保留它 |
| `team_view` | `viewForAgent` -> `AgentTeamLedger.view` | 否 | `includeCatalog: true` 时扫描全部 ordered facts，生成全部 Thread/Task catalog、Project×Member memberships；工具层再次调 `host.members()`，并对每个 Task 执行 `view.threads.find` |

## 3. 每次调用的固定成本

### 3.1 native tool 声明

**事实（本地测量）。** 本次直接用当前 `packages/tool-agent-team/src/index.ts` 的 `apply` 注册定义，再按 OpenAI-compatible `{ type: "function", function: { name, description, parameters } }` 序列化。使用 UTF-8 `Buffer.byteLength`，只算 name、description 和参数 schema，不算 provider 包装或 token：

| 工具 | bytes |
| --- | ---: |
| `team_inbox` | 891 |
| `team_thread` | 3,274 |
| `team_attention` | 1,778 |
| `team_message` | 5,920 |
| `team_dm` | 2,100 |
| `team_task` | 4,235 |
| `team_view` | 1,136 |
| **七项 payload 合计** | **19,334** |
| **JSON array 合计** | **19,342** |

description 合计 7,376 bytes，parameters 合计 11,389 bytes。`team_message` 单项最大，占 5,920 bytes；`team_task` 的 description 单独已有 2,044 bytes。

**事实（本地测量）。** 七个 output schema 合计 15,125 bytes。`wireSchemas` 只把 name、description、parameters 发给模型，因此 output schema 不进入请求上下文；它进入每次成功结果的校验与快照成本。

**事实（源码）。** prompt assembly 组装工具段时会对每个参数 schema 做 `structuredClone`；`../deepseek-harness/packages/core/session/src/request-header.ts` 的 `headerEquals` 又通过逐 schema 的 `JSON.stringify` 比较 header。Team preset 使用 native 模式，所以七份声明都在模型工具面。

**未测量：** 19,334 bytes 对应多少 token；provider 是否缓存完整 tools 段；schema 对首 token 延迟和写调用准确率各有多大影响。字节数不能直接换算 token。

### 3.2 参数和结果的 JSON 边界

**事实（源码）。** 一次成功调用至少有这些与值大小近似线性的步骤：参数 snapshot + freeze、参数 schema validation、output value snapshot + validation + freeze、render、render snapshot，以及最终 content 的三轮 materialization。`team_message` 多一次 presentationMeta snapshot；后续 materialization 也会重复复制该 meta。

**事实（源码）。** Team 的 `unread_required` 和 `stale_revision` 是正常 success value，`isError:false`，所以仍支付 output schema validation 和 render。thrown error 走失败结果，不支付成功 output 的 schema/render。三类结果要分开 benchmark，不能用一个“tool call”均值混合。

**推断：** 大型 `team_thread read/history`、`team_view`、`team_task board` 的 cost 不只来自查询本身，也来自随后对已经投影好的结构化 value 和文本 content 做多次深复制。此路径需要真实基准拆分，不能只看 Host 查询耗时。

**事实（源码）。** `team_message` 的 `attachmentPaths` 在进入 ledger 前先全部 `validatePathAttachment`，再逐个串行 `copyPathAttachment`；`attachments` 也逐个读取 cache metadata。文件越多、越大，tool 在开始 ledger 写入前等待越久。基准必须单列附件尺寸/数量，否则会把文件 I/O 错算成账本或模型成本。

### 3.3 事件循环和审计

**事实（源码）。** post-commit invariant 的 `setImmediate` 合并只减少连续提交触发的次数，不改变每次审计扫描整本账本的事实。

**推断：** 账本越大，提交后的下一次模型 step 越可能被同步 CPU 审计拖慢。因为审计位于 `setImmediate`，单看工具 Promise 的 wall time 可能漏掉这段成本。

**未测量：** 当前 SQLite 写、`applyTo`、`validate` 和事件循环延迟各自占一次 mutation 的多少；账本从 1k 增到 100k operations 时的曲线。

## 4. 读取与 projection 的复杂度

以下 `F` 为单 Thread facts，`T` 为 Threads，`K` 为 Tasks，`C` 为 Claims，`P` 为 Projects，`M` 为 Members。复杂度依据当前投影结构，不代表已测墙钟时间。

### 4.1 `team_inbox`

**事实（源码）。** `inboxForWorkspaces` 先从 Attention/direct/activity/reminder 派生索引取候选 Thread，再对每个候选调用 `unreadFor`；`unreadForFrom` 遍历该 Thread 的全部 facts。之后 `mainInboxItems` 遍历 Projects。每个返回 Thread 还执行 reminder、Attention、actor、task number 和 live Claim owner 的投影。

**推断：** 正常 follower 很多但每 Thread 很短时接近 `O(候选 Thread 数 + 总候选 facts + Project 数)`；少数长 Thread 会显著放大。它不是固定的“最多 50 行”成本，limit 只限制最终 items，候选和未读计数仍要先算。

### 4.2 `team_thread read/history/message`

**事实（源码）。** `readThread` 的 `prepareReadReceiptFrom` 调 `unreadForFrom` 扫一次 Thread；`prepareReadFrom` 的 `remainingUnreadAfter` 再扫一次；`earlierFactCount` 再扫一次。首次 follow 读取还可能再扫一次生成最多 12 条 background。因此常见 `read` 是 3 次事实扫描，首次读取可到 4 次。

**事实（源码）。** 工具层在 taskless `read` 上又调 `threadHistoryForAgent` 只为了取 `taskCards`；`history` 和 `message` 在 Host 结果之后又调 `attentionStatusForAgent`。有 Task 时还会单独调 `resolveTaskRefs` 求编号。

**推断：** 单 Thread 100–1,000 facts、短 body 时，这些重复扫描仍会先表现为 CPU；body 很大时，JSON 快照和模型上下文会更快成为主成本。`history limit` 默认 20、最大 100，但 `threadHistory` 仍先构造 `threadFacts(...).filter(...)` 的全集再截断，因此 limit 不把扫描成本压到页大小。

### 4.3 `team_task board`

**事实（源码）。** `taskBoardFor` 遍历全部 `state.tasks`。每个 Task 调 `hasActiveClaim`；其实现遍历全部 `state.claims.values()`。同时 `liveClaimOwners` 使用按 Task 索引的 `claimsByTask`。另有 `taskNumbers(workspaceId)` 扫描全部 Task 编号。

**推断：** 当 `C` 随 `K` 增长时，board 的 Claim 判断接近 `O(K*C)`；`claimsByTask` 已经存在，所以这里没有必须付出全局扫描的理由。这个判断应先用 1k/10k Claims 基准证实，再改。

### 4.4 `team_view`

**事实（源码）。** `AgentTeamLedger.view` 在 `includeCatalog: true` 时正向或反向扫描全部 `orderedFacts`，遍历全部 Threads 和 Tasks 生成 catalog，并用 `projectRefs × members` 生成成员关系。

**事实（源码）。** 工具层随后调用一次 `host.members()` 构造 handles map，又在 members 投影中第二次调用 `host.members()`；`tasks.map` 内对每个 Task 执行 `view.threads.find`。若 Task 与 Thread 均为 `N`，这一层是二次方。

**推断：** 小 Team 下 `team_view` 的固定开销主要来自 schema/结果快照；大 Team 下 catalog 全扫描和 Task×Thread 搜索都可能超过 schema 成本。

### 4.5 多 Agent 并发

**事实（源码）。** 一个 `AgentTeamLedger` 的所有写操作经同一个 `operationTail` 串行。不同 Agent、不同 Project 的 claim、reply、attention、DM 和 read receipt 也排在同一个队列。单步内的 `exclusive` barrier 和跨 Agent 的 ledger 串行是两层队列。

**推断：** 大规模 subagent 同时工作时，最先可观察到的争用可能是写队列等待和写入后的 event-loop 延迟；纯 inbox/view 读取可并发进入 Host，但它们也会争用同一个 JS 事件循环。

**未测量：** 同 Project 与跨 Project 并发的差别、N 个 Agent 同时读取/写入时的 p95、写队列等待、通知洪峰、idle DM fan-out 造成的完整模型 turn 数。

## 5. replay、notification 和上下文膨胀

### 5.1 replay

**事实（源码）。** `sortedRecords` 读取并排序整个 `operations` 表，构建 occurrence/instant 索引，做 legacy normalization，并在 scratch projection 上应用全部 operations。`validateRecords` 再做完整性、授权、Inbox delta、派生关系校验，并应用另一个 scratch projection。冷启动 `replay` 随后才把同一批 operations 应用于 live `state`。

**事实（源码）。** 读路径通常不 replay 全账本；风险集中在启动、每次提交后的 invariant audit、Session swap/wake 的 `measureLiveContext`，以及任何显式 `validate`/replay 测试。

**未测量：** 真实账本的 operation 数分布、每条 operation 平均大小、SQLite 读取与 JSON/Zod 解码占比、三次 projection 各占冷启动多久。`packages/agent-team/tests/storage-bench.spec.ts` 的注释里说 fixture 约 3.4 KB/operation，但那是 benchmark fixture，不是生产统计。

### 5.2 notification 重复派生

**事实（源码）。** `deliverInboxNotice` 先调 `notificationFacts` 和 `mainNotificationFacts`。`notificationFacts` 内先跑一次 `memberInbox`/`inbox`，再对每个返回 Thread 调一次 `unreadFor`。同一个 notice 还调用 `inboxDeliveryPlan`，`notificationText` 内部又调一次 `inboxDeliveryPlan`。

**事实（源码）。** 自动 notice 上限是 8 Threads、20 条 detail、单正文 8 KiB、总文本 32 KiB。`notificationText` 会为最多 8 个 Thread 再线性查找 plan 中的 Thread，但在 8 的上限下影响有限。

**推断：** 一次看似只渲染通知的 commit，可能支付两轮 Inbox/未读投影和两次 delivery plan。大 Team 的重复成本主要来自扫描，随后才可能是字符串拼接。

### 5.3 结果文本

**事实（源码）。** `team_inbox`、board、view 和 notice 对标题/正文做了短摘要；`team_thread read/history/message` 返回 Message 的原始 `body`，单个正文没有在本路径看到固定字符上限。一次最多包含 20 条 unread，首次 follow 还可附 12 条 background。

**事实（源码）。** rejection 会把 gating facts 渲染回模型，使用与 read 相同的 `factLine`。这能减少盲目重试，但拒绝文本也可能携带多段正文。

**事实（源码）。** tool result pruner 的阈值在工作树配置中是 8,192 characters，压缩时保留头 4,096 和尾 1,024（加 marker）；它是 compaction 阶段的服务，不是 tool result 一产生就无条件执行的逐调用截断。

**事实（本地测量）。** 当前 `.scratch/local/team-tools-model-eval/` 保留 13 份 transcript、69 次 Team 调用。从完整 `messages` 中取 tool content 长度：p50 416，p95 679，max 2,530 characters；Team tool `execute + output.render` 的整数毫秒计时为 p50 1 ms、p95 5 ms、max 12 ms，其中 16 次被计为 0 ms。

**边界。** 这 69 次来自旧 harness，直接调用 `tool.execute` 和 `output.render`，绕过 `ToolRuntime`、真实 Agent loop、provider 和 Session 写入；整数毫秒分辨率也粗。它只能说明这批干净短场景的 Team 侧文本通常不大，不能作为当前完整调用链性能。

## 6. 错误、重试和幂等

**事实（源码）。** `packages/tool-agent-team/src/index.ts` 的 `requestId(agentId, callId)` 把模型 tool-call id 编成 ledger request id。ledger 的 `byRequest` 只对完全相同的 request id 起幂等作用：相同 payload 重放已有 operation，payload 不同则冲突。

**推断：** 模型把一次业务拒绝读进上下文后，下一轮通常生成新的 tool-call id；新 id 对应新的 ledger request id，因而不能命中 `byRequest`。ledger 本身保证的是同一 call id 的重放，不保证模型改派生的新调用去重。以下恢复路径应假设会产生新的模型 step：

- `unread_required` 后先 read、再重新 write；
- `stale_revision` 后重新 read、再 write；
- action-only 参数错误、缺 ref、空 body 后改写参数；
- dispatch 前抛错后，模型在下一 step 重试。

相同模型 call id 的真实重放可以命中 byRequest；`packages/agent-team/tests/operation-protocol.spec.ts` 的 `RetryCoverage` 对每个当前 operation kind 覆盖 same-request replay、changed-payload collision 和 result mapping。`packages/agent-team/tests/agent-team-attention.spec.ts` 与 `packages/agent-team/tests/agent-team-transfer.spec.ts` 另有 DM 和 transfer 的幂等断言。

**事实（源码）。** `team_thread read` 在 Inbox delta 为空时不写 operation；同一 request id 已在 byRequest 时只重放 receipt，但 picture 仍按当前 projection 重新派生。也就是说，retry 省掉重复持久写入，不省结果投影。

**事实（源码）。** DM 的持久化和投递不是一个原子成功：先提交 `team/dm-sent`，找不到 live handle、wake gate 失败或投递抛错时返回结构性 delivery failure。没有自动 redelivery；工具说明要求发送方不要盲目重发。

**事实（历史数据）。** 归档 `.scratch/archive/2026-10/team-tools-model-eval/materials/2026-10-28-corpus-findings.md` 统计 7,239 次 Team 调用：6,771 成功、223 业务拒绝、245 抛错，摩擦 468 次（6.5%）。拒绝中 186 次 `unread_required`、35 次 `stale_revision`，43 次参数校验失败，其余包含已修复的旧参数形状。

**事实（历史数据）。** 同目录 `2026-10-28-live-eval-findings.md` 的 fresh-host 活模型 eval 为 144 次调用、140 成功、4 次抛错，集中在 message ref 形状；三处旧参数修复后，10-28 的 gpt-6.1-sol 小样本 8 次调用全绿。

**推断：** 一次多出来的模型 step 往往比一次本地 projection 扫描更贵，因为要重新发送 instruction、历史 tool results 和全部 tool schemas，再等待生成。其 token 和 wall-time 影响尚未测量。

**未测量：** 当前构建中各拒绝种类的发生率；一次 rejection→read→retry 的平均 p50/p95 延迟、输入 token 增量、成功增加轮数；provider 对相同前缀/tools 的缓存命中。

## 7. 现有测试和 benchmark 能证明什么

| 证据 | 能证明 | 不能证明 |
| --- | --- | --- |
| `packages/agent-team/tests/operation-protocol.spec.ts`、`agent-team-attention.spec.ts`、`agent-team-transfer.spec.ts`、`thread-read-progress.spec.ts` | request-id replay、changed-payload collision、DM/transfer 幂等、read 无 delta 时不写、结果映射正确 | 重试延迟、额外模型轮数、token 成本 |
| `packages/tool-agent-team/tests/team-tools-render.spec.ts`、`team-rejection-payload.spec.ts` | 成功/拒绝/陈旧 token 的模型可见文本契约 | 渲染耗时、文本 token、模型是否一次恢复 |
| `packages/agent-team/tests/storage-bench.spec.ts` | `KvUnit.putRecord` 的 JSON 与 SQLite 后端写曲线；用 `DSH_BENCH_STORAGE=1` 可手动运行 | ledger enqueue、projection、invariant、tool registry、模型上下文 |
| `.scratch/archive/2026-10/team-tools-model-eval/harness/live-eval.mts` | 七个真实 schema 和真实 Host 可在隔离环境中驱动；已有 10 个场景种子 | 它直接调用 `tool.execute` + `output.render`，绕过完整 registry；没有 usage/token、event-loop 或 replay 指标 |
| `.scratch/archive/.../materials/2026-10-28-corpus-findings.md` | 历史真实调用中的拒绝/抛错形状和数量 | 当前构建表现、延迟、token、项目规模相关性 |
| 本次 19,334-byte tool 声明测量 | 当前源码在 native 模式下有明确的大声明面 | token 数、provider 缓存收益、对模型正确率的影响 |

**事实（源码）。** Harness 已有能走真实 `ctx.tools.execute` 的测试路径，例如 `packages/agent-team/tests/member-lifecycle-core.spec.ts` 和 `member-tool-policy.spec.ts`。它们证明完整 registry 路径可测，但没有建立性能门槛。

## 8. 可运行的基准设计

基准分成三层。三层都要使用固定随机种子、同机、同一 Node 版本、串行运行，并记录环境信息。

### 8.1 第 1 层：ledger / Host 微基准

建议新增（本次只设计，未创建）：

```text
.scratch/active/team-performance-optimization/materials/bench/ledger-pipeline.mts
```

运行入口：

```bash
node --import tsx .scratch/active/team-performance-optimization/materials/bench/ledger-pipeline.mts \
  --profile small --repeat 30 --json
node --import tsx .scratch/active/team-performance-optimization/materials/bench/ledger-pipeline.mts \
  --profile medium --repeat 10 --json
node --import tsx .scratch/active/team-performance-optimization/materials/bench/ledger-pipeline.mts \
  --profile large --repeat 3 --json
```

固定数据集建议：

| profile | Workspaces | Projects | Members | Threads | facts/Thread | Tasks | Claims/Task |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 1 | 1 | 3 | 30 | 10 | 20 | 1 |
| medium | 3 | 30 | 100 | 5,000 | 50 | 2,000 | 5 |
| large | 3 | 100 | 300 | 10,000 | 100 | 10,000 | 10 |

测量项：

- 写入单次 operation：`table.put`、`applyTo`、总 wall time；
- post-commit `validate`：读表、排序、两遍 projection、event-loop delay；
- 冷启动：open storage、schema decode、`sortedRecords`、validation replay、live replay；
- `inboxForAgent`：空、1 Thread、50 Threads、每 Thread 1/100/1,000 facts；
- `readThreadForAgent`：首读、已读 no-op、20-fact 读、后续页；
- `threadHistoryForAgent`：limit 20/100，F=100/10,000；
- `taskBoardForAgent`：K=10/1,000/10,000，C/Task=0/1/10；
- `viewForAgent`：first page、continuation、full catalog；
- `dmHistoryBetween`：0/1/10k 非 DM operations 位于最新 DM 之前；
- 同 request id 重放：确认 operation 数不增，分别记录 ledger 命中、result 投影和 render；
- 每项前做 golden assertion：读操作不增 operation，read 无 delta 不增，成功 mutation 恰好加 1，same-request replay 不增。

统计：每项 warm-up 至少 5 次，正式样本不少于 30；输出 p50、p95、p99、均值、峰值 RSS 和 `monitorEventLoopDelay` 的 max/p99。大样本可以减少次数，但不得只报单次。

### 8.2 第 2 层：真实 Harness tool registry

建议入口：

```text
.scratch/active/team-performance-optimization/materials/bench/tool-runtime.mts
```

```bash
node --import tsx .scratch/active/team-performance-optimization/materials/bench/tool-runtime.mts \
  --suite all --profile medium --repeat 30 --json
```

用真实 `realHarness`/`ctx.tools.execute`，不要像归档 `live-eval.mts` 那样直接调 `tool.execute`。每个场景至少测：

| 编号 | 场景 | 预期路径 |
| --- | --- | --- |
| R0 | 无副作用 no-op 工具 | 分离 registry 固定成本 |
| R1 | inbox 空 / 50 Threads | 无写读取 |
| R2 | Thread 首读 / 20-fact 读 / 已读 no-op | receipt 写与无写两条路径 |
| R3 | history 20 / 100；message 单条 | 无写、长 body |
| R4 | attention status / follow | 读与写 |
| R5 | board / list / claim / done | 大 Claim 集 |
| R6 | view first / continuation | catalog 扫描与映射 |
| R7 | message start / reply / post；0/1/8 个附件，空/中/近上限尺寸 | mutation、rejection 与文件 I/O |
| R8 | DM online idle / busy / offline | cross-Agent wake |
| R9 | 同一 call id 重发 | byRequest 幂等 |
| R10 | 新 call id 重复 mutation | 新 operation，度量模型层需要防的重复 |

另跑协作并发 suite。场景使用 1、10、50、200 个真实 Member 身份，分别覆盖：

- C1：同 Project 的不同 Thread 同时 reply；
- C2：不同 Project 同时 claim/done；
- C3：混合 `team_inbox`、`team_thread read` 与 `team_message`，记录读延迟是否被长写队列拖累；
- C4：N 个 DM 分别命中 idle、busy、offline recipient，记录 wake 数、完整 agent turn 数及模型副作用延迟；
- C5：同一批未读变化触发多个 follower notice，记录 notice 合并次数、投影次数和投递数。

每项记录发起至拿到 tool result 的 wall time、进入 ledger 到开始 `table.put` 的排队时间、`table.put`、projection、post-commit audit、notify/wake 时间，以及 event-loop delay。所有 Agent 必须走现有 Member/session 路径；压测代码不能绕过授权或直接改 projection。

每项分别记录 `registry.execute` 总耗时、工具 body、pre/post policy、result snapshot/validate、render、Session append。实现时可在 bench 专用 wrapper 中埋点；不得把采样日志留在生产路径。

额外跑两个调度对照：

1. 同一 assistant step 提交 `team_inbox + team_view + team_thread history`；当前应为 exclusive 串行。记录总 wall time 与单独执行之和。
2. 同一批里放两个会写 ledger 的调用，确认串行和 operation sequence，作为未来只给纯读工具 opt-in 并行的正确性基线。

### 8.3 第 3 层：真实 Agent/model 循环

可以先扩展现有 `.scratch/archive/2026-10/team-tools-model-eval/harness/live-eval.mts`，也可以复制后改成使用真实 `ctx.tools.execute`。场景保留并补齐：

- inbox triage：`team_inbox -> team_thread read -> reply`；
- drain：一次 read 后仍有 unread，再 read，直到写 token 出现；
- long history：`history` 多页后总结；
- attention：status -> follow -> update -> unfollow；
- board：`board -> list -> claim -> done`；
- view：first page -> continuation -> task detail；
- Main stream：read -> post -> reply target；
- DM：idle、busy、offline；
- 三类恢复：`unread_required -> read -> retry`、`stale_revision -> read -> retry`、ref/action-only error -> corrected retry；
- 同一写入用相同 call id 重放，以及用新 call id 再发一次。

每个场景记录：模型 step 数、Team call 数、成功/拒绝/抛错数、完整回合数、provider wall time、`assistant/message.usage` 的 input/output/cached token、每步 request messages bytes、tool schema bytes、tool result chars、notice chars、冷启动/审计耗时和 event-loop max delay。

活模型部分至少对每个关键场景跑 5 轮及多种子；报告分布和 p50/p95，不用一次成功/失败判定。脚本或 provider 失败要单独计为 infra failure，不能混入业务拒绝。

### 8.4 已有命令

现有 storage 后端基准可以立即运行：

```bash
DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts
```

归档 harness 的 smoke 可以验证种子和 Host 组合：

```bash
node --import tsx .scratch/archive/2026-10/team-tools-model-eval/harness/smoke.mts
```

这两个命令只覆盖首尾局部，不能替代第 1–3 层。

## 9. 优化优先级

优先级按“先拿到可归因基线，再处理源码已证明的放大点”排列。每一项都需要基准中的对应结果才能确认收益。

| 优先级 | 候选 | 预期收益 | 风险/前置条件 |
| --- | --- | --- | --- |
| P0 | 建立上述三层基线并保存机器、seed、版本 | 让后续优化可比较；识别模型重试、Host 读取、registry 包装、ledger 审计各占多少 | 这是测量工作，不是产品改动 |
| P0 | A/B 测量当前 rejection→read→retry 的回合和 token | 若一次恢复多花一整轮，压缩模型回合通常收益最大 | 不得削弱 unread/stale 并发保护；先证明当前发生率 |
| P1 | 把 post-commit 全表 `validate` 从每次提交拆成增量检查 + 定期完整审计 | 直接减少每次 mutation 后的 O(N) 读表、排序和两遍 projection | 需定义审计延迟、故障观测和测试；不能失去 divergence 检测 |
| P1 | 合并 Host 重复读取：attention 的 history/status、thread 的 task number/task cards、notification 的两次 inbox/plan | 去掉已由源码证明的重复投影，不改变工具语义 | 先测 medium/large 的占比；保持 read receipt 与 write token 合同 |
| P1 | `team_task` 只在 rejection 需要时 `listClaimsForAgent`；committed value 不带 render 未使用的完整 Claim archive | 去掉每次成功 mutation 的计划外重读、Claim 复制和 output schema 负载 | 若 Client 或其他消费者依赖结构化 `claims`，先改为可信的窄字段或独立查询 |
| P2 | board 的 `hasActiveClaimFrom` 改用 `claimsByTask`；view 的 Task→Thread 用 Map；`host.members()` 只取一次 | 把 `O(K*C)`、Task×Thread 查找和重复 roster 投影降为线性 | 用 K/C/T 规模曲线证明是热点；保持排序和权限 |
| P2 | 将 Thread read 的三至四次 unread 扫描合并为单遍，返回 unread facts、remaining count、earlier count | 长 Thread 的 read/write 前置成本显著下降 | read、replay、marker consumption 三者必须继续同源；需要强回归测试 |
| P2 | 对 `team_inbox`、view、notification 的候选与 catalog 增加或复用派生索引 | 大 Team 的 triage 和唤醒成本下降 | 索引必须由唯一 append operation 更新；不得出现第二权威 |
| P2 | 验证写队列后设计 group commit 或按操作类型合并持久化批次 | 减少多 subagent 同时写时的 SQLite 往返和事件循环切换 | 必须保留单一全局 sequence、逐调用结果和失败语义；不能把 ledger 拆成多份权威 |
| P3 | 将纯读工具在确认无共享突变后声明 `isConcurrencySafe` | 同一 step 的独立读取可重叠，降低 wall time | 当前全部 exclusive；`team_thread read` 可能写 receipt，不能简单标并行。先跑 R10 并逐动作分类 |
| P3 | 对 native 声明做减重 A/B：缩短重复说明、动作专属 schema、defer/PTC 试验 | 每步减少工具上下文 bytes 和 schema clone/compare | 必须以真实模型成功率、恢复率和 token 作为门槛；当前 19,334 bytes 尚不能判断值不值得改 |
| P3 | 把 DM/自动 notice 合并为更少模型回合 | 减少跨 Agent 完整 turn | “idle DM 是一个 turn”是现有契约；需要产品层决定何时改用 Thread 状态同步 |

推荐执行顺序：先做 P0 基线；随后并行验证 P1 的账本审计和局部重复读取；P2 根据规模曲线选择查询重写；P3 的 schema 和并发改动必须拿真实模型结果做 A/B。

## 10. 目前不能下的结论

- 不能据 6.5% 历史摩擦宣称当前模型有同样摩擦；其中大量样本来自修复前版本，fresh-host eval 又只有 144 次。
- 不能据 69 次旧 transcript 的 0–12 ms 宣称完整 Team tool call 很快；它绕过了 registry、Session、provider 和 Agent wake。
- 不能据 19,334 bytes 宣称工具声明是首 token 延迟主因；没有 token、缓存和延迟数据。
- 不能据源码线性扫描宣称某个扫描已是实际瓶颈；必须先测台账规模分布和 p95。
- 不能把 SQLite 单次写 benchmark 外推成完整 mutation；它不包含 enqueue、projection、invariant、结果渲染和模型往返。

## 11. 源码索引

- 七个工具声明与注册：`packages/tool-agent-team/src/index.ts`，`teamInbox`、`teamThread`、`teamAttention`、`teamMessage`、`teamDm`、`teamTask`、`teamView`、`apply`。
- request id 与模型参数适配：`packages/tool-agent-team/src/index.ts`，`requestId`、`blankToAbsent`、`readFactView`、`threadResult`、`messageOutcome`、`taskRejection`。
- Host 入口与 Member 身份：`packages/agent-team/src/index.ts`，`memberForAgent`、`memberCall`、`inboxForAgent`、`readThreadForAgent`、`taskBoardForAgent`、`viewForAgent`、`dmForAgent`。
- 写入、投影和读取：`packages/agent-team/src/ledger.ts`，`AgentTeamLedger`、`enqueue`、`applyAndAdvanceProjectionVersion`、`applyTo`、`inboxForWorkspaces`、`prepareReadReceiptFrom`、`prepareReadFrom`、`remainingUnreadAfter`、`threadHistory`、`taskBoardFor`、`hasActiveClaimFrom`、`view`、`sortedRecords`、`validateRecords`、`replay`。
- 提交审计：`packages/agent-team/src/invariant.ts`，`validateAtMount`、`watchCommits`。
- 持久化：`packages/agent-team/src/index.ts`，`openTeamStorage`；`packages/agent-team/src/spec.ts`，`agentTeamDomainSpec`。
- 工具执行：`../deepseek-harness/packages/core/agent-loop/src/tool-calls.ts`，`executeToolCalls`、`runGroup`、`parseArguments`、`appendToolCall`、`appendToolResult`。
- 工具 registry：`../deepseek-harness/packages/core/tools/src/index.ts`，`createExecution`、`prepareExecution`、`dispatchToolBody`、`createSuccessResult`、`postExecute`、`finalizeScheduledExecution`、`finishScheduledExecution`、`materializeFinalResult`、`executionMode`、`wireSchemas`、`schemaOf`。
- schema 与 args validation：`../deepseek-harness/packages/core/tools/src/schema.ts`，`defineTool`、`parameterSchemaSpecToJsonSchema`、`valueSchemaSpecToJsonSchema`、`validateJsonSchemaValue`。
- prompt 和 request header：`../deepseek-harness/packages/core/system-prompt/src/index.ts`，`SystemPrompt.assemble`；`../deepseek-harness/packages/core/session/src/request-header.ts`，`headerEquals`、`sameSchema`。
- 结果压缩：`../deepseek-harness/packages/compaction/compaction-tool-result-pruner/src/index.ts`，`ToolResultPruner.pruneContent`、`pruneSession`；`../deepseek-harness/packages/compaction/compaction-basic/src/index.ts`，`compactIfNeeded`。
- 现有 benchmark 和评测：`packages/agent-team/tests/storage-bench.spec.ts`；`.scratch/archive/2026-10/team-tools-model-eval/harness/live-eval.mts`；`.scratch/archive/2026-10/team-tools-model-eval/materials/2026-10-28-corpus-findings.md`；`.scratch/archive/2026-10/team-tools-model-eval/materials/2026-10-28-live-eval-findings.md`。
