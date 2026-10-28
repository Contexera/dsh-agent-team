# Inbox、Project member 与责任驱动投递：本轮收敛草案

> 日期：2026-10-22。本文件记录本轮确认后的模型解释和待定细节。它补充 `2026-10-22-proposal.md`，不是当前实现契约。

## 1. 本轮已经确认的模型

### 1.1 Main stream

Main stream 独立于 Thread。它属于 Project，但没有 Task、Claim 或 Thread Attention。

- Project owner 可以发言和回复。
- Project member 可以查看 Project，也可以向 Project Main stream 发消息。
- Main stream 的消息会进入 Project owners 的通知路径；Project owners 收到消息正文或有界正文摘要，并允许在 idle 时开启 turn、在 running 时于 tool-call 空闲边界 steer。
- Main stream 消息不进入非-owner Project member 的 Inbox，也不唤醒或注入非-owner Project member。
- Main stream 普通消息不会自动创建 Thread；只有显式 Thread start 才创建 Discussion 或 Task Thread。

这里的“Project member”不是 Workspace 的全量 Member。Agent Member 只有在 Project 内被 durable mention 或被显式邀请进入该 Project 的协作面后，才获得 Project 可见性；获得后可以查看 Project 的 Main stream、Threads、Tasks 和公开 Activities。Human 是 Project 的管理者和默认最终裁决者。

### 1.2 Project member 与 Workspace participation

这两种关系必须分开：

```text
Workspace participation
    = 是否有资格进入这个 Workspace 的 Team 协作域

Project membership
    = 是否能看见并访问这个 Project

Thread participant
    = 是否被授予某个 Thread 的协作资格

Thread Attention
    = 是否接收该 Thread 的普通更新
```

推荐的 Project membership 派生规则：

1. Project owners 永远是 Project members。
2. Human 对所有 Project 具有管理可见性。
3. Workspace participant 被 Project 内的结构化 mention 命中后，成为该 Project member。
4. 被显式邀请进入 Project 内 Thread 的 Workspace participant，同时成为 Project member。
5. Project member 不因为 unfollow、Task 完成或 Thread 结束而退出 Project。
6. Member 离开 Workspace、被 archive 或被 remove 后，当前访问仍受生命周期状态限制；历史 Project membership 不删除。重新参与 Workspace 后，关系可以重新生效。
7. 旧 Message 的 mention recipient snapshot 不重算；旧历史由 replay 派生 Project visibility，不重新发送通知。

为兼容真实用户数据，建议旧 Channel 的显式 membership 在载入时作为 `legacy-channel-member` 的 Project visibility seed 保留。它只解决历史访问连续性，不再作为新 Project membership 的 live 写入口；新版本新增的 visibility 仍由 mention 和 invitation 派生。否则一个从未被点名、但实际长期使用旧 Channel 的 Agent 会在升级后突然失去 Project 访问。

Project membership 可以是 replay-derived index，不需要另建一份可被独立写入的“Project member 表”。它的输入是 ledger 中已冻结的 mention 和 invitation facts。这样不会产生第二个 Project authority。

### 1.3 Project message 与 Task Thread message

同一个 Agent Team 中存在两种不同的协作节奏：

| 场所 | 管理意图 | 普通消息的默认投递 |
| --- | --- | --- |
| Project Main stream | 让 Project owner 知道 Project 内发生了什么 | 所有 Project owner 直接收到并 wake/steer |
| Project Task/Discussion Thread | 让直接协作者推进局部工作 | 非-owner follower 直接收到并 wake/steer；owner/accountable owner 不因普通消息直接 wake |

Task Thread 的普通消息仍然会进入相关 Member 的 Inbox。区别在于 Inbox item 的投递政策：

- 非-owner follower：未读即允许即时 runtime delivery。
- Project owner：普通消息先留在 Inbox，不立即 delivery；后续用阈值兜底。
- accountable owner：普通消息先留在 Inbox，不立即 delivery；Task 状态变化、direct mention 和显式 invitation 仍立即 delivery。
- Claim executor：如果是非-owner follower，普通消息即时 delivery；如果同时是 Project owner 或 accountable owner，采用更保守的 owner/accountable policy。

“Owner 可以是 follower”是合法且有用的组合。典型路径是 Project owner 创建 Task Thread，并成为该 Thread 的 participant/follower；如果它也是该 Task 的 accountable owner，它仍然不因每条普通进展消息被 wake，但会因状态变化、direct mention 或达到 Inbox 阈值被 wake。

## 2. Inbox 是通知机制模型，不是 UI 列表

Inbox 的抽象不是“一个页面”，而是：

> Member 对 Agent Team 中尚未被处理的、带来源和投递政策的 durable collaboration notices 的集合。

它需要同时服务三个问题：

1. ledger 中有什么事实需要被某个 Member 看到；
2. 这个事实对该 Member 是普通更新、直接请求、责任变化还是状态事件；
3. Host 是否应该把它转换为 Agent context input。

建议把它拆成四层，不再让“有 Inbox”直接等价于“立刻唤醒”：

```text
Durable collaboration fact
        ↓
Inbox item projection
        ↓ 结合 recipient role 与 delivery policy
Notification eligibility
        ↓ 结合 Agent runtime 状态
followup / steer / no runtime delivery
```

### 2.1 Inbox item 的最小语义

每个 Inbox item 至少需要能回答：

| 字段 | 语义 |
| --- | --- |
| recipient | 哪个 Member 需要处理 |
| workspace | 哪个 Workspace 产生 |
| project | 哪个 Project 产生 |
| scope | Main stream、Thread 或 Task Thread |
| source kind | message、mention、invitation、claim、task-status、reminder |
| source ref | Message、Thread、Task、Claim 或 Activity ref |
| actor | 谁产生了事实 |
| recipient role | owner、accountable owner、follower、claim executor、direct target |
| unread state | 是否仍未被 Member 的 durable read 消费 |
| delivery class | immediate、threshold、pull-only |
| occurred sequence | ledger ordering authority |

`delivery class` 最好由当前 durable facts 和当前 recipient role 推导，而不是把运行时是否成功 steer 写回 ledger。Owner 被撤销、Task 转交、Member 状态变化后，同一个未读事实可能需要重新计算投递政策。

### 2.2 三类投递政策

#### `immediate`

表示事实需要即时进入 Agent context：

- Main stream message → Project owners；
- direct mention；
- explicit Thread invitation；
- Task status broadcast；
- Claim done / release 造成的责任变化；
- Task reopen；
- 需要 accountable owner 处理的明确状态事件。

Host 行为：

- Agent idle：以 followup / next-turn input 开启一次 turn；
- Agent running：以 steer 进入下一个安全 tool-call 边界，不中断当前 tool call；
- Agent 正处于 Session transition：不投给旧 generation，由 successor 从 durable Inbox 重新派生。

#### `threshold`

表示事实先留在 Inbox，达到条件后才进入 Agent context：

- Project owner 在 Task Thread 中收到的普通协作消息；
- accountable owner 在 Task Thread 中收到的普通协作消息；
- 其他不要求即时介入的普通更新。

达到阈值后，Host 注入一个 bounded summary，内容包括 Project、Thread、Task、消息数量、最早/最新 sequence 和读取入口，不默认把全部正文塞进 context。Agent 再调用 Team tools 读取完整事实。

阈值按 `recipient × project × thread` 计算比按整个 Agent 计算更安全。否则一个 Project 的五条无关消息会误触发另一个 Project 的责任人。默认值 5 或 10 仍待拍板；阈值是 delivery policy，不是业务状态。

#### `pull-only`

事实只保留在 Inbox，等待 Agent 主动调用 `team_inbox` 或被其他 immediate 事件带出。它适合低价值普通更新和不应打断工作的历史汇总。

第一版可以不使用大量 pull-only 场景，但必须保留这个抽象，否则未来所有通知都会退化成“每个 unread 都 wake”。

### 2.3 Inbox 与 wake 的关系

以下不变量需要写入模型：

- Inbox item 是事实已经进入 Member 责任面的证据，不是模型已经读取或处理的证据。
- runtime delivery 是 at-least-once attempt，不是 exactly-once model processing。
- delivery 失败不回滚 ledger operation；未读事实继续存在。
- 一个通知可以覆盖多个 Inbox item，但覆盖 identity 必须保留 source kind 和 source refs，不能只用“总共有 N 条 unread”。
- 运行中的 Agent 只能在 Harness 允许的安全边界 steer；Host 不中断正在执行的工具调用。
- Agent 不在场时，durable Inbox 不能丢；activation、resume、Session recycle 后必须重新计算 immediate 和已达到阈值的 threshold items。
- Agent 自己发送的 Message 不进入自己的普通 Inbox，除非它明确成为另一个需要自己处理的状态事件接收者。

## 3. Prompt 与 context 组合

Agent 需要知道整个模型，但不能把整个 ledger 或所有 Project facts 每次复制进 prompt。建议分三层：

### 3.1 稳定 Team contract：preset guidance

`team-member` preset 的稳定 guidance 应解释：

- Workspace participation、Project membership、Project owner、Thread participant、Attention、Claim executor、accountable owner 的区别；
- Main stream 与 Thread 的区别；
- Project owner 的普通更新节奏比直接执行者更安静；
- Inbox 是需要处理的事实集合，不等于已经读过；
- 被 wake 的通知只提供 bounded context，完整内容必须用 `team_view`、`team_inbox`、Main stream read 或 `team_thread` 读取；
- direct mention、invitation、Task status event 和普通消息的处理优先级不同；
- Agent 不能从正文、profile、handle 或通知来源推导额外权限；权限由 Host operation 校验；
- 需要在另一个 Workspace 工作时，先选择 Workspace 并读取该 checkout 的指令；
- 任务执行结果写入 Task Thread，状态变化由 Team facts 表达，不需要虚构 completion report；
- 收到责任事件后先读取当前状态，再决定是否 claim、reply、release、done 或请求 Human 决策。

### 3.2 动态 Member context：每个 eligible turn

每次 Team Member turn 的动态上下文只放当前事实的 bounded index：

- Member identity、当前参与的 Workspaces 和路径；
- 它在每个可见 Project 中是 owner 还是普通 Project member；
- 当前承担的 accountable Tasks 和 active Claims 的简表；
- 尚未读取的 immediate / threshold Inbox 摘要数量；
- 当前 turn 的 wake cause、Project、Thread/Task ref 和 source ref。

这不是第二份 facts store。它是 Host 从 ledger projection 和 runtime 状态构造的 context view；每次 turn 都可以重建。

### 3.3 Wake input：事件驱动的注入

Wake input 需要明确告诉模型“为什么现在收到它”：

```text
Team notification
  delivery: immediate | threshold
  cause: main-message | direct-mention | invitation | task-status | claim-change | inbox-threshold
  recipient-role: project-owner | accountable-owner | follower | claim-executor
  workspace: <workspace id>
  project: <project/channel ref>
  thread/task: <ref when present>
  source: <message/activity ref>
  summary: bounded text
  next action: read the named surface before mutating
```

Main stream 的 owner notification 和非-owner follower 的普通 Thread notification可以带有界正文，因为这两类消息本身就是即时协作输入。Task status event 以结构化状态、Task/Thread ref 和 source ref 为主，不复制完整 Task Thread。threshold notification 只带聚合摘要。

无论是否包含正文，通知都必须带稳定 source ref。模型要回答或执行动作时，使用 ref 重新读取 Host 当前 projection，而不是把通知正文当作最新状态。

## 4. Thread participant 的设计

### 4.1 participant 是协作资格，不是通知开关

建议引入一个由 ledger 记录的 Thread participant grant。它是唯一的 Thread 协作资格 authority；`everParticipatedFrom()` 不能继续作为新模型的权限判断。

一个 participant grant 至少包含：

```text
threadRef
project/channelRef
memberId
grantedBy
 reason: creator | follow | claim | accountable-owner | message-author
grantedAtSequence
```

初期不提供 participant revoke：

- unfollow 只停止普通更新，不撤销 participant；
- Workspace leave / Member archive / Member remove 通过外层当前授权状态阻止访问，但不删除历史 grant；
- Project/Channel archive 隐藏全部 surface；
- 未来如果出现误邀请或私有 Thread，再增加显式 revoke，不把 unfollow 变成 revoke 的兼容层。

### 4.2 哪些动作产生 participant grant

建议以下动作在同一个业务 operation 中携带 participant grant，确保 replay 只有一个权威输入：

1. Thread creator：创建 Thread 时授予自己 participant 和 Attention。
2. Member 自己执行 `team_attention follow`：同一 operation 授予 participant 和 Attention。
3. Claim created：Claim executor 自动获得 Task Thread participant 和 Attention。
4. accountable owner assignment：accountable owner 自动获得 Task Thread participant 和 Attention。
5. participant 发送 Thread Message：发送者必须已经是 participant；如果兼容旧行为允许 message author 自动加入，则 grant 必须随该 operation 一起落盘，而不是由读取时猜测。

mention 本身只保证 Project visibility 和 direct notification，不自动授予 Thread participant。这样可以表达：

```text
被 @ 到 → 能发现 Project，收到直接通知
主动 follow → 获得 Thread 协作资格和普通更新
```

被 mention 但尚未 participant 的 Agent 直接 reply 时，Host 返回 typed `thread_participation_required` rejection。结果指向当前 Thread，并要求先读取当前事实，再执行 `team_attention follow`，最后用新的 revision 重试。无需等待其他 Member invitation。

`unfollow` 只结束 Attention，不撤销 participant。已加入过 Thread 的 Member 之后仍可以 reply；再次 follow 只恢复普通更新。

## 5. `sourceThreadRefs` 与状态广播

本轮对 `sourceThreadRefs` 的解释需要调整：它不只是来源引用，也是 Task 状态需要回告的 discussion anchors。

### 5.1 Task status event

Task 的有效状态发生变化时，Host 产生一个结构化 Task status activity：

- `todo → in_progress`
- `in_progress → in_review`
- `in_review → done`
- `done → in_progress` 或其他 reopen 产生的状态变化
- `open → closed` / `closed → open` 对 UI 和责任面同样可观察

Claim 在同一状态下的重复变化不重复广播。例如 `in_progress` 下新增第二个 Claim，不再次产生 `todo → in_progress`。

Task 自己的 Thread 记录原始 Claim/Task Activity。每个仍可见的 `sourceThreadRef` 接收一个轻量的 Task status activity：

```text
Task status changed
Task: task:<id>
Transition: in_progress → in_review
Task Thread: thread:<id>
```

它不复制 Task Thread 的完成正文，也不制造另一份 Task 状态 authority。Host 只保存状态变化和引用，UI 与 Agent 通过 ref 重新读取 Task 当前投影。

### 5.2 多 Thread 原子性

一个状态变化可能影响多个 source Thread。推荐新增一个能够携带多个 target activity 的 operation，而不是循环调用现有单 Thread write：

```text
team/task-status-broadcast
  task snapshot
  status transition
  sourceThreadRefs
  target activities[]
  inbox delta[]
```

同一 operation 具备一个 ledger sequence；每个 target Thread 的 revision 都推进到该 sequence。这样：

- 状态变化和回告不会出现半数 source Thread 成功、半数失败；
- requestId retry 返回同一组 target activities；
- replay 可以验证每个 target 的旧 revision、Thread 所属 Project 和 recipient set；
- Client `changes()` 可以按涉及的 Thread/Project scopes 重新读取。

当前 ledger 的很多 operation 假设“一次只触碰一个 Thread”，这会是本重构的真实 Host seam，不能在 Client 层拼接多个操作。

### 5.3 source Thread 的边界

建议初版规则：

- `sourceThreadRefs` 第一版只能引用同一 Workspace、同一 Project 的 Thread；
- source Thread 归档后，保留 ref 和 Task 状态历史，但不再向已归档 surface 追加 activity；
- source Thread 不因为 Task 状态广播而自动重新打开；
- source Thread 的当前 followers 和 Project owners 接收 status activity；
- `sourceThreadRefs` 为空时，Task 仍有自己的 Thread，不产生额外广播；
- 同一个 Thread 出现在多个 source refs 中只产生一个 activity。

建议第一版把 `sourceThreadRefs` 限制在同一 Workspace、同一 Project。跨 Project 的来源会把一个 Project 的责任事件广播到另一套 owners 和 followers，授权、排序和归档语义都明显变复杂；如果确实需要，作为后续显式 cross-project reference 设计，而不是让普通 ref 默认跨 Project 广播。

这里“Thread owner”不作为新实体。接收者使用两个已有概念：该 Project 的 owners，以及该 Thread 的 current Attention followers。否则会再引入一个没有独立责任的 Thread owner 角色。

## 6. Accountable owner 与 follower

### 6.1 默认规则

- Agent Project owner 创建 Task：默认自己为 accountable owner，除非请求显式指定其他合法 owner。
- Human 创建 Task：请求可以显式指定 accountable owner；不指定时，Task 的 accountable owner 归 Human，表示默认由 Human 验收。
- accountable owner 自动成为 Task Thread participant/follower。
- Thread creator 自动成为 participant/follower。
- Claim executor 自动成为 participant/follower。

Accountable owner 是责任角色，不等同于“每条消息都要即时收到”。它的 ordinary Thread message delivery class 是 `threshold`；Task status、direct mention、invitation 和责任转移是 `immediate`。

### 6.2 验收资格

建议保留以下不变量：

- Human 可以验收任意 Task。
- Agent 只有在当前是 Project owner、且从未持有过该 Task 的 Claim 时，才可验收。
- accountable owner 不是自动验收资格；它必须同时满足 Project owner 且未执行过该 Task。
- Agent 只创建 Claim、随后 release，也视为持有过 Claim，不能通过 release 绕过自验禁止。
- Task reopen 不清除历史执行记录；新的 acceptance cycle 仍继承自验限制。

当前代码只允许 Human 做 Task resolution，因此 Agent owner 的验收能力是后续新 operation 和 replay authority 的变化，不是改一个表格就完成。

## 7. 仍需拍板的细节

本轮方向已经足够形成模型，但以下问题会改变 durable operation 或 delivery policy：

1. 新模型不再有 `@all` 特殊展开；显式 mention 命中的 Workspace participant 成为 Project member，但不自动成为 Thread participant。
2. 被 mention 的 Agent 是否可以直接回复 Thread；建议否，先成为 participant，除非明确保留现有“mention 即可回复”兼容规则。
3. Main stream 中 Owner 对 Owner 的消息是否也全部 immediate wake；用户确认“Project owner 收到所有消息并 wake/steer”，但这会保留 Owner 间互相礼貌回复的循环风险，需要决定是否接受模型约束，或只对非-owner 来源做硬性 immediate。
4. Owner/accountable ordinary message 的 threshold 默认值是 5 还是 10；建议默认 5，并按 `recipient × project × thread` 计数。
5. Main stream 的消息是否也需要自己的 durable read watermark operation；建议需要，不复用 Thread Attention。
6. Task status activity 的 source Thread 接收者是否就是“Project owners + source Thread followers”；建议是，不引入 Thread owner。
7. source Thread 已 closed 但未 archived 时，是否允许 Host-only status activity 写入；建议允许一种不改变普通 reply 权限的 Host activity，或明确禁止 closed source 并让 UI 仅从 Task 侧显示状态。
8. Project member 的第一次 membership 是否需要专门的 `project-visible` event；建议不需要，直接从 mention/invitation facts 派生。
9. 旧 Channel membership 是否作为兼容 visibility seed；建议保留为一次性 `legacy-channel-member` 来源，不恢复旧 membership 的新写入口。
10. “source Thread owner”是否指 Project owners，还是指 Thread creator；建议不新增 Thread owner，使用 source Project owners + current Attention followers。
