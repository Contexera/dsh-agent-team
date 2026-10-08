# Tools and preset

[English](tools-and-preset.md) | 中文

显式的 `team-member` preset 是唯一的 Team Member composition。它含一整套 coding capability rows：shell、filesystem/search、web search 与 fetch。还有 background jobs、skill 加载工具、compaction。skill 发现本身不是 preset row。每个 Member 的 provider 由 Host 注册在自己的 agent scope 上（见 Host authority）。另有 Team collaboration guidance/tools、Harness Workspace instruction discovery，和有界的 private-memory reference context。普通 Sessions 留在这个 isolated roster 之外。它们拿不到 Team prompt sections、tools 或 Member memory。

每一行 `name:` 都是 Loader 按 profile 解析的裸标识符，不按本 bundle 解析。profile 只链接本 bundle 与宿主闭包，所以一行只能点名宿主包或本 bundle 自己的子路径。绝不能点名嵌在本 bundle 依赖树里的包。工作树里能解析的名字，在真实安装里仍可能让该行 `never started`：依赖里的模块只能经由本 bundle 自己名下的再导出到达一行。

九个 model-facing tools 都定义在 `packages/tool-agent-team/src/`。五个 Team 工具在 `index.ts`，四个 context 工具在 `context-tools.ts`。实现层面的 collaboration contract 记录在 [`tools.zh.md`](../team-collaboration/tools.zh.md)。它们挂载在隔离的 `team-member` preset 下（`cordis.patch.yml` 里的一条 declarative row）。不要为了测试可用，就把 tool package 作为 global row 添加；普通 Sessions 必须保持 Team-free。

Host 在这些 preset 之上，编排 Member 上下文自主管理。`context_rollover` 与 `context_checkpoint` 工具只做校验并结束/锚定 turn。在 tool 执行时，引擎的门先拦下 Member 自己的 `context_status` 里未列为 restorable 的 `checkpointRef`。过了这道门的 ref，还要再过 Host 的 seed resolver 预校验。resolver 跟换窗用同一套。当下不可能成功的 ref 以 model-visible 的 error result 拒绝，不给假的 `scheduled`。可变 guard 集（jobs、route limits）在 commit seam 复查。

四个 context 工具一律用引擎自己的定义。`context-tools.ts` 通过引擎的 `createContinuityTools` 构造 `context_rollover`、`context_checkpoint`、`context_status` 与 `context_compact`，只给 Team 词汇和 host adapter，不再自带文案与校验。所以引擎文案点名的，永远是本工具面确实存在的工具，而 Team 自己的词汇表经引擎的 `timelineGuidance` 接缝传入。

adapter 里只剩一条 Team 规则：引擎在每一行都渲染该行的 `ref`。不可返回的行拿该 ref 的短摘要作答，不给 ref 本身：任何不可选择的行都不会携带可引用的字符串。

唯一的 context-continuity coordinator（`ContextContinuityCoordinator`，来自 `@contexera/dsh-context-continuity`）由 `context-continuity-host.ts` 绑到 Member lifecycle 上。它还拿 Team 的 plugin id 和冻结的 handoff 文案构造引擎的 message codec。它监听各 Member Session 的事件，从 durable 的 `tool/call`+`tool/result` 对折出 rollover 与 checkpoint 意图。再走串行 lifecycle queue 执行换窗。

该折叠即引擎自身的 `contextContinuity` projection unit，在 Team service init 时按 host 注册一次。`context-projection.ts` 只提供 Team 的那一半：

- 解析 `context-checkpoint-*`/`team-boundary-*` ref。把 boundary 归类为 `team-boundary`/`handoff`/`compaction`。把 claim boundary 归因到 ledger 上的 Thread。识别 Team notice 的 host hooks。
- 读取引擎状态的适配层。

unit 自带 fork cut：seed 子代的继承前缀折叠回同一引用。换窗随后按序执行：

1. 等真正 idle；
2. 在 commit seam 复查 owned-jobs guard；
3. retire 旧代（dispose + 归档、绝不删除）；
4. 提交幂等的 `team/member-session-rolled-over` operation；
5. 激活全新 Session：checkpoint 回返则以精确 completed-turn 前缀作 seed 的 Session。lineage parent 指向 seed 来源；
6. 以 steer 送达 handoff、以 followup 投递携带的非 Team 输入。

在折叠层，意图按未结束 turn 唯一。同一未结束 turn 里的第二次成功 rollover 调用，仍然 first-wins。所属 turn 已结束的 pending 就是 ready（重启后为 recoverable）的意图。正常 in-flight 路径上，coordinator 的进程锁会拒绝后续调用。只有这把锁没了（transition 失败或从未运行），后续 turn 的成功 rollover 才会替换已结束的 intent。这就是 seam 失败后恢复 Member 的 retry 路径。admission gate（`agent/turn-stopping` + `agent/pre-step`）只管旧代 Agent instance：后续输入开不了旧代的 model request。quiet checkpoint continuation 只投递一次。进程内靠 per-member latch 判重，跨重启靠 projection 的 durable delivery record 判重。

恢复从日志派生。重启重放 pending 意图并完成换窗。重启落在两个点之间。前面是 rollover 的 durable commit，后面是新 Session 激活。这时从 ledger 记录的上一 Session 重建 handoff。即使新 Session 在崩溃前从未落盘，也照样重建。重建幂等（自身日志已含 handoff 的一代不再收到第二条）。

重启后的 carried-input 重放是有界的。当前代只要已开始自身 turn 就跳过重放（携带输入已在运行中被投递或取代）。上一代 Session 读不出来时，看问题属于哪一类。两类都走 warn 放行。第一类是日志损坏（`corrupt session log`，Host 会修复 torn tail）。第二类是确定性格式拒绝（`SessionFormatUnsupportedError`，重试无法改变结果）。缺失、IO 和未知原因仍 fail-closed：当前代只要运行过，激活就不再受退役代可读性阻塞。Member Session 有没有 durable 持久内容，看 session-persistence inspection 的判定。判定会等进行中的 retirement drain。绝不使用会与 suspend 终末 flush 竞争的裸元数据列表。

上下文压力走引擎自己的策略（`ContextPressurePolicy`）：架在 Team 的宿主实现上，挂在同一 pre-step 接缝。预算阈值从当前 route 的 context window 派生（handoff 200K / 硬上限 256K cap 加安全 reserve）。到 handoff 预算，每 generation 发一条结构化通知，主推就地 `context_compact`，摘要 Member 自己写。`context_rollover` 留给已翻页的工作（一次后重新武装）。到硬上限，策略强制原地 compaction：证明不了进展就 fail closed。provider context-overflow 失败了，给一条有界 compact-and-retry 序列。

大 context 里隔了很久才到的那一步，先交给相关性 judge。judge 判为无关工作时，策略扣住这份输入、在原位投一条换代指令。被扣的输入在 driver 收敛后交回：若换代落地则随新代进入。按 Member 取的读数（limits、surface、log span、compaction、手上的工作）和 judge，都是 Team 给的。决策顺序、通知闩和 fail-closed 证明，还是归引擎。

原地硬 compaction 绝不取消 owner。拒绝持有 running 或未上报 terminal jobs 的 rollover，job guard 管不着。

Web Client 是唯一的 Human control surface。它经 typed Remote 把每个 mutation 委托给 `ctx.agentTeam`，不绕过 Host authorization 或 ledger commits。别把 slash-command adapter 加回来当第二界面。

修改 schema、canonical output、presentation 或 preset 时，编辑前先阅读匹配的 Harness docs：

- `../deepseek-harness/docs/subsystems/tools.md`
- `../deepseek-harness/docs/cookbook/adding-a-tool.md`
- `../deepseek-harness/docs/subsystems/permission-presets.md`
