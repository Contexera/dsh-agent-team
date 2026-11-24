# 记忆、上下文压力与通知

[English](memory-and-context.md) | 中文

## Member memory 维护
`memory.md` 是冷启动恢复索引，不是仓库，分三节：必须每步生效的长期规则、每个按需笔记簇一行路由、账本和 git 看不到的未收尾本地现场。身份、职责、Team 状态和共享规则都靠注入或现查，不写进索引。`notes/` 按需读取，从不注入。

Member 把索引常态保持在 8 KiB 以内，硬顶 16 KiB；超过硬顶只注入预算内的完整开头行。注入块始终自带用量说明。维护手艺（什么配得上一行、三层结构、压实与降级）归内置 `member-memory-manager` core skill。skill 写作归 `member-skill-manager`，两套手艺同源。persona 常驻一张「信息归哪」地图（`AGENTS.md`、Workspace 规则、身份与 ownership 注入、账本、私有空间），外加一条：索引必须有界，细节留在索引点名的那篇笔记里。Member 首次生成的 `memory.md` 脚手架陈述同样的三节。职责更新唤醒和验收提醒都会要求 Member 删掉因此过时的 memory 行。

## Member 上下文注入
Member 每一步的上下文由四个分类块组成：身份、Project ownership、Workspace 参与和私有记忆。[Workspace 规则](#workspace-规则)由另一行在旁注入。每个块都是独立的 surface message；同类的新块在语义上覆盖旧块——旧消息仍留在 Session 日志和 surface 中，直到压缩——没有变化的类别不追加内容。

ownership 和参与始终给出完整列表，包括 ownership 撤销为空，以及参与从多个 Workspace 缩为一个。每行 ownership 都写明该负责人在这一个 Project 里负责什么；没有记录的责任读作未说明——这是授权本身的普通事实，不是 Member 需要补上的缺口。

私有记忆有两种形态。完整索引是基线。`memory.md` 变化后，Member 只收到一条简短提示：先前副本已过时、文件位置和当前预算占用。判断以最新的 memory 事件对照文件当前状态，旧的匹配提示不能掩盖后来的变化。提示不是索引：压缩后只剩提示时，仍会补发最新的完整基线。索引缺失或不可读时，说明当前状况及其路径，不注入内容。超出预算的索引仍算基线：只注入预算内的完整开头行，并警告去读文件其余部分；文件本身绝不裁剪或自动摘要。

## Workspace 规则
每个 Workspace 可以有一份 Team 自有的规则文件 `$DSH_HOME/agent-team/workspaces/<workspaceId>/rules.md`，放在所有仓库之外。它只装这支 Team 在这个 Workspace 共享的内容：协作约定、共享 checkout 纪律和本机环境线索。公开工程规则仍放仓库的 `AGENTS.md`，实时状态仍以账本为准。

两个 Team preset 都挂载 `workspace-rules-context` 这一行，每个 Workspace 注入一个块。Member 读取它当前参与的 Workspace；team manager 读取所有已注册的 Workspace。普通 Session 和 fork 一个也不读。Host 从不创建这个文件，文件缺失时块内说明路径；只有 manager 被邀请新建它，Member 只有在记录一条自己被允许落地的规则时才创建。

注入块写明文件路径，声明它低于 system、developer、user 指令和 `AGENTS.md`，并说明谁能改什么。manager 被告知自己是主编。Member 可以直接修正过时事实，或落地 Human 已经定下的规则（注明日期和 ref）；新立或推翻跨成员规则则先提给 Human。

和私有记忆不同，文件一变就整份重新注入，因为读的人通常不是改的人。文件没变就不追加；压缩丢掉这个块之后会重新补上。预算是 8 KiB：超出时只注入预算内的完整开头行，并提示去读其余部分，文件本身绝不裁剪。

## 管理会话的记忆与 skills
团队管理会话在 `$DSH_HOME/agent-team/manager/` 下有自己的私有空间——`memory.md`、`notes/` 与 `skills/`——它不属于任何 Member。这个目录比任何一个管理会话都活得久：重启、归档后重开、「新开对话」读的都是同一批文件，所以 Human 教给 manager 的东西不会随教它的那次对话消失。

它的记忆块是 Member 记忆块的同一套契约、换一套措辞：完整索引作为基线，文件变化后只给一条「旧副本已过期」的提示，同样 16 KiB 硬顶、同样的框架转义、同样的超限处理——只注入预算内的开头并附警告，文件本身绝不自动裁剪。只有 `memory.md` 进入上下文；`notes/` 按块里给出的路径按需读取。唯一的差别是位置那句话：manager 在某个 Workspace 里运行，所以块内按实际 cwd 说明私有 root 的位置，而不是断言它在所有 Workspace 之外。

这个目录遵循同一套有界索引与私有 skill 规则，只是换成 manager 的路径；具体做法由随包的 `manager-memory` skill 负责：什么值得写、三层结构、复查节点，以及绝不能保存什么。manager 自己的六份引导 skills 放在 `packages/agent-team/manager-skills/`；Member 的 core-skill root 不会挂进它的目录。

skills 用文件配置，经 manager preset 的隔离 registry 按轮次发现：provider 先扫随包发布的 manager root，再扫可写的 `manager/skills/`，所以同名的私有 skill 不会盖住内置的。Host 全局 skills 不会进入 manager 的目录或加载器。在这里增删私有文件，下一轮就能看到，不必换会话、也不必改 preset。这两处 root 都不会挂给 Member 或普通 Session。

## 上下文生命周期归属

Member 维护私有连续性，不管理上下文生命周期。Team 有两种自动机制：原地压缩缩短 Session，换代则替换 Session 绑定。两者都不是模型可调用的 Team 工具。

### 原地压缩

preset 适配器使用 Harness 的 `BasicCompactionEngine`，保留当前代与原始日志。主动输入触发阈值为：

`floor(min(B, W × 0.8, W − 16384))`

`B` 是 `memberCompaction.tokens`（默认 256000），`W` 是路由的上下文窗口。没有声明窗口时仍使用 `B`。因此 1M／2M 模型默认在 256000 触发，272000 窗口在 217600 触发。该阈值不扣除模型最大输出。

计量使用上次可比较的 provider prompt 数，加上 surface 增长、待输入消息、工具变化与 system prompt 增长。没有可比较 usage 时才退回 token meter 估算，不会把失败／中止请求的 header 误当成有 usage 的请求。

达到阈值后，Team 先裁剪工具结果，仍有需要才强制压缩，保留尾部预算为零；上游仍可能保留最近的平衡块。summary 输出默认 32768 token，与输入阈值独立，可按模型覆盖。

summary 路由有明确优先级：

1. 显式的全局或已提交路由 summary target 优先。
2. 否则，step 路由上配置的 target 优先。
3. 没有显式 target 时，只有 step 固定路由的窗口严格容得下本次 summary 输入、指令、工具与 summary 上限，才使用它。
4. 否则使用最后一次已提交请求的路由。

step 路由从 `agent/pre-step.modelSelection` 捕获，只在该 step 及其重试中有效；路由不一致会在 summary 前拒绝。判断依据是本次回放的 summary 输入，不是整个 Session 大小。之后手动 `/compact` 不会沿用过期 step 路由。

每个 step 至多允许一次替代 summary 尝试。全局或已提交路由的显式 target 失败，不会轮换离开操作者的选择。自动 summary 失败后暂停该路由，直到路由／summary 配置变化或手动 `/compact` 成功。失败的 `compaction/end` 留在日志中；turn 可以不生成 summary 而继续，不被永久锁住。

若压缩后仍超阈值，且不是 summary 失败，则结束 turn。路由暂停后，provider overflow 也可能结束 turn。没有成功响应隔开的连续三次 provider overflow 会产生 compaction-unreachable 诊断与恢复选项；切换路由、新一代或成功 checkpoint 会清除该周期。

每次请求的输出额度限制为 `W − estimated input − 4096`，不超过原请求额度。临时限制写入日志，下次计算前移除。窗口小于 20480 token 时无法容纳保留量，该策略不介入。只有预算失败才恢复未接纳输入；取消遵循 Agent 的 stop／dispose 语义。

这是触发阈值，不是物理上限：工具输出可在下次请求前越过它。`memberCompaction.enabled: false` 恢复上游压力处理。volatile Host-row 组包含 `enabled` 与 `tokens`；Team「上下文」设置只编辑 `tokens`，接受 `256K`／`1M` 等容量，留空清除覆盖但不改变 `enabled`。普通 Session 不受影响。

### 换代

发给 idle Member 的通知、DM 或显式 resume 可以触发换代。默认两项条件都必须严格超过：idle 长于 60 分钟，实测上下文大于 128000 token。未知事实选择 resume。Host 不会仅因重启而新建换代，但会完成已经提交的换代。

`wakeRecycle` 是 volatile Host-row 组，包含 `enabled`、`idleMs` 与 `minContextTokens`。Team 设置页不提供表单；`enabled: false` 禁止新换代。即使达到阈值，待处理普通输入与自有 job 防护仍可能推迟换代。

换代提交 `team/member-session-recycled`，归档而非删除旧 Session，并激活新绑定。后继不是 Harness subagent：血统来自 Team transition，不是 Session 的 `parentSession` header。提交顺序、崩溃续完与有界输入重放由 [Host authority](../architecture/host-authority.zh.md#换代与输入重放)维护。

后继收到当前身份、ownership、参与关系、私有记忆和唤醒输入，不携带旧工作上下文或交接简报。工作过程中就应保存持久的私有结论；模型没有启动、阻止或操纵换代的动作。

### 验收边界

Thread read 确认验收时，仅在这次验收结束的是读者参与过或负责的工作时提示记忆维护。只是 follow 的观察者不受打扰。提交验收的 Member 无需另读一次，也得到相同边界。

Host 向相关 turn steer 一条 `<system-reminder>`，点明其身份（`contributed`、`accountable` 或 `accepted`），要求把持久结论写入 memory 索引和 notes。实测达到或超过 128000 token 时，该边界还会在 Agent 空闲后请求原地压缩。不宣布交接，也不在未挂载引擎时承诺压缩。

## Agent notification boundary

通知提供上下文与读取入口，不证明已确认未读，也不提供 next-write token。idle Agent 启动 turn，运行中的 Agent 在安全 step 接收。完整且身份明确的 Message／Activity 可满足后续写入的上下文检查，摘要不能。

排序、合并、输出限制、提醒消费与至少一次投递由 [Attention 与消息](attention-and-messaging.zh.md#agent-投递)维护。用 `team_thread` 读取缺失或省略的事实，用 `team_inbox` 分流范围。Thread 未读必须显式 read 才消除。

恢复与未读不同。运行时失败与恢复尝试不创建协作事实，也不移动读取水位。错误分类、重试上限、诊断与操作者恢复由 [Host authority](../architecture/host-authority.zh.md#哪些操作会唤醒-member以及-member-卡住时怎么选)维护。

## Assembled acceptance

场景覆盖与命令由维护中的[浏览器 lane 目录](../development/e2e-lanes.zh.md)负责。按[检查梯度](../development/start-and-checks.zh.md#检查梯度)选择组件、集成与 assembled 检查；影响 assembled Web 的改动以未过滤浏览器验收为交付门槛。

协作验收必须区分持久状态与呈现：taskless 创建与 Task 提升、查看 Inbox 与 read、follow 与 mention、Claim 完成与验收、reload 与重新取得投影。适用时覆盖 Human 写入、Agent 安全边界投递、桌面／移动端键盘路径和普通 DSH 恢复。

回放可以使用真实设置、通知投递与工具执行，同时替换模型响应和 Worker 可执行文件。但它不能证明真实模型判断、原生 CLI 行为或原生 steer。报告应明确这条边界，不把回放结果当成三者都已验证。
