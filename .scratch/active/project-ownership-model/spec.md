# Project 与具名 Owner：决策快照

本文件是 2026-10-20 至 2026-10-22 讨论收敛后的最终决策记录，**不是 API 权威**——当前行为以 `packages/` 源码、测试与 `docs/` 双语对为准。逐轮讨论见 [`materials/2026-10-22-convergence-agenda.md`](materials/2026-10-22-convergence-agenda.md)，ledger / 投影 / Remote / tool 形状见 [`materials/2026-10-22-durable-contract.md`](materials/2026-10-22-durable-contract.md)，工单见 [`issues/`](issues/)。

## 0. 一句话模型

> **看见按项目，发声有主，执行分散，责任具名；通知跟着责任走，不跟着参与走。**

旧模型里，Channel membership 与 Thread Attention 同时承担可见性、协作资格、通知订阅与参与历史。实测 60 天 ledger：Agent 发言量是 Human 的 1.98 倍，Agent 间回复占 Agent 回复的 56.5%，accept/close 100% 由 Human 完成；22 个未归档 Channel 中 20 个的声明成员数与实际发言人数不一致。系统有大量“参与”，却没有“谁负责推进、谁不能自验、何时需要介入”的制度。

## 1. 概念与职责

| 概念 | 回答的问题 | 不回答的问题 |
| --- | --- | --- |
| Workspace participation | Member 能否进入该 Workspace 的协作域 | 能看哪个 Project |
| Project member | Member 能否看见并参与某个 Project | 谁负责、谁收到每条消息 |
| Project owner | 谁能开讨论与 Task、谁对项目推进负责 | 谁亲自执行 |
| Thread Attention（follow） | 谁收到某个 Thread 的普通更新 | 谁能在 Thread 发言 |
| Claim executor | 谁正在做 Task 的某个方向 | 谁验收 |
| Task accountable owner | 谁推动 Task 到完成并组织验收 | 是否亲自执行 |
| Inbox | 有什么需要我看的新东西 | 模型是否已读、已处理 |
| Task board | 我可见的 Task 现在是什么状态、与我有何关系 | 有什么新东西 |

```text
Workspace（共享工作目录与授权域，不承载职责）
└─ Project（长期职责范围，原 Channel）
   ├─ owners：Human 恒在；Agent 由 Human 指定，数量不限
   ├─ Main stream：项目级消息流，含讨论卡片与 Task 卡片
   └─ Threads：只有 owner 能开
      ├─ 讨论 Thread
      └─ Task Thread（带工作状态的 Thread）
         ├─ accountable owner：一个
         └─ Claims：一个或多个执行方向
```

## 2. Project、owner 与 member

- Project 属于一个 Workspace。创建、改名、改描述、归档只有 Human 能做。
- Human 恒为每个 Project 的 owner，不存储、不可移除。Agent owner 只能由 Human 增删，且必须参与该 Project 的 Workspace。被指定的 Agent 立即收到通知。
- **Project member** 由 ledger 派生，不是可写的成员表：owners ∪ 在该 Project 被 mention 过 ∪ 在该 Project 发过言、认领过或 follow 过 ∪ 旧 Channel 的显式 membership；再与当前 Workspace participation 和 Member 生命周期取交集。
- Project membership 不因 unfollow、Task 完成或 Thread 结束而消失。
- 没有独立的 Thread participant 层：Project member 就能在该 Project 的任何 Thread 回复；follow 只决定是否收到普通更新；回复不会自动 follow。
- 没有 invitation 流程：点名一个 Workspace participant，就让它成为 Project member 并收到一次通知；它要持续收到更新，就自己 follow。

## 3. Main stream、Thread 与卡片

### 3.1 Composer（Human）

```
Project: UI-UX-AX                  [主对话] [任务看板]
│ ┌ 讨论：登录页改版 ─────── 6 条回复 · 2 人 ┐        ← 讨论卡片
│ ┌ Task #12 · 待验收 · 负责人 @Iris ─────────┐       ← Task 卡片（无来源的 Task）
│ @Iris  配色要不要跟设置页统一？                     ← Main stream 消息
┌──────────────────────────────────────────────────┐
│ 写消息…                                           │
│ [讨论/任务]                              [发送]   │  默认：Main stream 消息
└──────────────────────────────────────────────────┘
点开后：│ [讨论 ✓] [□ 作为任务]  负责人 [Human ▾]  [发送] │
   只选“讨论”   → 新讨论 Thread，Main stream 中出现讨论卡片
   勾“作为任务” → 新 Task Thread，发送后跳到任务看板
```

Agent 对应 `team_message.post`（Main stream）、`team_message.start`（讨论或 Task，仅 owner）。

### 3.2 规则

- Main stream 独立于 Thread：没有 Task、Claim、Attention、revision。普通消息不创建 Thread。
- Thread 总是新建自己的 anchor，不挂在 Main stream 的某条消息上。
- Project member 都能向 Main stream 发消息。非-owner 发言是低频行为，由 guidance 约束，不设单独 action。
- Owner 有 Main stream 未读时写入 Main stream 会被要求先读；Main stream 写入不带版本号。
- `replyToMessageRef` 只能指向同一 Main stream 或同一 Thread 的消息。
- Main stream 中的卡片是投影：讨论卡片显示回复数与参与者；Task 卡片显示当前状态与负责人，不按跃迁逐条追加。新开一个讨论 Thread 对其他 owners 算一条 Main stream 未读（等同于在主对话开了一个话题）；Task 卡片与升级前的旧卡片不产生未读。
- 有 `sourceThreadRefs` 的 Task，卡片放在每个来源 Thread 中；没有来源的放在 Main stream 中。
- 升级后，旧顶层 Thread 显示为讨论卡片，旧 Task 显示为 Task 卡片，按创建顺序排在 Main stream 中，与原 Channel feed 连续。

## 4. 权限

| tool.action / Human 操作 | 允许的 actor | 其他 actor 的结果 |
| --- | --- | --- |
| 读 Project 全部内容 | Project member | `not_project_member` |
| `team_message.post` | Project member | `not_project_member` |
| `team_message.start`（讨论 / Task） | Project owner | `project_owner_required`，指向 `post` |
| `team_message.reply` | Project member | `not_project_member` |
| `team_task.list` / `board` | Project member | — |
| `team_task.claim` / `done` / `release` | 任意 Agent Project member；done/release 只限自己的 Claim | 现有拒绝 |
| `team_task.accept` | Human；从未持有该 Task 任一 Claim 的 Agent Project owner | `self_acceptance_forbidden` / `project_owner_required` |
| `team_task.close` / `reopen` | Human、accountable owner | `accountable_owner_required` |
| `team_task.promote`（讨论转 Task） | Human、Project owner | `project_owner_required` |
| `team_task.transfer` | Human、当前 accountable；目标为本 Project owner 或 Human | `accountable_owner_required` |
| 增删 Agent owner、Project 管理 | Human | — |

- Human 不能 Claim（保持现状，另行决策）。
- “持有过 Claim”包括 release 过的 Claim；reopen 不清除这一历史。
- 拒绝码统一进入 `recovery-hints.ts`，每个拒绝点名下一步动作。

## 5. Task

- Task 仍是带工作状态的 Thread；状态由 Claims 派生，accept/close 是显式覆盖。
- **accountable owner**：Agent owner 创建时默认自己；Human 创建时可在 owners 中指定，不指定则为 Human。accountable 自动 follow Task Thread，但普通消息对它按 threshold 投递。
- **转交**：Human 或当前 accountable 发起，目标为本 Project owner 或 Human；新 accountable 立即收到通知并开始 follow。
- **`sourceThreadRefs`**：只在新建 Task 时写入，之后不可改；限同一 Project；原地 promote 没有来源。它决定 Task 卡片显示在哪里，不向来源 Thread 写入任何事实。
- 不做 completion report。Task Thread 消息、Claim Activity 与 Task 状态足以表达执行结果。
- **Owner 生命周期**：Agent owner 被撤销、离开 Workspace、archive 或 remove 时，同一 operation 把它负责的 open Task 转回 Human 并记 Activity，不拒绝该操作。Agent owner suspended 时保留 owner 与 accountable，通知留在 Inbox 等恢复后投递，UI 在 Task 上显示“负责人已暂停”。

## 6. Member 视图

Human 的收件箱与任务看板不是 Human 专属模型，而是每个 Member 都有的投影；Human Client 与 Agent tool 渲染同一份 Host 投影。

| 视图 | Human | Agent |
| --- | --- | --- |
| Inbox | 收件箱页（direct 蓝点、ordinary 白点） | `team_inbox` |
| Task board | 项目看板（四列，已完成显示最近 5 条）、全局看板（待处理/进行中/待验收） | `team_task board`（可按 Project 过滤、只看与我有关） |
| Address book | 侧栏与项目页 | `team_view`（Project 行带 owners 与我的角色） |

- Inbox 有两类行：Thread 行（follow 的普通未读 + 点名与责任事件）、每 Project 一行 Main stream（owner 的普通未读 + 点名）。Human 是所有 Project 的 owner，因此所有 Main stream 消息都进入 Human Inbox，以白点区分。
- `team_view` 原有的 active task threads 段并入 Task board；Human 看板改读 Host 投影，不再从 feed 已加载窗口推算。

### 6.1 一次 Task 状态变化的三种用途

```text
Task 状态变化：一条事实，记在 Task 自己的 Thread
 ├─ 推送（必须动手的事，按角色，进入 Inbox 的 direct 级）
 │    accountable：被指定/转交、进入 in_review、Claim 释放后无人执行、reopen
 │    Human：accountable 曾执行该 Task、无验收资格时“需要你验收”
 │    Task Thread followers：照常收 Thread 未读
 ├─ 状态：其余跃迁不进入任何人的 Inbox，只改变 Task board；Member 自己去看
 └─ 显示：Task 卡片（§3.2），不产生未读
```

责任事件按角色投递，不看 Attention：accountable unfollow 了 Task Thread，仍收到该它处理的事件。

## 7. 投递

Inbox 记录事实，投递决定是否打断 Agent。投递等级由当前角色在运行时计算，不落盘：

| 未读事实 | 对 Agent 的投递 |
| --- | --- |
| 点名、`replyToMessageRef` 指向自己的消息、责任事件、owner 指定、提醒 | immediate |
| Main stream 普通消息、新讨论 Thread（recipient 是 owner） | immediate |
| Thread 普通消息（recipient 是该 Project owner 或该 Task accountable） | threshold |
| Thread 普通消息（其余 follower） | immediate |
| 新 Task（非 accountable 的 owner） | 不投递，看 board |

- **immediate**：Agent 空闲时开启一轮，运行中时在工具调用间隙插入；不中断正在执行的工具。
- **threshold**：按“每个 Member × 每个 Thread”计数，满 5 条注入一次有界摘要；不足 5 条的随下一次 immediate 通知一并摘要带出。
- 角色重叠时，普通 Thread 消息按 owner/accountable 的 threshold；点名与责任事件仍为 immediate。
- 发送者自己的消息不进入自己的 Inbox。Main stream 中 owner 之间的对话仍会互相通知；不由 Host 硬性消除循环，靠 guidance、有界通知与模型判断，并在试用期观察。
- 不带 `replyToMessageRef` 的普通消息不通知原作者。由此，执行者回答 owner 的问题时必须点名或带链接，否则 owner 要攒满 5 条才被打断——guidance 必须写明。
- 投递是 at-least-once 尝试，失败不回滚 ledger；Session recycle、resume、activation 后从 durable Inbox 重新派生。
- 新模型移除 `@all` 的特殊展开；历史 recipient snapshot 照旧 replay。

## 8. Agent context

| 层 | 内容 |
| --- | --- |
| persona（常驻） | 行为规则（消息形态、何时找 Human、礼仪）+ 8 行以内的角色速查；整体改写，删除 `@all`、Human-only 邀请/验收、顶层消息建 Thread、mention 恢复 Attention、`team_claim` 等过期条目 |
| 每步动态 context | 现有身份、memory index、Workspace 列表 + 一块“你是哪些 Project 的 owner”；内容不变则不重复注入；不带 Task 状态 |
| Inbox notice | 每条带 delivery、cause、scope（Main stream / Thread / Task）、本 scope 内角色、source ref、读取入口 |
| `team-domain-model` core skill（按需） | 角色与权限、Main stream 与 Thread 的分工、点名/回复/普通消息的投递差别、何时看 board、Task 生命周期与验收、DM 用途、常见拒绝与恢复；不含任何当前状态 |

权限、Inbox、投递、steer 与 replay 始终由 Host 负责；skill 与 prompt 只减少模型犯错。

## 9. 提醒

- 提醒在事件发生时评估（任何 ledger 提交、activation、Inbox read、已有 wake），Host 不自行计时。单个 Task 停滞时团队其他活动仍会触发评估；整个 Team 完全静默时漏检，可接受。
- 待验收积压：Task 处于 `in_review`，应验收者为 accountable；accountable 无验收资格时为 Human。应验收者是 Agent 时条件为“该 Agent idle ≥ 30 分钟”；是 Human 时没有 idle 信号，条件为“进入待验收已 ≥ 30 分钟”。
- 停滞：Task 处于 `in_progress` ∧（Task Thread 24 小时无消息 ∪ Claim 持有者 idle 超过 24 小时）；接收者为 accountable。
- Agent idle 是运行时数据；Host 重启后未知时跳过评估，不判定停滞。
- 每个 episode 只提醒一次，提醒写成 durable operation，以 `taskRef + 类型 + 接收者 + 条件起点` 去重。
- `docs/team-collaboration/model-and-time` 的“时间绝不驱动自动行为”改写为“时间条件只在事件发生时评估，Host 不自行计时”。
- 30 分钟 / 24 小时为初值，试用后冻结。

## 10. 迁移与兼容

- **规则版本**：replay 会精确重算每条记录的通知结果，因此每个改变既有记录校验规则的批次都在首次挂载时追加一条 `team/rules-version-adopted`（第 2 批为版本 2，第 3 批为版本 3）。每条记录按它之前最近的版本校验；旧版本规则集中为 replay-only validator。（2026-10-25 修订：批次 3、4 一并归入版本 2，不发布中间 v3/v4；开发中的中间 v2 账本可重建，不承担公开迁移承诺。详见 [`materials/2026-10-25-final-v2-decisions.md`](materials/2026-10-25-final-v2-decisions.md)。）
- **改名**：代码、Remote、tool 文案、新 operation 全部改为 Project；新 ref 为 `project:<uuid>`。旧 `channel:` ref 与 `channelRef` 字段在解码时归一化，ref 解析永久接受 `channel:` 输入，历史正文中的 ref 仍可点击。存储字节不改写。
- **升级后的项目**：所有 Channel 成为 Project，owner 只有 Human；需要由 Human 重新指定 Agent owner。旧 Task 的 accountable 读为 Human，Claims 照常继续；旧 Task 的 `sourceThreadRefs` 为空。
- **升级后的可见性**：按 §2 的派生规则，Agent 能看到的项目不减少。
- **升级后的主对话**：旧 Thread 与 Task 以卡片出现在 Main stream；新 Main stream 消息从升级后开始。
- **发布**：支持向前迁移，不承诺旧版本打开新 ledger；发布说明要求先备份 `agent_team.sqlite`，并面向外部使用者说明“升级后需重新指定 Agent owner”。
- 不修改 `../deepseek-harness`、agent loop 或 shipped defaults。

## 11. 分批与试用

| 批次 | 内容 | 用户可见变化 |
| --- | --- | --- |
| 1 | 全仓 Channel → Project 改名（含 `project:` ref 与解码归一化）、旧数据 replay 一致性；不改变任何校验规则，不写版本标记 | 只有用语变化 |
| 2 | 规则版本 2、Project member 派生（§2）、Agent owner 管理、Main stream、composer、取消 participant/邀请确认/`@all`、immediate 与 threshold 两级投递、Inbox Main stream 行与蓝白点、persona 改写、`team-domain-model` skill、owner 角色块 | Human 试用一周 |
| 3 | 规则版本 3、`team_claim` 并入 `team_task`、accountable 与转交、Agent 验收与自验禁止、`sourceThreadRefs`、Task 卡片、Task board 投影与 Human 看板改造、责任事件推送、生命周期转回 Human | |
| 4 | 待验收积压与停滞提醒 | |

试用期观察：Agent 之间互相回复的占比、Human 亲自 accept/close 的占比、每个 owner 每天被打断次数、非-owner 在 Main stream 的发言数；第 4 批后加提醒触发次数与误报。

## 12. 已取消或撤回

| 项 | 结论 |
| --- | --- |
| Thread participant grant、`thread_participation_required` | 取消：自助 follow 之后这道门不保护任何东西 |
| invitation 流程、Human 邀请确认 | 取消：点名即通知，对方自己 follow |
| 非-owner 的 `report` action | 取消：Project member 直接 post |
| completion report | 取消 |
| 向来源 Thread 写状态的多 Thread 原子 operation | 取消：来源处只显示 Task 卡片 |
| 每轮自动注入“项目现状” | 取消：Member 自己看 Task board |
| `@all` 特殊展开 | 移除 |
| Project 对整个 Workspace 可见 | 改为 Project member 派生 |
| 提醒需要任务数量门槛（5 个） | 撤回，改为停滞信号 |
| “unfollow 次数说明 Agent 在逃离 Thread” | 撤回：unfollow 观测由 inbox delta 派生，close、archive、remove 都会记一条 |
| “用 Agent 最后发言判断对话烂尾” | 撤回，未验证 |
| “Task 必须从 Thread 独立成另一类容器” | 撤回：界面分流与容器拆分是两件事 |
| “Human 只能通过看板触及 Task” | 撤回 |

## 13. 实施前需探针确认

- Agent DM 的 Workspace 边界是否在 Host 校验（文档写了，实现未核实）。
- 历史 accept 缺 `acceptedClaimRefs` 时的唤醒语义在新规则版本的 replay 下保持不变。
- 规则版本标记写入与 Host 挂载顺序：标记必须早于该版本的任何写入，包括启动恢复期间的生命周期 effect。

## 14. 实测依据

2026-10-20 的 ledger 统计（7275 条消息，Human 占 33%）：

| 项目 | 消息 | 参与者 | 任务 | 主要发言者 |
| --- | --- | --- | --- | --- |
| dsh-agent-team / Main-Dev | 2734 | 10 | 117 | Reeve 674 / Human 658 / Tars 359 |
| dsh-agent-team / Publish-Ship-Growth | 735 | 3 | 48 | Ferry 385 / Human 335 |
| dsh-agent-team / Bug-Check-Fix | 515 | 8 | 31 | Human 194 / Vera 127 / Aster 85 |
| dsh-agent-team / Issue-PR-Review-Merge | 477 | 7 | 20 | Vera 192 / Human 156 |
| dsh-agent-team / Roadmap | 463 | 5 | 47 | Human 258 / Momo 154 |
| dsh-agent-team / UI-UX-AX | 449 | 5 | 28 | Iris 205 / Human 191 |
| Loom / Main | 623 | 11 | 28 | Human 225 / Terra 145 / Sol 139 |

3 个 Channel 建了从未使用，2 个 ≥30 天无活动。7 个 Channel 改过名、14 个 memberId 改过 handle，因此 owner、来源引用与迁移一律以 branded ref 为锚，不以名字为锚。
