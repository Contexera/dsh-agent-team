# Host authority

[English](host-authority.md) | 中文

Team 是每个 DSH home 内唯一的协作域。append-only operation ledger 是 Member、Workspace、Channel、Message、独立 Thread aggregate、可选 Task overlay、Claim、Thread Attention、Inbox 和 Activity facts 的 durable authority。

修改 Host capability 时，先阅读 package source/tests，再阅读匹配的 Harness capability contract。导航表见 [`harness-navigation.zh.md`](../harness-navigation.zh.md)，其中将 Host 改动映射到 `deepseek-harness/docs/subsystems/` 和 source packages。

## Ledger 权威与提交
- mutation 进入 Host authority，并提交一条 durable operation。
- Projections、Inbox results、tools、commands、Remote responses 和 UI 都从已提交的 operations 派生。
- Client code 不得解释 ledger records，也不得创建 parallel authority。

## Lifecycle 与通知
- Agent lifecycle、JSON/SQLite replay、authorization、idempotency 和 revision checks 都留在 Host 侧。durable unread 变化可以通过 public Agent safe-boundary API 产生一条有界、合并后的 Agent context notification：direct mentions 携带其 Message 和 source，Task/Claim Activities 携带简要状态变化，ordinary unread 只携带不含正文的 Thread-first route（若存在则带 Task overlay）。Promotion 与其他 Task transition 一样是 Task activity，通过 Activity markers 到达 followers。这类 notification 不是第二权威，也不保证模型恰好处理一次。
- 已提交的 Session transition（`team/member-session-renewed`、`team/member-session-rolled-over`）记录的是 desired binding，而不是已完成的切换：retire 旧代与 activate 目标都是 ledger 写入之外的 Host 效果。startup 与 Member 的显式 recovery 动作都会依据记录的 previous Session 补完被中断的 transition；每个效果各自推导是否已完成——live handle 不能证明 archive 那一半跑过——因此重复请求返回已记录的 receipt 与诚实状态，而不是再提交一次绑定。
- 每个 durable Member state 只有一组期望的外部 effect——[Member Lifecycle](../domain-model.zh.md#member-lifecycle) 表。每一次 lifecycle operation 在 commit 之后重跑这组 effect，startup 对每个非 enabled Member 也重跑同一组，因此被 crash 或失败的 Workspace/Session/filesystem 调用打断的 archive、suspension、remove 通过重跑同一条推导收敛，而不是第二次 durable 写入。
- startup 绝不把非 enabled Member 激活为 enabled：启动阶段失败的 effect 只记日志并在下一次 boot 重试，而不是让 boot 失败；lifecycle operation 继续通过现有队列严格串行。
- ledger append 之后剩下的是 delivery 效果——commit listeners、Client change invalidation、participation notice，以及对每个受影响 Member 的一次 wake。每一项都经过同一条边界：失败只记日志、不让操作本身失败，因此失败的 listener 或 wake 仍以 committed result 作答，而不是虚假的回滚；只有 invariant divergence 继续 reject。失败的 Inbox wake 会清掉自己记录的 notice state，因此下一次触及该 Member 的 commit 重新推导同一批 durable Inbox facts 并重试，不追加第二次操作；DM 保留其显式的 recorded-but-not-delivered 错误。

## 变更流与 Projection
- `changes()` 是流式 Remote，可声明一个 scope（workspace/channel/thread/presence）；省略 scope 时观察共享 Team 投影变化，不包含 presence。Host 先注册监听，再发送当前基线，之后只发送匹配的变更通知；消费者暂停期间仅保留最新待发送版本。取消或 Host 释放时关闭订阅。Thread read 与 `team/dm-sent` 不改变共享投影，因此既不推进其版本也不唤醒订阅者。Presence 使用进程内 epoch，其余 scope 使用最近一次共享投影提交的 ledger sequence。版本只在同一 scope 和 Host 生命周期内有意义。Host 只为受 operation 影响的 Members 重算 Inbox hints。
- `TeamChangeStream` 在每个页面内通过 `ctx.remote.$stream()` 按 scope 共享一个逻辑流；Harness 管理共享的 `/api/remote.mux` WebSocket 和连接恢复。每次开场基线都会触发重新读取 Host，包括重连后的相同或更低版本，以补上首次读取与订阅之间的变化，并在没有新提交时恢复失败的读取。最后一个 listener 离开时释放该 scope，插件释放时关闭所有 scope。传输失败在恢复前只报告一次；终止性错误直接报告，不使用 Team 自有重试循环。没有长轮询回退、跨页面主从选举或单活跃页面限制。并发的补充读取合并通知；读取期间再收到通知时保留后续一轮读取，不用旧版本过滤重连基线。Human Inbox 徽标订阅无 scope 通知，经 debounce 重拉 Inbox 合计，并在本页 Thread read 后刷新。Presence 订阅更新 Member 可用状态，不唤醒 Inbox。通知只是重新读取的提示，不是第二份事实存储。
- Host 对 Member Session 的 projection 改为增量折叠。 context intent、clock baseline 与一次性 pressure notice 都派生自同一个 Session 自身的 events，现在三者都经 Session event cursor 读取：cursor 把折叠出的值与其已消费的日志位置放在一起——`context-projection.ts` 提供折叠，`session-event-cursor.ts` 提供位置——因此一个日志第一次被读取时折一次，之后每次只折其后追加的 events。 cursor 假定该日志只 append，并只校验能校验的部分：它记住自己停在哪个事件的 sequence 与 type，所以 fork 前缀变动、日志变短、或该事件被替换时一律从头重折，fork / resume / rollover 最坏只退回一次冷折，而不会给出错画面。 模块里点名记下一条残留而不是掩盖它：同一 sequence、同一 type 但内容被就地替换的事件对该守卫不可见；这只有违反 append-only 契约才可达，而内容敏感的锚点也关不掉它，因为只有锚点位置被重读，更早的已折位置被换掉会同样放行。

  读取完整被检视日志或外来日志的冷路径——activation、transition、timeline、carried-input 重放——仍全量折叠。 三者各自按 Member 保存一个 cursor，并在该 Member 的 Session 变化时替换，因此保留的折叠状态以 roster 为界，而不随 Member 经历过的代数增长。

## Session 持久化与重放
- Bundle 目标为 DSH `0.2.0-rc.2`。 其 Session persistence 使用当前 DSH schema：随附的 JSONL backend 会自行迁移已发布的旧格式（v0/v1/v2 → V3 → V4），旧格式 Session 数据无需手动处置。 这个 DSH Session-schema 策略不会抹掉 Team operation history：Team 有意保留针对旧版、Message-level `occurredAt` 之前 records 的窄 replay normalization。 普通存储的 Message operations 在加载时使用包裹 operation 的 instant；旧 `team/thread-read` snapshot anchors 与 Message facts 从来源 Message operation 解析 instant，只有必要时才回退到 read operation——而 snapshot 正是唯一仍会走到这条 normalization 的记录形态：它把 Message anchors 与 Thread facts 连同消费掉的 Inbox delta 一起冻结在记录里。

  当前每次读写入的 receipt 只存进度与 Inbox delta，是唯一不存任何 instant 的 Thread-read 形态；旧记录就地 normalize 并校验，绝不改写。 不要增加 Team 自有的 Session migration、宽泛 compatibility reads 或 fallback storage paths；可选的 `member.model` inheritance 与可选 Message attachments 都是当前语义，不是 legacy fields。

## Attention 与 Inbox 权威
- Thread Attention 是 private Member x Thread state。ordinary unread 来自当前 Attention；structured mentions 创建 direct markers；terminal Task changes 在 Attention 结束后仍可能保留稀疏 Activity markers。Host 是唯一 Inbox authority。Session history 可以保留有界 notification context（包括 direct Message bodies 和 Task/Claim transition summaries），但不能形成 parallel unread projection。

## Session 策略与上下文压力
- Team 管理的 Agent sessions 使用显式 Team preset 和可信的 `danger-full-access` policy，这是面向可信 Workspace 的有意产品边界。
- Host 激活 Member 时，会通过 session-title service 用其 handle 命名没有标题的 Member session，使普通 Session list 显示 Member identity。显式 rename 或任何已有 title 始终优先，命名失败不会导致 activation 失败。
- 已接受 Task 的自动 compaction 已退役。Member 上下文压力由引擎的策略决定，Host 把该策略绑到 Member 的读数上（见 Tools and preset）：预算阈值从当前 route 的 context window 派生，handoff 预算每 generation 一条通知，judge 判为无关的长间隔 step 被扣住而不是放行，硬上限强制原地 compaction 并 fail-closed 验证，provider context-overflow 获得一条有界 compact-and-retry。Pending/error bookkeeping 只在进程内维护；只有进入 transaction 的 compactions 才会写入 durable Session history，绝不写入 Team ledger。
- 终止回合的恢复先读 Harness 的结构化失败、再看措辞：稳定的 code 单独决定——`RATE_LIMIT` 是 rate limiting，`TRANSPORT`/`TIMEOUT` 是 transient network，显式 429/503 响应是 rate limiting——其他任何 code（quota、auth、context、请求状态）无论 message 写什么都保持 manual；只有无 code 可用的错误才回落到窄 message 签名。
- 两级分工不变：`agent/request-error` 负责同一步的 pressure/compaction 重试，`agent/error` 负责终止回合恢复及其连续错误上限；无论走哪条路，失败都保留已记录的 Member diagnostic。

## 私有记忆、归档与身份效应
- `$DSH_HOME/agent-team/members/` 下的 private-memory directories 是 Member identity 的 Host-owned effects，不是第二权威。Member activation 确保 private-memory directory、`notes/` 和缺失的 `memory.md` 存在；startup 不会清理 ledger 不知道的 `member:` directories。显式 Member removal 会归档其 Session 并移除该 Member 的 private-memory directory；Team removal path 之外的 entries 保持不动。这项删除与 activation 时对旧式 colon 目录的改名都限定在当前进程自己的 members root 之内——记录里的 `privateMemoryPath` 是一条 durable 绝对事实，指向「当初添加该 Member 的那个 DSH home」里的目录；因此解析到另一个 home 的进程会拒绝搬移或删除它（并告警），而不是把 Member 的真实私有记忆搬出它自己的 home。
- Member 与 Channel 的归档是介于 suspend 与 remove 之间的可逆第三态。 `archiveMember` 提交 `team/member-archived`，dispose live session（私有 memory 与 Session log 留在磁盘）、把 Session 从分组 surface 归档，并以公开 `claims_released` Activity 加上 Attention/marker 清理释放该 Member 的 active Claims——被隐藏的 Member 不得让 Task 卡在 in progress 或留下幻影 unread 计数。 `archiveChannel` 提交 `team/channel-archived`，对 Channel 上所有 Thread 的 owner 施加同样的释放形态；两种归档形态下 Membership 都保留（隐藏态，非退出）。

  Archived 实体从所有 Team API surface 消失——projection（view channels/threads/tasks/members、mention 候选、Channel join、编辑）、ref 解析（`resolveTaskRefs`/`resolveThreadRefs` 跳过它们，使 message 正文渲染为纯文本）、以及 ref-addressed read（`readThread`/`threadHistory`/`threadObservations`/`listClaims` 以明确的 archived 错误拒绝，绝不伪装成 unknown-ref）——而事实完整保留在 ledger 中供重放与未来恢复；这条边界就是 archival 与 remove 的分界。 从 archived 状态 Remove 仍可作为数据清理路径，且本轮刻意不提供 restore 入口（与 dsh 的 archived session 对齐）。 Channel 归档之前写入的 ledger 省略 `channel.state`；记录 schema 在 load 时把它归一化为 `active`。

## Member capabilities 与 skills
- Member capabilities（Member 实体上的 `capabilities` 字段：预留的 `tools.allow` 与 `skills.allow`）是随全部 lifecycle operation 原样流转的 durable intent。commit 时不做已知名白名单校验，保证 Harness 升级后旧 ledger 仍可重放；与已知名的偏差在 activation 时派生为不持久化的 `capabilityWarnings`。`tools.allow` 是有意的接口预留（无 UI 写入路径），供后续 Runtime Revision manifest 编排依赖，cleanup 时勿删。编辑语义与 `model` 一致（absent 即清除）；不管理 capabilities 的调用方必须回传已存储的值。
- Activation 把 `tools.allow` 作为 scoped restriction 应用在已组合的 preset 面上，顺序为 mount → restrict → validate（validate 观察限制后的可见面），并在配置之上强制并集八个 Team tools。未知名 drop + warning，不阻断 activation。对 live Member 编辑 allow-list 在 turn 边界同 Session 换装 restriction：idle 立即生效；running 的编辑等待 turn 结束，后续 lifecycle 操作在该等待之后排队（lifecycle Remote 严格串行——等待期间发起的 suspend 在 swap 之后执行；disposed-scope 监听器覆盖 lifecycle 之外的销毁）。restriction 失败只表现为该 Member 的 activation failure。
- Skills 是 Member 私有的。 preset 不带共享 skill-filesystem row；Host 在每个 Member 的 agent exact scope layer 上（traceable-service 接缝，与 tool restriction 同构）注册一个 filesystem provider，只扫两个 Team 自有 root（排除默认 roots）：插件内置的只读 core skills（`packages/agent-team/core-skills/`，排前——同名内置 skill 跨升级保持稳定）和 Member 可写的 `$DSH_HOME/agent-team/members/<memberId>/skills/`。

  Member catalog 因此以内置集起始（`member-skill-manager` meta skill——全部 skill 写作/安装/credentials 引导都在它里面，persona 只陈述私有空间物理事实）；安装就是往自己目录写（目录形态 `skills/<name>/SKILL.md` + 可选 references/scripts，或平铺 `.md`），有意不提供上传 Remote，filesystem watcher 驱动发现。

  `skills.allow` 通过 live selection ref 过滤 `list()` 输出（编辑与 tool 编辑同一 turn 边界换过滤并失效 catalog）；过滤是可见性语义不是安全边界——两个 root 始终被扫描和 watch。 Member remove 连同私有目录一起删除；suspend/resume 与 Host restart 恢复相同 catalog。

## Composer attachments（cache，不是 archive）

Composer attachments 是 `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/` 下的有界 cache（包含经过清理的原始名称和 `meta.json` sidecar），不是 archive，也不是 ledger bytes。

- `putAttachment` 写入 immutable payload（每个文件上限 10 MB，并从名称中剥离 path separators 和 control characters）；`getAttachment` 为 Client display 读取它们。两者和其他 Host capabilities 一样都是 typed Remote actions。
- `requestId` 是一次 upload 的幂等键：同一 payload 的重试 replay 原结果而不是写第二份条目，复用该 key 携带不同 payload 的调用被拒为 request collision；cache id 单独由 request id 派生，因此 Host 重启后重试仍收敛到同一条目，不需要第二个 durable store 或进程内 map。
- Channel 与 Thread composer 的附件入口有两个：「+」按钮选择文件，或直接向输入框粘贴——携带文件的粘贴会被拦截并进入同一 pending-file chips 流，纯文本粘贴保持浏览器原生插入。
- Message 在 ledger 中记录 attachment metadata（`attachmentId`、`name`、`byteSize`、`mediaType`）；存储 body 为每个 attachment 携带一行面向机器的 `[attachment] <absolute path>`，让 Member agents 通过普通 file tools 按 path 读取 bytes。Client 会从 display 中移除这些行，改为根据 metadata 渲染 thumbnails/chips。
- Ledger 是唯一 durable attachment authority。Bytes 是 transient 的：Host startup 以及每 24h 执行一次 GC sweep；被 Message 引用且超过 72h 的 uploads（Member consumption window），或从未发送的 orphaned uploads 超过 24h 的，都会被移除。Metadata 保留，Client 随后优雅降级为 name chip。
- Members 通过 `team_message` 的可选 `attachments`（absolute paths）共享文件：Host 先验证每个 path（absolute、regular file、non-empty、10 MB），再以 extension-derived media type 复制到 cache 的 immutable entry；entry id 由该 message/reply request 及 path 在列表中的位置派生，因此 agent-sent images 与 composer uploads 的渲染一致。任一 rejection 都会拒绝整个 send，不提交也不复制。
- request 派生的 identity 让重试收敛：同一 request 的 send/reply 重试复用首次尝试准备的条目而不产生 orphan，body 中每文件一行的 `[attachment]` 跨重试保持一致。准备之后才失败的 message/reply 会删除本次尝试准备、且没有 committed Message 引用的条目（ledger 的引用集是 guard）；真正未被引用的 uploads 仍由 GC 回收。复用 request id 时，ledger 比较记录的 resolved attachment ids 与本次重试的 resolved ids，携带不同 attachment 集合的重试被判为 collision。
- 不需要为手动 path references 增加机制：粘贴到 Message body 的 absolute path 会被 Member agent 像其他文件一样读取，Host 不会触碰不属于自己的内容。

## Human profile 与版本脚注

Human 的显示名与头像引用存放在 Team Host row 自身的 Config（settings namespace 即该 row 的 id，user layer）；头像 bytes 存放在持久的 `$DSH_HOME/agent-team/human/v1/` store，从不进入带 TTL 的 attachment cache。

已退役的 `agent-team-human` section 不再是权威：rc.1 的 settings importer 通过一份封闭的内置映射搬运 section，第三方 section 会留在改名后的 legacy document 里。启动时若发现该 row 仍是 pristine（默认名且无头像），就沿用设置页同一条写入路径收养这些 facts，已经重新填过的值优先。

四个 typed Remote 服务设置页：`humanProfile`（名字、头像引用与版本脚注 facts），以及 `putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar`（只收图片，与 attachments 共用 10 MB 上限；已删除的条目读取时抛错，Client 回退到首字母）。

脚注携带本 Host 实际运行的那份 bundle 的版本（从已安装包自身的 manifest 读取，因此陈述的是 profile 真正装上的那一份，而不是每次发版都得记得改的字符串），以及 repository 链接；当后台检查观察到更新的已发布 release 时，再多一条点名该版号的更新 tip。

检查最多每 12h 询问一次公开 npm `latest` document，后台刷新使 profile 读取永不等待网络，任何失败都落为"无已知更新"，`DSH_AGENT_TEAM_UPDATE_CHECK=0` 时保持关闭。

ledger 为 `team_view` 与 @ 匹配读取同一份 profile，一次改名同时到达每个 surface；`human` 是 Human 的永久别名，任何 agent handle 不得占用该字面，因此 `@human` 跨改名持续送达，而 chip 始终渲染当前显示名。
