# 领域负责人、后台执行与 #79：调研依据

核对日期：2026-11-08。Team 源码基线 [b455aa8](https://github.com/Contexera/dsh-agent-team/commit/b455aa81f7469f12a60482cd8271748810b2cc66)，Harness 基线 [fcc0ad4](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)。这份材料保留各轮候选方案；最终决定见[决策快照](../spec.md)，原生控制和只读查询的证据见[可行性核对](feasibility.md)。“现成 OAR 不支持 steer”指 Harness 发布的 OAR provider 未暴露控制；OAR 库本身支持，Team 自有 provider 可持有原生会话。

最终首版范围已统一：Codex 和 Claude Code 都支持发起、同轮 steer、停止和只读诊断，并按相同规则回传结果。此前仅将 Claude steer 视为可选的讨论不再适用。

## 问题和现有 Team

- [#79](https://github.com/Contexera/dsh-agent-team/issues/79) 要求复用本机 Codex／Claude Code 的执行环境。提出了两种产品形态：外部引擎作为持久成员，或现有 DSH 成员委派一次执行。第一阶段明确允许后一种；Team 里应能定位任务、状态、结果和失败。[维护者回复](https://github.com/Contexera/dsh-agent-team/issues/79#issuecomment-6679491386)倾向按成员配置 Worker，并优先复用 OAR。
- 11-02 讨论附件和截图提出另一层假设：长期成员按负责的领域组织；写代码、测试、文档是按需获得的执行能力；跨成员协作为共享约定、依赖和冲突服务。这个假设是讨论输入。领域未必对应代码目录或现有 Project；文档、测试也可以是有长期目标的独立领域。
- 当前 Team 已分别表达 [Project owner、Task accountable 和 Claim 执行者](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/docs/team-collaboration/boundaries.md#ownership-and-task-authority)。[每个 Member 一个 live handle](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/index.ts#L465-L475)，但 [Claim 的重复检查是同一 Task 下同一执行方向](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L2683-L2694)，同一成员可以承担多个 Task。
- [Agent 验收规则](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L2777-L2803)：曾持有该 Task Claim 的 Agent 不得验收，即便 Claim 已完成或释放。若 owner 的 Worker 实际承担实现，应由该 owner 持有 Claim；开另一个引擎或子会话不增加独立验收者。
- [现有 Team preset](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/cordis.patch.yml) 没挂委派工具。[成员工具策略](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/member-runtime.ts#L100-L145)只允许显式 preset 中的工具；存储的 allow-list 可以缩小工具集合，但未设 allow-list 的成员默认拥有整个 preset。往共享 preset 加工具不等于逐成员启用；按成员、按引擎选择需要明确的权限语义。
- Team 已有[持久 Member 提醒及 Inbox 唤醒](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/docs/architecture/host-authority.md#which-operations-wake-a-member-and-how-recovery-is-chosen)，也有 [Project 定时／Webhook 订阅](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/docs/team-collaboration/tools.md#team_subscription)。定时或事件唤醒与执行完成通知是两件事；已有提醒不负责保持进程存活，也不证明领域 owner 会主动发现有价值的工作。

## Harness：可复用的能力和差距

- 附件描述的 `spawn_teammate` 和 Team 专属通信工具已在 [Harness 的 0.2.1-rc.2 迁移](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/upgrade-guide/v0.2.1-rc.2/agent-team-subagents/guide.md#change)中移除。[当前内置 Team](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/team/agent-team/README.md#teammates)用通用 subagent 工具和执行树成员身份，把任务板记在根 Session；可被指派的是根 Agent 或可续聊子 Agent。任务更新不自动唤醒成员，文件重叠只是提醒。这和本项目的跨 Session 成员身份、Thread、Inbox 与验收是不同的产品能力。
- [OAR provider](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/README.md#use-this-package) 和 [subagent_oar tool](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/tool-subagent-oar/README.md#use-this-package)分开。npm 已发布两者的 `0.2.2-rc.1`，peer 依赖将 Harness 组件精确匹配到该版本；不能据此断定 Team 声明的整个版本范围均可安装。provider 使用本机原生 CLI、登录和设置；每次新建原生会话，只交付一次文字任务，无 DSH 子 Session，无追加指令、续跑或完整 transcript 回传。
- [现成工具代码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/tool-subagent-oar/src/index.ts#L34-L105)接收引擎别名、描述、prompt、可选名字和 cwd，等待启动被接纳后返回名字；不等待长任务完成。直接调用 [`ctx.subagents.startActivation`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md#activation-capacity) 可拿到 childId、结果和取消方法；可由调用方接收结果，或让 Harness 通知父 Session。现成工具用父级通知，没有 Task／Thread 或 Claim 归属，也没有逐成员引擎选择。
- [完成通知](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md#settlement-notice)可唤起仍驻留的空闲父 Agent，不恢复离线父 Agent。父 Session 记下被接纳的外部子项，目录本身不存执行状态；后台运行归当前父 Agent 的执行树。[停止根 Agent 前，宿主需明确停止并等待其子执行](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md#L80-L82)。Team 的成员 Session 可以回收、换代和停用，[当前释放 handle 的入口](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/index.ts#L5118-L5126)不负责停止子执行。需实测回收、停止和重启；不能把父级通知或原生 CLI 会话历史当成持久的 Team 执行记录。
- [权限由 provider 固定](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/README.md#configure-a-runtime-instance)：官方样例用 Codex `workspace-write` 和 Claude `dontAsk`，不转发原生批准请求。Claude 未显式传权限模式会落到 OAR 的绕过默认值。cwd 是执行目录，不能代替权限隔离，也不能防止两次写入同一工作树。由操作者设定权限，模型只选允许的引擎。支持本机登录不等于继承 Team 私有记忆和工具。
- [容量](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md#activation-capacity)默认每棵执行树 8 个活跃或正在启动的子项；满额拒绝而不排队。它不构成整个 Host 的并发、花费或仓库写入上限。多个领域 owner 同时启动时仍需单独检验共享资源上限。
- [终止的限制](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/README.md#known-limitations-and-deferred-work)：OAR 超时从原生会话打开后开始；启动中取消要等打开返回再清理；已发生的文件或外部写入不会随取消回滚。

## 同类做法

- [Claude Code：Agent Teams 与 subagents](https://code.claude.com/docs/en/agent-teams#compare-with-subagents)：两者都有独立上下文。普通 subagent 的主路径是向调用方回报；具名子项也能互相发消息。实验性 Agent Teams 的差别是同伴可以被人类直接联系，也可以彼此通信和通过共享任务列表自行协调。官方建议串行、同文件或依赖紧密的工作用单 Session 或 subagents。这个例子支持按实际协调需要选择组织方式，不能证明按领域长期分工一定更好。
- [Codex：Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)：由主 Agent 发起、跟进、等待和汇总；支持的客户端能打开子线程查看进度和结果。官方建议先并行探索、测试、日志分析并回传摘要，指出多人同时改代码会增加冲突。这是“一个协调者加多个执行者”的基线；Team 需要在此之外证明长期责任或跨领域协作的价值。
- [LangChain：Agents Are Going Async](https://www.langchain.com/blog/agents-are-going-async)、[Deep Agents 生命周期和通知](https://docs.langchain.com/oss/python/deepagents/async-subagents#understand-the-lifecycle)：发起立即拿 ID，单独查询、更新、取消；各子任务有独立 thread。完成结果按上层忙、空闲、等待批准的状态排入；空闲主动唤起受部署拓扑和 beta 功能约束。可迁移的是异步交付、可定位的执行及有节制的唤醒；该产品的会话续跑不是 OAR 能力。
- [Anthropic 的多 Agent Research 实践](https://www.anthropic.com/research/multi-agent-research-system)：可独立展开的调研最适合并行；范围模糊会重复搜索，任务太小会浪费预算。给每个 Worker 明确目标、输出和可用工具，按问题规模控制数量，大份产物单独保留、回传引用。其收益来自内部调研评测，不能用来推算对共享工作树的并行开发收益。
- [OpenMausBot 的 Codex helper 验证说明](https://github.com/milind-soni/OpenMausBot/blob/d7ce39ea08e23bf39d6ec0496f9fef39edcd77ad/docs/verification/codex-helpers.md)：app-server 的原生 helper 和父进程事件交错，只有相同父 thread 与 turn 的事件可更新主对话或完成主任务。可迁移的是用执行身份匹配回传，避免另一次执行的结果被误认；这里的证据来自离线协议样例。

## 供讨论的方案与检验

| 方案 | 能验证什么 | 主要缺口 |
| --- | --- | --- |
| 给 Team 成员打开现成 `subagent_oar`，由成员手动回帖 | 最快核对安装、权限、启动和父 Session 通知 | 执行归属靠模型记住；成员不回帖、关联错 Thread 或会话换代时，人类可能查不到结果 |
| Team 在发起时确认任务归属，复用 Harness／OAR 执行，记录结果到对应 Task Thread | 用户能在原任务看到执行引擎、负责人和结果或失败；可测试不同 Task 的结果不会串 | 需要处理启动与落记录、结束与取消、重试与重复交付的次序；要约定重启后的结果 |
| 外部引擎成为持久 Team Member | 能讨论外部 owner、直接沟通和交接 | 一次执行提供方并不提供持久收件、稳定授权、Team 工具和验收；是另一项产品能力 |

建议第二项作为产品目标，第一项只作验证手段。初始验收场景：一位 DSH 成员为两个既有 Task 启动独立 Worker，启动后还能回复人类；两个任务的完成与失败分别回到各自 Thread；Worker 只提交执行结果，不能代替成员验收。这里的“两项并行”是证明 owner 不被阻塞的检验，不是大并发承诺。

后续轮次需要决定：执行身份与 Claim 如何绑定；首版状态和中断语义；成员启用权限、文件写入范围和审阅归属；大规模并发时的容量、写入冲突、通知合并、成本与主动发现。当前是源码、文档与 npm 元数据核对，未跑 Team 与两种原生 CLI 的组合。


扩大并发前的验收建议：以单成员自己做、单成员加 Worker、两位领域 owner 各自加 Worker 三种方式跑同一类任务，比较人类等到回应的时间、完成耗时、重复工作、失败归档及写入冲突。只读探索可在任务独立时增加并行；同一工作树的写入先串行或隔离，单纯提高并发上限不算进展。给 Worker 提供验收条件、工作范围和预期产物；日志和长产物留在执行侧，Team 保留能追溯的结果；例行完成可以合并通知，真正的阻塞或跨领域冲突才打断 owner。哪些上限、隔离规则和通知规则进入首版，留到后续轮次。

## 第二轮：长期推进、默认授权和执行恢复

用户确认常驻 owner 的设立条件。第一轮提出的通用 Agent 对照只适合测委派开销，不能作为长期责任是否成立的检验。给定同样的目标、规则和上下文，通用 Agent 也能做一次任务。长期验收看 owner 能否在没有人逐条派活时，根据 reminder／Project 订阅找到有意义的变化，回到持久目标判断要不要行动，再根据交付反馈调整下次判断。一个可验证场景是：两次收到同类 CI 异常，中间换过 Session，第二次仍能根据前一次结论判定新问题或避免重复开票。第一版可用现有 Project、Thread、提醒和订阅试跑这个闭环；没有证据要求先加 Domain 对象或常驻轮询。

**谁能启动。** [Project owner 是按 Project 授权的](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L6841-L6852)，[Task 也可由不具备该授权的普通成员负责](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L6724-L6734)。候选默认规则：操作者配置并启用本机引擎后，属于目标 Project 的 Agent owner 可发起，Host 在每次发起时核对 Task 的 Project 与调用者权限。角色不自动安装或启用引擎，不把 A Project 的授权带到 B Project。不动现有成员工具权限配置；首版是否给非 owner 例外待定。

**如何接入。** 建议 Team 提供从 Task 发起的委派入口，复用 OAR provider 与 [`ctx.subagents.startActivation`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md#activation-capacity)。Team 记录该次执行和 Task 的对应关系，从 `delivery: 'caller'` 的 activation 接结果，必要时用 `dispose()` 停止该次执行；在结果落到 Team 后再通知 owner。这里不需要外部 Worker 拥有 Team 身份。Harness [`subagent/end` 与结果承诺](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L1081-L1117)来自当前进程，不能作为重启后的回放来源；清理失败可和已捕获结果并存，不能把收到文字当成进程已可靠退出。

**恢复任务与恢复会话是两回事。**

| 能力 | 本地 OAR | Team 候选承诺 |
| --- | --- | --- |
| 人类给 owner 新目标 | 可继续与 owner 交谈 | owner 判断是否让当前 Worker 继续、停止或另开一次 |
| 改 Worker 当前指令 | 当前接口不支持 | 第一版可停止旧执行，在确认停止后带新指令重开；期间不宣称已停止 |
| 接回外部原会话 | 当前接口无此入口 | 第一版继续原 Task：留下工作目录／分支与已有产物，由 owner 检查后开新执行；新执行有新 ID |
| Host 重启或失联 | 不能重新附着 | Team 保留任务归属和尝试记录，未确认终态标为中断或失联；不假设原生进程已退出，不自动重跑可能写过文件或调用外部系统的任务 |

Harness 的两种独立原生适配同样是一次执行：[Codex 创建临时 thread](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent-codex/src/wire.ts#L289-L315)，[Claude 单次 query 禁用会话持久化](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent-claude-code/src/run.ts#L316-L352)。换成这两个 provider 并不能得到 steer 或续跑。原生引擎本身有更强能力：[Codex App Server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)支持 turn 内输入，并可恢复已保存的 thread；[Claude SDK](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode#streaming-input-mode-recommended)支持队列输入、打断和[会话恢复](https://code.claude.com/docs/en/agent-sdk/sessions)。两者控制语义不同，也都不能用会话恢复撤销已做的文件修改或外部调用。若首版必须原会话交互，应先用一个引擎验证上游扩展或原生接口，不能把现成 OAR 当作已经支持。

建议首版验证一个明确的中断场景：Worker 在隔离目录里已写出部分修改，human 更改要求；owner 停止旧执行，确认清理并检查改动，从同一 Task 开新执行。Team 同时保留两次记录、拒绝旧结果覆盖新尝试；原始 Claim 仍在成员层，执行结束不触发验收。另需验证一次 Host 重启，不把失联执行报告为成功或偷偷重跑。

## 第三轮：沿用现有权限，澄清一次性执行

- 用户要求在 Team 设置页提供“允许项目负责人委派 Worker”。[Team 已有 Host 设置表单](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/client-agent-team/src/client/TeamSettingsSection.tsx#L62-L86)可作为设置行为的参考。和 [`team_message`、`team_task`、`team_subscription` 的注册](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/tool-agent-team/src/index.ts#L1691-L1701)一样，统一声明工具，由 Host 判断动作是否允许；不按成员动态挂卸工具。
- 用户接受按现有规则统一 Project 范围。[`team_message start` 创建普通 Thread 或 Task](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L2542-L2565)都要求调用者是目标 Project 的 owner；[`team_task promote`](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/ledger.ts#L2627-L2639)同样校验。这不限制普通成员按已有规则发帖、回复或认领 Task。Worker 的发起权限沿用前一类：根据 Task 得到 Project，由 Host 校验设置和 owner 资格。
- 上轮“恢复”容易误解为接回原生会话；[当前 OAR 不支持](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/README.md#known-limitations-and-deferred-work)。候选首版只有发起一次、结果或失败回原 Task，必要时由 owner 检查留下的产物并重新发起；那是新执行，没有自动重试、续跑入口或恢复流程。Host 重启若不知道该次结局，记录无法确认，不推断成功、失败或进程已退出。显式停止和写入隔离还没定。
- “复用 `subagent_oar`”有两层：可复用 Harness 的 OAR provider 和同一个启动接口；原工具直接用 [`delivery: 'parent'`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/tool-subagent-oar/src/index.ts#L85-L105)并返回名字，本身不校验 Team Project，也不会把结果写回 Task。带这些语义的 Team 工具应调用 provider，让 Team 接收结果；不自建 Codex／Claude 适配。

## 第四轮：默认引擎与诊断

首版确认定位为实验功能，一次性委派。成功、失败和已知超时归档；重启后没有终态则标为无法确认。不接回原生会话，不自动重试。

- [Harness 的 OAR provider 配置](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/README.md#configure-a-runtime-instance)有 `runtime`、`providerName`、可选 `model`、`effort`、`launchArgs`、`env`、`timeoutMs`。内置库接受 Antigravity、Claude Code、Codex、Grok、Kimi、OpenCode、Pi 七个 runtime；只有 Claude Code 与 Codex 有 Harness 的原生端到端覆盖。建议首版只开放这两种，不要求另外安装 OAR CLI。用户须已有可用的本机 CLI 和认证。
- OAR 的长任务是异步的；[安装探测和原生会话打开](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/src/run.ts#L243-L300)仍在启动路径上。发起工具等启动被接受，拿回执行标识后可继续；耗时 turn 在后台，已有 `timeoutMs` 从原生会话打开后开始计时。
- 原工具的 [`runtime` 是必填项](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/tool-subagent-oar/src/index.ts#L34-L48)。建议 Team 挂载两个已明确配置权限的 provider，由 Team 设置保存实验开关、允许的引擎和默认引擎。一次委派未指明引擎时用默认值；明确指定时只能选已启用的引擎。一个引擎不可用时报告失败，不悄悄切换账号或引擎。Native 启动参数和权限仍由配置控制，不作为模型参数。
- 原工具在安装或启动失败时返回工具错误；已接纳执行在结束时通过 [父 Session 完成通知](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/continuation-messages.ts#L141-L174)带结束状态、已有回答和可用诊断。OAR 的 [`OarFailure`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/src/run.ts#L51-L74)保留阶段和分类，原始原因可能含凭证。Team 用 caller 回传时须主动归档诊断并提醒发起成员，不会自动得到这条父级通知。

### 落盘和 trace 的三层

| 层 | 当前行为 | 调用成员能否定位 |
| --- | --- | --- |
| 原生 CLI 的会话 | OAR `0.67.0` 的 [Codex adapter](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/packages/oar/src/runtimes/codex/session.ts#L33-L40)使用可保存的 native thread；[Claude adapter](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/packages/oar/src/runtimes/claude/launch.ts#L27-L52)用原生 session id，由 CLI 按其设置写历史。打开之前失败时可能无会话文件。 | OAR 库知道 native id，当前 Harness provider 不传出。不要把它和 Harness 独立的临时 Codex provider 混为一谈。 |
| OAR 的事件流 | [`rawEvents`／`records`](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/packages/oar/src/contracts/session.ts#L199-L208)可读本次进程所见事件；[重放需要调用方自己落盘](https://github.com/botiverse/oar/blob/c264f17040dd9513b43300886a80f3f6eddde7b1/docs/spec/session-graph-and-cursor.md#the-resumable-cursor)。native transcript 不是这个事件流。 | Harness [只订阅根回答的文字](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/src/run.ts#L177-L183)，没有导出原始记录。 |
| Harness 委派结果 | 对外是状态、最终文字、安全诊断；[执行编号是另外生成的 UUID](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/src/run.ts#L200-L233)。不创建 DSH child Session。 | 不能根据执行编号找到 Codex session 文件。父通知里的 `senderSessionId` 对外部执行也不是原生会话 id。 |

建议首版记录引擎、执行编号、状态和诊断，有 Worker 文字结果时保留，按正常 Team 通知送给调用成员。要求 Worker 在有能力回报时指出可查看的工作产物、关键命令和失败位置；启动失败或进程崩溃时不承诺这种补充。若首版就必须让 Agent 查看原生 trace，应先验证 Harness 能否公开稳定的原生会话引用或有界诊断读取接口。按工作目录或“最新文件”猜会话，在并行场景会串结果。

## 第五轮：委派从哪里发起，结果回哪里

Q5 确认第四轮的 Team 设置与默认 Worker 规则；Q6 确认首版不提供原生 trace。

- [原装 `subagent_oar`](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/tool-subagent-oar/src/index.ts#L71-L105) 的工具结果是启动回执 `started subagent <name>`，不是最终答案。已接纳的执行结束后，[Harness 向发起 Session 注入独立的完成消息](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L1108-L1128)：忙时送到后续步骤，空闲则唤起，离线不补投。它既不认识 Team Thread，也不写 Team Inbox。
- [Team 的 Task 是 Thread 上的任务状态](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/docs/team-collaboration/attention-and-messaging.md#thread-attention-and-inbox)。成员从自己的 Session 调用工具；[现有 Team 工具已允许显式指定 Thread／Task](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/docs/team-collaboration/tools.md#team_message)，不依赖人类正打开哪个页面。绑 Task 和绑普通 Thread 的归档位置都是目标 Thread。

| 发起参数 | 授权范围 | 建议的回传 |
| --- | --- | --- |
| Task 或已有 Thread | Host 从目标查到 Project，校验发起者是 owner | 工具先回启动回执；Team 在原 Thread 记录结果或诊断，为发起成员写未读提醒，告知结果在哪。其他读者按现有关注规则。 |
| 只指定 Project | Host 校验发起者是该 Project 的 owner | 允许不值得新开 Thread 的临时协助。结果只通知发起 Session，沿用 Harness parent delivery；不发布到 Main、不创建 Task、不承诺离线补投。 |
| 都没给 | 缺少 Project 授权范围 | 请明确目标，不从 UI、cwd 或拥有的任意 Project 猜。 |

建议用一个 Team 委派入口提供这两种回传。前者用 Harness caller delivery，Team 负责先写入再通知；后者直接使用 parent delivery。Thread 保存一次可查的结果；Inbox 指向这条结果，不再保存第二份完整输出，也不同时发两种完成通知。模型调用不阻塞到 Worker 完成；如果启动本身失败，立即收到工具错误，若已绑定 Thread 也应能从该 Thread 追查该次尝试。

## 第六轮：成员和 Worker 的引导

Q7、Q8 已确认：临时委派指定 Project、结果回 Session；团队工作指定 Thread／Task，原 Thread 留结果，发起成员经 Inbox 获知。

现有做法：

- [Persona 的角色速查](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/cordis.patch.yml#L60-L69)只写 owner 应为负责的领域主动建提醒和订阅；[reminder 工具说明](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/tool-agent-team/src/index.ts#L1594-L1605)写用途、参数和生命周期；[到期通知](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/inbox-notice.ts#L388-L397)带回之前写下的 note 和如何处理。
- [`project-subscriptions` skill](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/core-skills/project-subscriptions/SKILL.md#L6-L45)单独讲选触发方式、写脚本、稳定事件标识和诊断。[订阅事件通知](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/inbox-notice.ts#L324-L335)将外部文本标为数据，不从文本推导命令或提及。[核心 skill 可由成员的 allow-list 筛选](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/packages/agent-team/src/member-skills.ts#L81-L92)，所以工具不能依赖成员已读技能。

首版建议：

| 位置 | 写什么 |
| --- | --- |
| Persona | 一句选型：owner 在功能开启时，可把范围明确、可以独立推进的工作交给 Worker；涉及跨 Project 责任、共享约定或冲突，仍和对应 owner 协调。提醒和订阅唤醒判断，不触发无条件派发。 |
| 工具说明与回执 | 参数说清 Project 临时协助与 Thread／Task 归档的差别，未选引擎用默认；要求自包含任务说明；回执提示启动不等于完成，可继续工作，不必轮询。错误指向可采取的下一步。 |
| 现有 `team-domain-model` skill | 增加简短段落：委派不转移责任；如果 Worker 代成员执行 Task，Claim 仍属于该成员；结果是待核对的证据，不能替代独立验收。首版不加专门 skill，日后若形成多 Worker 拆分与产物交接流程，再按需提取。 |
| 给外部 Worker 的任务说明 | 发起者给目标、必要背景、工作范围、验收标准和产物；不假设外部 Worker 看过 Team 对话。请 Worker 回答做了什么、怎么验证、剩什么，保留可定位的证据。 |
| 完成通知 | 说明哪个 Worker 完成或失败、结果在哪；已归档时提示发起者核对和决策，不再把同一结果发一遍。外部输出按数据对待，不触发提及、指令或自动验收。 |

示例简报：“在当前指定的工作目录调查连续 CI 失败的原因。只读，区分确定证据和假设。返回失败步骤、日志位置、复现条件与建议；如果是认证或工具失败，说明卡在哪一步。” 工作目录和授权以实际调用策略为准，简报不能替代权限控制。

验收选一个可观察的 Team 场景：订阅发出事件，owner 判断值得调查，用一个自包含 Worker 任务并继续手头工作；收到结果后从正确 Thread 读取，核对证据后决定下一步。另选一个无需 Worker 的轻量提醒，验证引导没有把所有唤醒变成派发。

## 第七轮：可写工作目录与停止

Q9 已确认：沿用 persona、工具说明和现有 `team-domain-model`，不另加 Worker skill。

- [Team 的 Workspace 约定](https://github.com/Contexera/dsh-agent-team/blob/b455aa81f7469f12a60482cd8271748810b2cc66/docs/team-collaboration/model-and-time.md#L11-L14)把参与权限与当前目录分开；[Harness 的启动目录选择](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/manager.ts#L488-L495)仅解析目录，不按 Team Project 限制，也不隔离文件。原生执行权限由 provider 固定：[Codex workspace-write](https://learn.chatgpt.com/docs/agent-approvals-security#sandbox-and-approvals)与 [Claude dontAsk](https://code.claude.com/docs/en/permissions#permission-modes)语义不同，后者拒绝需要询问的操作，但已有 allow 规则仍生效。任务说明写“只读”不构成只读权限。
- 建议支持真实修改：启动时核对工作目录处于已授权的 checkout；同一 checkout 已有可能写入的 Worker 时，拒绝再启动另一个可写 Worker，不能用子目录名绕过。除非 provider 明确保证只读，否则按可能写入处理。不同已授权 checkout 可并行；首版不自动建 worktree、合并或回滚。该规则减少 Worker 互相覆盖文件，不是跨进程文件锁，也不替代原生权限。发起者仍要避开同一 checkout 的同时写入。
- [Harness activation](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/src/types.ts#L39-L66)持有停止这一次执行的句柄；[OAR](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/experimental/subagent-oar/README.md#known-limitations-and-deferred-work)启动中不能立即中断，取消要等启动返回再处理；超时从原生会话打开后计时。请求停止后不能假定进程已退出，也不会撤销已写入文件。建议允许发起成员和 Human 显式停止指定执行；确认清理后才记录“已停止”，原 Task 和已产生的文件保留。
- 首版并发复用 [Harness 每棵执行树的容量限制](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/subagent/subagent/README.md#activation-capacity)，不承诺全 Host 调度或排队。验收至少覆盖同一 checkout 的拒绝、两个独立目录可并行、停止后保留已写改动、不同 Task 的结果不串、功能关闭及非目标 Project owner 拒绝，以及实际 CLI 的正常和失败路径。
