# member 参与 channel 逻辑重新设计 — 决策快照（第一期）

来源：Thread thread:898d427e-5a65-491c-b312-1bdd88b85fb4 · Task task:5f9e3661-3c56-43c0-a7d0-2097fbdf21e0（#47）· Channel channel:60067dd5（Roadmap）· Workspace 40459c33。设计由 Human 与 @Reeve 定，@Tars 实现，@Reeve review。无 GitHub issue（Human 已撤回）。

本文件是「讨论收敛后的确认快照」。实现以 `packages/` 源码与测试为准；本文件给模型与约束，不给逐行改法。

## 一、模型（Human 拍板）

1. **Agent 是全局身份，不是「属于某 workspace」。** Member 的私有记忆 / 技能 / persona / 模型都是 Member 全局事实；`workspaceId` 只记录「在哪创建」且不可变；授权一律读「当前参与集」。准确表述：agent 有一个创建归属 workspace，但可被 Human 引入任意 workspace；`participatesIn(workspace)` 不是身份归属，而是「已被引入、可在此干活」的工作授权边界。依据 docs/domain-model.md「Workspace Participation → Channel membership → Thread Attention」三级分层。

2. **Channel 是 Human 侧的组织结构。** 它主要帮 Human 管理/归类；Agent 不需要「加入/理解」channel。Channel membership 因此从「准入闸」降为「派生订阅」——只决定 team_view 等可见范围，不再是写门槛。

3. **Thread 是 Agent 与 Human 协作的空间。** Agent 的协作、通知、上下文都发生在 thread 这一级（thread 内消息往往就在 Agent 的 context history 里）。

## 二、锁定的决策

- **写权限边界** = `participatesIn(workspace)`，不再是 channel membership。
- **mention 候选集** 从「channel 成员」放宽到「workspace 参与者」——这是「非成员连名字都解析不出」的最靠上游根因。
- **`@all`** 展开 = 该 channel 的「已参与者」，**不是**整个 workspace。「可被 `@Handle` 点名」的集合（workspace 参与者）与「`@all` 展开」的集合（channel 已参与者）是两个不同集合。
- **Agent 点名「不在本 thread 的人」维持现状**：只有 Human 能把人拉进来；Agent 作者点到非 thread 参与者仍是「回报而不投递」（undeliveredMentions），不静默扩人。显式「待邀请态」留第二期。
- **channel membership 派生化**：由「在该 channel 任一 thread 里参与过」派生（对标 `everParticipated` 的做法），叠加历史账本里已有的显式 membership。team_view 仍只显示「参与过的 channel」。
- **撤销成员管理**：`joinChannel` / `removeChannelMember` 的 Remote 入口与对应 Client 管理 UI 移除。

## 三、提醒与通知规则（Human 第二点修正的落点）

Human 要「怎么提醒」按参与深度分级，但最终口径把三种情形**塌成一条规则**：

- **拉入 channel** = 纯 Human 侧记账，**不通知 Agent**；需要 Human 这侧输入框的二次确认。
- **拉入 thread** = **通知 Agent**（走已有的 mention→team_inbox 投递，Agent 据此自己去拉相关 context）+ 二次确认。
- 「既不在 channel 也不在 thread」的 Agent（情形③）与「在 channel 但不在本 thread」的 Agent（情形②）**agent 面行为完全一样**：都只经由 thread 的 inbox 通知 + 二次确认；是否在 channel 只是 Human 侧的静默差别。

落地含义：所有「Human @mention 把一个不在本 thread 的 Agent 拉进来」的动作，Agent 唯一收到的信号就是该 thread 的 inbox 通知；channel 归属静默派生，不另发「你被加入某 channel」的通知。情形②③的判别在「处理 thread 内 reply 的 mention」那一步做。

## 四、硬约束（实现与 review 都要守）

1. **向后兼容是强制的，不是可选的。** 账本在持久化路径与加载路径都会用 `validateRecords` → `validateOperation` **对全部历史操作重新校验一遍**（含授权校验与 `validMentionTarget` 的 mention 目标校验）。因此任何「收紧」都会让首次提交即在某条历史操作上抛错、整个账本无法加载。本次全部改动都是**放宽**（member→participates），放宽是 replay-safe 的：每条历史上通过了 membership 校验的 actor，必然也 `participatesIn`（因为加入 channel 的前提就是参与该 workspace）。实现方必须对**「live 命令守卫」与「操作 replay 校验器」两头同时放宽**，否则提交期全量复校会炸。

2. **历史 membership 操作必须继续可 replay。** 旧账本含 `channel-member-joined` / `channel-member-removed` 等操作，其 apply/validate 处理必须保留（expand–contract：停止**产生**新显式 membership，但继续**消费**旧的）。不要删这些操作的处理分支，只删对外 Remote 入口与 UI。

3. **mention 的 `@all`/候选集改动不触及历史消息的 replay。** 历史消息的 recipients/mentions 是写入时就快照冻结的；replay 期只用冻结的 `mentions` 列表做目标校验，不会重新解析正文、不会重新展开 `@all`。所以放宽候选集与改 `@all` 范围对旧账本安全——但 `validMentionTarget` 这类「每条历史 mention 都要过」的校验器必须随之放宽（去掉 isChannelMember 要求、保留 participatesIn），否则历史里本来合法的 mention 在新规则下复校失败。

4. **二次确认保持 human-only。** 复用已有确认原语（issue/consume confirmation），非 Human 触发即拒。确认流只是把触发条件从「channel 成员但未 follow 本 thread」放宽到「workspace 参与者且不在本 thread」。

5. **team_view 可见范围不得变宽到「整个 workspace 的所有 channel」。** 它仍按「参与过的 channel」收口，只是「参与过」的判据从显式 membership 变成派生。

## 五、关键实现锚点（稳定符号名，非行号）

- `mentionCandidatesFor`：候选集来源，放宽到 workspace 参与者。
- `mergeBodyMentions` / `resolveBodyMentions`：`@all` 展开点；展开集改为 channel 已参与者。
- `validateOperation`（经 `validateRecords`，加载 + 提交全量复校都走它）：message / claim / attention 三类的授权判据 `projection.memberships...has(actor)` 放宽为 `participatesIn`。
- `validMentionTarget` / `validateMentions`：replay 期逐条 mention 目标校验，去掉 isChannelMember、保留 participatesIn。
- `validateMessageInbox`：其中「member 作者 reply 不能点未 everParticipated 的人」这条**保留**（对应「Agent 不能扩人」）。
- `assertMentionTargets`：live 侧 mention 目标守卫，同样放宽。
- live 命令守卫 `requireChannelMember` 一类调用点：发消息 / claim / follow 的 live 授权改判 participatesIn。
- 确认触发点（Human reply 路径里判 unfollowed agents 的那段）与 `issueConfirmation`/`consumeConfirmation`：放宽触发条件、保持 human-only。
- `everParticipated`：channel 可见范围派生的对标实现。
- `joinChannel` / `removeChannelMember`（ledger + index Remote）：撤对外入口，保留 apply/validate 分支供旧账本 replay。

## 六、不在本期（第二期）

- Agent 的「显式待邀请态」：让 Agent 能提名一个非参与者、Human 一键确认/驳回，取代当前的静默回报。需新增一条持久「待邀请」事实 + Human 操作面。
- 一并理 issue #40（team_view「活跃 task thread」段）：其可见范围口径随 membership 派生化而变，一起看。
