# Team 性能基准与观测能力

- 最后检查日期：2026-10-28
- 检查基线：当前工作树，最终检查时 HEAD 为 `f4c44d46e560910c612a3487de7be2a1e84c0a8a`
- 工作区状态：最终检查时 Git 跟踪文件无未提交改动；本文按该提交的当前行为理解
- 证据口径：本文只检查源码、测试、配置和现有历史材料，没有运行新的性能探针，因此不提供“当前性能数字”
- 结论标记：**事实**表示已从当前文件或符号确认；**推断**表示由代码路径推导；**未测量**表示本轮没有可复现实验数据

## 结论

**事实**：仓库已有可复现的真实装配 fixture，也有一个直接测 SQLite/JSON 单条写入的微基准；但没有 Team 专用的完整性能 test suite、统一采样器、trace 和结果汇总格式。上游 Harness 已有成熟的 child-process、固定 workload、浏览器 CDP 和 JSONL 报告基础设施，当前 Team 没有接入。

**事实**：现有六项能力中，只有“单次工具处理”和“后端单条写入”可以直接搭出局部计时；加载、连续协作、并发和尾延迟没有现成性能口径；存储规模只覆盖 1,000 和 10,000 次裸写入。

**推断**：只测当前 `storage-bench.spec.ts` 的 KV 写入会漏掉 Team 的主要成本。当前加载路径会完整读取、排序、规范化和校验 ledger；提交后还可能异步执行全量 invariant 校验；ledger 的 live operation 通过单尾队列串行。这些成本都不在现有 `KvUnit.putRecord()` 微基准里。

**推断**：最小而有用的 baseline 应按 6 条真实路径分组，而不是做全量笛卡尔积：冷启动、原子工具、连续协作、并发、尾部分布、存储规模。性能结论统一保留逐样本 JSONL，再生成 JSON 汇总；只看 `console.table()`、单次 `console.log()` 或功能断言都不能复跑和比较分位数。

## 1. 现有资产

### 1.1 后端 benchmark 和业务计时

| 资产 | 具体符号 | 现状 |
| --- | --- | --- |
| 存储微基准 | `packages/agent-team/tests/storage-bench.spec.ts` 的 `operationPayload()`、`timedPuts()`、`directoryBytes()`、`summarize()` | **事实**：仅在 `DSH_BENCH_STORAGE=1` 时启用；生成确定性、约 3.4 KB 的 operation 形状；逐条调用 `KvUnit.putRecord()`；JSON 和 SQLite 各跑 1,000 与 10,000 次；汇总 `totalMs`、`meanMicros`、`p95Micros`，并用 `mediumBytes` 记录临时目录的文件总字节 |
| 业务账本计时 | `scripts/team-trial-metrics.ts` 的 `run()`、`calculateTrialMetrics()`、`replay()` | **事实**：只接受 SQLite 副本并以 `readOnly: true` 打开；唯一计时字段叫 `validation.replayValidationMs` |
| 计时口径问题 | `run()` 中的 `started`、`replay(records)`、`calculateTrialMetrics(records)`、`performance.now()` | **事实**：`calculateTrialMetrics()` 内部又调用一次 `replay(records)`；当前 `replayValidationMs` 实际覆盖“第一次重放 + calculateTrialMetrics 内的第二次重放与全部聚合”，不是单独的 replay validation |

**事实**：`storage-bench.spec.ts` 是裸后端 benchmark，输入的 JSON operation 不经过真实 `AgentTeamLedger`、真实 Team service、`ctx.emit('agent-team/committed')` 或 invariant listener。它适合定位 KV 写入，不足以代表一次 Team 工具调用或一次连续协作。

**事实**：`scripts/team-trial-metrics.ts` 的主体是使用统计，不是性能基准；它没有重复样本、冷热区分、分位数或环境元数据。

**事实**：`readOperations()` 在 `started = performance.now()` 之前执行，因此当前 `replayValidationMs` 既不包含 SQLite 行读取、JSON parse 与排序，也不是单次 replay。

### 1.2 真实装配 fixture

| 文件 | 可复用符号 | 能覆盖的真实路径 |
| --- | --- | --- |
| `packages/agent-team/tests/helpers/host-harness.ts` | `harness()`、`sqliteHarness(path)`、`ledgerAtBoot()`、`addLedgerMember()`、`makeOwner()`、`storedPool()` | **事实**：内存或真实 SQLite 后端、真实 `AgentTeam` plugin、ledger 初始化与宿主装配 |
| `packages/agent-team/tests/helpers/memory-backend.ts` | `MemoryStorageBackend`、`MemoryMediaPool` | **事实**：可注入失败的存储替身，适合错误路径和故障回归，不适合可信磁盘性能 |
| `packages/agent-team/tests/helpers/team-host-fixture.ts` | `mountTeamMemberHost()` | **事实**：Host、Team preset、Session 和工具面的完整装配 |
| `packages/agent-team/tests/helpers/surface-harness.ts` | Host surface harness | **事实**：可直接走 Host 服务面，避免每次从 UI 输入 |
| `packages/agent-team/tests/member-tool-policy.spec.ts` | `ScriptedAdapter`、`toolCallResponse()`、`ctx.tools.execute()` | **事实**：可脚本化 agent loop，可在不调用活模型的情况下产生固定工具调用；也直接调用统一工具执行入口 |
| `packages/tool-agent-team/tests/blank-parameter-tolerance.spec.ts` | `call()`、`tool.execute(args, { agent, callId, signal })` | **事实**：可直接测单个 Team handler 的参数处理和业务执行 |
| `packages/client-agent-team/tests/harness.tsx` | `runtimeWithTeam(options)`、`seededMessages`、`remainingUnreadCounts`、`mainStreamEntries`、`mainStreamUnread` | **事实**：可喂固定 Client 数据，并替换 `readThread`、`viewProjects`、`loadThreadHistory`、`threadObservations` 等 Remote 调用 |

这些 fixture 已能生成样本，但现有测试主要断言行为和调用次数，没有统一开始/结束 mark、重复批次或结果文件。

### 1.3 现有功能测试和浏览器流程

| 文件 | 已有样本 | 限制 |
| --- | --- | --- |
| `packages/client-agent-team/tests/render-isolation.client.spec.tsx` | `seed(count)` 生成 10 或 30 条消息；`counters.messages`、`counters.composers`、`counts()` 检查渲染和 Remote 调用次数 | **事实**：没有墙钟、React commit 时长、DOM 数量或帧耗时 |
| `scripts/e2e/team-journey.e2e.ts` | keyless 的页面、持久化、恢复流程，可重复执行 | **事实**：数据和步骤没有 workload/scale 参数；没有性能采样 |
| `scripts/e2e/team-multi-page.e2e.ts` | 真实 Chromium 打开 4 页，验证共享订阅与独立浏览器 | **事实**：只给单次 `/agentTeam/members` fetch 计时并 `console.log()`；没有吞吐、排队或分位数 |
| `scripts/e2e/support.ts` | `installLocalBundle()`、`openTeamPage()`、`settleAnimations()`、`settleLayout()`、`watchConsole()` | **事实**：会创建隔离 HOME/profile 并等待布局稳定；没有 trace、video、CDP performance 或 long-task 样本 |
| `scripts/run-browser-test.mjs` | 构建真实 bundle，复制进临时 profile，使用 Harness 的 `vitest.web.config.ts` 与 Chromium | **事实**：是可复现浏览器环境，不是性能跑分器 |
| `scripts/isolate-dsh-home.setup.ts`、`vitest.config.ts` | 每个测试文件隔离 `DSH_HOME`，固定 `TZ=Asia/Shanghai` | **事实**：减少相互污染，但仍没有固定 CPU、数据库冷热或样本批次 |

**事实**：现有 Task 要求包含 `npm run test:browser` 的可见 UI 验证，但该命令服务功能验收；仓库没有 Team browser performance command。

**事实**：本次检查机是 Linux 6.6 WSL2、8 个逻辑 CPU，Node 24.15.0、npm 11.12.1、Chrome 138.0.7204.168；Team 声明 pnpm 11.7.0，相邻 Harness 声明 pnpm 11.28.5 且 checkout 精确为 `dsh-v0.2.1-rc.2`。这是当前检查环境，不是现有测试自动记录的统一 benchmark 环境。

### 1.4 现有运行时观测

| 层 | 符号 | 现有信息 | 性能缺口 |
| --- | --- | --- | --- |
| Client Remote 查询 | `packages/client-agent-team/src/client/team-queries.ts` 的 `TeamQueryCounters`、`diagnostics()` | issued、shared、superseded、droppedStale、droppedSuperseded、failed | **事实**：没有请求耗时、响应字节、首字节时间或排队时间 |
| Client Change stream | `packages/client-agent-team/src/client/team-changes.ts` 的 `TeamChangeStream` | stream、重连、版本推进和 stale filtering 的行为 | **事实**：没有消息间隔、重连次数、恢复时长或丢失窗口统计 |
| Member 生命周期 | `packages/agent-team/src/index.ts` 的 `waitLogged()` | 部分等待已记录日志 | **事实**：不是结构化 span，也没有覆盖启动全链 |
| Ledger 不变量 | `packages/agent-team/src/invariant.ts` 的 `watchCommits()`、`validateLedger()` | 提交后经 `setImmediate(check)` 合并，再全量校验，冲突时形成 fail-closed 错误 | **事实**：没有 pending 次数、校验次数、等待时长、latch 持续时长或每批 op 数 |
| Ledger 状态 | `packages/agent-team/src/ledger.ts` 的 `status()` | sequence、operationCount、project/member 数 | **事实**：没有存储体积、replay/validate 时间、队列深度、最大延迟或读写字节 |

**事实**：在当前 Team 工作树中没有统一的 `performance.mark()`/`measure()`、OpenTelemetry span、structured metric event、Playwright trace 配置或 CDP performance sampler。

### 1.5 上游 Harness 可复用的观测模式

当前相邻 Harness checkout 固定在 `dsh-v0.2.1-rc.2`。以下资产属于 Harness，不是 Team 基准结果，也没有使用 Team workload：

| Harness 资产 | 可复用点 |
| --- | --- |
| `../deepseek-harness/benchmarks/support/scaling-report.ts` 的 `recordTimings()`、`recordPeakMemory()` | case、metric、wall/CPU、budget、环境和 `results.jsonl` + HTML 报告 |
| `../deepseek-harness/benchmarks/support/calibration.ts` 的 `CI_TIME_SCALE`、`PERFORMANCE_BUDGET_HEADROOM`、`ciTimeBudget()` | CI 计时缩放和预算余量 |
| `../deepseek-harness/benchmarks/session-open/session-open.bench.ts` 的 `ATTEMPTS = 5` | 每场景独立 child process，报 `openMs`、`readMs`、`sessionRestoreMs`、`projectionMs`、CPU、堆内存和 RSS |
| `../deepseek-harness/benchmarks/agent-continuation/workload.ts`、`agent-continuation.bench.ts` 的 `ATTEMPTS = 5` | 固定 800 个历史 turn、每 turn 4 个工具调用、40 requests、20 continuation turns 等固定 workload；fresh worker/copy |
| `../deepseek-harness/benchmarks/long-session-browser/long-session.bench.ts` 的 `SAMPLES = 3` | 真实 built Web + Chromium，记录打开、分页、轨迹、首可见回复、输入重叠和 CDP `TaskDuration` |
| `../deepseek-harness/vitest.bench.config.ts` | `fileParallelism: false`、`maxWorkers: 1`，避免性能文件互抢资源 |

**推断**：应复用这些运行模式，而不是把 Harness 的 session 性能数字当 Team 数字。Team 需要的 workload 是 ledger operations、Team 工具调用、Agent 协作步骤和真实 Client 渲染。

### 1.6 历史证据

历史材料位于：

- `.scratch/archive/2026-09/team-perf/materials/phase0/findings.md`
- `.scratch/archive/2026-09/team-perf/materials/vera-replay-ruler.md`
- `.scratch/archive/2026-09/team-perf/materials/constraints.md`
- `.scratch/archive/2026-09/team-perf/materials/phase0/sanitize-ledger-paths.py`

**事实**：这些材料记录了 2026-09-13 前后的真 SQLite、真 service、真 invariant 探针。11,695 operations 的冻结输入曾测得约 0.8 秒单次全量校验，启动约 1.5–2.5 秒，小样本噪声可达约 ±34%。这些是历史证据，不是当前代码的实测数字。

**事实**：当前存在：

- `artifacts/team-perf/frozen-ledger-11695ops.sanitized.sqlite.gz`
- SHA-256：`1bc895ea06e93d60ed9f3305523ef1c8d10b64d4fd6d4ba8ca0780a09bbbcd0d`

**未测量**：本轮没有解压或重跑该冻结件，没有确认当前代码在此输入上的加载、工具、replay 或浏览器耗时。

**事实**：历史材料记录未消毒原件含有真实 Member 的绝对 `privateMemoryPath`；真装配配合隔离 `DSH_HOME` 时，迁移逻辑可能移动真实目录。以后所有可写探针必须从 sanitized 副本开始，每次运行再复制一份。

## 2. 当前六项能力判断

| 能力 | 当前是否可测 | 证据和边界 |
| --- | --- | --- |
| 加载 | **部分可测** | **事实**：`harness()`、`sqliteHarness(path)` 和浏览器 journey 能构造真实装配。**未测量**：没有 process/module/storage/ledger/Host/Client/Remote 阶段 mark，不能可靠给出冷启动分解。 |
| 单次 tool call | **部分可测** | **事实**：可直接执行 `tool.execute()` 或 `ctx.tools.execute()`，也能用 `ScriptedAdapter` 产生 agent loop 调用。**未测量**：没有统一 tool span、ledger queue wait、commit/emit/invariant 子阶段，无法区分 Team 服务、后端或 agent loop。 |
| 连续协作 | **只有功能流程** | **事实**：`team-journey.e2e.ts` 可重复跑完整旅程。**未测量**：没有固定 Agent 数、固定步骤、每步 scale、重复样本、跨步骤累计耗时或 drain 尾延迟。 |
| 并发 | **只有正确性覆盖** | **事实**：多页 E2E 验证共享订阅；ledger 是单 writer。**未测量**：没有并发读者/写者吞吐、queue depth、queue wait、冲突或同 `requestId` 重试性能。 |
| 尾延迟 | **基本不可测** | **事实**：存储微基准只有 p95 和每个规模一个批次；上游 5 样本场景只剩 order statistics，不能稳定估计 p99。**未测量**：没有 Team 端到端 p99、max、直方图或批次间抖动。 |
| 存储规模 | **后端局部可测** | **事实**：现有微基准只测 1,000/10,000 次逐条 put。**未测量**：没有合法 operation 全量生成、`loadAll`、构造期 replay/validate、读取、DB/WAL/SHM 或 100k 规模。 |

## 3. 缺失计时点

### 3.1 加载链

**事实**：`packages/agent-team/src/index.ts` 的 `apply()` 依次执行 `openTeamStorage()`、`storageDomain.open(agentTeamDomainSpec)`、构造 `AgentTeamLedger`、`ledger.initialize()`、`persistedSessionHeaders()`、`sweepWorkspaceParticipations()`，然后恢复或激活 enabled Member。

**事实**：`AgentTeamLedger` 构造器调用 `replay()`。当前 `replay()` 依次走 `sortedRecords()`、`validateRecords()` 和逐条 `applyAndAdvanceProjectionVersion()`；这些阶段没有独立 timer。

**事实**：`sortedRecords()` 通过 `table.entries()` 读取、排序、逐条 normalize，并在 scratch projection 上 apply；`validateRecords()` 从 `emptyProjection()` 再做完整验证。`validateAtMount()` 消费构造期 `bootValidation`，正常路径通常不额外全量校验，但实际命中情况应被观测，而不是假定。

**事实**：`packages/agent-team/src/vendor/storage-sqlite/unit.ts` 的 `SqliteKvUnit.loadAll()` 在 `DomainFacility.open()` 内被调用，当前 Team 阶段计时拿不到这段独立耗时。

**需要补的 mark**：

```text
process start
  -> module and profile load
  -> storage open
  -> loadAll
  -> ledger construct
       -> entries
       -> sort
       -> normalize
       -> validateRecords
       -> live apply
  -> initialize
  -> persistedSessionHeaders
  -> workspace sweep
  -> each enabled Member activation
       -> preset mount
       -> session resume/create
       -> capability apply
       -> session attach
  -> Host ready
  -> Client mount
  -> Remote ready
  -> first Team usable
```

**推断**：没有上述阶段，冷启动只能报一个总墙钟，无法判断是 bundle 加载、SQLite 读、replay/validate、Member resume 还是 Client 首屏占主导。

### 3.2 单次 tool call

**事实**：`packages/tool-agent-team/src/index.ts` 的 `apply()` 注册 `team_inbox`、`team_thread`、`team_attention`、`team_message`、`team_dm`、`team_task`、`team_view`。各 `execute` 没有统一的 enter/exit span。

**事实**：`packages/agent-team/src/ledger.ts` 的 `enqueue()` 通过私有 `operationTail` 串行操作。新调用要等前一个 operation 完成，但当前没有 queue depth 或 queue wait。

**事实**：`invariant.ts` 的 `watchCommits()` 用 `setImmediate(check)` 合并提交后全量校验，工具调用不会同步等待这次校验完成。

**推断**：延迟校验仍会占用同一进程的 CPU 和事件循环，并可能影响后续操作。当前没有记录批次大小、开始/结束时间或 latch 持续时长。

**事实**：`emitCommitted()`、`emitChanged()` 没有处理时间、唤醒 listener 数、订阅者完成时间或 payload bytes。

**需要补的 span**：

```text
agent loop turn start/end
  -> tool enter/exit
  -> Host service enter/exit
  -> ledger enqueue
  -> queue wait
  -> service projection and validation
  -> storage put
  -> apply and commit
  -> listener fan-out
  -> deferred invariant check
  -> result serialize
  -> Client apply/render
```

**推断**：至少需要 `runId`、`callId`、Team `requestId` 和 ledger `operationId` 的关联字段。现有各层分别有调用标识，但没有一条 trace 能把它们串起来。

### 3.3 连续协作、并发和尾延迟

**事实**：现有 keyless journey 能构造完整协作故事，但每一步都由 UI 脚本即时决定，不能通过参数固定同一 workload。

**事实**：多页 E2E 是正确性断言，不是 benchmark；它没有测多个请求同时候选时的排队和完成顺序带来的延迟。

**事实**：ledger 的 live operation 通过 `operationTail` 排队。

**推断**：并发写主要通过排队串行化。没有 queue wait 时，测得的总延迟无法判断是业务执行慢还是排队。

**事实**：`packages/agent-team/src/index.ts` 的 `commitMessageAs()` 在返回结果前调用 `emitCommittedOutcome()`。后者进入 `emitCommitted()`，经同步 `afterCommit()` 对 `affectedMembersOf()` 的每个 live Member 调用 `notifyMember()`；这条 post-commit fan-out 包含在发送方工具响应的时间里。

**推断**：Agent-to-Agent 基准必须把以下完成点分开；只测“发送工具返回”或只测“最终 idle”都会把不同阶段混在一起：

| 完成点 | 含义 | 当前可用信号 |
| --- | --- | --- |
| A 工具开始 | A 的模型决定调用发送工具 | agent loop 的 tool 调用事件 |
| A commit ack | ledger 已落盘、live projection 已 apply、同步 post-commit 已返回 | 工具结果 |
| B notice queued | Host 已把 Team notice 放入 B 的 Harness inbox | 日志和 inbox 事件，当前未形成统一 span |
| B notice claimed | B 的下一 step 或 turn 取得 notice | Harness inbox 事件 |
| B read committed | B 读取 facts，并在有进展时追加 read receipt | Team read operation 和工具结果 |
| B handled | B 完成 reply、claim、done 等基准终态动作 | 对应 operation 和工具结果 |
| B turn idle | B 整个 Agent 没有待处理输入 | agent 状态事件，不等于单条消息已处理 |

**推断**：连续协作和并发必须同时记录“每步处理时间”和“从发出请求到可见结果的时间”。否则会漏掉合并 invariant、Change stream 唤醒和 Client drain 轮次造成的尾延迟。

### 3.4 存储规模

**事实**：`storage-bench.spec.ts` 使用相同 operation payload 逐条写 KV，并用 `directoryBytes()` 记录临时目录总字节；没有读回、重放或 DB/WAL/SHM 分项信息。

**事实**：`status()` 只给逻辑数量，不给 SQLite 的 DB/WAL/SHM 文件大小、operation value bytes、索引页或压缩后体积。

**推断**：规模基准至少要分三层：

1. KV 层：单条 put/read 与原始字节。
2. Ledger 层：`loadAll`、`entries`、`sortedRecords`、`validateRecords`、live apply。
3. 用户路径：Host 服务调用、Remote response bytes、Client mount/render。

## 4. 样本生成方式

### 4.1 规模输入

使用一个合法 operation corpus generator，不能让分片前缀或随意复制记录造成重复 `operationId`、`requestId`、错误 `previousOperationId` 或重复 `team/initialized`。历史材料已经记录这些放大陷阱。

| corpus | 生成方式 | 用途 |
| --- | --- | --- |
| empty | 只含初始化所需最小合法记录 | 预热、模型/loop 固定成本、存储冷开 |
| 1k | 固定 seed 生成合法 operations，分布含 messages、reads、tasks、attention | 快速回归，不据此评小比例改进 |
| 10k | 同一 seed 规则生成，并对齐 sanitized 11,695 fixture 的线程/消息倾斜 | 与历史证据量级接近 |
| 100k | 同一 seed 规则继续放大，保证每个 ref 和生产 schema 合法 | 检查超线性、replay/validate 斜率和存储增长 |

每个 corpus 还要有多个 workload profile，而不是只做一个均匀分布：

- balanced：Project、Thread、Member 的规模接近均匀。
- hot-thread：少数 Thread 承载大部分消息与未读，覆盖真实倾斜。
- many-members：更多 enabled Member，覆盖 Session 恢复和 activation。
- mutation-heavy：更多写、冲突和幂等重试，覆盖单 writer 和 invariant。

**事实**：历史冻结件是真实分布，但只能作 10k 档对照；生成 corpus 适合 1k/100k 和可调故障路径。

### 4.2 工具调用

不要用活模型产生性能样本。用 `ScriptedAdapter`、`toolCallResponse()` 和固定参数序列走 `ctx.tools.execute()`；另保留少量 live smoke 只验证兼容，不进入稳定性能门禁。

至少生成这些调用：

| 场景 | 样本 | 覆盖路径 |
| --- | --- | --- |
| fast read | `team_view` 固定 view | 快路径、序列化和 Client 读响应 |
| unread read | `team_thread` 读取有未读的 Thread | 未读处理、receipt、commit |
| no-op read | 已读 Thread 再读 | 应避免无意义写入的路径；必须确认当前行为 |
| write | `team_message` reply 成功 | 服务校验、ledger enqueue、put、apply、emit |
| rejected write | 使用 stale revision 或缺少未读条件 | 拒绝路径，不能被“成功请求”掩盖 |
| idempotent retry | 同一 `requestId` 连续执行两次 | 幂等命中、缓存、是否重复 emit |
| drain | 20/100/400 条未读分批读 | 连续工具调用、每轮响应字节和 commit 批次 |

每条样本记录结果状态和错误类别；拒绝与无进展也必须计入分母，否则 benchmark 只剩成功快路径。

### 4.3 连续协作

固定 3 个 Agent、1 个 Human，使用真实 Host/Session 与脚本化模型响应，按同一序列执行：

1. Human 建 Project/Thread，邀请 3 个 Agent。
2. Agent A 发消息，Agent B/C 分别读取。
3. B reply 并提及 C，C reply 并提及 B。
4. Human 创建 Task，分配负责人，完成一个 Task，制造一次 stale revision。
5. 重试一次同 `requestId`。
6. Human 打开 Thread 并 drain 全部未读。

每步记录 Host 处理时间、工具总时间、queue wait、commit 数、invariant 批次、响应字节和可见 UI 时间。规模用 20、100、400 个未读或协作步骤，长档只跑少量独立批次。

### 4.4 并发

并发样本至少包含 1、4、16 个同时发起的工具调用：

- 多个 `team_view` 读者。
- 多个独立 `team_message` 写者。
- 同一 `requestId` 的重复写者。
- 同一 revision 的冲突写者。
- 读写混合，其中写者持续触发 invariant。

并发不是“同时 Promise.all 一次”就结束；要重复 burst，并记录每个调用的入队时间、离队时间、执行时间、总延迟、结果和 operation 数。

### 4.5 浏览器

沿用 `installLocalBundle()`、`openTeamPage()`、`settleLayout()` 的隔离环境，在固定 viewport 下采集：

- navigation start 到 Team 可操作。
- Client mount、Remote ready、首个 Thread 数据可见。
- 打开 hot Thread、分页、发送 reply、drain 的帧和长任务。
- 桌面 viewport 与 390×844 各一组。

**事实**：当前浏览器测试没有启用 Playwright trace、video 或 CDP performance sampling。baseline 至少要采集 CDP `TaskDuration`、long task、JS heap，必要时保留 trace 供失败样本诊断。

## 5. 结果格式

### 5.1 运行元数据

每次 run 必须固定并记录：

- `schemaVersion`、`runId`、`gitCommit`、`gitDirty`。
- 若 `gitDirty` 为 true，记录可审查的 diff digest；该结果不能作为正式跨日基线。
- scenario、scale、seed、backend、invariant on/off、cold/warm、repetition。
- OS/kernel、WSL 或 native、CPU 型号与可用核数、RAM、filesystem。
- Node、npm/pnpm、Chromium、Harness tag。
- 是否使用 sanitized corpus，以及 corpus SHA-256。

正式比较应使用 clean commit。当前本地根 `package.json` 与 Harness 的 `packageManager` 版本声明不同；baseline runner 应分别执行实际版本命令并记录输出，不应只抄声明。

冷热状态要按以下口径命名，不能只写 `cold`：

- `cold-process`：新 Node 进程、新临时 `DSH_HOME`、新 DB 副本、新浏览器 profile。
- `warm-process`：同一进程完成固定预热后，在相同 corpus 上连续采样。
- `fresh-copy`：每次从同一个只读 corpus 复制可写数据库；这保证写入隔离，但不保证 OS page cache 是冷的。
- 本轮没有控制 `drop_caches`。除非运行环境能明确重置文件缓存，否则不要声称测量了物理磁盘冷读。

### 5.2 原始样本 JSONL

每行是一条可独立分析的样本，至少包含：

```json
{
  "schemaVersion": 1,
  "runId": "stable-id",
  "sampleId": "scenario-scale-index",
  "scenario": "tool-message-reply",
  "phase": "ledger-queue-wait",
  "scale": 10000,
  "tool": "team_message",
  "requestIdHash": "sha256",
  "operationIdHashes": ["sha256"],
  "startedAt": "ISO-8601",
  "durationMs": 12.3,
  "cpuUserMs": 4.1,
  "cpuSystemMs": 1.2,
  "queueWaitMs": 3.4,
  "responseBytes": 2048,
  "operationDelta": 1,
  "invariantBatches": 1,
  "status": "ok",
  "errorClass": null
}
```

浏览器样本还要有 `viewport`、`navigationMs`、`firstUsableMs`、`longTasks`、`taskDurationMs`、`jsHeapBytes`；存储样本还要有 `dbBytes`、`walBytes`、`shmBytes`、`valueBytes`。

不要写消息正文、真实路径、token 或完整 ref。需要关联时使用本次 run 内稳定的 hash，并在元数据中说明生成方式。

### 5.3 汇总 JSON

每个 scenario/phase 至少输出：

- `n`、失败数、错误分类。
- `min`、`mean`、`p50`、`p95`、`p99`、`max`。
- 吞吐、CPU 时间、峰值 RSS/heap。
- 输入输出字节、operation delta、invariant 批次。
- 相对路径基线（例如相对 1k 或 10k）的放大倍数。

汇总不能替代原始 JSONL。分位数要根据原始样本重算；只报已聚合值会丢失批次和失败信息。

### 5.4 存放和失败处理

**事实**：`.scratch/AGENTS.md` 要求临时日志、截图和下载物放到 `local/` 或 `artifacts/`。建议运行产物放 `artifacts/team-perf/runs/<runId>/`，只有经过人工确认的里程碑摘要进入 active 或 archive。

场景失败、状态不符、账本 operation 数不符、invariant 失败或浏览器控制台 error 时，应将 run 标红并保留原始样本；不得只丢慢样本或重跑后覆盖失败。

## 6. 最小但足够的 baseline matrix

这张矩阵覆盖六项能力，不做六维全排列。**冷启动**和**存储规模**用独立进程；**工具、连续协作、并发**共享合法 corpus；**尾延迟**从这些样本的重复批次中计算。

| ID | 真实路径 | 规模 / workload | 变体 | 样本方式 | 主要结果 |
| --- | --- | --- | --- | --- | --- |
| L0 | bundle 完全冷启动到 Host ready | empty | Team preset off/on；invariant on/off | 每变体独立进程 10 次；新临时 HOME，数据库空 | 全链阶段 mark、p95/max、内存 |
| L1 | 数据库冷启动到 first Team usable | 1k、10k、100k | invariant on/off；Member 1/3 | 每档每变体 10 次独立进程、每次新 DB 副本 | storage/open/replay/validate/activation 分解 |
| L2 | 浏览器冷开 Team | 1k、10k、100k，balanced 与 hot-thread | invariant on/off；桌面与 390×844 | 每档每变体 5 次 fresh profile，失败可重跑 | first usable、first content、long task、CDP task duration |
| T1 | 单工具处理 | 10k，balanced | `team_view`、unread read、no-op read、reply、reject、idempotent retry | 每个操作 5 个独立批次，每批 200 次；每次新唯一 requestId（幂等场景除外） | handler、queue wait、put、commit、p99/max |
| T2 | 一小段固定 agent loop | 10k | `ScriptedAdapter`；2/8 个连续 tool calls | 每档 5 次 fresh process | loop 总耗时、tool span、回合间等待 |
| C1 | 连续协作故事 | 10k 上 20/100/400 未读；3 Agent + Human | invariant on/off | 小档 5 次，大档 3 次独立批次 | 每步耗时、drain、commit/replay 合并、最终 UI |
| X1 | 并发 burst | 10k | 1/4/16 读者和写者；冲突、同 requestId | 每档 5 个 burst，每 burst 200 次调用 | 吞吐、queue wait、错误率、p99/max |
| S1 | 存储后端 | 1k/10k/100k operation values | JSON/SQLite；cold/warm | 每档 5 个独立批次；每批至少 1,000 次，最终一次顺序 put | put/read、DB/WAL/SHM、value bytes |
| S2 | 合法全 ledger 规模 | 1k/10k/100k | invariant on/off | 每档 5 次 fresh process + 可写 sanitized copy | loadAll、construct、sort、validate、live apply、heap/RSS |

执行顺序建议：

1. PR smoke：L0、T1 的 10k 小样本、S1 的 1k/10k、C1 的 20 条。
2. nightly/里程碑：完整 L1/L2、T2、C1 100/400、X1、S2 100k。
3. 发布前：同一 clean commit、同一 machine 连续跑两次；若关键大档差异小于历史约 ±34% 噪声，按“无证据”处理。

### 6.1 尾延迟口径

- **事实**：5 个样本只能报 5 个观测值；称其为 p99 不会增加信息。
- 工具和存储的单个 operation 至少 5 批 × 200 次，共 1,000 个样本，再报 p50/p95/p99/max，同时保留每批分布。
- 冷启动可做 10 次，只报 p50/p95/max；少于约 100 次不声称稳定 p99。
- 浏览器单次几秒且成本高，5–10 次只报中位、p95/max，并明确样本限制。
- 所有长尾场景同时报成功率、queue wait 和 operation 数。只报成功样本会系统性隐藏冲突与 invariant 慢路径。

### 6.2 结果判据

每次 baseline 先验证语义，再比较时间：

- 每个场景的最终 ledger sequence、operation delta、unread、receipt 和错误类别符合预期。
- 同 requestId 重试不产生第二份事实。
- invariant on/off 不改变业务结果。
- 独立并发写都恰好产生一条 operation；同 `requestId` 的重复写只产生一条事实；冲突写没有丢失已提交更新。
- 浏览器最终页面数据与同一 corpus 的 Host 读数一致。

性能门槛先建立在本机同一 commit 的成对对照和绝对大档上。历史 ±34% 噪声意味着小档比值不能作为优化证据；100k 的绝对成本、尾延迟和内存斜率更有解释力。

## 7. 当前未测项

以下内容本轮都没有测量，不能用现有材料补数字：

- 当前 HEAD 在 empty/1k/10k/100k 上的冷启动和热启动。
- 当前 `loadAll`、`sortedRecords`、`validateRecords`、live apply 各占多少时间。
- 七个 Team 工具的 p50/p95/p99，以及成功、拒绝、no-op、幂等路径差异。
- `operationTail` 在 4/16 并发下的 queue wait 和吞吐上限。
- invariant 合并批次对连续协作和浏览器可见延迟的影响。
- 当前 SQLite DB/WAL/SHM 随 100k operations 的增长。
- 当前 Client mount、Thread 打开、drain 和渲染的长任务分布。
- live 模型调用时间；它受 provider 和模型波动影响，应与 Team 自己的性能分开。
- 2026-09 历史数字在当前代码上是否仍成立。

## 8. 建议的最小实现顺序

1. 增加统一 run/sample 结果类型、环境采集和 JSONL/JSON 汇总器；先在现有 `storage-bench.spec.ts` 和 multi-page fetch 上试通。
2. 在真实 `harness()` 加载路径补阶段 mark，再做 L0/L1；不要先拆 `AgentTeamLedger` 的裸计时。
3. 在 `tool-agent-team/src/index.ts` 的统一工具包装层加 span，在 `AgentTeamLedger.enqueue()` 加 queue wait，在 invariant 批次加 span。
4. 用 `ScriptedAdapter` 做 T1/T2，再加 C1/X1。
5. 复用 Harness 的 Chromium + CDP 采样方式做 L2，并把 trace 只作为失败诊断产物。
6. 最后把 100k corpus、S2 和浏览器大档接入 nightly；PR 只保留少量 smoke，避免每次改动都付完整成本。

这套结构先保证能解释慢在哪里，再讨论优化幅度。没有跨层 trace 的 benchmark 只能得到一个总时间，很容易把 SQLite、ledger replay、invariant、排队或浏览器渲染中的一项误判成主要瓶颈。
