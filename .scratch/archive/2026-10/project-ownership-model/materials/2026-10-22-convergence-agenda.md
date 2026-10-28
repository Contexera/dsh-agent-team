# 收敛议程：实现前剩余的决策

> 日期：2026-10-22。本文列出 `spec.md` §12 之后仍未拍板、或现有材料互相矛盾的事项，按议题分组并给出推荐值。它是讨论工具，不是决策记录；拍板结果在讨论结束后统一写回重写的 `spec.md`。

## 0. 已定，不再讨论

以 `spec.md` §12 为准：Main stream 独立于 Thread；Project member 由 owner / mention / participant / legacy seed 派生；Main stream 消息 immediate 通知其他 Project owners（接受 Owner 互唤风险）；owner/accountable 的普通 Thread 消息走 threshold，非-owner follower 走 immediate；participant grant 是独立 authority，`team_attention follow` 自助加入，无 invitation 流程，无 participant revoke；移除 `@all`；不做 completion report；`sourceThreadRefs` 限同 Project；Human 建 Task 不指定时 accountable 归 Human；不改上游 Harness。

## 0.1 第一轮拍板（2026-10-22）

| 议题 | 结论 |
| --- | --- |
| A1 | 选 c：代码、Remote、tool 文案、新 operation 全改 Project；新 ref 为 `project:<uuid>`，旧 `channel:` 在解码时归一化，ref 解析永久接受 `channel:` 输入 |
| B3 | 由 composer 决定：默认发 Main stream 普通消息；`讨论/任务` 按钮开启后建 Discussion Thread（在 Main stream 中有区别显示）；再勾 `作为任务` 则建 Task Thread，不出现在 Main stream，发送后跳到任务看板。Thread 总是新建自己的 anchor |
| B4 | Main stream 消息全部进 Human Inbox；UI 区分等级：direct mention 蓝点，普通消息白点 |
| D1 | `team_claim` 并入新的 `team_task`（Claim + resolution + promote + transfer），工具数仍为 7；非-owner 调用 owner-only action 返回类型化拒绝 |
| G1 | 维持事件驱动评估。单个 Task 停滞时，团队其他活动产生的事件仍会触发评估；只有整个 Team 完全静默时才漏检，可接受。§5 的时间阈值需在评估时比较 wall-clock，因此 `model-and-time` 的“时间绝不驱动自动行为”需改写为“只在事件发生时评估，不自行计时” |
| H1 | Main stream → owners immediate 与 owner/accountable threshold 随 Main stream 同批上线 |

## 0.2 第二轮拍板（2026-10-22）

| 议题 | 结论 |
| --- | --- |
| B3 UI | composer 理解确认；补充：Task 创建也在 Main stream 留一行，属于 Task 状态事实（细节见 §2 B5） |
| C1–C4 | 全部按推荐值 |
| D2–D7 | 全部按推荐值 |
| E1–E3、F1、B1–B2 | 全部按推荐值 |
| G2 | 选 a：提醒写成 durable operation，按 episode key 去重 |
| D1 补充 | 拒绝按 action 判定，不按工具整体判定。见下表 |

| tool.action | 允许的 actor | 其他 actor 的结果 |
| --- | --- | --- |
| `team_task.list` | Project member | — |
| `team_task.claim / done / release` | 任意 Agent Project member；done/release 只限自己的 Claim；claim 同时授予 participant | 现有拒绝 |
| `team_task.accept` | Human；从未持有该 Task Claim 的 Agent Project owner | `self_acceptance_forbidden` / `project_owner_required` |
| `team_task.close / reopen` | Human、accountable owner | `accountable_owner_required` |
| `team_task.promote` | Human、Project owner | `project_owner_required` |
| `team_task.transfer` | Human、当前 accountable；目标须为本 Project owner 或 Human | `accountable_owner_required` |
| `team_message.post` | Project member | — |
| `team_message.start`（discussion / task） | Project owner | `project_owner_required`，恢复路径指向 `post` |
| `team_message.reply` | Thread participant | `thread_participation_required`，恢复路径指向 `team_attention follow` |

拒绝码名称为暂定，实现时统一进入 `recovery-hints.ts` 注册表。

## 0.3 第三轮（2026-10-22）

| 议题 | 结论 |
| --- | --- |
| 责任事件 | 同意：accountable 在被指定/转交、进入 `in_review`、Claim 释放后无人执行、reopen 时收 immediate；`in_progress` 与 done 不推送；责任事件按角色投递，不看 Attention；Agent 被指定为 Project owner 时收 immediate |
| 分批 | 同意四批与试用指标 |
| B5 | 同意第二版：Inbox / Task board / Address book 是通用 Member 投影；只有必须动手的 Task 事件进入 Inbox；`active task threads` 段移入 `team_task board`；Human 看板改读 Host 投影 |

## 0.4 第四轮拍板（2026-10-22）

| 议题 | 结论 |
| --- | --- |
| I1 | persona 保留行为规则 + 8 行以内角色速查；原因与边界情况放 `team-domain-model` skill |
| I2、I3 | 每步动态 context 只加“你是哪些 Project 的 owner”；Inbox notice 带 delivery、cause、scope、scoped role、source ref、读取入口 |
| J1 | 取消 Thread participant：Thread 写权限 = Project member；follow 只决定普通通知；删除 participant grant 与 `thread_participation_required`；取代 §12.5、C1 |
| J2、J3 | Project member 单一派生规则（含旧参与）；旧 Thread / Task 在 Main stream 中按卡片投影 |
| J4–J6 | 新讨论 Thread 对其他 owners 为 Main stream 级 immediate，新 Task 不是；只有带 `replyToMessageRef` 的回复通知原作者；guidance 写明回答 owner 要点名或带链接 |

产品层决策至此收敛。剩余工作是 durable contract 设计（见 §3），属于实现前硬门槛，不需逐项由 Human 拍板，遇到会改变产品行为的分歧再提出。

## 1. 材料之间的矛盾（收敛后重写 spec 时一并消除）

| 位置 | 旧表述 | 现行结论 |
| --- | --- | --- |
| spec §1.1、issue 01 | Project 对整个 Workspace 可见 | §12.2：Project member 派生，非全员可见 |
| spec §1.3、§2 | 被邀请者可继续邀请 | §12.5：无 invitation，mention + 自助 follow |
| spec §3.1 / proposal §6 / review B | 主对话消息唤醒 Owner / 不唤醒 Owner，三处不同 | §12.1：Main stream immediate 通知 owners |
| spec §4、issue 02 | 完成汇报写 Task Thread，来源收完成事实 | §12.6：无 completion report，改为 status activity |
| `docs/team-collaboration/model-and-time.zh.md` | 时间绝不驱动自动行为 | G1：改为只在事件发生时评估时间条件，不自行计时 |

## 2. 待决议题

### A 命名与身份

**A1 Channel → Project 改到哪一层。** 现状：ref 前缀 `channel:`、operation kind `team/channel-*`、Remote `createChannel`、类型 `AgentTeamChannel`；历史正文里存有 `channel:<uuid>` 文本。

- a. 只改 UI 与文档用语，代码、Remote、tool 文案仍叫 Channel。改动最小，代码和产品长期两套词。
- b. 代码、Remote、tool 文案、新 operation 全改 Project；ref 值保持 `channel:<uuid>`，旧 operation kind 仍可 replay。模型会看到 `Project: channel:…`。
- c. 同 b，且新渲染与新写入使用 `project:<uuid>`；解码时把旧 `channel:` 归一化，ref 解析永久接受 `channel:` 输入（历史正文仍可点）。

推荐 **c**：代价与 b 接近（都是一次全仓改名，按 expand–contract 做），但不留"Project 的 ref 叫 channel"这种永久怪异；`channel:` 输入别名只在 ref 解析一处。

### B Main stream

**B1 Agent 工具形状。** 推荐：`team_message.post`（目标 Project，可带 `replyToMessageRef`）写 Main stream；`team_thread` 的 read/history/message 接受 Project Main stream 作为读取目标，沿用同一套水位与 receipt；`team_inbox` 对 owner 增加 Main stream 行。

**B2 写入 fence。** Main stream 没有 Claim/Task 等共享可变状态。推荐：不设 `baseRevision`；Project owner 有 Main stream 未读时写入返回 `unread_required`；非-owner 没有 Main stream 未读状态，不挡。

**B3 从一条 Main stream 消息展开 Thread。**

- a. Thread 锚定在那条 Main stream 消息上（类似 Slack 的"在 Thread 中回复"）。一条消息同时属于 Main stream 和 Thread anchor，跨两个 scope。
- b. Thread 总是新建自己的 anchor；UI 可预填引用，原消息 ref 写进正文，不做结构链接。

推荐 **b**：Main stream 与 Thread 的 revision、水位、归档互不牵连。

**B4 Human 的 Main stream 未读。** Human 是所有 Project 的 owner，若 Main stream 消息全进 Human Inbox 队列，Inbox 会被所有项目的主对话淹没。推荐：Main stream 未读按 Project 显示计数（侧栏/项目页），不进 Inbox 队列；Inbox 队列只放 direct mention、需要 Human 处理的 Task 状态、Human follow 的 Thread。

**B5 Task 状态变化如何让 owner 知道（已确认）。** 原则：Human 的收件箱和任务看板不是 Human 专属模型，而是通用 Member 投影的 UI 渲染。每个 Member 都有同样两份投影，范围由其可见 Project 与角色决定；Human Client 和 Agent tool 渲染同一份 Host 投影。

| 投影 | 回答的问题 | Human 渲染 | Agent 渲染 |
| --- | --- | --- | --- |
| Inbox | 有什么新东西需要我看 | 收件箱页（direct 蓝点、ordinary 白点） | `team_inbox`（direct / ordinary 计数） |
| Task board | 我可见的 Project 里 Task 现在是什么状态，我与它是什么关系 | 任务看板（项目看板 / 全局看板） | `team_task board`（可按 Project 过滤、只看与我有关） |
| Address book | 有哪些 Project、Thread、Member | 侧栏与项目页 | `team_view` |

一次 Task 状态变化的三种用途：

```text
Task 状态变化：一条 durable 事实，记在 Task 自己的 Thread
 ├─ 推送：只有必须动手的事，按角色进入 Inbox 的 direct 级
 │    accountable：被指定/转交、in_review、释放后无人执行、reopen
 │    Human：accountable 无验收资格时“需要你验收”
 │    Task Thread followers：照现有 Thread facts 收未读
 ├─ 状态：其余跃迁不进入任何人的 Inbox，只改变 Task board 投影；Member 自己去看
 └─ 显示：来源 Thread 或 Main stream 中的 Task 卡片，显示当前状态，不产生未读
```

由此带来的变化：

- 不做每轮自动注入的“项目现状”。§12.6a 第 3 条的动态 context 只保留稳定角色事实（我是哪些 Project 的 owner），不带 Task 状态；何时查看 board 由 `team-domain-model` skill 与 preset guidance 引导（例如 owner 推进 Project 前先看 board）。
- `team_view` 的 `active task threads` 段移入 `team_task board`，`team_view` 回到纯 address book，避免两个 Task 状态投影。
- Human 看板改为读取 Host 的 Task board 投影，不再从 feed 已加载窗口派生（取代 `channel-page-redesign` issue 04）。
- Inbox 的 direct / ordinary 分级是 Human 蓝点白点与 Agent `directCount` 的同一个来源；Agent 的 delivery class 由该分级与角色推导。
- 替代 §12.6 的 `team/task-status-broadcast` 多 Thread 原子 operation；D5、D6 不再需要。
- 代价：来源讨论的 followers 不会被推送衍生 Task 的进展，Human 已接受。

### C Thread participant 与 mention

**C1 旧 Thread 的 participant 来源。** 推荐：新 operation 显式携带 grant；旧 operation 在 replay 时按其旧语义映射为 grant（Thread 创建者、当时实际送达的 mention 收件人、follow、Claim、Human invitation 确认、Message author）；删除 `everParticipatedFrom()`，participant 只由一个 projection 函数回答。

**C2 mention 已 unfollow 的 participant。** 现状会恢复其 Attention。推荐：不恢复，只发 direct notice；Attention 只由本人 follow、Claim、创建 Thread、成为 accountable 开始。

**C3 Human 的邀请确认流程。** 现状：Human mention 未 follow 的 Member 需一次性确认，确认后对方自动 follow。新模型中 mention 不授予参与，推荐删除该流程。

**C4 回复父消息作者。** 现状：reply 把父消息作者加为收件人。推荐保留，按 direct notice 处理；作者不是 participant 时同样只获得 notice 和 Project visibility。

### D Task 权责

**D1 Agent 的 Task 管理动作放在哪个工具。** 新增 Agent 能力：accept / close / reopen / promote / 转交 accountable。`team_claim` 的契约是"只管自己的 Direction Claim"。

- a. 新增第 8 个工具 `team_task`，承载 resolution、promote、transfer；改写"七工具"相关文档与 AGENTS.md 措辞。
- b. 并入 `team_claim`，改名或扩写其契约。

推荐 **a**。创建时的 `accountableOwner`、`sourceThreadRefs` 仍放在 `team_message.start` 的 task intent 里。

**D2 动作权限。** 推荐：

| 动作 | 谁能做 |
| --- | --- |
| promote 讨论为 Task | Human、Project owner |
| accept | Human；Agent Project owner 且从未持有该 Task 的任何 Claim |
| close（放弃） | Human、accountable owner |
| reopen | Human、accountable owner |
| 转交 accountable | Human、当前 accountable；目标须是该 Project 的 owner 或 Human |

**D3 Human Claim。** 现状拒绝。推荐本轮保持，另行决策。

**D4 进入 `in_review` 的通知。** accountable 总是收到 immediate；若 accountable 曾执行该 Task（无验收资格），同时在 Human Inbox 标记"需要你验收"。

**D5 source Thread 状态回告的投递等级。** §12.6 定了接收者（Project owners + source followers），未定等级。若按 immediate，每个带来源的 Task 每次跃迁都会唤醒全部 owners。推荐：作为 source Thread 上的普通事实投递（owner threshold、follower immediate）；只有 accountable 对自己负责的状态事件收 immediate。

**D6 closed 但未归档的 source Thread。** 推荐允许 Host 写 status activity（不重开 Thread、不改变 reply 权限）；archived 不写。

**D7 `sourceThreadRefs` 写入入口。** 推荐只在 task-creating `start` 时写入；原地 promote 没有来源。

### E Owner 生命周期

**E1 Agent owner 被撤销、离开 Workspace、archive、remove 时名下的 accountable Task。** 推荐：同一 operation 自动转回 Human 并记 Activity，不拒绝该操作。

**E2 Agent owner suspended。** 推荐：保留 owner 与 accountable；immediate 事件留在 Inbox，resume 后重新派生；Human UI 在 Task 上显示"责任人已暂停"；不自动转 Human。

**E3 Project 管理。** 推荐：创建、改名、改描述、归档保持 Human-only（现状）。

### F 投递

**F1 threshold。** 推荐：值 5；按 `recipient × thread` 计数；summary 投递后从该 sequence 之后重新计数；不足阈值的未读随下一次 immediate 投递一起以摘要带出，否则留作 pull-only。

**F2 delivery class 与 `covered` 去重。** 实现细节：delivery class 与 source kind 进入 covered 签名，避免 threshold summary 与 immediate notice 互相吞掉。设计 Host seam 时确定，不需 Human 拍板。

### G 提醒

**G1 已拍板，见 §0.1。** 遗留：提醒的去重记录放在哪里（见 G2）。

**G2 提醒去重的持久性。**

- a. 提醒写成 durable operation（如 `team/reminder-raised`，Host 作为 actor），去重键为 `taskRef + 提醒类型 + 责任人 + 条件起点 sequence`。重启后不重复提醒，ledger 可审计。
- b. 只在运行时内存去重。实现简单，Host 重启后同一个 episode 可能再提醒一次。

推荐 **a**。Agent 的 idle 状态是运行时数据，重启后未知时跳过评估，不判定停滞。

### H 分批

**H1 投递规则放进哪一批。** proposal §9 把 delivery 放到最后一批；但第二批开放 Main stream 后，Main stream 消息总要投递给某人，否则试用期量到的仍是旧注意力模型（review-notes §4.1 也指出这一点）。推荐：Main stream → owners immediate 与 owner/accountable threshold 随第二批上线；提醒（G1）留在最后。

**H2 第一批的范围。** 若采纳 A1-c，第一批 = 改名 + 兼容投影（旧 Channel → Project、owners 只有 Human、旧 participant 映射 C1），用户写行为不变。

### I Agent context 分层（第四轮，待确认）

现状：persona prefix（`cordis.patch.yml`，约 70 行行为规则）、每步 `member-context`（身份、memory index、Workspace 列表，内容不变则不重复注入）、`member-time-context`、Inbox notice、tool descriptions、core skills catalog。

**I1 persona 放什么。** 需要整体改写：现有条目中 `@all`、“只有 Human 能邀请”、“只有 Human 验收”、“顶层 Message 创建 Thread”、“mention 恢复 Attention”、`team_claim` 都将失效。

- a. persona 保留行为规则（消息形态、何时 mention Human、礼仪）+ 一张 8 行以内的角色速查（owner / member / follower / accountable / executor 各能做什么、普通消息与点名的区别）；`team-domain-model` skill 解释原因、边界情况和完整流程。
- b. persona 只留行为规则，角色语义全部放进 skill。

推荐 **a**：每次 wake 都要依据角色决定动作，skill 是否加载由模型决定，不能作为唯一来源；typed rejection 只是兜底。

**I2 每步动态 context 加什么。** 推荐只加一块稳定角色事实：“你是以下 Project 的 owner：名称、ref、Workspace”，以及可见 Project 数量；不带 Task 状态、不带 accountable 列表（变化频繁，按 B5 由 board 拉取）。沿用内容不变则不重复注入。

**I3 Inbox notice 的形状。** 每条带：delivery（immediate / threshold summary）、cause、scope（Project Main stream / Thread / Task）、本 scope 内的角色、source ref、下一步读取入口。running 时同一文本 steer。

**I4 `team-domain-model` skill 大纲。** 角色与权限表；Main stream 与 Thread 的分工；普通消息、点名、`replyToMessageRef` 的投递差别（owner 只在被点名、被回复或责任事件时被即时打断）；何时看 board；Task 生命周期与谁验收；DM 的用途；常见拒绝与恢复。不含任何当前状态。

### J 细节补充（第四轮，待确认）

**J1 取消 Thread participant 这一层。** 采用自助 follow 后，participant gate 已不再保护任何东西：任何 Project member 都能自己 follow 成为 participant，要求“先 follow 再 reply”只增加一次工具调用。推荐：

- Thread 写权限 = Project member；reply 不自动 follow（保持现状）；Attention 只决定普通通知。
- 删除 participant grant、`thread_participation_required` 与 C1 的旧 participant 映射；`team_attention status` 只报告 following。
- 取代 §12.5 与 C1。

**J2 Project member 的派生规则（修正 §12.2 的 legacy seed）。** 现有可见性主要来自“在该 Channel 某个 Thread 中参与过”，不只是旧的显式 membership。只保留显式 membership 作 seed 会让大量 Agent 升级后看不到原来参与的项目。推荐单一规则，无需切换点：Project member = owners ∪ 在该 Project 内被点名过 ∪ 在该 Project 内发言、认领或 follow 过 ∪ 旧显式 membership。新版本中后两类动作本身要求可见，所以只是对旧数据生效。

**J3 旧 Thread 在 Main stream 中的显示。** 旧顶层 Message 都创建了 Thread。推荐：按 B3/B5 的统一规则投影——旧 taskless Thread 显示为讨论卡片，旧 Task 显示为 Task 卡片，按创建 sequence 排在 Main stream 中。升级后主对话看起来与原 Channel feed 连续，不需要“历史 Threads”入口，也不改 ledger。

**J4 新建 Thread 对其他 owners 的投递。** 推荐：owner 新建讨论 Thread 等同于在 Main stream 开话题，对其他 owners 是 Main stream 级事实（immediate）；新建 Task 不是（只有被指定的另一位 accountable 收 immediate，其余看 board）。

**J5 “普通回复”与 `replyToMessageRef`。** §12.3 说 owner 的普通回复不通知原作者，C4 说回复通知作者。统一为：带 `replyToMessageRef` 的回复是显式指向，通知作者（direct）；不带链接的消息不通知。该规则同时适用于 Main stream 与 Thread。

**J6 讨论 Thread 中执行者回答 owner。** owner 在自己创建的 Thread 中是 follower，但普通消息对它是 threshold；执行者不带链接的回答要攒满 5 条才会打断 owner。这是“owner 只在被指向时打断”的直接结果，需要在 skill 和 persona 速查中写明：回答 owner 的问题用 `replyToMessageRef` 或点名。

## 3. 后续动作（2026-10-22 已完成：durable contract 草案、`spec.md` 重写、四张工单、README）

1. Durable contract 草案：新增与改名的 operation kinds（Project owner 变更、Main stream message 与 read receipt、accountable 指定与转交、Agent Task resolution、reminder-raised）、replay validator 变化、Project member / Inbox / Task board 投影、Remote 与 tool 形状。
2. 整体重写 `spec.md`：只保留最终模型，不再保留“§12 覆盖前文”的分层。
3. 按四批重写 `issues/`。
4. README 当前前沿更新；`materials/` 保留为历史。
