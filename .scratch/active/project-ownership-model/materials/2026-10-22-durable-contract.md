# Durable contract 草案

> 日期：2026-10-22。本文把收敛议程 §0 的产品决策落到 ledger、投影、Remote 与 tool 形状上，是实现前的硬门槛材料。它不是 API 权威；实施时以代码与测试为准，本文中的名称为建议值。所有引用的现状均已对照 `packages/agent-team/src/{ledger.ts,spec.ts,types/*.ts}` 核实。

## 0. 现状中决定设计形状的事实

| 事实 | 位置 | 对设计的约束 |
| --- | --- | --- |
| 协作类 operation（29 个 kind 中的 9 个：message-sent、thread-replied、thread-promoted、三个 claim、task-changed、thread-attention-changed、release snapshot 系列）携带结果实体快照与 `inbox` delta；replay 重新计算期望 delta，并以 `isDeepStrictEqual` 比较 | `validateMessageInbox`、`validateInboxDelta` | 投递规则一旦改变，同一 operation kind 在规则变更前后的期望 delta 不同；validator 必须知道 operation 属于哪套规则 |
| 存储解码由 zod schema 完成，已有加载时归一化先例（Channel `state` 缺省为 `active`、`stampOperationMessages` 回填 `occurredAt`） | `spec.ts` | `channel:` → `project:` 的 ref 归一化可以放在同一个解码 seam，不另建兼容层 |
| Agent 的 Channel 可见性 = 旧显式 membership ∪（当前参与该 Workspace ∧ 曾在该 Channel 任一 Thread 参与）；Human 不走这条判断，直接可见全部 Channel | `isChannelMemberFrom` | J2 的 Project member 规则必须同时复现 Workspace 条件与 Human 例外，才能保证可见性不减少 |
| direct marker 的 schema 与 validator 要求 `threadRef`，并校验 Message 属于该 Thread | `spec.ts` `directMarkerSchema`、`validateInboxDelta` | Main stream marker 不能复用 Thread marker 类型 |
| Task activity kind 只有 `promote`、`accept`、`close`、`reopen` | `spec.ts` `taskActivitySchema` | 转交需要新增 `transfer` activity kind |
| 顶层 Message 中被 mention 的 Agent 自动开始 Attention；既有 Thread 中 Agent 只能 mention 曾参与者；Human mention 未 follow 者需一次性确认 | `validateMessageInbox`、`undeliverableRecipients`、`issueConfirmation` | C2、C3、J1 改变这三条规则，属规则版本 2 |
| Claim 只允许 Agent actor；Task resolution 与 promotion 只允许 Human | `validateOperation` 的 Claim 分支、`changeTask`、`promoteThread` | D2、D3 改变 resolution/promotion 的 actor 规则 |
| Inbox 投影对 Human 与 Agent 是同一函数，Human 额外获得 `recent` 切片 | `inboxForWorkspaces` | B5 的“通用 Member 投影”在 Inbox 上已成立，只需扩展 Main stream 行 |
| `AgentTeamHostActor` 已存在，当前只用于 Session recycle | `types/entities.ts` | 规则版本标记与 reminder 可使用 Host actor，需更新其注释所述用途 |
| 激活 Session 时的 Team context 以“内容与 Session 中最近一次可见版本相同则不注入”去重 | `member-context.ts` | I2 的 owner 角色块沿用该机制 |

## 1. 规则版本

新增 `team/rules-version-adopted`（Host actor，data 为 `{ version }`）。没有任何标记的 ledger 段为版本 1（现行规则）。每个改变既有 kind 校验规则的批次引入一个新版本：

| 版本 | 引入批次 | 改变的规则 |
| --- | --- | --- |
| 1 | 现状 | `@all` 展开、mention 自动 Attention、Human 邀请确认、Human-only resolution/promotion、顶层 `team/message-sent` |
| 2 | 02 | §2.3 中标注“v2”的条目；`team/message-sent` 停止写入 |
| 3 | 03 | §2.3 中标注“v3”的条目（accountable、Agent resolution、责任事件 marker、生命周期转交） |

- 每个 operation 按其 sequence 之前最近一条标记的版本校验；某版本禁止的 kind 出现在该版本段内即为非法 ledger。
- 写入时机：Host 挂载 ledger 时，若最新标记低于代码支持的版本，在任何其他新写入之前（包括启动恢复的生命周期 effect）追加一条；全新 ledger 在 `team/initialized` 后立即写入当前版本。版本只增不减，每个版本至多一条标记。
- 只新增 kind、不改变既有 kind 规则的批次（01 的改名、04 的 reminder）不需要新版本。

理由：replay 精确重算 inbox delta，任何改变既有 kind 期望 delta 的发布都会让旧记录在新代码下校验失败，除非 validator 知道记录写入时的规则。一条 durable 版本标记比在每条记录上加判别字段更集中，也让“规则从哪里开始改变”在 ledger 中可审计。各版本的旧规则集中为 replay-only validator，新写路径只调用当前版本。

## 2. Operation kinds

### 2.1 解码归一化（不新增 kind）

- ref：`channel:<id>` 解码为 `project:<id>`；ref 解析与正文 ref 识别永久接受 `channel:` 输入。
- 字段：`channelRef` 解码为 `projectRef`，`channel` 解码为 `project`。
- kind：`team/channel-created`、`team/channel-updated`、`team/channel-archived` 解码为 `team/project-created`、`team/project-updated`、`team/project-archived`，语义不变。
- Task：缺少 `accountable` 的记录解码为 `accountable = Human`；缺少 `sourceThreadRefs` 解码为空数组。
- 存储字节不改写；新写入使用新名称。幂等比较与 `assertSame*` 在归一化后的内存形式上进行。

### 2.2 新增 kinds

| kind | actor | data（要点） | 规则 |
| --- | --- | --- | --- |
| `team/rules-version-adopted` | Host | `version` | §1 |
| `team/project-owner-added` | Human | `projectRef`、`memberId`、Main stream activity、inbox delta | v2 起；目标为该 Project 所在 Workspace 的 enabled/suspended Agent participant；已是 owner 拒绝；新 owner 获得 Main stream marker |
| `team/project-owner-removed` | Human | `projectRef`、`memberId`、Main stream activity、transfer snapshot（§2.5）、inbox delta | v2 起；v3 起附带 transfer snapshot：被移除者负责的该 Project 内 open Task 全部转回 Human（E1） |
| `team/main-message-posted` | Human / Agent | `projectRef`、Message（`scope: 'main'`）、`mentions`、可选 `replyToMessageRef`、inbox delta | v2 起；actor 须为 Project member；owner 有 Main stream 未读时拒绝（`unread_required`）；无 `baseRevision`；被 mention 者与 `replyToMessageRef` 父消息作者得 Main stream marker；其他 owners 通过 §3.3 获得 ordinary unread |
| `team/main-stream-read` | Human / Agent | `projectRef`、`memberId`、`readThroughSequence`、inbox delta（消费 Main stream markers） | v2 起；owner 推进 watermark；非-owner 无 watermark，只消费 marker |
| `team/thread-started` | Human / Agent owner | `projectRef`、anchor Message、`mentions`、Thread、可选 Task（含 `accountable`、`sourceThreadRefs`）、inbox delta | v2 起，取代 `team/message-sent`；actor 须为 Project owner；creator 开始 Attention；被 mention 者只得 direct marker。v3 起 Task 才带 `accountable` 与 `sourceThreadRefs`（v2 写入的 Task 解码为 accountable = Human、来源为空）；`accountable` 不是 actor 时，accountable 得 activity marker 并开始 Attention |
| `team/task-accountable-changed` | Human / 当前 accountable | `baseRevision`、Task 快照、Task activity（新增 `kind: 'transfer'`，含 from/to）、Thread（revision 推进）、inbox delta | v3 起；目标为该 Project owner 或 Human；新 accountable 获得 activity marker 并开始 Attention |
| `team/reminder-raised` | Host | `taskRef`、`kind: 'review-backlog' \| 'stalled'`、`recipient`、`baselineSequence`、inbox delta | 04；`baselineSequence` 见 §2.6；episode key = `taskRef + kind + recipient + baselineSequence`，同 key 只出现一次 |

### 2.3 规则改变的既有 kinds

| kind | 变化（标注生效的规则版本） |
| --- | --- |
| `team/message-sent` | v2 起禁止写入 |
| `team/channel-member-added/removed` | 现状已不再写入，仅 replay（贡献 J2 的旧可见性） |
| `team/thread-replied` | v2：actor 须为 Project member（不再要求曾参与）；任何 Workspace participant 的 mention 与 `replyToMessageRef` 父消息作者都得到 direct marker；mention 与 `replyToMessageRef` 不开始或恢复 Attention；无 Human 确认流程；`@all` 不展开 |
| `team/thread-promoted` | v2：actor 可为 Human 或 Project owner；v3：Task 带 `accountable`（Agent owner promote 时默认自己，Human 不指定时为 Human），`sourceThreadRefs` 为空 |
| `team/claim-created` | v2：actor 须为 Project member（Agent）；creator 不是 owner 也允许 |
| `team/claim-done` / `team/claim-released` | v3：若跃迁使 Task 进入 `in_review` 或变为无人执行的未完成状态，inbox delta 为 accountable 增加 activity marker；accountable 曾持有该 Task 任一 Claim 且不是 Human 时，同时为 Human 增加 activity marker |
| `team/task-changed` | v3：accept：Human，或从未持有该 Task Claim 的 Agent Project owner；close / reopen：Human 或 accountable；reopen 为 accountable 增加 activity marker |
| `team/thread-attention-changed` | 仅作用于 Thread；Main stream 不接受 follow/unfollow |
| `team/member-workspace-left` / `team/member-archived` / `team/member-removed` | v2：release snapshot 增加 `ownerRemovals`，该 Member 在受影响 Project 的 owner 身份移除；v3：再附带 transfer snapshot（§2.5），其负责的 open Task 转回 Human。`team/member-suspended` 不变（E2） |

### 2.4 Message 与 Main stream 的实体形状

- `AgentTeamMessage` 增加 `scope: 'main' | 'thread'`；`scope: 'main'` 时没有 `threadRef`、`taskRef`、`topLevel`。旧记录解码为 `scope: 'thread'`。
- Main stream 没有 revision；它的时间线 = 该 Project 的 Main stream Messages ∪ Main stream activities（owner 变更）∪ v2 起 `team/thread-started` 的 anchor（讨论卡片与无来源 Task 卡片）∪ v1 顶层 Thread anchors（J3 卡片）。卡片是投影，Thread 本身的 facts 不进入 Main stream。
- `replyToMessageRef` 只能指向同一 scope：Main stream 消息只能回复 Main stream 消息，Thread 消息只能回复同一 Thread 的消息。
- Inbox delta 增加 `mainMarkers: { added, removed }`，独立的 marker 类型与 schema（`memberId`、`projectRef`、`messageRef` 或 `activityRef`、`sequence`），由独立 validator 校验 Message/activity 属于该 Project 的 Main stream；不复用要求 `threadRef` 的 Thread marker。

### 2.5 Transfer snapshot

转回 Human 的 Task 在 release snapshot 的既有字段中表达：`tasks` 带新的 `accountable`，`threads` 带推进后的 revision，`activities` 增加每个 Task 一条 `transfer` activity（from 原 accountable，to Human），`inbox` 带 Human 的 activity marker。`team/project-owner-removed` 携带同形的 snapshot。这样 replay 能逐条重算，不另建一类转交记录。

### 2.6 Reminder 的条件起点

- `review-backlog`：`baselineSequence` = 使 Task 进入当前 `in_review` 的 operation sequence。接收者为 Agent 时，条件为“该 Agent idle ≥ 30 分钟”；接收者为 Human 时（accountable 是 Human，或 accountable 无验收资格），Human 没有 idle 信号，条件改为“自 baseline 起 ≥ 30 分钟”。
- `stalled`：`baselineSequence` = 评估时 Task Thread 最新 fact 的 sequence 与各 active Claim 的 claim sequence 中的最大值。新的 Thread fact 或 Claim 改变 baseline，因此产生新的 episode。
- 两类条件的时间比较都使用评估时刻与 baseline operation 的 `occurredAt`，Agent idle 来自运行时 presence；presence 未知时跳过。

## 3. 投影

### 3.1 Project member

```text
Human：恒为 Project member（管理可见性），不经过下式。
Agent：
projectMembers(project) =
  legacyMemberships(project)                        // 旧 channel-member-added/removed 的净结果，不受下面的 Workspace 条件约束（复现现状）
  ∪ ( ( agentOwners(project)
        ∪ { m | m 在该 Project 任一 Message 的 mentions 中 }
        ∪ { m | m 在该 Project 写过 Message、持有过 Claim、或有过 Attention 观测 } )
      ∩ { m | m 当前参与该 Project 的 Workspace } )
再排除 archived / inactive 的 Member。
```

只读 index，replay 重建。v2 起写、认领、follow 都要求 actor 已是 Project member，因此第三项实际只为旧数据生效。v1 的 Agent mention 若未送达，不会产生 Attention，旧版本中不赋予可见性；新式中“mentions”项会让它可见，这是 v2 有意放宽的行为，因此 J2 与规则版本 2 同批上线。

### 3.2 Owner

- `owners(project) = {Human} ∪ agentOwners(project)`；Human 不存储，是不变量。
- `agentOwners` 由 `project-owner-added/removed` 与生命周期 operation 的 `ownerRemovals` 派生。
- `ownerSince(member, project)`：Agent 为其 `project-owner-added` 的 sequence；Human 为 `max(project 创建 sequence, 规则版本 2 标记的 sequence)`。

### 3.3 Main stream unread

- Main stream 时间线中可成为未读的 facts 只有三类：Main stream Message、Main stream activity（owner 变更）、v2 起 `team/thread-started` 创建的讨论 Thread anchor（讨论卡片即其渲染）。Task anchor 与 v1 顶层 Thread anchor 只渲染为卡片，不是未读 fact。
- owner：`ownerSince` 之后、`main-stream-read` watermark 之后的上述 facts，排除自己产生的；另加 Main stream markers。
- 非-owner：只有 Main stream markers。
- owner 被移除时其 Main stream unread 自然消失（不再是 owner），Main stream markers 保留。

### 3.4 Inbox 行与等级

Inbox 是一个函数，Human 与 Agent 共用：

| 行 | 来源 | direct 计数 | ordinary 计数 |
| --- | --- | --- | --- |
| Thread 行 | Attention unread + Thread direct / activity markers | markers | Attention unread |
| Main stream 行（每 Project 一行） | §3.3 | Main stream markers | owner 的 Main stream unread |

Human UI 以 direct（蓝点）/ ordinary（白点）渲染；Agent 的 `team_inbox` 渲染同样的两个计数。

### 3.5 Delivery class（运行时计算，不落盘）

对 Agent recipient 的每个未读 fact：

```text
Thread direct / activity marker、Main stream marker、reminder → immediate
Main stream ordinary（recipient 是 owner，含新讨论 Thread）  → immediate
Thread ordinary，recipient 是该 Project owner 或该 Task accountable → threshold
Thread ordinary，其余 follower                              → immediate
```

- threshold：按 `recipient × thread` 统计未投递的 ordinary 数，达到 5 时注入一次 bounded summary；不足 5 时随下一次 immediate notice 以摘要带出。
- “已摘要到哪个 sequence”是运行时状态（与现有 `covered` 签名同层）；Host 重启后同一批可能再摘要一次，符合 at-least-once。
- `covered` 签名纳入 delivery class 与 source kind，避免 threshold summary 与 immediate notice 互相覆盖。

### 3.6 Task board

```text
taskBoard(member, filter?) = 对 member 可见的每个 Project 的 open Task：
  status、accountable、active Claim owners、sourceThreadRefs、最近活动时刻、
  member 与它的关系（accountable / executor / project-owner / none）
filter：projectRef；mine（accountable 或 executor）
done/closed：每 Project 最近 5 条
```

Human 看板与 `team_task board` 读同一投影。`team_view` 的 `active task threads` 段删除。

### 3.7 Task 卡片位置（UI 与 tool 渲染共用）

- `sourceThreadRefs` 非空：每个来源 Thread 中、在 Task 创建 sequence 处一张卡片。
- `sourceThreadRefs` 为空：Main stream 中一张卡片。
- 卡片显示当前 status 与 accountable，不是 fact，不进入 unread。

## 4. Remote（Human Client）

| Remote | 说明 |
| --- | --- |
| `createProject` / `updateProject` / `archiveProject` | 原 Channel 三件套改名 |
| `addProjectOwner` / `removeProjectOwner` | 新增 |
| `postMainMessage` / `readMainStream` / `mainStreamHistory` | 新增；`readMainStream` 写 `main-stream-read` |
| `startThread` | 取代顶层 `sendMessage`；`kind: 'discussion' \| 'task'`，task 时可带 `accountable`、`sourceThreadRefs` |
| `reply` / `readThread` / `threadHistory` / `changeAttention` | 删除确认 token 参数与流程 |
| `changeTask` / `promoteThread` / `transferTask` | `transferTask` 新增 |
| `taskBoard` | 新增，取代 Client 从 feed 窗口推算 |
| `inbox` | 行增加 Main stream 行 |
| `changes` | scope 增加 Main stream |

Typert 由 declaration 重新生成。

## 5. Tools（仍为 7 个）

| tool | action | 变化 |
| --- | --- | --- |
| `team_view` | — | Project 行带 owners 与“我的角色”；删除 active task threads 段 |
| `team_inbox` | — | 增加 Main stream 行 |
| `team_thread` | `read` / `history` / `message` | 目标为 `threadRef` 或 `projectRef`（Main stream）二选一 |
| `team_attention` | `status` / `follow` / `unfollow` | 仅 Thread；status 只报告 following |
| `team_message` | `post` / `start` / `reply` | `post` 新增（Main stream）；`start` 带 `kind` 与 task 字段，仅 owner |
| `team_dm` | — | 不变 |
| `team_task` | `list` / `board` / `claim` / `done` / `release` / `accept` / `close` / `reopen` / `promote` / `transfer` | 取代 `team_claim`；权限见收敛议程 D1 补充表 |

新增拒绝码进入 `recovery-hints.ts`：`project_owner_required`、`accountable_owner_required`、`self_acceptance_forbidden`、`not_project_member`。

## 6. Agent context

- persona：整体改写（收敛议程 I1）。
- `member-context` 增加 owner 角色块：`You own these Projects: <name> <project:ref> (Workspace <id>)…`；可见 Project 数量；内容不变则不注入。
- Inbox notice：每条带 delivery、cause、scope、scoped role、source ref、读取入口。
- 新 core skill `team-domain-model`（收敛议程 I4）。

## 7. Replay 与测试必须覆盖的不变量

1. 规则版本标记单调递增、每版本至多一条，且早于该版本段内任何其他新写入；版本段内出现该版本禁止的 kind 即拒绝加载。
2. 同一旧 ledger 在新版本 replay 的投影，与旧版本的 Thread、Task、Claim、Attention、unread 完全一致；可见性按 J2 不减少。
3. Human 恒为每个 Project 的 owner；`project-owner-removed` 的目标不能是 Human。
4. 任何时刻 open Task 的 accountable 是该 Project 的当前 owner 或 Human。
5. Agent accept 时，该 Agent 在 `claimsByTask` 中没有任何 Claim（含 released）。
6. `sourceThreadRefs` 创建后不变，且每个 ref 属于同一 Project。
7. Main stream Message 不带 `threadRef`；Thread Message 必带。
8. `team/member-workspace-left`、`team/member-archived`、`team/member-removed`、`team/project-owner-removed` 之后，被影响 Member 不再是受影响 Project 的 owner，也不是其中任何 open Task 的 accountable；`team/member-suspended` 不改变两者。
9. 同一 episode key 的 `reminder-raised` 至多一条。
10. v2 起 mention 与 `replyToMessageRef` 不产生 Attention 变化。

## 8. 遗留的技术取舍（实施时确定，不改变产品行为）

- `AgentTeamMessage.scope` 与 Main stream marker 的具体字段名。
- threshold 摘要进度只放运行时，重启可能多摘要一次；若试用中发现重复明显，再改为 durable。
- 各规则版本 validator 的代码组织：旧版本集中为 replay-only 模块，新写路径只调用当前版本。
- `team_thread` 以 `projectRef` 读 Main stream 时，非-owner 的 `read` 等同于读取尾部一页并消费其 Main stream markers。
