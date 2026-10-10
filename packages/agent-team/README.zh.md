# @contexera/dsh-agent-team

[English](README.md) | 中文

一个 dshHome 内唯一 Agent Team 的 Host capability。`ctx.agentTeam` 拥有 append-only operation ledger、重建当前协作 projection，并作为同一 capability 内 Member Agent 的 lifecycle owner。Thread Attention 和 Member Inbox 是 Host 的持久 projection。未读状态变化时，本包通过 Agent 的公开安全边界 API 发送一次有界、合并的 context 通知；不会中断正在执行的请求，也不运行 Session delivery worker。[Agent Team 架构 Agent Note](../../.scratch/archive/2026-08/m1/design/agent-notes/2026-08-15-agent-team-operation-ledger.md)记录持久化和包拓扑决策。

## Service 约定

Service 使用 `ctx.storageDomain`、`ctx.workspaceRegistry`、`ctx.agents`、`ctx.agentDefaultModel`、`ctx.agentPresets`、`ctx.tools`、`ctx.sessions` 和 `ctx.sessionPersistence`，并在 Cordis 发布 `ctx.agentTeam` 前打开带版本的 `agent_team` Domain。首次启动为稳定 Human Member 追加一条 `team/initialized` operation；后续启动重放同一 operation，不追加新记录。

`status()` 返回当前持久 sequence、operation 数量、channel 数量、Agent Member 数量和 Human Member ref。它不发起模型请求，也不写 storage。`validateLedger()` 对照持久 operation table 检查包内 projection。invariant companion 在挂载时完整重导该表——重放不通过的账本会让启动失败——但当这期间没有任何提交落地时，它会复用账本构造期已经跑过的那次记录级重放：该复用只能用一次，并受三项同一性检查把关（记录条数、末条 sequence、末条 operation id），而这三项只有 operations 表的唯一写者——账本的 commit 路径——能改变。期间任何一次提交、以及此后的每次校验，都会重新重放持久记录。此后每批提交只跑一次，且安排在这次提交调用返回**之后**执行，所以打开 Thread 不会等待 O(账本) 的重放。漂移由这次延后重放记录日志，并在随后每次提交上重新抛出，直到某次重放干净为止。

每条 operation record 包含正数全局 sequence、唯一 operation/request id、actor snapshot 和前一条 operation id。重放拒绝无效字段、table key/id 不一致、sequence 缺口、previous link 断裂、重复 id 和非法状态转换。相同 request id 和 payload 的重试返回原 receipt；同 request id 携带变化后的 payload 会被拒绝。

有一类记录存的是「进度」，而不是它当场报告的那份投影。`team/thread-read` receipt 只携带 Workspace、Member、Thread ref、可选 Task ref、read watermark 与 Inbox delta；Thread、其 facts、anchor、读者的 Attention 与读完后剩余的未读计数，都在每次重放时从 projection 重新派生，因此重放一条读不再需要克隆一份假设投影、也不再重新数未读。这个形态之前写入的记录会把整份画面连同 delta 一起冻结：同一个 strict union 同时接受两形，旧记录以自身完整派生作为 expected 值，加载时就地 normalize 与校验，绝不改写任何已存储字节。两形都不符的记录——receipt 里多带画面字段、旧记录缺了所属 Task 或缺了一条 fact——会让整个 domain 打不开，而不是被猜测。对一次已提交读的相同重试返回原 receipt，画面取自当前 projection，从不返回冻结的旧画面。

## 持久化与生命周期

`storage-domain` 在持久读取处校验每条 record，并拒绝被其他版本标记的 backend unit。Team 只在 `KvTable.put()` 完成后更新 projection。其 Fiber 持有 Domain handle；dispose 通过 Cordis 移除拒绝新的 Service 调用，排空已接受的 Domain write，并在名称可重新打开前关闭 backend unit。

创建 Member 时，先提交稳定的 Member/session/Workspace/preset/private-memory 身份，再执行 unpublished Agent setup。创建 Workspace 记录为 Member 的创建地；更多 Workspace 通过参与操作（`team/member-workspace-joined`/`team/member-workspace-left`）加入与退出——加入即获得协作能力，不移动 Session。Setup 挂载指定 preset，并在发布前检查带 marker 的 `team_message` 和全部八个 Team tools。失败只把该 Member 标为 unavailable。Suspend 等待所属 `AgentHandle` 完全停止；resume 和 Host remount 恢复同一个持久 session。

归档（archival）是介于 suspend 与 remove 之间的可逆第三态，Member 与 Channel 通用。`archiveMember` 提交 `team/member-archived`，dispose 活跃 session（私有记忆与 Session log 留在磁盘），把 Session 从分组面归档，并释放该 Member 的活跃 Claim（公开 `claims_released` Activity + Attention/marker 清理）。`archiveChannel` 提交 `team/channel-archived`，对该频道全部 Threads 上所有 owner 做同样的释放。两种归档都保留 Memberships——是隐藏而非离开。归档实体在所有 Team API 面上"默认不存在"：投影、ref 解析（其 Task ref 不再解析，消息正文渲染为纯文本）、按 ref 的读取（`readThread`/`threadHistory`/`threadObservations`/`listClaims` 以明确的 archived 错误拒绝）——而事实在 ledger 中完整保留，供重放与未来恢复；这条边界正是归档与 remove 的分界。从归档态 remove 仍可用（数据卫生路径）；本轮有意不提供恢复入口（对齐 dsh session 归档现状）。

Member 可携带持久能力意图（`capabilities.tools.allow`、`capabilities.skills.allow`）。它随全部 lifecycle operation 原样流转，Host restart 后原样重放，commit 时不做已知名校验（Harness 升级不会破坏旧 ledger）；与已知名的偏差在 activation 时派生为不持久化的 `capabilityWarnings`。`tools.allow` 是有意的接口预留（当前无 UI 写入路径），供后续 Runtime Revision manifest 编排依赖。编辑语义与 `model` 一致，都是局部更新：字段缺省即保持已存储的值，显式传 `null` 才清除。不管理 capabilities 的调用方可以直接省略该字段。

Activation 把 `tools.allow` 作为 scoped restriction 应用在已组合的 preset 面上（mount → restrict → validate），八个 Team tools 在配置之上强制并集；未知名 drop + warning，不使 Member 失败。对 live Member 的 allow-list 编辑在 turn 边界同 Session 换装 restriction——idle 立即生效，与 running turn 竞争的编辑等待其结束，后续 lifecycle 操作在该等待之后排队。restriction 失败只隔离为该 Member 的 activation diagnostic。

Skills 是 Member 私有的：preset 不带共享 skill-filesystem row，Host 为每个 Member 注册一个 provider，只扫插件内置的只读 core skills（`packages/agent-team/core-skills/`——`member-skill-manager` meta skill，全部 skill 写作/安装/credentials 引导都在它里面）加该 Member 可写的私有 `skills/` 目录（排除默认 roots）。安装就是往自己目录写——目录形态 `skills/<name>/SKILL.md` + 可选 references/scripts，或平铺 `.md`——有意不提供上传 Remote。persona 只陈述私有空间物理事实，meta skill 的 description 负责"涉及 skill 管理工作时先读我"。`skills.allow` 通过同一 turn 边界换装的 live selection ref 过滤 catalog；自装后的发现由 filesystem watcher 驱动。

每个 Team 管理的 session 都会持久写入 `danger-full-access`。项目 cwd 仍是 Workspace 路径，私有记忆位于 `$DSH_HOME/agent-team/members/<memberId>/`。没有标题的 Member session 会通过 session-title service 以 handle 命名，普通 Session 列表因此直接显示 Member 身份；显式重命名或任何既有标题始终优先。隔离的 `team-member` preset 还提供 coding 工具、面向模型的 Web 搜索、Workspace instruction discovery 和 Team protocol guidance。共享的 Web service 与 provider 仍由 Host 持有；preset 只挂载面向模型的 Web tool。小写 `memory.md` 是有界的 16 KiB 参考索引，只有该 Member 的内容变化时才注入，注入块注明当前用量（已用 X.X KiB / 16 KiB）；`notes/` 只通过 filesystem tools 按需读取。超预算索引只产生维护警告，不静默截断。普通 session 和 fork 不获得 Team 身份或私有记忆上下文。Host 启动时会为每个 enabled Member 准备其私有记忆，并对 `inactive` Member 归档其 Session 后删除其私有记忆；重放 ledger 不引用的目录一律不清理，被丢弃 ledger 的遗留物留在磁盘上交给操作者处置。这项删除与 activation 时对旧式 colon 目录的迁移都只作用于当前进程自己的 `$DSH_HOME/agent-team/members/` 之内的路径：记录里指向另一个 DSH home（隔离测试 home、第二个实例）的路径会被拒绝并告警，既不改名也不删除——对它动手等于把 Member 的真实私有记忆搬出它自己的 home。

把 Member 加入 Channel 只授予之后的 read/send/claim authority，不向 Member session 注入历史 Message。每条顶层 Message 都创建 Thread；新 Client/tool 显式选择 taskless，released Client 省略意图时仍保持 taskful；Human 可之后 promotion taskless Thread，原子附加 Task overlay 与结构化 `promote` Task activity。创建 Thread、创建 Claim、显式 follow、顶层消息 mention 到、或 Human 确认邀请会开始 Thread Attention。普通未读从 Attention 派生，structured mention 形成持久 direct marker；终止 Task 的状态变化会为受影响关注者保留稀疏 Activity marker，即使 Attention 已结束仍可读取。`team_inbox` 和 Thread read 是 Host projection，不是 Session inbox 内容。Direct mention context 包含消息正文和来源，Task/Claim 变化（含 promotion）包含简短状态事实，普通未读提供无正文的 Thread-first 路由。提示会合并，忽略提示不会形成循环，resume/runtime error recovery 会从持久未读状态重新判断是否提示。对于可恢复的服务错误，Host 会在连续 `agent/error` occurrence 的前两次后唤醒 Member；第 3 次错误则交给 operator，只有 clean turn 才会重置这段连续错误。

Member reply 必须携带准确的当前 Thread revision，并在一个 operation 内更新 Message 和 Thread facts。`threadRef` 是协作主身份；released task-only Client 可为 taskful Thread 传入 Host-resolved `taskRef` alias，而 Task/Claim 操作仍以 Task ref 为准。未读工作必须先 read；revision 过期时拒绝写入。Closed Task 拒绝 reply 和新的 Attention；reopen 恢复 Task，但不恢复之前的 Attention。taskless Thread 仍支持 reply、follow、mention、Inbox、read 和 history，但没有 Claim 或 Task resolution path。顶层消息可以直接 mention Agent：被 mention 的 Member 会开始关注新 Thread。在既有 Thread 中，Human 的 reply 提到当前未 follow 的 Member 时必须先取得 process-local one-use confirmation token 才提交 operation；Member 的此类 reply 会提交，但只送达该 Thread 曾经承载过的 Member，其余在结果里报告为未送达。mention 在 Message 正文里以 `@Handle` 撰写，由 Host 按 Channel 的可寻址名字解析；Message fact 携带解析后的 refs，Client 只为这些 Member 渲染 mention chip。claim/done/release 和 Task change 是有序的 host-authored Activity。Active Claim 只排斥相同的 normalized Direction；不同 Direction 可以并行。Task status 从 Claims 派生，Human accept/close 是覆盖事实。Close 原子释放 active Claims 并清除 Thread Attention。Member remove 原子标记 inactive、释放 owned active Claims、清除该成员的 Attention 和 direct markers，再归档 session。Message 与 Activity facts 共用一个有界 sequence cursor。

`changes({ scope? }, signal?)` 通过流式 Remote 返回 `AsyncIterable<{ version: number }>`。先发送当前基线，之后发送匹配的 workspace/channel/thread/presence 通知；省略 scope 时观察共享投影，不包含 presence。消费者暂停期间只保留最新待发送版本；取消或 Host 释放时关闭流。Client 必须在每次基线到达时重读投影，即使重启后的版本相同或更低。scope、版本和恢复语义见[架构文档](../../docs/architecture/host-authority.zh.md)。Thread read 只改变私有已读状态，不唤醒任何 scope；没有未读或 marker 可消费时不追加 operation。提交后只为受影响的 Members 重算 Inbox hints。

M1 支持单个 Host writer。Ledger 永久保留，不提供 snapshot 或 compaction。

## Composition

Bundle 使用 Host 已有的 singleton provider，不重复挂载 `agents`、默认模型选择、`tools`、`fs`、`sandboxPolicy`、Session store/persistence、Workspace registry 或 storage 的替代实现。Host services 只挂载一次，再挂载本 Service 及 invariant companion。`/team` 等 Human control 是独立 Consumer。

Team-enabled preset 在自身 Agent scope 注册八个工具，并用 `markAgentTeamPreset()` 标记 `team_message` definition。Preset row 应在执行时读取 `ctx.agentTeam`，不能声明静态 inject：Host 在自身激活期间恢复 Member 时就会挂载成员 preset，声明依赖 `agentTeam` 的 row 无法激活，会让每次启动恢复失败。Scoped tool 重名会在 unpublished setup 阶段失败，只使对应 Member unavailable。Host service provider 重复则仍是 composition error，应删除重复行，不做叠加。

Member 上下文自主管理复用同一 lifecycle owner。`context_rollover` 与 `context_checkpoint` 工具只做校验并结束/锚定 turn；单一 `ContextManagementCoordinator` 监听 Member Session 事件，从 durable 的成功 `tool/call`+`tool/result` 对派生 rollover 与 checkpoint 意图，并经串行 lifecycle queue 执行换窗：等真正 idle、复查 owned-jobs guard、dispose 并归档旧 Session（绝不删除）、提交幂等的 `team/member-session-rolled-over` operation（Member actor、仅限自身、不写 handoff 正文）、激活全新 Session——checkpoint 回返则以精确 completed-turn 前缀作 seed——再送达 handoff 与携带的非 Team 输入。身份、模型、私有记忆、skills、Claims 和 Attention 全部保留；进程内状态在崩溃后可从 durable log 重建，包括重启落在 rollover commit 与新 Session 激活之间时，从 ledger 记录的上一 Session 重建 handoff。第二个 Host 持有的 coordinator（`pressure-policy.ts`）拥有上下文压力：预算阈值从当前 route 的 context window 派生，handoff 预算每 generation 一条通知，硬上限强制原地 compaction 并 fail-closed 验证，provider context-overflow 获得一条有界 compact-and-retry；已接受 Task 的自动 compaction 已退役。Host 侧 clear-context Remote 保留为无可见 Client 入口的迁移逃生门。

## Model Experience

### Host collaboration state

#### What the model sees

启用的 Member 在持久未读工作出现后，可能收到一次有界、合并的 context 通知。Structured direct mention 包含消息正文和来源；Task/Claim Activity 包含简短状态变化；普通未读只包含 Thread-first 路由、数量和 revision，存在时附带 Task overlay。通知通过 Agent 的安全 step 边界排队，正在执行的模型请求和工具不会被中断。常见路径可以直接调用 `team_thread.read`；只有需要跨 Thread 分流时才调用 `team_inbox`。

#### Token effect

Ledger、projection 和 Human status read 不增加模型 token。

#### KV Cache effect

Host ledger 和 Human status read 不改变模型请求或 cache reuse。

## Known Limitations and Deferred Work

- **单 Host writer** — 不支持多个进程并发写同一 dshHome；operation serialization 只在进程内生效。
- **永久 ledger** — M1 不提供 snapshot 或 compaction，storage 会随已提交协作事实增长。
- **没有 remote provider seam** — 在真实 remote Consumer 需要另一 Provider 前，本包合并 capability definition 和唯一实现。
- **自身不提供 Session 迁移** — Member Sessions 依赖 Host 的 Session persistence 与其已发布格式迁移链；本包不提供 Team ledger 或 Member Session 迁移、兼容读取或回退。
