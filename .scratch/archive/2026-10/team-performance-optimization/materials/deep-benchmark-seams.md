# Team 性能基准的最小观测接缝

**检查日期：** 2026-10-28\
**代码基线：** bf777c39ecc1ff912a3b473d85f575dd0758bdd5 加当前工作树；工作树中已有的 scripts/team-ui.ui-preview.ts 改动不属于本研究\
**范围：** 只读核对当前 Team、相邻 Harness、测试夹具和浏览器流程；本文不修改生产代码\
**结论口径：** “事实”来自已检查的代码或测试，“推断”由调用链推导，“未测量”表示本轮没有计时样本

## 结论

首轮可以先用现有 Harness 事件和浏览器选择器完成总时长测量，不需要先给所有业务函数加计时器。外围总时长已经能从以下边界得到：

- Cold Host boot：子进程启动到 appReady.onReady()；生产 dsh web 还会在 Loader settlement 和启动审计后输出 URL。
- Team Client usable：浏览器导航或点击开始，到目标页面已有真实数据，并经过两帧提交。
- 单次 tool call：持久 Session 中配对的 tool/call 到 tool/result；中间可用 tools/execute 和 tools/result 分开调度、业务执行与结果整理。
- Wake/read/reply：agent/inbox/inserted、agent/inbox/claimed、agent/status、session/event 和 agent/assistant-stream 已提供主要状态点。

当前真正缺的内部边界有四类：Ledger 排队与全量重放、同步 post-commit fan-out 的结束位置、通知从 source commit 到 inbox notice 的因果关联，以及 Client 的 Remote mount/首次渲染内部阶段。要解释“为什么慢”，这几类边界需要生产代码发出只读的结构化 perf 事件。测试包装适合测外围总时长和现有 Harness 状态，不适合通过反射或改写私有方法伪造这些内部边界。

主协作基准应使用两条时间线：

1. collaboration.e2e：A 的 kickoff turn 开始，到 B 的 reply tool/result 落盘。
2. team.handoff：A 的 send tool/call 开始，到 B 的 reply tool/result 落盘。

前者反映完整用户等待，后者减少 A 的初始模型输出差异，适合判断 Team 链路是否退化。B 的 turn 结束和 agent/status=idle 单独记录，不能代替 reply committed；回复已经可用时，Agent 可能还在收尾或处理下一条输入。

## 1. 指标定义

| 指标 | 起点 | 终点 | 是否主指标 | 说明 |
|---|---|---|---|---|
| host.coldBoot | Host 子进程 spawn | appReady.onReady() 或首条 dsh web: URL | 否 | 包含 profile 加载和 Team 初始化；两种 ready 信号不可混用 |
| host.teamInit | Team Service.init 开始 | Team 初始化 Promise 完成 | 否 | 包含 storage、Ledger、Session inventory 和 Member 激活 |
| client.usable | 页面导航开始或点击 Team 开始 | 目标数据的稳定 DOM 出现 + 2 RAF | 否 | 必须以真实数据选择器为终点，不能只看外层骨架 |
| tool.call | 配对 tool/call Session 事件 | 配对 tool/result Session 事件 | 否 | 包含排队、参数处理、Host、Ledger、fan-out、结果校验和持久化 |
| postCommit.fanout | emitCommitted() 进入 | 所有同步 Member 通知完成调度 | 否 | idle Member 的后续异步唤醒是 child span，不能让根 span 假装已送达 |
| notice.queue | 通知派生开始 | 成功调用 followup() 或 steer() | 否 | 包括 wake gate 和通知派生；不等于模型已读取 |
| wake.claim | notice 已插入 inbox | agent/inbox/claimed | 否 | 表示 Harness 开始消费通知 |
| member.read | 读取工具 tool/call | 配对 tool/result | 否 | 无进展读取也必须保留样本 |
| member.reply | 回复工具 tool/call | 配对 tool/result | 否 | 以 durable reply 为终点 |
| team.handoff | A 的 send tool/call | B 的 reply tool/result | 是 | Team 自身的主优化指标 |
| collaboration.e2e | A 的 kickoff turn 开始 | B 的 reply tool/result | 是 | 用户等待的总时间，包含两次模型回合 |
| turn.tail | B 的 reply tool/result | B 的 agent/status=idle | 否 | 单独观察收尾、遗留输入和重复唤醒 |

分位数必须基于每个样本的同一指标。不能把不完整的阶段相加后当作端到端样本，也不能只汇总各阶段 p95 来声称端到端 p95。端到端和分段必须来自同一条 trace。

## 2. 可用的最小接缝

### 2.1 Cold Host boot

**事实：** Team 的初始化和 Member 恢复都在 AgentTeam 的 Service.init 内完成。当前顺序是 storage open、Ledger 构造与 replay、initialize、Session headers、Workspace sweep、逐个 Member transition/activation。

**事实：** appReady 是 launcher 所有的启动成功信号；它只在 boot、Loader 和 Host setup 成功后提交。Web 的 URL 行还等待 Loader settlement 和 auditStartupEntries()。

最小接缝：

| 层级 | 起点 | 终点 | 可用方式 |
|---|---|---|---|
| 用户进程总启动 | 测试 runner spawn | 首条 dsh web: URL 或 ctx.appReady.onReady() | 测试包装；无需 Team 改动 |
| Team fiber 整体 | fiber LOADING | fiber ACTIVE | 测试插件监听 internal/status；无需 Team 改动 |
| storage open | storageDomain.open() 前 | domain.open() 后 | 生产 hook |
| Ledger replay | AgentTeamLedger.replay() 前 | live projection apply 完成 | 生产 hook |
| Ledger replay 子阶段 | entries、sort/normalize、validate、apply | 各自同步结束 | 生产 hook；CPU profile 只能归因，不能替代计时 |
| Session inventory | persistedSessionHeaders() 前 | 返回 | 测试可包装 sessionPersistence.list，生产 hook 更稳定 |
| Workspace sweep | sweep 前 | 所有 participation 收敛 | 生产 hook |
| Member activation | 每个 activateMember() 前 | create/resume、attach、carry、initial notify 后 | 父、子 span 均需生产 hook |

Team 初始化内部的精确阶段不能用 appReady 倒推。appReady 只适合作为外部 SLO；内部阶段必须单独打点，否则 cold boot 异常仍无法归因。

### 2.2 Team Client usable

**事实：** Team Client 的 apply() 等待 remote.$mount(agentTeamRemote)，随后通过 ctx.inject(['remote.agentTeam']) 才执行 applyUi()。普通 Web boot 的 data-dsh-boot 消失表示整个 Client 已完成首次 mount，不代表 Team 数据可用。

**事实：** 当前页面已有可用 DOM 锚点，但有的锚点只证明骨架存在。例如 data-team-project 在外层页面渲染时就出现，不能单独作为 loaded 的终点；Thread 的加载态会持续到首次 read、history 和 observations 完成。

最小接缝：

| 指标 | 测试包装可测 | 生产 hook 可补 |
|---|---|---|
| 普通 Web 首屏 | data-dsh-boot 消失 | 无 |
| Team rail 可点击 | 等待 button[aria-label="团队"] 可操作 | 可选记录 applyUi 完成 |
| Team shell 可用 | 点击后等待 html[data-agent-team-mode="team"] 和 data-team-action="leave"，再等 2 RAF | 可选 client.teamShellReady mark |
| Inbox 数据可用 | 等 data-team-inbox 内固定数据行，而非只看页面根节点 | 可选 loaded mark |
| Thread 数据可用 | 等固定 Thread 标题、正文和 composer 同时存在 | 推荐一个 client.viewUsable mark |
| Remote mount/agentTeam ready | 只能间接推断 | 必须在 $mount 与 inject 回调处打点 |
| 首次请求发出/响应/DOM commit | 可从 CDP/Resource Timing 和选择器得到总边界 | 查询级耗时和响应字节需要 hook |

基准中至少要区分：

1. 冷页面加载后 Team 入口可用。
2. 已加载页面点击 Team 后 shell 可用。
3. Inbox 或 Thread 的真实数据可用。

把三者合成一个 Client usable 会掩盖“入口已经出现但数据仍未到”的等待。

### 2.3 单次 tool call

**事实：** Harness 在调度 model tool call 时先写 tool/call，正常完成后写配对的 tool/result；ToolRuntime 的 tools/execute waterfall 包住实际工具体，tools/result 在结果最终整理后触发。现有事件足以把一次调用从模型决定调用到结果 durable 的边界连起来。

**事实：** Team 七个工具的 requestId 已由 agent.id + exec.callId 生成；ledger receipt 还带唯一的 operationId 和 sequence。这些字段可直接作为 trace attributes。

最小接缝：

| 阶段 | 信号 | 归属 |
|---|---|---|
| 模型已提交 call | session/event 的 tool/call | 测试包装 |
| 参数准备、pre-policy、调度等待 | tool/call 到 tools/execute 进入 | 测试包装 |
| 工具与 Host 处理 | tools/execute 进入/退出 | 测试包装 |
| post-execute、render、materialize | tools/execute 退出到 tools/result | 测试包装 |
| 结果 durable | 配对 session/event 的 tool/result | 测试包装 |
| Team 业务 commit | agent-team/committed | 测试包装 |
| Ledger queue wait / operation 执行 | operationTail 入队到 operation 完成 | 生产 hook |
| Ledger replay/sort/normalize/validate/apply | 私有内部阶段 | 生产 hook |
| invariant 延迟复检 | setImmediate 开始到返回 | 测试可临时包装公开 validateLedger()；正式指标用生产 hook |

tools/pre-execute 可以用来标出 policy 开始，但它不能括住后续 dispatch；tools/execute 也不能证明它前面在 exclusive barrier 等了多久。完整 tool.call 必须从 durable tool/call 事件起算。

### 2.4 Post-commit fan-out

**事实：** emitCommitted() 先发 agent-team/committed，随后同步执行 change invalidation、reminder 调度和 affectedMembersOf() 的 Member 循环。hot Member 的 notice 派生与 steer/followup 位于发送方调用栈内；需要 wake gate 的 idle Member 转入 notifyMemberAtWake() 的异步路径。

最小接缝：

| 范围 | 起点 | 终点 | 方式 |
|---|---|---|---|
| commit listener dispatch | emitCommitted 进入 | agent-team/committed 返回 | 生产 hook |
| affected member 枚举 | 调用 affectedMembersOf | 返回 | 生产 hook |
| 全部同步 fan-out | Member 循环前 | Member 循环结束 | 生产 hook |
| 单个 Member notice | notifyMember 进入 | skipped/carry/queued/failed/scheduled 结果 | 生产 hook |
| wake gate | gate 前 | gate 返回或 Session 已换 | 生产 hook |
| 实际 inbox 插入 | followup/steer 前 | agent/inbox/inserted | Harness 事件；需 message id 关联 |

agent-team/committed 只说明 commit 已完成、通知即将开始，不能当作 fan-out 完成。tool/result 也不适合作为异步冷唤醒的结束点，因为 Host 可能先返回、后完成 wake gate。

### 2.5 Agent wake、read、reply

**事实：** Harness 已提供下面这些稳定事件：

- agent/inbox/inserted：通知进入 inbox。
- agent/inbox/claimed：Agent 在某个 turn 取得通知。
- agent/status：running/idle。
- agent/assistant-stream：模型 attempt 的 start/end，带 attempt、turn、step。
- session/event：turn/start、user/message、assistant/message、tool/call、tool/result、turn/end。

这些事件足以在**每个接收 Session 同时只有一个待归因协作样本**时拼出 wake/read/reply。并发协作时还缺一项：notice 的 source commit 与 notice message.id 在现有 Team 状态中只通过 UI 文本和当前 case 间接对应；trackTeamWake() 当前只存 message.id -> memberId/sessionId，没有保存 cause request/operation。

最小生产关联点是 deliverInboxNotice() 成功入队处。它应发出一个结构化事件，包含：

- causeRequestId、causeOperationId、source sequence。
- recipientMemberId、recipientSessionId。
- noticeMessageId、noticeKind（message/task/reminder）。
- queuedAs（steer/followup）、wake state（hot/idle/recycled）。

然后 Harness 的 agent/inbox/claimed 以 noticeMessageId 接上 turn，B 的 read/reply tool/call 以 requestId 和 operationId 接上。只记录时间顺序不足以处理并发。

## 3. 测试包装与生产 hook 的分界

| 能力 | 现有测试 wrapper | 临时测试插桩 | 必须生产 hook |
|---|---|---|---|
| Host 总启动 | 是：spawn、URL、appReady | 不需要 | 否 |
| Team fiber 总初始化 | 是：internal/status | 不需要 | 否 |
| Team Client 总可用 | 是：CDP、现有 data 属性 | 可加 Playwright performance mark，但不进入产品 | 精确的 Remote/query/render 分段需要 |
| 单次 tool call 总时长 | 是：session/event + tools waterfall | 不需要 | 否 |
| Model attempt 时长 | 是：assistant-stream | 不需要 | 否 |
| Notice claim 时长 | 顺序场景可直接用 inbox 事件 | 并发场景需要临时 caseId 映射 | 正式因果关联和 fan-out span 需要 |
| Storage/Ledger 内部 | 只能看公开调用总时长 | 可包裹 Domain facade、临时包 validateLedger() | queue wait、replay、projection、validate 需要 |
| Post-commit 同步 fan-out | 无法从现有 commit 事件找到结束位置 | 可通过 probe member 和事件时间近似 | 生产 hook 需要 |
| Member 逐个激活 | 可看最终 fiber 或 Session 出现 | 可包 Session persistence | 生产父/子 span 更稳定 |

判断标准是：wrapper 能站在真实生产调用栈外，且信号本身属于 Harness 的稳定契约，就可以用测试包装；如果必须进 Team 私有控制流才能知道边界，或者没有稳定字段用于因果关联，就应加生产 hook，但默认关闭，不改变业务执行顺序。

## 4. 最小结构化 hook

不建议为每个指标引入独立 API。建议增加一个 off-by-default 的只读 perf sink，一次安装后只发给已注册 observer。字段命名可先使用：

| 字段 | 含义 |
|---|---|
| schemaVersion | 事件模式版本 |
| traceId | 协作样本根 trace |
| spanId, parentSpanId | 分段层级 |
| name | stable span 名，例如 ledger.replay、ledger.queue.wait、team.fanout.member |
| startUnixNs, endUnixNs | 用于跨进程排列 trace 的墙钟时间 |
| durationNs | 解释器内分段使用 monotonic clock；每进程另记 timeOrigin 以便换算 |
| hostInstanceId | 区分重启前后 |
| agentId, sessionId, turn, step | Agent 归属 |
| callId, rootCallId, requestId | tool 归属 |
| operationId, sequence | ledger 归属 |
| noticeMessageId, memberId | wake 归属 |
| outcome | ok/refused/failed/timeout/restarted |
| queueDepth | Ledger operation 排队或 Session query 数量 |
| recordCount, memberCount | 规模属性 |

span 不应无限增长。Ledger 和 fan-out 的 span 只发结构化记录，不复制 operation payload；错误只保留稳定的 error code 和可选短摘要。采样必须按完整 trace 决定，避免只留下父段或只留下子段。

跨 Host、浏览器和重启的关联以显式 id 为主。墙钟时间只用于展示时间线；即使 NTP 或重启令时间戳回退，同一 operation 的因果链仍应能从 parentSpanId、requestId 和 operationId 恢复。

最小 hook 清单：

1. Team Service.init：storage.open、session.inventory、ledger.replay、initialize、workspace.sweep、member.activate 父/子段。
2. AgentTeamLedger：queue.enqueue、queue.acquire、operation.replay、operation.normalize、operation.validate、operation.project、operation.complete。
3. emitCommitted：commit listener、affected members、每个 Member notify、wake gate、notice queued/skipped/failed。
4. deliverInboxNotice：cause operation -> notice message 的关联事件。
5. Client：remote mount、agentTeam inject、query issued/settled、view usable。
6. 可选：每个 Session 的 event-loop lag 和 heap after GC，用于解释某个同步 span 的全局阻塞。

前 1、2、3、4 项是 baseline 后做出可靠归因的必要条件。第 5 项可以先通过浏览器总时长和现有 DOM 锚点降低范围，但优化 Team 数据加载前应补 query/render 边界。

## 5. Trace 关联

测试 runner 为首个样本生成 traceId，后续由消息和工具结果显式传播：

    traceId
      clientNavigationId
      A.agentId
      A.turn
      A.send.callId = rootCallId
      A.send.requestId
      A.send.operationId
      noticeMessageId
      B.memberId
      B.sessionId
      B.claimedTurn
      B.read.callId/requestId/operationId
      B.reply.callId/requestId/operationId

每次跨异步边界都带 parentSpanId。对于通知，Team 提供 causeOperationId -> noticeMessageId；Harness 提供 noticeMessageId -> claimedTurn；Session 事件提供 turn -> tool/call；Ledger receipt 提供 tool requestId -> operationId。所有 hop 都必须有显式字段，不能用一个固定时间窗内最先出现的 B 事件猜因果。

PTC 或嵌套工具调用使用 rootCallId 关联根协作 trace，用 callId 区分子调用。样本结束时验证：

- 每个节点最多属于一个 trace。
- A send、notice、B claim、B reply 能沿 parent 链走通。
- B 的 reply operation 的 note/thread target 与最后查询到的内容一致。
- 同一 Session 若出现第二条 source notice，不能静默归到第一条 trace。

## 6. 样本隔离

每个样本必须有唯一 traceId、独立目标 Thread/Task 和明确的 durable 结果。

| 类别 | 隔离方式 |
|---|---|
| Host cold boot | 新子进程、新临时 DSH_HOME/profile copy、新 SQLite；预生成 corpus 副本再启动 |
| Ledger/Team 测试 | 固定 corpus 起点；每样本唯一 Thread；记录样本前后的 record count 和 event-loop lag |
| Tool call | 独立 Session 或 Thread；禁止上一个样本的未读、wake 和 invariant 工作跨入下一个计时窗口 |
| Concurrency | 所有 caller ready 后 barrier 同时 release；记录实际 overlap 和共享 queue depth |
| Browser | 新 browser context、固定 viewport、locale、deviceScaleFactor、network throttle 和 bundle；关闭 video/trace |
| Provider | scripted provider 与 live provider 分文件、分矩阵；live 结果不能和 scripted 混入同一 p95 |
| Failure | failed/refused/timeout/incomplete 单独计率并保留原始样本，不能从分布里删掉再宣称成功路径延迟 |

warmup 必须在目标样本之外，并使用不同 Thread。对于协作 trace，warmup 的消息和回复不能留在被测 Member 的未读或思考历史中；否则 2 分钟 p95 会被错误地抬高或压低。

单进程连续样本适合 tool 和 collaboration 的常规规模，但每批结束都要清空未读、确认 B idle、等待 invariant 完成，并记录 Ledger 大小。对于 100k 规模，400 个样本造成的记录增长相对较小，但仍应报告起始和结束 record count。

以下样本应使用新的 Host 进程，避免 OS 缓存、JIT 和 Agent 热状态混入：

- 所有 cold Host 主样本。
- cold Member recycle / resume 主样本。
- process restart 恢复场景。

对完整 corpus 可从同一个 immutable 种子复制到新 SQLite。若一次运行内重复使用同一文件，第一个样本会被记为 cold，后续记为 OS cache warm；两类分别汇总。

浏览器 usable 只在成功渲染后完成计时。失败、空数据或进入错误页也要写结果记录，不能因为选择器超时就把该样本从总体样本数中删除。

## 7. 分位数与样本量

预注册算法，避免不同报告中分位数定义漂移：

- 成功路径与失败路径分开。
- 用最近秩：位置 = ceil(p/100 * n)，索引从 1 开始。
- 同时报告 count、p50、p95、p99、max、error/refusal rate。
- 报告 bootstrap 95% 置信区间；冷启动和噪声较大的 run 按子进程/block 做 block bootstrap。
- 正式回归门槛比较同日、同 runner、ABBA 交替后的 p95 相对变化与 CI，不单看绝对值。

样本数量的经验判断：

| 有效样本数 | p95 位置 | 尾侧样本约数 | 用途 |
|---:|---:|---:|---|
| 30 | 29 | 2 | smoke，不能据此判定 SLO 或优化成功 |
| 100 | 95 | 5 | 可显示 p50；p95 只供方向判断 |
| 200 | 190 | 10 | 内部临时对照，置信区间仍然很宽 |
| 400 | 380 | 20 | 每个正式 baseline 核心格的最小建议 |
| 1,000 | 950 | 50 | 稳定观察尾部，适合重要版本比较 |
| 2,000 | 1,900 | 100 | 发布门槛或需要对尾部精细归因时 |

p50 比 p95 稳定得多；100 到 200 个样本足以初步看中位趋势。p95 实际由最慢约 5% 的样本决定，30 个样本时只有 2 个样本支撑，一次挂起或 GC 就可能改变近 3 个百分点。

核心协作、tool、fan-out 的每个正式 baseline 格建议每边 400 个有效样本，A/B 两边共 800 次样本执行。这样两个独立 p95 比较的常见标准误约为约 1.3 到 1.8 个百分点，方向性判断比 100 样本清楚。1,000 样本留给较大的夜间版本比较，2,000 样本用于发布承诺或尾部结论。

cold boot 的单样本成本高，但分布也更容易受一次 process/GC 抖动影响。100 个可作为临时 smoke，200 个可作为 provisional baseline，400 个作为正式 baseline。若磁盘和机器预算只允许 100 个，必须报告 CI，且不能据此宣布小于约 5% 的 p95 改善。100k Ledger 等超大格可先做 100 个探索样本，再对候选改动补 400 个。

live model 的自然方差更大，不应用 100 个样本宣称稳定的 p95。建议 100 个只作 canary 分布，至少 500 个才做模型场景的日常分布比较；脚本 provider 仍是主回归门槛。任何上限由 provider 费用决定时，结论限制为“观察到”，不进入 SLO 门槛。

## 8. 最小 baseline matrix

矩阵采用“最小路径 + 单因素规模格”，不做所有维度的笛卡尔积。基础层为 11 个格；H3 和 C2 是紧邻的尾部/可用性扩展。每个基础格先取 400 个有效样本，cold boot 的 100k 格可先取 100 个。

| ID | 路径 | 固定条件 | 规模或状态 | 主要指标 |
|---|---|---|---|---|
| H1 | cold Host boot | persisted minimal Workspace/Project，2 Members | SQLite 近空，OS cache cold | host.coldBoot、host.teamInit |
| H2 | cold Host boot | 10k Ledger operations，8 enabled Members，4 idle recyclable | OS cache cold，process new | host.coldBoot、ledger.replay、member.activate |
| H3 | cold Host boot | 100k Ledger operations，16 enabled Members，8 idle recyclable | OS cache cold，process new；先 100 样本 | host.coldBoot 尾部、heap/event-loop lag |
| C1 | Client cold usable | H2 数据，固定 Workspace/Inbox，桌面视口 | 新 browser context、bundle cache cold | client.usable、query count/bytes |
| C2 | Team re-entry | Host 已 ready，Team 未进入 | 点击到 Team shell 和数据 loaded | shell.usable、data.usable |
| T1 | read-only call | 10k Ledger，team_view | 单调用、无写 | tool.call、execute、result |
| T2 | read call | 10k Ledger，B 有 20 条未读 | 单 team_thread read | tool.call、Ledger validate/apply |
| T3 | write call | 10k Ledger，reply 到当前 Thread | 无需要通知的外部 Member | tool.call、commit、receipt |
| F1 | post-commit fan-out | 10k Ledger，消息影响 4 个 idle 且可 wake 的 Members | 单次 source commit | fanout、notice.queue、每个 Member |
| F2 | post-commit fan-out | 10k Ledger，4 个 running hot Members | 单次 source commit | fanout、steer/followup 计数 |
| E1 | collaboration handoff | H2，4 Members，B 有 20 条既有未读；新 source notice 唯一 | scripted provider，B hot running | team.handoff、A/B tool call、read/reply |
| E2 | collaboration handoff | H2，4 Members，B cold recyclable，20 条既有未读 | scripted provider，新 source notice 唯一 | wake.claim、notice.queue、team.handoff |
| E3 | collaboration handoff | H2，8 Members，B 有 100 条未读 | scripted provider，drain-oriented read | read/reply、fanout、turn.tail |

这里 H2 是规模基准；H1 和 H3 与 H2 做单因素扩展，不必生成 5 个 Ledger 大小乘以 5 个 Member 数量的全矩阵。

## 9. 扩充分支

baseline 通过后，按异常点选择分支：

| 维度 | 取值 | 触发条件 |
|---|---|---|
| Ledger 规模 | empty、1k、10k、100k | H2 的 replay/validate 占比明显；或 tail 随记录数明显增长 |
| Member 数 | 1、4、8、16 | F1 或 member.activate 的 p95 接近线性以上 |
| 并发 callers | 1、4、8 | queue wait 或 exclusive barrier 成为固定成本 |
| 通知状态 | running hot、idle live、idle recycled | E1/E2 的差异显著 |
| Unread facts | 0、20、100、400 | 读取和 fan-out 随 unread 非线性增长 |
| 失败路径 | stale revision、unread_required、timeout、duplicate request、wake failure | 成功路径已稳定，需要看总体体验 |
| 恢复 | crash/restart after commit、after read、before reply | 不能与正常路径合算 |
| Provider | scripted、live smoke | 只对 scripted 设硬回归门槛 |

每一个扩充格只改变一个主要变量。超时上限和样本截断方法必须预注册；如果对连续工作 load 做固定 2 分钟截断，2 分钟样本是一个可解释的分类型观测，但未完成任务仍属于失败并进入总体结果，不能伪装成成功延迟。

## 10. 原始记录与汇总

每一行基准结果至少保留：

- runId、sampleId、traceId、scenario、repeat、randomization position。
- code SHA、dirty diff digest、Team bundle digest、Harness SHA、profile digest。
- provider kind/model id、script fixture hash、seed。
- host PID/instance id、DSH_HOME 标识（不含凭据）、OS cache policy、Node 版本。
- Ledger record count、Thread/task count、Member count、warmup 状态。
- 所有 span、明确 outcome、error code、是否超时。
- tool call/request/operation/notice/member/session/turn 关联字段。
- Client viewport、bundle cache 状态、query count、compressed/uncompressed bytes（可从 Client 与响应头取得的部分）。
- process CPU、peak RSS、optional heap after GC、event-loop lag。

汇总 JSON 只存由原始 JSONL 重新计算出的 count、分位数、CI 和失败率；不要只保存手工总结。原始 JSONL 中的失败样本要保留，以便总体体验指标与成功路径指标都可以重算。

## 11. 实施顺序

1. 先用零生产代码的 runner 打通 H1、C1、T1、E1/E2 总时长、trace 关联和原始 JSONL。
2. 加入 Service.init、Ledger 和 fan-out/notice 三类只读生产 perf 事件，仍保持默认关闭。
3. 跑 H1/H2、T2/T3、F1/F2、E1/E2 的 100 样本探索，只用于定位噪声和选择 400 样本预算。
4. 固化版本、corpus 和分位数算法，跑 400 样本正式 baseline。
5. 从同一 trace 计算 stage contribution、queue/event-loop lag correlation 和 p95 outlier 聚类，再决定第一个优化目标。

在完成上述步骤前，本文不提供当前毫秒基线，也不声称某一阶段已经是瓶颈。现有代码事实只足够确定观测位置和需要补齐的 hook。

## 12. 源码证据

本轮核对的关键位置如下。行号以本次工作树为准，只用于回到当前代码，不作为 API 约定。

| 主题 | 位置 |
|---|---|
| Team 初始化与 Member 激活 | packages/agent-team/src/index.ts:683 |
| Ledger 构造即 replay | packages/agent-team/src/ledger.ts:658、667 |
| ledger replay / validate | packages/agent-team/src/ledger.ts:2807、2813 |
| Ledger operation 串行队列 | packages/agent-team/src/ledger.ts:632、6478 |
| affected Members 投影 | packages/agent-team/src/ledger.ts:2719 |
| commit 后 fan-out | packages/agent-team/src/index.ts:2590 |
| idle wake gate | packages/agent-team/src/index.ts:2752 |
| notice 创建与 followup/steer | packages/agent-team/src/index.ts:2773 |
| wake 关联现状 | packages/agent-team/src/index.ts:2867 |
| Team Remote mount 与 UI inject | packages/client-agent-team/src/client/index.ts:472 |
| Thread loading / main marker | packages/client-agent-team/src/client/TeamThreadPage.tsx:504、606 |
| Project main marker | packages/client-agent-team/src/client/TeamProjectPage.tsx:351 |
| Inbox marker | packages/client-agent-team/src/client/TeamInboxPage.tsx:158 |
| tools/execute waterfall | ../deepseek-harness/packages/core/tools/src/index.ts:1609 |
| agent inbox inserted | ../deepseek-harness/packages/core/agent-loop/src/inbox.ts:240 |
| appReady 契约 | ../deepseek-harness/packages/boot/cmdline/src/index.ts:45 |
| launcher appReady commit | ../deepseek-harness/apps/cli/src/profile-boot.ts:344 |
| Web URL ready 边界 | ../deepseek-harness/packages/bundle/web-app/src/index.ts:218 |
| Browser boot page marker | ../deepseek-harness/packages/client/web/src/boot-page.ts:35 |

## 13. 事实、推断与未测量

**已核对的事实：**

- Team Service.init 拥有 storage、Ledger、Session inventory、Workspace sweep 和 Member activation 主流程。
- Ledger 有 replay、record validation、sort/normalize、projection apply 和 deferred full validation 路径。
- Team Client 等待 Remote mount 和 agentTeam injection 后才安装 UI。
- Harness 有 appReady、tool/call/tool/result、tools waterfall、agent inbox/status/assistant-stream 事件。
- post-commit fan-out 对 affected Members 同步循环；部分 idle Member 通过异步 wake gate 处理。
- trackTeamWake 当前没有持久保存 source operation 到 notice 的 cause 关联。
- 七个 Team tools 当前被 Harness 视为 exclusive；其 tool span 会包含共享队列等待。

**由代码推导的推断：**

- 单次 tool.call 的增长可能来自 Ledger 全量工作、共享 exclusive queue、post-commit fan-out 和结果持久化的任一组合。
- hot Member 的 notice 派生会在发送方工具调用完成前增加同步工作；cold Member 的总延迟可能主要落在工具返回之后。
- 只测 Agent 模型时长或只测 handler 时长都会漏掉用户等待的显著部分。

**本轮未测量：**

- 没有运行基准，也没有当前 p50/p95。
- 没有证明 Ledger record 数、Member 数或 unread 数与延迟的量化关系。
- 没有确认 live provider 下 p95 是否由模型、队列、存储或唤醒主导。
- 没有修改生产代码；所有 hook 都是设计候选。
