# Member Runtime / Context 隐式状态机审计

- 基线：`7076dbd2578641ef5b20a773a8191a7178d1b937`；2026-11-10；初始只读审计，随后按追加授权完成 alternative-cancellation 的单用例 red/green 与单行 guard。
- 状态：**完成**；13/13 个列名源码、9 组机制、4 组 helper 已收口；本责任域没有剩余审计项；补试取消风险已复现并最小修复，定向文件 37/37 通过。保留第一批记录，验证与覆盖清单见下文。
- 范围：MemberRuntime、compaction engine/budget、context/memory、wake/idle、reminders、skills、stored-session reader、context source/codec、time context。Host/index、领域账本、subscription、client/tools 由其他审查负责，仅核对必要调用接缝。
- 已读根 `AGENTS.md`、`docs/README.md`、`.scratch/AGENTS.md`/README、工作项 README、codebase-design skill。当前业务以源码/测试为权威，历史材料不作实现权威。
- 初始审计“覆盖”指源码读取、测试符号扫描及关键断言抽读；追加验证仅执行 `member-compaction-flow.spec.ts`。未跑完整套件/typecheck/build/浏览器；完整测试与 typecheck 由主代理负责。

## 第一批已确认：权威分层与保留项

1. `MemberIdleTracker`（`packages/agent-team/src/member-idle.ts:3-23`）是**进程观察值**而非持久 Member 意图：首次 idle 记时，重复 idle 不重置，running/error 清除，dispose 用 forget；重启后空。`idleMs` 对时钟回退夹零。裁决：**保留**，不要把观察时间写入账本或拿它替代 durable last activity。
2. `decideWakeRecycle`（`wake-recycle.ts:64-80`）已是纯决策和具名结果，不是待引入 FSM 的对象：disabled → 无前代 → last activity 不明 → TTL 未过 → 只此时才允许 measure-context → context 不够大 → recycle。阈值均严格大于才换代，任何信息不全默认保留连续性。`wakeRecycleIdentity`（87-91）由旧 Session 派生稳定 successor/requestId，为 crash 重试幂等提供身份。裁决：**保留**：UX 不误丢工作轨迹，DX 可测试纯 gate，AX 可解释 reason。
3. `MemberRuntime`（`member-runtime.ts:80-91,152-197`）区分 persisted capabilities intent 与 live applied proof：`Map.has` 区分“已应用 undefined”和“无证据”；tool policy swap 失败尝试恢复上次 allow，仍保留账本新意图待后续重试。warnings 和 proof 都是 runtime，重启重算，不应持久化成平行权威。
4. turn-boundary（`member-runtime.ts:204-237`）：running 才注册 wait，非 running status 或同 Session disposed 结束；settle 注销监听；Host shutdown 统一释放。裁决收口为**保留**；后续 M2 补充生命周期接缝与并发测试证据。

## 完整分组与计数口径

本范围共 **9 组有状态机制**：8 组隐式编排/资源协议，1 组显式事件 reducer（时钟）；另列 **4 组无状态决策/读写适配**，不把带 `kind` 的结果联合类型误算为独立 FSM。没有发现需要统一 FSM 框架才能表达的复杂度。技能挂载并入能力应用；换代与 continuation 合列一组恢复协议，避免按 Map/Set 数量膨胀计数。下文源码路径均相对 `packages/agent-team/src/`，测试均相对 `packages/agent-team/tests/`。状态名是审计记号，不声称仓库已有同名 enum。

### M1 — 能力意图到工具/技能面的应用（隐式，保留；变化局部化）

- **状态/事件：** 未挂载 → 已限制/技能已挂载 → 新意图待应用 → 应用成功或失败保留旧面 → 释放。`MemberRuntime` 的 restriction、enforced allow、bindings、applied proof、warnings、skill mount 共同承载状态；不是六个业务状态机。入口 `applyMemberToolPolicy`（101–149）、`reapplyMemberToolPolicy`（164–184）、`recordAppliedCapabilities`（159–161）、`swapSkillSelection`（255–257）。
- **守卫/权威：** ledger 是能力意图，live proof 只是应用证据；`appliedCapabilitiesMatch`（153–156）用 presence 区分未知和已应用空值。工具来自 preset 自有定义与显式共享目录工具，Team 工具不能被 allow-list 移除；执行 guard 还核对定义身份，拒绝同名替换及未声明调用。未知名字降级为 warning，不让升级改名直接使 Member 不可用。
- **效果/恢复：** swap 先释放再限制，失败尝试恢复旧 allow；恢复也失败只日志，不把新意图冒充已应用。`forgetMember`/`disposeAll`（299–325）按所有 map key 的并集释放，重启重新派生。技能 `mountMemberSkillProvider`（`member-skills.ts:33–45`）无 registry 返回无 mount；`select`（76–79）换过滤器并 invalidate；`list`（82–87）只筛目录，`get`（90–92）透传，**这不是文件安全沙箱**。
- **证据/裁决：** `member-tool-policy.spec.ts:202,246,395,424,458,509,537,572,607,645,748` 覆盖 late registration、替换、跨重启、turn-boundary、失败重试和响应状态；`member-skills.spec.ts:75,193,231,246` 覆盖私有发现、选择、清理与恢复。UX 要保留 stored intent 与 applied/deferred 的可见差异；DX 宜继续把运行时副作用收在现有深 module；AX 必须保留准确工具声明和 warning，不能用“配置保存成功”代替生效。**不增加第二份 durable capabilities，不合并意图与证据。**

### M2 — 当前 turn 结束屏障（隐式资源协议，保留）

- **状态/事件：** 无需等待 / 等待中 → 已结算。`awaitTurnBoundary`（`member-runtime.ts:208–230`）只在 running set 命中后挂监听；同 Agent 非 running status、同 Session dispose、Host `releaseTurnWaits`（234–237）均结算。其他 Agent/Session 事件不能放行。
- **权威/效果/恢复：** running set 与 Host 事件是进程观察，不进 ledger。settle 从 resolver set 删除自身，排空监听 disposer，resolve 一次性 promise；Host 停止时也释放，避免 lifecycle 队列永远等不到新事件。等待返回 `waited` 不表示 capability 已应用，也不表示 generation swap 已成功。
- **证据/裁决：** `member-tool-policy.spec.ts:458` 明确把后续生命周期动作排在当前应用之后；`748` 验证运行 turn 的技能目录不被中途打断。屏障只管时序，成员生命周期链由 Host 持有，不移入这个 module。UX 不打断 turn，DX 保留幂等注销，AX 保证单次模型调用的工具/技能面不漂移；不把等待 promise 变成持久“成员正在编辑”状态。

### M3 — 私有内存目录预备/迁移/移除（隐式外部资源协议，保留）

- **状态/事件：** 未准备、legacy-only、sanitized 已存在、colon twin 并存 → 可运行目录；Member remove → archive Session 与删除本进程拥有的目录 → 成功或部分失败。`initializePrivateMemory`（`member-runtime.ts:266–280`）先迁移/合并，再 mkdir notes/skills，`wx` 首建 memory.md；已有文件不覆盖。
- **守卫/权威：** `memberMemoryDirectoryPath`（60–67）只处理末段身份中的冒号，保留 Windows drive colon。`migrateLegacyMemoryDirectory`（335–350）只同 parent rename，目标已存在不取代；跨 home 拒绝迁移并新建当前目录。`mergeTwinMemoryDirectory`/`mergeDirectoryContents`（377–410）以 live root 为胜者，冲突副本另存 `.colon-twin`。内容权威是文件，不是 Session 中注入的快照。
- **效果/恢复：** `cleanupRemovedMember`（284–296）只删除 `isInsideMembersRoot`（354–358）认可的 descendant，archive 与 rm 用 allSettled 收集失败后 AggregateError；不是原子事务，不能把部分成功描述为“全部清理”。重试利用 mkdir/rm/既存目标的幂等性，失败诊断和 durable removed 状态的接续归 Host。
- **证据/裁决：** `member-memory-dirs.spec.ts:20,28,69,110,137,175` 和 `member-memory-scaffold.spec.ts:16`。UX 保数据且不碰另一 home；DX 保留文件系统协议，不套业务 enum；AX 保留唯一绝对私有路径。不要为简化迁移而删除旧 producer 兼容、覆盖旧 memory.md 或将清理失败降级成无声成功。

### M4 — 每步输入预算与输出 clamp（隐式请求编排，保留；高耦合重点）

- **状态/事件：** pre-step 固定 route/收集 pending 与 claimed → assemble 捕获当前 prompt/tools → prepare → 可选 prune/compact/重测 → clamp → header 记录生效；reject、throw、step/end 清 route。关键入口 `installMemberCompaction`（`member-compaction.ts:61–120,122–215`）。
- **守卫/权威：** `prepareBudget` 拒绝 abort/retiring 和与 frozen step route 不一致的 request（123–135）。`measureMemberInput`（40–58）计入待进入 messages、当前 prompt 和 admitted tools，不能只看上次 header。纯函数 threshold（27–31）取 configured budget、窗口比例、reserve 的较小值；窗口太小交上游限制，模型信息缺失并不假造窗口。
- **效果/恢复：** 先 optional prune，再一次 engine 调用，成功后仍超预算则明确拒绝；已确认摘要失败可在真实窗口容纳时透传，输出空间不足仍拒绝。prepared clamp 只有 header 事件证实后成为 logged clamp（86–98）；下次恢复原 requested 值（126–130），不把临时收紧粘住。prepare 失败只把原 claimed 输入放回 next-turn（200–214），不能重放新注入块；abort/retiring 不复活输入。
- **证据/裁决：** `member-compaction-flow.spec.ts:112,124,180,201,215,228,242,251,397,522,538`；测试覆盖非 sticky allowance、cancel、上游 overflow 恢复、保留输入与 route 清理。此协议跨 Agent waterfall、Session header、summary engine 三处，属于本域最高回归敏感度；局部化应围绕单次请求 prepared/committed 数据，不引入统一全局 FSM。UX 保输入，DX 保日志提交点，AX 保实际可用工具与预算一致。

### M5 — 摘要路由、有界补试与跨轮断路（隐式，单行局部修复完成）

- **状态/事件：** route 可尝试 → primary summary → 必要时一次 alternative → 成功或 degraded；新 step 重置 alternativeSpent，但相同失败 route 不自动重付；换 route 或手动 compact 成功解除断路。`MemberCompactionEngine.useStepRoute`（48–55）、`degraded`/`takeSummaryFailure`（58–67）、`compactNow`（70–80）、`summarize`（83–113）、`recordFailure`（128–131）。状态是 Agent 弱引用内存；非 durable checkpoint。
- **守卫/权威：** `summaryDecision`（134–148）先尊重显式 summary target，再考虑 frozen step route；`canHoldSummary`（152–165）计 summary region、instruction、tools、cap，严格小于窗口才允许。并非每次摘要必有两次调用：只有 `decision.kind === route` 且未花 alternative 才补。Team budget enabled 时压住另一套 pressure 自动触发（40–44），保留 overflow/manual 路径。
- **已证实问题与修复：** 原补试 catch 在调用者取消后仍执行 recordFailure，误把 step route 置 degraded。新增 `member-compaction-flow.spec.ts:373–395` 用已有 `beforeSummary` seam 使 middle 首次摘要无正文，再在 large 补试开始时调用 agent.cancel；red 在第 386 行稳定得到 degraded=true，而期望 false。`member-compaction-engine.ts:109` 加入与主 catch 第 98 行相同的 abort guard，取消直接重抛，不记录 failure/degraded；其余重试预算、真实错误断路与手动恢复不变。
- **证据/裁决：** 既有 `member-compaction-flow.spec.ts:315–371` 覆盖 fallback、断路、manual 与主尝试取消；新增 `373–395` 同时验证 route 顺序、aborted、无 degraded/summary failure，以及下一轮仍能在同一 middle route 正常摘要并完成；`557` 保留每步至多 primary+alternative 覆盖。整个 flow 文件 37/37 green。UX 不因取消持续失去自动摘要，DX 对称异常出口，AX 仅在真实摘要失败时进入 degraded。无框架或额外状态。

### M6 — 模型可见身份/参与/私有内存新鲜度（隐式派生，保留）

- **状态/事件：** 分类块未出现/当前一致/过期；memory 进一步区分无可用 baseline、完整 baseline、update notice、unavailable。`memberContextMessages`（`member-context.ts:79–110`）逐类比较，只注入变化类；digest 变化且 baseline 仍在才发短 update，否则补完整 baseline。
- **守卫/权威：** 当前身份/ownership/workspace 取 Host，memory 取文件；`visibleMemberContext`（137–158）仅从 surface 的 projected message 取证，校验 textDigest，不因原 event 仍有 tag 就相信剪裁后的内容。`readMemberMemory`（200–205）区分 absent/unreadable；16 KiB 为注入上限，不是磁盘读取上限；超限发 unavailable/warning，不擅自删写、截断或摘要文件。
- **效果/恢复：** unchanged 无注入；空 ownership/participation 显式替换旧列表（168–187）。compaction 掉 baseline、只剩 stale notice 或投影改写文本时重补完整信息；重启重新根据 surface 推导，不保存“我已注入过”全局 Set。Host 缺失、unbound Agent、reject/abort 不污染普通 Session（57–71）。
- **证据/裁决：** `member-context-integration.spec.ts:107,147,182,219,423,450,487,523,552,573,614`；`member-context.spec.ts:5,16,23,30`。UX 防旧角色/路径残留，DX 保单一派生算法，AX 清楚区分完整参考与“早前副本已过期”。不要把 update 当最新 memory 正文，也不将“完整文件 readFile”误称有界 I/O。

### M7 — generation swap 互斥与 legacy continuation 恢复（隐式，保留）

- **状态/事件：** per-member settled → transition in-flight → settled；另有 checkpoint 未结束/已结束未送/进程已调度/日志已送达的恢复门。`TeamContextManagement.requestRecycle`（77–99）、`whenSettled`（56–60）、`recoverPendingTransition`（117–134）、`repairContinuations`/`claimContinuationLatch`（136–157）。
- **守卫/权威：** members Set 只防并发，不是 durable generation authority。真正已提交的 binding/输入边界归 ledger 与 Session log。`wakeRecycleIdentity` 和 `teamRolloverIdentity`（37–39）用旧 Session 及必要 toolCallId 派生 successor/requestId，避免重试造第三代。legacy pending 没 durable turn end 只记 spent 日志并放弃；不永久锁住 Member。
- **效果/恢复：** transition reject 只日志，finally 清锁/settle waiter；因此 await 完成不等于新代生效，Host 必须再读权威。dispose 解除所有 waiter，但不声称取消 executeTransition。continuation 只补有 durable turnEnd、无 deliveredSeq、未调度者；followup 同步失败删除 latch 供重试；成功 latch 只是本进程去重，重启靠 log 重判。
- **证据/裁决：** 已抽读 `team-context-management.spec.ts:103–198` 的失败解锁、稳定 identity、并发第二请求、whenSettled、dispose 与 continuation 断言；`member-wake-safety.spec.ts:57,113` 扫描到 commit 后 activation 失败和 legacy unanswered-input 恢复。UX 不重复唤醒/丢输入；DX 明确“settled 非 succeeded”；AX 代际上下文只由 Host 换绑。不要把锁或 scheduled latch 落成平行 ledger。生命周期 commit/boot 细节属于主代理 Host/index 审计，本材料不重复宣称完整验证。

### M8 — 观察到的 idle 区间（隐式，两态，保留）

第一批第 1 条收口为保留：`MemberIdleTracker.status/idleMs/forget`（`member-idle.ts:4–23`）只有 unknown 与 observed-idle。首次 idle 建 baseline，重复不重置，running/error/forget 清空；重启 unknown，时钟回退夹零。没有“推测离线已 idle 很久”的恢复路径。`task-reminders.spec.ts:125,340` 扫描覆盖 idle 起点及 unknown/running 不作 idle 信号。UX 宁可晚提醒不误报，DX 避免与 last durable activity 混淆，AX 不把观察缺失叙述为“长期无进展”。wake TTL 的判断用 durable 活动时间，是另一输入，不合并两种时钟。

### M9 — turn 时钟 snapshot 基线（显式事件 reducer，保留）

- **状态/事件：** `ClockBaseline` 的 openTurn、lastMessageTime、lastInjectionTime、lastTurnInjectionTime；`applyClockEvent`（`member-time-context.ts:63–82`）显式 switch turn/start、turn/end、user/assistant/tool event。turn 开始/结束只清 turn-local baseline，历史可见消息时间保留；只有自身 producer message 算 snapshot，普通消息不能伪造时钟注入。
- **守卫/权威/效果：** `shouldSampleClock`（93–96）首步必采样，后续等本 turn 上次落日志 snapshot 满 refresh interval；`apply`（118–153）一 Member 一个 owned cursor，Session 换代冷启动，不跨代猜 elapsed。参考时钟用固定 UTC+8，回退 elapsed 夹零，排序与并发仍由 seq/revision 决定。snapshot 落 Session 后 fold 才证明它存在，不另写时钟 authority。
- **证据/裁决：** `member-time-context.spec.ts:27,64,101,106,115,129,194`、integration `53,63,86,128` 覆盖 baseline、新代、回退、采样与串接。UX 消除无意义时间确认，DX 已有清楚 reducer 无需再框架化，AX 获得可靠 elapsed 而不把 wall clock 当因果顺序；保留现状。

## 非状态机：四组不能为了统一形式而重写的 helper

1. **wake 决策：** `wake-recycle.ts:64–91` 的 gate ladder 与稳定 identity 已由第一批说明；`wake-recycle.spec.ts:28–75` 覆盖所有 reason 和 identity。它不拥有计时器、不自行读存储、不执行换代；`measure-context` 是允许调用方花一次昂贵测量的结果，不是持久中间态。保留精确 reason，变更 Host orchestration 时仍复用它。
2. **提醒排程/候选：** `member-reminders.ts` 全部是纯函数。`parseReminderSchedule`（250–280）归一 once/every/cron，10 分钟最小间隔、固定 UTC+8、400 年日历最近间隔检查；`reminderRefForCallId`（305–306）注入式转义 `%`/`:`，`sameReminderIntent`（322–324）判幂等重试意图。`planMemberReminders`（358–374）只读 active 且 enabled/suspended 的 durable 事实；once 按原到期时刻一次，recurring 停机欠账折成当前一次，新 occurrence 允许替换未读旧次。`nextReminderWakeAt`（400–412）只给将来唤醒时刻，不自建 timer。durable active/cancelled/finished 与 occurrence 消费归 ledger/Host，不在本文件复制。测试扫描 `member-reminders.spec.ts:66–336`、delivery `176,217,270,296`、timer `33`；长定时器截片和消费失败重送是 Host 接缝证据，不声称这里有 timer FSM。UX 防补发风暴，DX 保纯 planner，AX 可解释 reminder 与 Session 换代无关。**保留；计时器总审计由订阅/Host 域汇总。**
3. **存储读取与错误分类：** `StoredSessionReader.read`（`stored-session-reader.ts:116–127`）是单次 open→read→finally close 资源协议，无跨调用状态；返回完整 inspection 或 missing/refused/corrupt/io/unknown。`sessionClassInChain`（82–89）最多向下四层 cause（含根共五次匹配），只有 reader 知道是 session I/O 时直接 code 才归 io；外部 `sessionFailureOf` 不误认普通 fs 故障。`exists`（130–131）对 unexpected stat 错误仍抛出。`stored-session-reader.spec.ts:42–104,160` 扫描含 close 失败归类和 identity mismatch。这是**有界 cause 深度，不是有界历史读取**；不把完整事件读改成截断“成功”来换性能。保留分类 seam，优化全量读须有真实性能证据再延后决策。
4. **上下文信封 codec/识别：** `createCheckpointContinuationMessage`（`context-codec.ts:16–25`）只写一种 snapshot；`context-source.ts:48–62,93–160` 只读本 producer 当前/legacy/V3-converted 精确 kind 和 section 形状。handoff 必要字段、safe integer seq、trigger 需通过，continuation 必须恰一非空 Checkpoint section。`parseRelatedFiles`（106–115）先 JSON，兼容旧逗号连接格式；不以正文关键词认身份。`context-source-migration.spec.ts:133,151,175,206,215,225,246,256` 扫描覆盖历史归属、第三方排除与逗号路径。保留；移除旧识别器会破坏历史恢复，不是无成本死代码清理。

## 证据级别、重启语义与完成边界

- **已复现并最小修复（1 项）：** alternative-cancellation 在原实现中误开 route circuit；red 的具体失败为 `expected true to be false`，位置 `packages/agent-team/tests/member-compaction-flow.spec.ts:386:82`。现于 `packages/agent-team/src/member-compaction-engine.ts:109` 加一行 abort guard，定向文件 37/37 green；不再作为未验证风险列入后续票。
- **验证边界：** 证明调用者取消不设置 route degraded、不留下 summaryFailure，且下一 turn 可正常摘要；不声称覆盖所有取消竞态、完整 Host 集成或真实模型环境。没有新增待验证缺陷；全量测试与 typecheck 尚待主代理。
- **重启语义：** M1 的应用证据、warnings 与技能挂载重建；M2 waiter 和 M8 idle 观察不跨进程恢复；M3 文件及迁移结果保留，激活重跑幂等准备；M4 请求闭包与 M5 route 断路不持久化，新实例重新准备预算，已写 header/checkpoint 仍归 Session；M6 从文件与当前 surface 重建新鲜度；M7 从 ledger/Session projection 重试，稳定 identity 避免多造 generation；M9 只 fold 当前 generation 自己的事件，不沿用前代时间基线。四组 helper 均无自身持久状态，提醒事实在 ledger，不在 planner。
- **完成边界：** 已提供来源符号/行号、状态/事件/守卫/权威/副作用/恢复及相关测试；追加实现严格限定本材料、`member-compaction-engine.ts` 与 `member-compaction-flow.spec.ts`，日志只写指定 ignored artifacts 目录；不扩展 Host 生命周期审计，不调用付费模型。跨域去重与全量验证留给主代理。

## 风险与最小后续决策

- **最高风险面：M4/M5 请求预算—摘要—取消的组合协议。** 现有 tests 已覆盖很多正常及失败路径，不建议全局状态机替换；M5 的 alternative cancellation 已通过现有 flow seam 复现并以单行 guard 修复；保留原有有界 fallback/circuit 策略，不建议继续扩大改造。
- **第二风险面：M7 的 lock settled 不代表 commit/activation 成功。** 呼叫方必须回读 member binding，不能拿 `Promise<void>` 当成功凭据；现有 finally 与日志不能为了 API 美观改成“全部成功”。优先保留 Host 单一 durable authority，而非设计新 transition store。
- **延后项：** 文件迁移冲突命名、完整 Session/memory 读取性能、统一 FSM 框架。此次没有用户故障或性能数据证明必须扩大改造；不以理论场景宣称 bug，不加工具链或大范围测试。
- **无回归验证：** 新增一个精准回归用例，生产码仅加一行取消 guard；该文件 37 个测试全部通过，`git diff --check` 通过。主代理提供的既有 2062 通过仍只是改动前基线；本子代理未运行完整测试/typecheck/build/浏览器，不能以定向 green 替代全量结果。

## Alternative-cancellation red/green 记录

预先约定 seam 为现有 `member-compaction-flow.spec.ts` 的真实 Agent loop + BudgetAdapter；无新增 mock、私有方法调用、计时器或测试基础设施。调用顺序为 primary middle 空摘要 → alternative large 中取消 → aborted；取消后下一 turn 在 middle 成功摘要，验证恢复而非只检查内部标记。

- **Red（生产码未改）：** `pnpm exec vitest run packages/agent-team/tests/member-compaction-flow.spec.ts -t 'does not open the circuit when the turn is cancelled during the alternative summary'`；exit 1，1 failed / 36 skipped。route degraded 应为 false、实为 true；此前顺序和 aborted 断言均通过。日志：`artifacts/state-machine-audit/member-compaction-alternative-cancellation-red.log`。
- **Green（加 guard 后）：** `pnpm exec vitest run packages/agent-team/tests/member-compaction-flow.spec.ts`；exit 0，1 file passed / 37 tests passed。日志：`artifacts/state-machine-audit/member-compaction-alternative-cancellation-green.log`。
- **差异检查：** `git diff --check -- packages/agent-team/src/member-compaction-engine.ts packages/agent-team/tests/member-compaction-flow.spec.ts` exit 0；review diff 为生产码 +1 行、测试 +24 行。日志目录经 `git check-ignore` 确认为 ignored，不提交日志。未写入独占集之外的源码/测试/材料，未执行全量测试/typecheck。

## 最终覆盖清单与交接

任务文字写“14 sources”，但逐项实际列 **13 个唯一文件**；本次逐一覆盖这 13 个（基线共 2362 行，修复后共 2363 行），没有臆造第 14 个，也没有漏掉清单项：

| 源码 | 对应分组/主要符号 |
| --- | --- |
| `member-runtime.ts:1–411` | M1–M3；policy/bindings/proof/wait/memory/forget/dispose |
| `member-compaction.ts:1–216` | M4；threshold/measure/install/prepareBudget |
| `member-compaction-engine.ts:1–196` | M5；step route/fallback/circuit/manual/gate |
| `member-context.ts:1–260` | M6；可见 surface 判据、分类注入、memory 读取/呈现 |
| `team-context-management.ts:1–167` | M7；互斥、settle、legacy swap/continuation 恢复 |
| `member-idle.ts:1–23` | M8；idle 观察基线 |
| `wake-recycle.ts:1–91` | helper 1；纯 gate 与换代身份 |
| `member-reminders.ts:1–413` | helper 2；cron/校验/幂等/到期候选/next wake |
| `member-skills.ts:1–102` | M1；provider mount/select/list/get/dispose |
| `stored-session-reader.ts:1–133` | helper 3；错误分类与完整 read/close |
| `context-source.ts:1–173` | helper 4；producer/legacy/envelope 识别 |
| `context-codec.ts:1–25` | helper 4；continuation 单一 writer |
| `member-time-context.ts:1–153` | M9；事件 reducer、采样与 owned cursor |

交接：9 组机制 + 4 组 helper 已收口，第一批结论保留并扩展；没有需要本代理继续实施的源码工作。主代理负责与 Host/index、durable domain、subscriptions/client 审计去重，并执行最终完整测试/typecheck；alternative-cancellation 已复现并最小修复，不再保留为待验证风险。
