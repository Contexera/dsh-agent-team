# Tools and preset

[English](tools-and-preset.md) | 中文

显式的 `team-member` preset 是唯一的 Team Member composition。它含一整套 coding capability rows：shell、filesystem/search、web search 与 fetch。还有 background jobs、skill 加载工具、compaction。skill 发现本身不是 preset row。每个 Member 的 provider 由 Host 注册在自己的 agent scope 上（见 Host authority）。另有 Team collaboration guidance/tools、Harness Workspace instruction discovery，和有界的 private-memory reference context。普通 Sessions 留在这个 isolated roster 之外。它们拿不到 Team prompt sections、tools 或 Member memory。

每一行 `name:` 都是 Loader 按 profile 解析的裸标识符，不按本 bundle 解析。profile 只链接本 bundle 与宿主闭包，所以一行只能点名宿主包或本 bundle 自己的子路径。绝不能点名嵌在本 bundle 依赖树里的包。工作树里能解析的名字，在真实安装里仍可能让该行 `never started`：依赖里的模块只能经由本 bundle 自己名下的再导出到达一行。

七个 model-facing tools 都定义在 `packages/tool-agent-team/src/index.ts`。collaboration contract 记录在 [`tools.zh.md`](../team-collaboration/tools.zh.md)。它们挂载在隔离的 `team-member` preset 下（`cordis.patch.yml` 里的一条 declarative row）。不要为了测试可用，就把 tool package 作为 global row 添加；普通 Sessions 必须保持 Team-free。

Member 完全没有 context 工具。Session 变大时由引擎就地压缩：preset 的 `compaction-basic` 行挂的是本 bundle 自己的 `team-compaction-engine`，一个只提供 7 节实测摘要模板的 `BasicCompactionEngine` 子类，`auto` 打开，触发点 256K。换代是 Host 的决定，不是模型的，所以工具面既没有可安排的事，也没有可引用的 ref。

换代归 `team-context-management.ts`，Team 自己的协调器。它监听各 Member Session 的事件，从 durable 的 `tool/call`+`tool/result` 对折出 pending 意图（旧日志里仍有早先版本写下的 rollover 对；当前构建不再产生），再走串行 lifecycle queue 执行换窗：

1. 等真正 idle；
2. 在 commit seam 复查 owned-jobs guard；
3. retire 旧代（dispose + 归档、绝不删除）；
4. 以 Host actor 提交幂等的 `team/member-session-recycled` operation；
5. 激活新 Session，lineage parent 指向被替换的那一代；
6. 以 followup 投递携带的非 Team 输入，再重导出 Inbox。

新代第一眼看到的就是它每步的常规注入——身份、`memory.md`、workspace 列表——加上唤醒它的那条消息。没有 handoff 信封，也没有换代公告：被告知「你收到了交接」的新代，会去执行交接仪式，而不是读自己的记忆。

折叠是 Team 自己的 `contextContinuity` projection unit，在 Team service init 时按 host 注册一次。`context-projection.ts` 负责 durable ref 命名、Team notice 规则、boundary 分类（`team-boundary`/`handoff`/`compaction`）、claim boundary 的 Task→Thread 归因，以及 fork cut：seed 子代的继承前缀折叠回同一引用。`context-codec.ts` 是它读回的那两个信封的唯一写者，字节与早先版本写出的一致。

崩溃恢复从日志派生。重启重放 pending 意图并完成换窗；旧日志里所属 turn 从未 durable 结束的 pending 视为 spent 直接丢弃，不会让该代永久无法换窗。

quiet checkpoint continuation 只投递一次。进程内靠 per-member latch 判重，跨重启靠 projection 的 durable delivery record 判重。

重启后的 carried-input 重放是有界的。当前代只要已开始自身 turn 就跳过重放（携带输入已在运行中被投递或取代）。上一代 Session 读不出来时，看问题属于哪一类。两类都走 warn 放行。第一类是日志损坏（`corrupt session log`，Host 会修复 torn tail）。第二类是确定性格式拒绝（`SessionFormatUnsupportedError`，重试无法改变结果）。缺失、IO 和未知原因仍 fail-closed：当前代只要运行过，激活就不再受退役代可读性阻塞。Member Session 有没有 durable 持久内容，看 session-persistence inspection 的判定。判定会等进行中的 retirement drain。绝不使用会与 suspend 终末 flush 竞争的裸元数据列表。

Web Client 是唯一的 Human control surface。它经 typed Remote 把每个 mutation 委托给 `ctx.agentTeam`，不绕过 Host authorization 或 ledger commits。别把 slash-command adapter 加回来当第二界面。

修改 schema、canonical output、presentation 或 preset 时，编辑前先阅读匹配的 Harness docs：

- `../deepseek-harness/docs/subsystems/tools.md`
- `../deepseek-harness/docs/cookbook/adding-a-tool.md`
- `../deepseek-harness/docs/subsystems/permission-presets.md`
