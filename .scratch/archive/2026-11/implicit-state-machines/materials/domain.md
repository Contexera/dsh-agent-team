# 领域状态机：协议、责任、阅读与代际连续性

**完成静态盘点；基线 `7076dbd`，2026-11-10。** 已读根 `AGENTS.md`、`docs/README.md`、`.scratch/AGENTS.md`、`.scratch/README.md` 与本工作项 README。仅写本文，不改代码/测试，不运行重型检查。2062 pass 是父任务提供的基线，不是本次重跑证据；本文测试引用表示已定位的现有用例，不宣称本次执行成功。以下路径以仓库根为起点，行号对应此基线。

## 总结与计数口径

按业务生命周期与恢复边界归为 **19 台逻辑机器**：15 类账本协议/领域生命周期、1 台进程内不变式监控、3 类 Session 事件折叠/游标控制。它们共享权威与原子操作，不是 19 个独立 store，也不意味着状态字段所有排列都可达。Project membership 是派生资格，不另算一台可写机器；Task status 是 resolution＋Claim 的派生显示，不另算独立权威；上下文可见性是 mutation guard，不另立 durable read 状态。订阅实现不在本分工内，Host 总协调与工具入口由父代理盘点。

**已验证的主要回归风险：**“看得到”“已持久阅读”“当前 revision”是三件事。将可见上下文豁免变成自动已读，或把 revision 检查移到 unread 检查之前，会改变既有 UX/AX 与恢复契约。代码已明确防护，未发现需要本轮立即修复的确定性缺陷。第二个高耦合边界是退出/归档/撤权与 Claim 释放、责任回交、Attention/marker 清理，不能拆成多次独立提交。

**决策：** keep＝保留当前表达；localize＝若后续确有改动，只在既有 authority 内归拢纯规则/类型；defer＝没有本轮收益证据，不推动架构迁移。这里是审计结论，不是已实施重构；不建议引入通用 FSM 框架或全仓改写。

## 一、提交协议与检查控制

### D01 — 初始化、规则采纳、请求回执、串行提交与重放（keep）

- 权威/状态：append-only operations 表；未初始化→已初始化，规则版本随 marker 单向采纳；每个 requestId 为未提交或已绑定一条 operation。队列是进程内执行控制，不是持久分布式锁。
- 事件/守卫：`AgentTeamLedger.initialize`（`ledger.ts:1928`）只允许空表首次初始化；重试核对 payload，返回原 receipt；`adoptRulesVersion:1962` 在同一队列中追加规则 marker。`enqueue:8435` 把后继接到 `operationTail`，失败分支也释放尾链，不使队列永久 rejected。
- 效果/重启：写路径先 `table.put` 再 apply，receipt 含 operation/request/sequence/time（`receipt:8179`）。`replay:4204`、`validateRecords:4210` 核对连续 sequence、previous 链、唯一 request/operation 与首条初始化，再独立重建投影。`sortedRecords:8217` 做历史字段/Attention/read/cleanup 的内存归一，不覆写旧表。禁止改用当前规则重判所有历史；不能把“结果可重试”扩张为外部副作用 exactly-once。
- 证据：`operation-protocol.spec.ts:744,753,1794` 的 same-request/collision/结果映射矩阵；`rules-version.spec.ts:66,74`；`rules-v1-replay.spec.ts:81`、`rules-v2-replay.spec.ts:59`。`spec.ts:498,985,988` 是闭合存储 union 与 v1 domain schema；规则版本与存储版本不能混为一谈。

### D02 — invariant 挂载/合并检查/故障闩锁（keep）

- `invariant.ts:26` apply，`:32` mount 同步验证；`:41` `watchCommits` 持有 pending immediate 与 latched divergence。事件为 commit、recheck、dispose；未排程→已排程，多个 commit 合并；检查失败保持闩锁，只有 clean replay 清除。pending 与 latched 可并存，不能压成一个“checking/error”互斥枚举。
- commit 先 arm recheck 再抛既存故障；首次发现发生于响应 I/O turn 后的检查，并非每笔写入前同步全表重放。dispose 清定时句柄，重启丢弃进程闩锁但 mount 重新验证。`ledger.ts:3892` validate / `3896` validateAtMount 的 bootValidation 仅可复用一次且表头必须仍匹配。
- 测试入口：operation protocol、规则重放与投影一致性 suites；本轮未单独执行 companion plugin 的调度/抛错集成测试，不把源码注释当成执行证明。

## 二、身份、空间、资格与会话

### D03 — Member 持久生命周期（keep）

- 权威为 Member facts；`enabled↔suspended` 是 Human 可逆工作对；`enabled/suspended→archived` 保留 Session/私有记忆、隐藏成员；非 inactive 成员可 remove→`inactive`，包括 archived→inactive。没有 archive restore 入口，不能替用户承诺可恢复操作。
- `setMemberState:7327` 精确检查前态；`archiveMember:2893`、`removeMember:2855` 释放 active Claims、更新受影响任务/责任、清 Attention 与 markers，作为同一 operation 快照。真正 Session 资源/目录清理由 Host 执行，账本仅记录事实。
- 重启从原记录重放，运行时 availability/presence/capabilityState（`types/entities.ts:104`）不是另一条生命周期权威。测试：`member-archival.spec.ts:19,62` 覆盖归档、清理、冷重启、后续 removal；`agent-team-attention.spec.ts` 覆盖关联清理。

### D04 — Workspace participation（keep）

- `joinWorkspace:2248` / `leaveWorkspace:2281` 管附加 Workspace 参与关系；default Workspace 不可 leave，Session 不迁移、不另建。Human 授权，拒 inactive/archived、重复加入/无关系退出，加入还验证目标范围 handle 冲突。
- leave 原子释放该 Workspace active Claims、回交责任、撤销该范围 Attention/marker/owner 关系，不能误清其他 Workspace。重启重建 participation；不要把跨 Workspace 工作当跨 Session 身份。
- 测试：`agent-team-attention.spec.ts:66,94` 明确 Session/default Workspace 不动与隔离退出；`member-presence-scope.spec.ts` 为运行时投影边界入口。

### D05 — Project 生命周期（keep）

- `createProject:1974` 建 active 项目，Human 更新元数据（`updateProject:2002`）；`archiveProject:2325` 附近 active→archived，无恢复入口。归档一次性释放其 active Claims、回交开放任务责任、清项目范围 Attention/markers；记录保留，某些历史读取仍可由只读路径提供，不能等同项目可继续写。
- `requireActiveProject:7513` 是 live 写门；重放验证历史归档和 cleanup，而不是删除 Tasks/Threads。测试入口 `project-archival.spec.ts`、`archived-reads.spec.ts`；清理共用 `buildReleaseSnapshot:7149` 与 `validateReleaseCleanup:5078`。

### 派生关系 — Project membership（不另计机器，keep）

`isProjectMemberFrom:7570` 的资格来源是 Workspace participation ∩ 生命周期许可，再并 owner grant、被点名、历史 enrollment、曾参与 Thread。rules≥2 排除 inactive/archived；离开 Workspace 后历史发言不再授访问权。`withoutOwnerGrant` 供撤 owner 时判断其他参与依据是否仍存在。Human 不走 Agent membership 谓词，而走专属 authority。

`team/project-member-added/removed` 的 schema/apply/validate 分支是**历史兼容，不是当前 CRUD 接口**；`operation-protocol.spec.ts:1115,1122` 明确无当前 writer。因此不要看到 `AgentTeamProjectMembership` 类型（`types/entities.ts:260`）就新建另一份 membership store 或独立 add/remove FSM。

### D06 — Project owner grant/revoke（keep）

- `changeProjectOwner:2032`、`projectOwnerChangeProblem:2075`：Human 管具名 owner；Human 固有拥有全部 Project，不能被移除；Agent 必须存在、enabled/suspended 且参与所在 Workspace，拒绝重复授予/撤销不存在关系。
- grant 新起 Main Attention，但若已 follow 则保留自己的起点/read 水位；revoke **不是 unfollow**，也不是取消所有历史参与。`accountabilityReturnsFrom:6797` 按 rules≥3 判断其余参与资格，仍有效时不盲目回交任务。owner、accountable、executor、verifier 绝非同义词。
- grant/revoke、Main activity/marker、必要责任回交同条落盘，重启可重建。测试：`project-owners.spec.ts:61,89`；`task-accountability.spec.ts:69,118`、`task-transfer-v3.spec.ts:90`。

### D07 — Session generation 绑定/替换与历史换代（keep；旧入口 defer）

- 当前 `recycleMemberSession:2185`：Host-only、Member enabled、previousSessionId 必须等于当前绑定、新旧必须不同，inputFromSeq 必须非负安全整数；只替换 sessionId，其他 Member facts 不变。
- `previousSessionForMember:2221`与 `lastTransitionForMember:2231`保存恢复所需前代/目标绑定。先 durable bind 后 activation 之间若崩溃，Host 可基于 transition 重建目标；此处不重审 Host 激活状态机。
- `types/operations.ts:96–150` 还包含 restarted/context-cleared/renewed/rolled-over；其中旧入口为 replay-only（`operation-protocol.spec.ts:967,976,984,991`）。`ledger.ts:4308` renewal、`:4370` rollover 校验 enabled/旧绑定/只变 Session，checkpoint source+through 成对、checkpoint 与 seed 同现。不得把兼容 validator 误读成仍可调用的 API，也不可轻删。
- 测试入口 `legacy-session-transition.spec.ts`、`session-recycling.spec.ts`、`wake-recycle.spec.ts`；generation 身份是 Session binding，不是本文新增的数字计数器。

## 三、Thread、Task、Claim：一个原子责任图

### D08 — taskless Thread → Task-bearing Thread（keep）

- `types/entities.ts:306` Thread 的 taskRef 可缺省；`startThread:2542`可建 discussion/task，`promoteThread:2627` 单向加 Task，不存在 demote 或新建第二 Thread 的迁移。
- promotion 需要尚无 Task、项目 owner/Human authority（依历史 rules）、unread/revision fence；Agent 必须以自己为 accountable。一次写入 Task、Thread revision、promote activity、责任 Attention/markers；Thread/ref/历史保持，Task 初始 open/todo。
- 重启验证同一引用图。测试入口 `task-accountability.spec.ts`、`operation-protocol.spec.ts` promotion 行；不要把 discussion/task 卡片 enum 作为独立可写分类机。

### D09 — Task resolution＋责任转移（keep；纯规则可 localize）

- `types/entities.ts:291`、`changeTask:2770`：权威 resolution 为 open/accepted/closed；status 映射 accepted→done、closed→closed，open 时由 Claim 派生：有 active→in_progress，否则有 done→in_review，否则 todo（`deriveTaskStatus:7320`）。因此不是 status×resolution 任意组合。
- close 释放 active Claims，accept 完成 active Claims，reopen 不复活终态 Claims，而按保留的 Claim 历史重新派生。Human 可接受 todo/in_progress/in_review；Agent 仅可接受 in_review，必须 owner 或 rules≥3 的 accountable，且**曾持有任何 Claim 都禁止验收**。reopen 需原 accountable 仍合法。
- `transferTask:2733`：Agent 只能转自己负责的 open Task；rules≥3 可给 enabled、有效 Project participant；同一目标拒绝。更改责任同时更新 revision/活动/所需 Attention，资格退出则原子回交 Human。
- `acceptedClaimRefs` 是接受时全部 done Claims 的持久判别，不只本次自动完成者；`refollowedMembers` 记录新 reopen 语义，旧记录保留旧语义。测试 `task-accountability.spec.ts:69`、`task-transfer-v3.spec.ts:90,109`、rules replay；不能靠现态补算历史接受通知。

### D10 — Claim direction 占用与终止（keep）

- `changeClaim:2667`、`types/entities.ts:502`：新建 active→done/released，两种终态不再原地重激活；另一次领取产生新 Claim。open Task 才能更改，Human 不能更改 Agent Claim，Agent 只改自己的 active Claim；normalized direction 的 active 占用必须唯一。
- Claim 写入同时派生 Task status、推进 Thread revision、写公共 Activity、为新 claim owner 建 Attention、给责任方 marker。关闭/归档/离开范围可从另一业务入口原子 release；accept 可原子 done。历史曾持有关系保留，用于独立验收禁止自审。
- 重启需校验 Claim/Task/Thread 一致；测试 `task-accountability.spec.ts`、`agent-team-attention.spec.ts`、protocol Claim rows。不要让“无 active claim”一律推成 todo：仍有 done 就应 in_review。

## 四、Attention、阅读与稀疏未读

### D11 — Thread Attention 的关注期间（keep）

- `types/entities.ts:315`；`changeAttention:2926`：不存在↔following row，row 带 source/start/readThrough。follow 从当前尾部后起，不重读全部历史；新 claim/author/accountable 等业务事件也会建立期间，source 是来源，不是独立状态。
- own active Claim 时不得 unfollow；unfollow 清自身 direct markers 而非清所有领域责任。rules≥4 允许 follow closed Task（`ledger.ts:2949` 附近），旧规则仍限制；close、accept、reopen 的特殊收件人规则由 `closeThreadInboxFrom:6381`、`acceptThreadInboxFrom:6414`、`reopenThreadInboxFrom:6424` 决定。
- Attention 与 direct/activity marker 可并存，不能假设“未 follow 就绝无未读”。测试 `closed-thread-follow.spec.ts`、`agent-team-attention.spec.ts`、rules-v1 replay。

### D12 — Main Attention（keep）

- `writeMainAttention:2985`与 `mainAttentionForFrom:6572`：Project Main stream 的独立关注期间，非每条 Thread 的合计。owner grant 仅在缺 row 时创建，Agent 可 unfollow；Human 的固有 Main Attention 不可 unfollow，应通过 read 消费更新。
- owner revoke 保留个人 follow；退出/项目归档按 scope 清理。Main 与 Thread 的 start/readThrough 相似但合法来源、Human 规则不同，不值得以一个通用“关注 store”抹平。
- 重启由 inbox delta 重建；测试 `project-owners.spec.ts:61,89`、`main-stream.spec.ts:342,376`、`legacy-main-attention.spec.ts`。

### D13 — Thread read：连续水位＋direct/activity/reminder 稀疏消费（keep）

- `readThread:3416` 在队列内选择；`prepareReadReceiptFrom:6112` 默认首 20 个 unread，只允许已选 prefix；`isUnreadFact:6237` 为 follower 普通未读 OR direct marker OR activity marker。marker 不是 Attention 的别名。
- 普通阅读只单调推进水位，消费较老 direct marker 不能倒退水位；仅移除实际 batch 的对应 markers。Task reminder 只在确实确认内容后清除。空 delta/no-op 不落盘，不制造 receipt。重试已提交 read 返回原 receipt，展示可基于当前状态，不重新消费新内容。
- `spec.ts:470,481` 同时支持紧凑 receipt 与旧完整 read snapshot，strict schema 避免两种形状同时成立；validator 必须从前态和记录界限重建，不能依赖当下 Session 可见性。
- 测试 `thread-read-selection.spec.ts:88,117,139,196,252,285` 覆盖零选择、不跳读、重放、请求绑定与队列竞争；`thread-read-progress.spec.ts` 覆盖连续水位。

### D14 — Main read 与 Main sparse markers（keep）

- `readMainStream:2467` / `planMainRead:2526` 队列内确定范围；普通来源来自 Main Attention 水位，稀疏来源可为 message/activity/event marker；`mainUnreadFrom:6878` 按 sequence 合并，ordinary/direct 可同时为真但只呈现一次，排除自己的普通产出。
- 无 follow 仍可因命名/责任保留稀疏未读；消费只改读取人的 Main row/markers，不能顺带确认对应 Thread 的正文。no-op 不写；读界限与 inbox delta 落盘可冷重放。订阅 event marker 在此仅作为来源 union，不重审订阅发送状态机。
- 测试 `main-stream.spec.ts:323,342,376`，`main-read-context.spec.ts`，`thread-read-selection.spec.ts:326`；私有 read 不应推进共享 projection cursor（`member-change-domains.spec.ts:23`）。

### 跨 D08–D14 的 mutation fence（守卫，不另计机器）

`deferredThreadWrite:7249` 顺序为 **unread → 可见性豁免 → baseRevision 精确匹配**。未读未全可见返回 unread_required；全可见也仍须通过 stale_revision。豁免不写水位、不清 marker、不代替 read。

`surface-visibility.ts:41` 只承认当前 Session surface 中的合法 Team notice，或经 sourceEventSeqs 绑定自有 Team tool call 的成功 result；完整文本 digest 必须匹配。`:91,100,109,119` 逐 fact 校验 message body digest/分片完整覆盖，activity 身份＋不可变事实 digest；不可只因某串 ref/摘要出现就认定“已读”。无 live Agent/无 probe/缺任一事实都 fail closed。`activity-facts.ts:97,122,133` 固定身份及 canonical digest，不依赖当前 Task 显示状态。`postMainMessage:2423` 对 Main unread 也有相应可见性守卫（此路径不冒充 Thread revision fence），不能跨 surface 豁免。

已定位回归证据：`surface-exemption.spec.ts:81,105,121,136,159` 验证只放行当次写、不持久阅读；`surface-probe.spec.ts`、`surface-agreement.spec.ts` 覆盖渲染绑定；`thread-read-selection.spec.ts:285` 覆盖队列内边界。UX 少一轮无意义 read；AX 不误丢提醒；DX 只有一处 gate，而不是创建平行“已见”表。

## 五、提醒与 Session 可重建投影

### D15 — Task reminder episode（keep）

- `task-reminders.ts:46` `planTaskReminders` 是纯评估器；权威 episode/marker 在 ledger（`reminderFacts:980`、`planReminders:1010`、`raiseReminder:1021`）。候选键为 task/kind/recipient/baseline，未触发→已 raised；阅读消费 marker 不删除已发生 episode，因此同 baseline 不反复提醒。
- 仅 active Project/open Task；in_review 的 review backlog 对 Human 看状态年龄、Agent 看已观测 idle≥30min；in_progress 的 stalled 看公开静默或执行者 idle>24h。未知 runtime idle 不算 idle；已有 unread responsibility 或 episode 则抑制。发出前重新评估，不能把旧候选直接提交。
- 重启 episode 保留，runtime idle 需重新观测。测试 `task-reminders.spec.ts`、`task-reminder-restart.spec.ts:109`；Host 定时器本分工不审。保留纯 planner＋ledger commit 的分离，不另存“待触发”权威。

### D16 — Member reminder 定时承诺＋occurrence 消费（keep）

- `types/entities.ts:439,451`：active→done（once 已触发）/cancelled；重复 schedule 保持 active。创建 `ledger.ts:1743` 解析 schedule/note、限额与成员资格；`:1797` cancel 仅自己或 Human，清当前 marker；once/every/cron 的具体日历解析由既有 reminder 模块负责，本轮不扩大审计。
- `raiseMemberReminder:1860` 提交前 replan，按 reminder 保存最新未消费 occurrence，替换旧 marker 而非无界堆积。`consumeMemberReminders:1892` 以 reminderRef＋**occurrence sequence** 确认，旧通知不得吃掉刚替换的新 occurrence。
- context 已收而 consume 尚未落盘就崩溃时会重送同 occurrence，明确至少一次而非 exactly-once。测试 `member-reminder-ledger.spec.ts:105,194,216,230,261` 覆盖请求重放、消费、重送、替换；`:340` 覆盖额度。

### D17 — Context continuity/checkpoint/rollover 意图与携带输入折叠（keep）

- `context-projection.ts:75` state、`:192` createStep、`:340` full fold、`:351` projection definition；权威是 Session events，缓存不是另一份 Team ledger。跟踪 open tool calls、成功结果形成 checkpoint/pending intent、同一 turn/end 才释放，`turnEndSeq=-1` 表未完成，不能被后续别的 turn 复活。
- tool/result 必须匹配已记录调用，error/坏参数不生 intent；祖先 inherited prefix 的事件不归当前 Session。checkpointRef 由 Session＋callId 稳定生成（`:138`），旧 rollover 的识别主要服务旧日志恢复，不代表当前公开工具仍存在。
- inbox splice 的候选输入→user/message 已 surfaced→同 turn 的非 interrupted assistant/message 才 consumed；Team 可重生成 notice 与真正外部输入的携带规则有别；continuation 以 checkpointRef 去重，不能重复“释放”旧意图。`:365` carriedInputOf 从日志拼回候选正文。
- 重启由相同 Session event stream 还原，fork/current generation 边界保留；测试 `context-projection.spec.ts`、`context-projection-legacy.spec.ts`。这是派生恢复状态，不允许 UI/工具直接修改 pending enum。

### D18 — cold Inbox 重建（keep）

- `cold-inbox.ts:18` `coldInboxOf` 从空 next-turn/next-step 列表顺序 fold `agent/inbox/spliced`；合法 splice 插/删产生下一状态，越界、非安全整数、跨两列表重复 message id 立即返回 undefined，不做猜测修复。
- 没有 live Agent 时仍可恢复队列边界；无独立 persistence，权威来自 Session splice 日志，调用者必须区分合法空队列与无法可信重建。与 D17 的“输入已被回答”不是一套判定，不应合并。
- 测试入口 `cold-inbox.spec.ts`；纯函数实现可重放，不应引入第二个 durable pending-input store。

### D19 — Session event cursor 冷起/增量命中/重建（keep）

- `session-event-cursor.ts:31` init、`:40` advance、`:84` owned advance；游标带 logFrom/foldedThrough/最后 seq+type anchor。第一次全量 fold，同 Session/同 fork 边界/anchor 成立时只折尾部；截短、换 prefix、anchor 失配或换 Session 则 cold refold，事件切片与声明范围不符抛 RangeError。
- owner→Session 绑定防 replacement 误命中，owner key 使缓存规模受 roster 约束；重启丢缓存不丢语义。anchor 不是内容哈希或抗篡改证明，不为此另造完整 log integrity 系统。
- 测试 `session-event-cursor.spec.ts:48,65,73,89,96,107,117,127,149,172` 覆盖增量、无变化、非零 cut、范围错误、替换/截短/Session 变化。

## 六、14 个文件的角色与后续最小机会

| 文件（均在 `packages/agent-team/src/`） | 是否承载可变控制/折叠；盘点归属 |
| --- | --- |
| `ledger.ts` | 唯一 Team 持久事实入口及可重建索引，D01、D03–D16；本轮排除订阅内部 |
| `invariant.ts` | 进程内 pending/latch，D02 |
| `context-projection.ts` | Session 纯 reducer＋projection 声明，D17；不承载独立 durable authority |
| `cold-inbox.ts` | 无持久成员的历史 fold，D18 |
| `session-event-cursor.ts` | 调用者持有的增量 fold 状态，D19 |
| `types/entities.ts` | 领域 facts/投影/refs 的类型；不执行转换，不能按 union 数量算机器 |
| `types/operations.ts` | 事件闭合类型＋receipt/历史 envelope；兼容事件不等于当前接口 |
| `spec.ts` | 纯存储 schema 与历史 spelling/message stamp 归一，非 lifecycle orchestrator |
| `task-reminders.ts` | 无自有状态的纯候选评估；D15 的 guard/planner |
| `acceptance-context.ts` | `planAcceptanceContext:27` 纯二选一计划，128000 tokens 且可 compact 才 compact，否则 remind；消息构造无队列权威 |
| `surface-visibility.ts` | 当前 surface 的纯读取/验证，mutation guard，不存 seen 状态 |
| `activity-facts.ts` | 不可变事件事实、文案与 canonical digest，无写 authority |
| `mentions.ts` | `scanBodyHandles:62` / `resolveBodyMentions:91` 纯文本扫描；代码区/ASCII 边界/@all 与候选排除非持久 parser 状态 |
| `request-scoped-id.ts` | `stableRequestUuid:4` 用 namespace/request/scope hash 出 UUID 形状，纯确定函数；不记录请求是否成功 |

**最小机会：localize，不扩权。** 将 D09 现有 resolution→status 规则视为单一纯语义边界：后续真正改 Task 转换时，优先复用已存在的 `deriveResolvedTaskStatus:7316`/`deriveTaskStatus:7320`，避免写路径与 replay validator 继续出现各自手写分支；是否值得抽取完整 transition plan 需真实改动证明，不能仅为“显式 FSM”迁移整个 ledger。更低风险的即时产物就是此状态/guard/测试地图，帮助 Agent 精确定位且不改变用户行为。

**延后：**通用 FSM 引擎、独立 membership/seen store、恢复被撤掉的 rollover/renew API、以 projection enum 重建领域 authority、拆散 release snapshot 为多提交、声称外部投递 exactly-once。它们没有本轮 UX/DX/AX 同时改善的证据，反而会扩大兼容与恢复回归面。

**验证边界：**本次只做源码/测试静态交叉定位、文件范围检查；无代码、无测试改动，因此未跑 build、全套单测或 browser。没有 UI 改动，未开展 appearance/interaction 验证。要交付任何后续行为修改，仍需重跑对应 suites，再由父代理整合跨 Host/工具/Client 的端到端证据；本文不能作为“全部状态组合已实测”的声明。
