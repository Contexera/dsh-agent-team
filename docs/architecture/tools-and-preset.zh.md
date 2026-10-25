# Tools and preset

[English](tools-and-preset.md) | 中文

显式的 `team-member` preset 是唯一的 Team Member composition。它含一整套 coding capability rows：shell、filesystem/search、web search 与 fetch。还有 background jobs、skill 加载工具、compaction。skill 发现本身不是 preset row。每个 Member 的 provider 由 Host 注册在自己的 agent scope 上（见 Host authority）。另有 Team collaboration guidance/tools、Harness Workspace instruction discovery，和有界的 private-memory reference context。普通 Sessions 留在这个 isolated roster 之外。它们拿不到 Team prompt sections、tools 或 Member memory。

每个 Member 默认只获准使用所选 preset 注册的工具定义，以及显式共享的 `working_directory`。Host 全局工具不在此范围内。`capabilities.tools.allow` 只能进一步缩减，不能授权 Host 工具或后来插件添加的工具。七个 Team 工具和 `working_directory` 始终保留。

Host 在 Agent 发布前保存这些工具定义，在提示组装时过滤请求中的工具列表，并在直接调用和嵌套调用执行前检查。后来注册到 Member 自身 scope 的工具不会进入请求，调用也会被拒绝；允许的工具定义被替换时，请求组装和执行都会被拒绝。能力编辑沿用原始定义。检查只作用于该 Member，不影响普通 Agent 或委派子 scope。

Team mode 不过滤其他官方或自定义插件注入的提示。当前 Harness 公开接口不支持完整的 Member 提示隔离：必需上下文会在组装后被恢复。例如 experimental Team 的 `team:policy` 与必需的 `team:identity` 仍会进入上下文，但不会因此阻止激活或对话。

这些检查使用 Harness 公开扩展接口，不是强制执行的最终请求策略。其他组装中间件仍可在 Team 过滤之后改变结果。尚未完成通用插件兼容性认证，见[兼容性限制](../dsh-release-compatibility.zh.md#37-并存的另一套-team-实现)。

每一行 `name:` 都是 Loader 按 profile 解析的裸标识符，不按本 bundle 解析。profile 只链接本 bundle 与宿主闭包，所以一行只能点名宿主包或本 bundle 自己的子路径。绝不能点名嵌在本 bundle 依赖树里的包。工作树里能解析的名字，在真实安装里仍可能让该行 `never started`：依赖里的模块只能经由本 bundle 自己名下的再导出到达一行。

七个 model-facing tools 都定义在 `packages/tool-agent-team/src/index.ts`。collaboration contract 记录在 [`tools.zh.md`](../team-collaboration/tools.zh.md)。它们挂载在隔离的 `team-member` preset 下（`cordis.patch.yml` 里的一条 declarative row）。不要为了测试可用，就把 tool package 作为 global row 添加；普通 Sessions 必须保持 Team-free。

Member 没有 context 工具。preset 的 `compaction-basic` 行挂载 Team 的薄适配层 `member-compaction-engine`：Team 负责主动请求准入，Harness 的 `BasicCompactionEngine` 提供摘要模板、压缩事务与 overflow 恢复。预算定义归 [`memory-and-context.zh.md`](../team-collaboration/memory-and-context.zh.md)。换代仍是 Host 的决定，不是模型的。

换代归 `team-context-management.ts`，Team 自己的协调器。它从 Host 的唤醒决定出发，而不是从 durable 意图出发，走串行 lifecycle queue 执行，并让新代身份从被退役的 Session 派生，因此崩溃后收敛到同一个后继：

1. 等真正 idle；
2. 在 commit seam 复查 owned-jobs guard 与普通输入队列——排队中的普通消息会让这次换代延后；
3. 在 `agent.runMaintenance` 内以 Host actor 提交幂等的 `team/member-session-recycled` operation，并在存在 live 代时记下 `inputFromSeq`（退役日志的偏移）；
4. retire 旧代：它的 pre-step gate reject 该 step，不发旧代模型请求；随后 dispose + 归档，绝不删除；即使输入已经被 claim，最初的 inbox 插入记录仍在日志中；
5. 激活新 Session，lineage parent 指向被替换的那一代；
6. 从 `inputFromSeq` 起折叠退役日志，按 message id 剔掉新代已经持有的消息，其余用 followup 投递，再从 ledger 重导出 Inbox。

maintenance 是这次 commit 能安全面对换窗中途新输入的原因：loop 停在那里，新消息留在 durable inbox，不会落到正在被退役的那一代。commit 失败则 maintenance 放行，旧代继续运行；commit 成功就退役它，崩溃则留给启动或恢复补完尚未重放的换代。

新代第一眼看到的就是它每步的常规注入——身份、`memory.md`、workspace 列表——加上唤醒它的那条消息。没有 handoff 信封，也没有换代公告：被告知「你收到了交接」的新代，会去执行交接仪式，而不是读自己的记忆。

折叠是 Team 自己的 `contextContinuity` projection unit，在 Team service init 时按 host 注册一次。`context-projection.ts` 拥有 durable checkpoint ref 命名、Team notice 规则、fork cut，以及一代读回的那份折叠状态：带 turn-end 投递状态的 checkpoints、至多一条 legacy rollover 意图、continuation 投递记录，以及被退役那代从未消费的非 Team 输入。它仍然解码的工具名（`context_rollover`、`new_context`、`context_checkpoint`）是给早先版本日志用的解码器，不是 tool alias。

`context-codec.ts` 只写当前构建还产出的那一个信封：quiet checkpoint continuation。识别它、以及识别早先版本写下的两种形状，都在 `context-source.ts`；handoff 的写者只作为那些 legacy 形状的测试 helper 保留。

崩溃恢复从日志派生。被中断的换代按已记录的绑定与被退役的 Session 补完；旧日志里所属 turn 从未 durable 结束的 pending 意图视为 spent 直接丢弃，不会让该代永久无法换窗。

carried-input 重放有界，且以 message id 为准。换代在 commit 时记下 `inputFromSeq`，即退役日志的偏移；折叠只计该边界及其之后的输入。唯一来源是退役 Session 的日志——不出于搬运而把消息内容留在内存里。新代即使已经跑过自己的 turn 也不因此跳过：由边界、新代自己的日志和 inbox 队列决定它还缺哪些消息。只有不带 `inputFromSeq` 的 legacy transition 就沿其已开始的代直接跳过重放。`agent-instructions` 消息由新代重新生成，不作为独立回合重放。

取消的 inbox splice 不记录由谁移除消息。重放必须保住 dispose 清空的输入，因此换代期间显式删除或替换的排队消息也可能被重放。普通 Session cancel 按设计保留待处理输入；这项限制只涉及换代期间编辑队列。

上一代 Session 读不出来时，看问题属于哪一类。两类都走 warn 放行。第一类是日志损坏（`corrupt session log`，Host 会修复 torn tail）。第二类是确定性格式拒绝（`SessionFormatUnsupportedError`，重试无法改变结果）。缺失、IO 和未知原因仍 fail-closed。带输入边界的 wake 换代即使新代已经运行，也仍执行这项检查。Member Session 有没有 durable 持久内容，看 session-persistence inspection 的判定。判定会等进行中的 retirement drain。绝不使用会与 suspend 终末 flush 竞争的裸元数据列表。

唤醒判定本身是 `wake-recycle.ts` 里的一条纯 gate 阶梯：未启用、没有上一代、活动时刻读不出来、缓存可能还热、context 未到水位线，每一档都答 resume，只有冷得够久且 context 够大才换代。[`memory-and-context.zh.md`](../team-collaboration/memory-and-context.zh.md) 拥有阈值与那个配置组。

Web Client 是唯一的 Human control surface。它经 typed Remote 把每个 mutation 委托给 `ctx.agentTeam`，不绕过 Host authorization 或 ledger commits。别把 slash-command adapter 加回来当第二界面。

修改 schema、canonical output、presentation 或 preset 时，编辑前先阅读匹配的 Harness docs：

- `../deepseek-harness/docs/subsystems/tools.md`
- `../deepseek-harness/docs/cookbook/adding-a-tool.md`
- `../deepseek-harness/docs/subsystems/permission-presets.md`

## Persona 与 core skills

persona 是 `cordis.patch.yml` 中 `persona` 行的 `prefix`。它常驻，只写行为规则，不写参考资料：

- 每种消息该放哪里：Main stream 发言、开讨论或 Task、Thread 回复、DM；
- 只有 Project owner 能开讨论和 Task，且每个 Task 只有一个负责人；
- 点名、带 `replyToMessageRef` 的回复与普通消息的区别，以及何时找 Human；
- 验收、关闭、重开是三个不同决定，执行过该 Task 的 Agent 不能验收；
- 礼仪、先读后写的流程，以及不超过八行的角色速查。

Team 内容仍是不可信输入。persona 按代码里的现状点名工具；工具接口变化时，persona 同步修改。

详细内容放在 `packages/agent-team/core-skills/` 下的内置 core skills，由 Member 的 skill 目录按需加载：

- `team-domain-model` 说明角色与权限（Human、Project owner、Project member、负责人）、Main stream 与 Thread 的分工、点名、带链接的回复与普通消息如何投递（含 owner 对 Thread 普通消息的阈值）、何时看 Inbox 或 board、Task 生命周期与谁来验收、关闭、重开或转交、DM 的用途，以及常见拒绝码与恢复方式。它只写稳定规则，不含当前状态：身份、所属 Project、未读工作来自动态 context 和 Team tools，权限与投递规则由 Host 执行。
- `member-memory-manager` 与 `member-skill-manager` 负责私有 memory 与私有 skill 的写法。

`npm run check:core-skills` 检查每个 skill 的 front matter、description、体积预算与链接。
