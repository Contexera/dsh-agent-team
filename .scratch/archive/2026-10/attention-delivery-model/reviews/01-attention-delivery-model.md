# Review 01 — attention-delivery-model

**Conclusion:** Changes needed
**Work item:** attention-delivery-model
**Ticket:** Whole work item (tickets 01–05, all marked complete)
**Compared:** `6f2ca5a..HEAD` (`7558dfd`)
**Commits:** `7761537`, `f821206`, `51f58d8`, `8a27985`, `7558dfd`
**Reviewed:** 2026-10-28

三个独立评审轴（spec / correctness / standards）并行运行，候选发现经逐条复核后汇总。每条结论都有可复现的输入或代码路径支撑；不可复现的列入「未验证范围」。

## Findings

### blocker — Main stream 读取回放校验拒绝当前格式的记录，账本无法重开

**位置：** `packages/agent-team/src/ledger.ts:6292`（`repairLegacyMainStreamRead`），入口 `:6255`

**现象：** `prepareMainReadFrom` 只在读取真正推进 watermark 时才写 `inbox.mainAttention` 行。一次只消费 marker、不推进水位的 Agent 读取，存的是「只有 marker」的 inbox。`repairLegacyMainStreamRead` 无法把这条当前格式的记录与 Attention 之前的旧凭据区分开，于是给它补了一行 Attention；`validateOperation`（`:3212`）随后按当前格式重新推导出 `advances === false`，期待「只有 marker」的 inbox，两者不符，抛 `invalid Main stream read receipt`。构造函数会 replay 并 validate，因此之后每次启动 Host 都失败。

**复现（实测）：** Agent 在 follow 之前被 Human 在 Main stream @（seq 7）→ `team_attention projectRef follow`（start 8，readThrough 7）→ `team_thread read projectRef`（默认 readThrough = head 7）。读取提交成功（消费 1 个 marker，`advances=false`），随后 `new AgentTeamLedger(table, …)` 抛错。这条路径就是 `main-stream.spec.ts:376` 已经测过的「先被 mention、再 follow、再读」流程，只是那个测试没有重开账本。

**依据：** 修复回归本身。本工作项的验收缝 9 要求「重放校验覆盖迁移后的持久表示」；上一轮修复（`7558dfd`）解决了旧账本打不开，却让新写入的合法记录也打不开。

**最小修复：** 只在当前构建本该写出一行时才修——先算 `this.prepareMainReadFrom(projection, memberId, projectRef, readThroughSequence)`，`!prepared.advances` 时直接 `return operation`。这同时覆盖「readThrough 低于 Attention 起点」的旧部分读取。

---

### major — 非 owner 的 Main stream follower 永远收不到唤醒

**位置：** `packages/agent-team/src/ledger.ts:2708-2739`（`affectedMembersOf`）

**现象：** 普通 Main 工作的唤醒名单来自 Project owner（`:2731-2737`）、发送者和 Main marker。非 owner Member 的 `mainAttention` 行不出现在名单的任何来源里，而 `touchedThreadRefs` 对 `team/main-message-posted` 不返回 Thread。结果是 follower 的 `standing.unreadCount` 在涨，Host 却从未对它调用 `notifyMember`。

**复现（Host 级实测）：** 非 owner Member follow Project Main → Human 发一条 Main 消息，follower `unreadCount: 1`、唤醒调用 0 次；Human 开一个 discussion，`unreadCount: 2`、唤醒 0 次。反向同样断裂：follower 发言时 `affectedMembersOf` 只返回 `["member:f1"]`，Human owner 不在名单里（Human 的 Main 未读靠派生，本就不在 `projectOwnerIds` 中）。

**依据：** `docs/team-collaboration/attention-and-messaging.md` 声明 Main stream 普通更新对 Attention 覆盖的读者是 Immediate；`team_attention follow` 的 render 文案是 "Ordinary updates from there will interrupt you"。票据 03 的验收条件要求 owner 与非 owner 在 follow / unfollow / 读取 / **唤醒**上对称。

**最小修复：** 对每个追加 Main source 的操作（`team/main-message-posted`、discussion 形态的 `team/thread-started`、`team/project-owner-added/removed`），把该 Project 下持有 Main attention 行、且不是发送者的 Member 加入名单。**必须先做下一条 membership 门禁**，否则这会把 Main 内容投给非成员。

---

### major — Main stream Attention 的 follow/status 与 Main inbox 行没有 Project 成员门禁

**位置：** `packages/agent-team/src/ledger.ts:1756-1762`（`writeMainAttention`）、`:1861-1872`（`mainAttentionStatus`）、`:2014-2031`（`mainInboxItems`）、`:1400-1408`（`mainNotificationFacts`）

**现象：** `writeMainAttention` 只校验 Workspace（`assertActorForWorkspace` + `requireActiveProject`），而 `postMainMessage`、`readMainStream`、`mainStreamHistory` 都会调 `requireProjectMemberActor`。Thread 的 inbox 循环有成员门禁（`:1910`），Main 的循环没有。

**复现（实测）：** 一个参与 Workspace 但不属于该 Project 的 Member `changeAttention(projectRef, follow)` 成功提交。随后 `memberInbox` 返回一行 Main，`previewText` 是 Project 消息正文的首行（实测取到 `secret project talk`），而 `mainStreamHistory` 对同一个 Member 抛 `not_project_member`。也就是说：读全文被拒，摘要照样泄露。`team_attention projectRef` 让这成为模型的常规动作。

**依据：** DESIGN「参与与可见性仍由现有权限模型决定」；`docs/AGENTS.md`「Source and tests define implementation behavior」。

**最小修复：** `writeMainAttention` 与 `mainAttentionStatus` 加 `this.requireProjectMemberActor(actor, project.projectRef)`；`mainInboxItems` 与 `mainNotificationFacts` 镜像 Thread 循环的 `isProjectMember` 过滤。**重放校验保持在 `participatesInProjectWorkspaceFrom`**，否则后来被移除成员的历史 follow 无法重放。

---

### major — owner 授权覆盖已存在的 follow 行，静默清掉未读

**位置：** `packages/agent-team/src/ledger.ts:890-894`（写入）与 `:2925-2927`（校验）

**现象：** `team/project-owner-added` 无条件把 `startMainAttention(member, project, grantSeq)` 放进 delta，替换掉已有行，`readThroughSequence` 被压成 `grantSeq - 1`。

**复现（实测）：** Member follow Main（watermark 1）→ Human 发两条普通更新（unread 2）→ Human 授予 owner 身份，该 Member 的普通未读在没有读取的情况下归 0，存储行的 `readThroughSequence` 跳到授权点。这与「撤回 owner 保留这一行」的对称性相反，也与 `project-owners.spec.ts:107` 的注释「Attention 属于 Member 自己」相反。

**依据：** DESIGN「身份撤销不自动收回既有 Attention：此时持续关注可能已经成为 Member 自己的选择」。同一个问题在 Thread 侧不存在——`followAttention` 会拒绝重复建行。

**最小修复：** 仅在 `mainAttentionForFrom(projection, memberId, projectRef) === undefined` 时才铸授权行，并在 `validateOperation` 的 `grantedMainAttention` 镜像该条件。本构建已写出的账本含覆盖行为，因此校验需同时接受两种形状，或补一条修复。

---

### minor — Human 的 Main stream unfollow 提交成功但什么都不做

**位置：** `packages/agent-team/src/ledger.ts:1776-1790`、`:4684-4689`

**现象：** `humanMainAttentionFrom` 对存在的 Project 总是返回一行，所以 unfollow 分支写下 `removed: []` 并回一个 receipt、不带 `attention`。`mainAttentionStatus` 与 `standing.following` 仍为 true，普通未读继续流动。用新的 requestId 重复 unfollow 可以无限次提交；follow 则被「already following」拒绝。

**复现（实测）：** unfollow 提交成功 → 状态仍返回 `attention` → 第二次 unfollow 又提交成功 → follow 被拒。通过公开的 `@Remote('changeAttention')` 可达。派生形式满足「默认 follow」这一条（从 `createdAtSequence` 起算、重放确定），但让 unfollow 不可能，且账本报告成功而不是拒绝请求。

**最小修复：** 直接拒绝 Human 的 Main stream unfollow（派生注意力无法结束），或存一个显式 tombstone。当前 Web Client 与 Agent 工具都没有这条路径，属于潜伏缺陷。

---

### minor — 离开 Workspace 不再结束 Main stream Attention

**位置：** `packages/agent-team/src/ledger.ts:3839-3849`（apply 分支）

**现象：** `team/member-workspace-left` 删除 Project memberships 与 owners，但不碰 `mainAttention`。对比 `removeMemberThreadInboxFrom`（`:4590`）会清掉 Thread Attention 与 Main marker。旧代码在这里删 `mainWatermarks`。

**复现（实测）：** Member 在加入的 Workspace 里 follow Main → 离开 → 期间有新消息 → 重新加入，仍是 `following: true`，且离开期间的消息被算成未读。

**依据：** `docs/team-collaboration/attention-and-messaging.md:53`（中英同）声明「离开 Workspace、移除和归档会收回这一行，与 Thread Attention 相同」；票据 04 的实施说明同样写「member-workspace-left 同样收回」。代码与票据自己的说明不符，也与 Thread 侧不对称。归档同理（`team/project-archived` 的 `projectArchivalInboxFrom` 清 Thread Attention，不清 Main attention 行）。

**最小修复：** 要么在 apply 分支删掉该 Workspace 下各 Project 的 Main attention 行，要么改文档与票据说明。二者只能改一边；建议按 DESIGN「身份变化不动既有 Attention」的原则改文档——但 Thread 侧的不对称要一并说明。

---

### minor — 通知预算溢出的事实被标记为已覆盖，之后不再触发

**位置：** `packages/agent-team/src/index.ts:2810`（`beginInboxDelivery(plan)`）、`:2927`（`slice(0, 8)`）、`packages/agent-team/src/inbox-delivery.ts:49-55`

**现象：** 渲染仍有界（8 段 + 字符预算），但 `covered` 签名覆盖**全部**未读事实，包括文本里被省略的那些。threshold 档移除后，没有任何机制再把未渲染 Thread 的普通更新挡在 `covered` 之外（原先的 `recordedPlan` 会把未渲染 Thread 的 `summarizedThrough` 压住）。

**具体场景：** 一个 owner follow 了 9 个 Thread，各有 1 条普通更新；通知渲染 8 个、覆盖 9 个，于是被丢下的那个 Thread 的更新不会自己触发一次通知，除非之后有别的事实改变签名。

**依据：** 票据 01 验收条件「取消 threshold 不破坏有界合并」；票据 02「同一批未读不重复唤醒」与「唤醒失败能重试」两条都依赖 `covered` 语义准确。

**最小修复：** 从**实际渲染**的事实推导 `covered`，或让溢出的事实保持未覆盖。

---

### minor — `changeAttention` 同时收到两个 scope 时静默择一

**位置：** `packages/agent-team/src/ledger.ts:1713-1719`、`:6015-6029`

**现象：** 新请求同时带 `projectRef` 与 `threadRef` 时忽略 `threadRef`，follow Main stream。若该 requestId 下已提交过一次 Thread follow，同样的形状会被静默按存储的 Thread 结果应答（`projectRef` 被忽略），于是同一请求形状依提交历史表示两个不同 scope。

**依据：** 工具层拒绝两个 ref 同时出现，Host 层不拒绝；`Remote` 是公开入口。

**最小修复：** 在 fresh 与 replay 两条路径上，`projectRef` 与 `threadRef`/`taskRef` 同时出现即抛错。

---

### minor — 票据 05 的「自动 follow 说明来源」未实现，票据自身已记录

**位置：** `packages/tool-agent-team/src/index.ts:899`（`messageOutcome` 丢掉 Host 返回的 `attention`）；`AgentTeamMainAttention` / `AgentTeamThreadAttention` 都不存来源

**现象：** Agent 因 owner 授权、Claim、accountable 或 Thread 作者身份被自动 follow 时，没有任何工具结果告诉它「你现在关注了 X、为什么、普通更新会到达、如何 unfollow」。只有之后主动 `team_attention status` 才能看到状态。

**依据：** 票据 05 验收条件 2、票据 04 验收条件 7。票据 05 的「未做」一节确实记录了这一点，但验收条件仍勾选为完成。

**最小修复：** 要么把票据 05 条件 2、票据 04 条件 7 改回未完成并移到后续票据，要么给 Attention 行加来源字段。在拿到事实之前说明原因就是猜——当前「什么都不说」是可选方案里最不坏的，但勾选状态不反映事实。

---

### minor — 票据 02 条件 6 的失败重试没有测试支撑

**位置：** `packages/agent-team/tests/post-commit-delivery.spec.ts:152-208`

**现象：** 该测试名为「retries a failed wake over ordinary Thread unread alone…」，但从未设置 `state.fail = true`（只有 `:162` 的 `false`）；文件里唯一的失败用例（`:87`）走的是 mention。

**依据：** 票据 02 验收条件 6「唤醒失败后…测试锁定该重试路径」，以及提交 `f821206` 的标题本身做了同样声明。实现（`index.ts:3098` `dropInboxCoverage`）行为大概率正确，但标记为无 marker 的失败重试路径没有被验证，`dropInboxCoverage` 或触发条件回归时套件仍会全绿。

**最小修复：** 在该用例里注入一次投递失败，再断言下一次 durable 变化重新派生并重试。

---

### minor — 票据 05 的测试是整段逐字断言，且多个场景无测试

**位置：** `packages/tool-agent-team/tests/team-tools-render.spec.ts:212-237`

**现象：** 用 `expect(text).toBe(<整段字符串>)`。票据 05 实施说明写「测试断言语义…不断言整段逐字」，与事实相反。自动 follow 结果（条件 2）、active-Claim 拒绝（条件 4）、Main stream read 的 `Attention:` 行（`index.ts:626-628`）都没有测试。

**最小修复：** 改为断言关键子句；补齐三个缺失场景。

---

### minor — 显式 follow 的结果没说「更早内容仍可读取」

**位置：** `packages/tool-agent-team/src/index.ts:370-376`

**依据：** 票据 05 验收条件 3「显式 follow 成功说明从当前开始的普通更新会到达、更早内容可主动读取」。当前 render 只说前者。

---

### minor — active-Claim 拒绝 unfollow 时没有给出下一步

**位置：** `packages/agent-team/src/ledger.ts:1738`，抛出裸文本 `Member cannot unfollow while owning an active Claim`

**依据：** 票据 05 验收条件 4「说明需要先完成或释放 Claim」。原因说了，要求的动作没说。

---

### nit — `status` 查询用了变更措辞

**位置：** `packages/tool-agent-team/src/index.ts:370-372`，`status` 与 `unfollow` 共用同一句。对一个从未 follow 的流做 `status`，会说「Ordinary updates will no longer interrupt you… follow again to resume」，描述了一件没有发生的变化。

---

### nit — Main stream 通知的 role 文案把 follower 标成「被点名」

**位置：** `packages/agent-team/src/index.ts:2969-2972`；`packages/tool-agent-team/src/index.ts:445`（"an owner's unread and the mentions of every Member"）

**现象：** 非 owner follower 收到的是 "Project member named here"，而它并不是被 marker 点名进来的。

---

### nit — 文档仍教 owner 派生的 Main 未读与被移除的 threshold

**位置：** `docs/team-collaboration/tools.md:19` 与 `.zh.md:19`；`docs/architecture/tools-and-preset.md:66` 与 `.zh.md:70`（"including the owner threshold" /「含 owner 对 Thread 普通消息的阈值」）；`packages/agent-team/core-skills/team-domain-model/SKILL.md:44`、`:45`、`:72`；`cordis.patch.yml:58`、`:109`；`scripts/team-trial-metrics.ts:166`、`:176`、`:178`

**依据：** 工作项 README 的「正式文档出口」明确列出 `docs/architecture/tools-and-preset.*` 与 core skills；`AGENTS.md`「Update the affected maintained document… when a non-trivial change alters a public contract」。

**影响：** 出厂的 persona 与 core skill 让 Agent 认为要 @ owner「否则可能等」，并把 Main stream 投递描述成 owner 专属。`main_inbox` 被描述为「owner 普通未读 + marker」，而 `mainInboxItems` 返回的是任何 Attention 覆盖的未读。

---

### nit — 源码里残留 owner 派生的注释

**位置：** `packages/agent-team/src/ledger.ts:486`、`:1249`、`:1399`、`:478-479`、`:4896`；`packages/agent-team/src/types/entities.ts:406`；`packages/agent-team/src/types/requests-results.ts:467`、`:809`

**依据：** `AGENTS.md`「Comments explain only non-obvious constraints… they are not the sole definition of current behavior」。说反话的注释比没有注释更糟。`humanOwnerFloor` 的注释说它是「Human Main stream 未读最早能起算的位置」，而 `humanMainAttentionFrom` 已改用 `createdAtSequence`。

---

### nit — 遗留死代码

**位置与替代：**

- `ledger.ts:595` `mainWatermarkKey` 无调用者 → 由 `mainAttentionKey`（`:599`）替代，删除。
- `inbox-delivery.ts:16` `InboxScopeRole` 仍含 `'owner'`，但 `planInboxDelivery` 只产出 `'follower' | 'member'`（`:57`）→ `index.ts:2926` 的 `roleText.owner` 不可达，两处一并删。
- `inbox-delivery.ts:39`、`:57` `InboxThreadPlan.delivery` 恒为 `'immediate'` 且生产代码不再读（通知只渲染 `role`）→ 删除字段及 `tests/inbox-delivery.spec.ts:28,34,46` 的断言。`InboxDeliveryPlan.trigger` **不是**死代码，它是 `index.ts:2788` 的门禁。
- `ledger.ts:478-479`、`:3783`、`:4896-4903` `humanOwnerFloor` 被写入，唯一读者 `ownerSinceFrom` 的 Human 分支在唯一调用点（`:1993`）不可达 → `ownerSinceFrom` 只用于 Agent 的 relation 标签，改用 `isProjectOwnerFrom`，删掉 `ownerSinceFrom` 与 `humanOwnerFloor`。
- `ledger.ts:474-475` `mainAttentionByMember` 是重复索引，注释声称「per-reader Inbox derivation」，实际只被 apply 维护与 `dropMainAttention` 使用；扁平的 `mainAttention` 已能回答所有查询 → 删除，`dropMainAttention` 改为扫描 `mainAttention`。
- `ledger.ts:4667-4675` `followMainAttention` 与 `startMainAttention(memberId, projectRef, tail + 1)` 完全等价 → 合并为一个构造器。
- `ledger.ts:1760`、`:1791` `writeMainAttention` 的多余裸块 → 去掉大括号并反缩进。
- `inbox-delivery.ts:4-12` `type InboxDelivery = 'immediate'` 上的 8 行注释复述了已移除的 threshold 理由，且与 `:32` 的 `covered` 注释重复 → 删掉 `delivery` 字段后一并压缩。

**依据：** `AGENTS.md`「Keep one authoritative formatter/projection per domain concept. Do not add speculative registries, compatibility layers, fallback authorities, or duplicate stores」；全局规则「废弃的代码路径直接移除」。

---

### nit — 两个回放修复的结构重复

**位置：** `ledger.ts:6264-6301` 与 `:6303-6319`

同一套骨架（kind 判断 → `mainAttention !== undefined` → 重建只有 marker 的 delta → `isDeepStrictEqual` → 带行重建）重复了两遍。可抽一个 `repairEraMainAttention(inbox, markerList, row)`。纯结构性，未发现复制粘贴错误。

---

### nit — 架构文档缺一条等价的存储形状说明

**位置：** `docs/architecture/host-authority.md:14-15` 记录了可选的 `mainMarkers` delta 字段与 v2 操作类型，但没记录同样可选的 `mainAttention` 字段与 `team/main-attention-changed`。两者存储形状理由完全相同。

---

### nit — Client 的 `changeAttention` 类型声明落后于生成的 Remote

**位置：** `packages/client-agent-team/src/client/slots.ts:156`、`client/index.ts:255` 仍声明返回 `AgentTeamThreadAttentionResult`，而生成的 Remote 返回联合类型。因为注入对象是 `Record<string, unknown>` 所以类型检查通过，但声明的契约已过期。

---

### nit — `tools.md` 的 active-Claim 禁止语没有 Thread 限定

**位置：** `docs/team-collaboration/tools.md:59`（中 `:43`）说「active Claim 会拒绝 unfollow」，实际只对 Thread unfollow 成立（`ledger.ts:1738`）；Main stream unfollow 没有 Task，永远不会被拒。`attention-and-messaging.md:6` 已正确限定为 taskful Thread。两个文档只能对齐一边。

## 修复记录（2026-10-28）

评审后按严重度顺序修完了 blocker 与全部 major，以及报告中的 minor 与 nit 里属于代码或文档事实错误的部分。提交：`80a6e0d`（行为与测试）、`fde555a`（文档）、`f4c44d4`（CHANGELOG）。

| 发现 | 处理 |
| --- | --- |
| blocker：当前格式的 marker-only Main 读取被打不开 | 已修：只在当前构建本该写出一行时才补（`prepareMainReadFrom().advances`）。新增测试 `legacy-main-attention.spec.ts`「leaves a current-format read that consumed only markers alone」 |
| major：非 owner follower 收不到唤醒 | 已修：`affectedMembersOf` 改用 `mainStreamRecipientsFrom`，覆盖全部 Main attention 行 + 派生的 Human 行。新增测试「wakes the followers a Main stream commit reaches, and only those」 |
| major：Main stream 无 Project 成员门禁 | 已修：`writeMainAttention` / `mainAttentionStatus` 加 `requireProjectMemberActor`；`mainInboxItems` / `mainNotificationFacts` 镜像 Thread 循环的成员过滤（Human 豁免，与其派生身份一致）。新增测试「refuses a Main stream follow from a Workspace Member that is not in the Project」 |
| major：owner 授权覆盖已有 follow | 已修：仅在该 Member 尚未关注时才铸授权行；重放校验接受两种形状，并加一条内存修复还原被旧构建覆盖掉的已读水位。新增测试「leaves an existing follow alone when ownership is granted」与「restores the read progress an owner grant used to overwrite」 |
| minor：Human 的 Main stream unfollow 是空操作 | 已修：直接拒绝。新增测试「refuses a Main stream unfollow from the Human」 |
| minor：通知预算溢出的事实被标 covered | 已修：`InboxDeliveryPlan` 分出 `delivered`（实际渲染的事实）与 `signature`（全部事实）；`covered` 记 `delivered`，reminder 始终计入。新增 3 个单测 |
| minor：`changeAttention` 同时给两个 scope 静默择一 | 已修：Host 层拒绝。新增测试「refuses one request addressing both the Main stream and a Thread」 |
| minor：票据 05「自动 follow 说明来源」 | 已修（2026-10-28 追加）：给 Attention 行加 `source` 字段，六种来源 `thread-author` / `claim` / `accountable` / `project-owner` / `mention` / `self`；reopen 归入 `accountable`。存储上可选，重放校验不比较它 |
| minor：票据 02 条件 6 无失败重试测试 | 未做：需在该用例注入一次投递失败，属测试补强 |
| nit：`status` 用了变更措辞、Main role 文案、Client `changeAttention` 类型、`tools.md` 的 Claim 限定 | Client 类型已改为联合；`status` 措辞、Main role 文案、Claim 限定三处留待 `agent-tools-context-rendering` 统一呈现时一并处理（本工作项的呈现出口） |
| minor：active-Claim 拒绝无下一步 | 已修：错误文本带上 Task 与「先完成或释放 Claim」 |
| nit：`mainWatermarkKey`、`InboxScopeRole` 的 `'owner'`、`roleText.owner`、`humanOwnerFloor`、`ownerSinceFrom`、`mainAttentionByMember`、`followMainAttention`、`writeMainAttention` 裸块 | 已全部删除；`mainAttentionByMember` 删除时同步简化 `dropMainAttention` |
| nit：文档仍教 owner 派生未读与已移除的 threshold | 已修：`tools.*`、`tools-and-preset.*`、`domain-model.*`、`attention-and-messaging.*`、core skill、`cordis.patch.yml` 全部对齐；`host-authority.md` 补 `mainAttention` 与 `team/main-attention-changed` 的存储形状说明 |
| nit：离开 Workspace / 归档 Project 是否收回 Main attention 行 | 改文档而非改代码：基线构建在这里本来就不回收（只删 `mainWatermarks`），按 `docs/AGENTS.md`「prose 与 code 冲突时修文档」处理 |
| nit：`status` 用了变更措辞、Main stream role 文案、Client `changeAttention` 类型、`tools.md` 的 Claim 限定 | Client 类型已改为联合；`status` 措辞、Main role 文案、Claim 限定三处留待 `agent-tools-context-rendering` 统一呈现时一并处理（本工作项的呈现出口） |

## 追加修复（2026-10-28 晚，来源字段）

第一轮修完后做了 source 字段（`23ed8ee`、`0a19c52`），又跑一轮只读评审，发现三个 blocker，已修（`3fb6bed`、`8a23163`）：

1. **类型检查其实没过**：`withDefault` 的联合类型映射推成联合数组，赋不回 `readonly AgentTeamThreadAttention[]`。我第一轮用 `grep -c "error TS"` 数到 0，是因为错误以 `TypertAnalysisError` 形式从 typert 生成器抛出，不是 `tsc` 行——度量方式错了，不是检查过了。**教训：`npm run typecheck` 要看退出码和完整输出，不能 grep 计数。**
2. **`team_task` 输出 schema 没声明 `source`**，而 `execute` 返回它，`additionalProperties: false` 直接抛 `ToolOutputError`——正好打在这个功能要覆盖的 claim 路径上。被 `member-lifecycle-core.spec.ts` 的真实集成测试抓住。渲染测试抓不到，因为 `renderText` 绕过 schema 校验。
3. **旧账本打不开**：三个校验器（owner grant / claim / task-changed）仍完整比较 source，而 `repairLegacyAttentionSource` 只补一个笼统默认值。

第 3 条的修法改变了设计：不再「按规则版本猜默认值 + 校验时剥掉 source」，改成**从 operation 种类推导真实 source**（grant → `project-owner`，claim → `claim`，thread-started → `thread-author`，transfer/reopen → `accountable`）。这样校验可以保持严格，`sourcelessDelta` 和 `withSource` 两个补丁全部删除——它们一个是过度放行，一个是与 repair 不一致的第二套默认值。

评审还指出 v1 段不全是 mention（v1 也能显式 follow 和 claim），这正是「按版本猜」错的根源；改成按 operation 推导后这个问题自然消失。

## 修复后的验证

全量 `npx vitest run`：121 files passed / 1 skipped，**1404 tests passed / 1 skipped**（评审前 1394）。`typecheck`、`check:docs`、`check:comments`、`check:boundaries`、`check:core-skills` 全部通过；`git diff --check HEAD` 干净。

每条修复都做了消融验证：临时改回旧行为，对应用例转红，再恢复。其中 `followMainAttention` 与 `startMainAttention` 合并时引入过一次锚点差一错误（follow 锚在 `tail + 1`，授权锚在 `sequence`），被 `main-stream.spec.ts` 立即抓住。

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| 01.1 投递只看 Attention，`owns` 移除 | Met | `inbox-delivery.ts` 无 `owns`；`inbox-delivery.spec.ts:18-31` |
| 01.2 follow 后 1 条即唤醒；不 follow 无未读/唤醒 | Partial | 判定与推导正确；**非 owner follower 的唤醒断裂**（finding 2） |
| 01.3 未读推导与投递判定同一事实 | Met | `notificationFacts` → `unreadFor` → plan |
| 01.4 @ / reply / 责任 / reminder 不变 | Met | `isUnreadFact` marker 分支；实测 Thread 与 Main reply 到达非 follower |
| 01.5 threshold 常量/触发/owner 文案消失 | Met | 无 `INBOX_THRESHOLD_UPDATES` / `summarizedThrough` / `Delivery:` 残留 |
| 01.6 有界合并保持 | Partial | 8 段 / 20 详情 / 字符预算仍在，但溢出事实被标 covered（finding 8） |
| 01.7 文档 + core skill + CHANGELOG 同步 | Partial | 主文档已同步；`tools-and-preset.*`、core skill、`cordis.patch.yml` 仍教旧规则 |
| 02.1 资格只由 durable 事实决定 | Met | `InboxDeliveryInput` 无计数器 |
| 02.2 无悬空引用；typecheck | Met | grep 干净；`tsc` 干净 |
| 02.3 旧结构读写回滚全删 | Met | `InboxNoticeDelivery` 只剩 `covered` / `attempt` |
| 02.4 测试重写而非清空 | Met | `inbox-delivery.spec.ts` 已重写 |
| 02.5 `covered` 单独去重并有测试 | Met | 三个去重用例 |
| 02.6 无 marker 的失败重试有测试 | Partial | 实现正确，命名测试从未注入失败 |
| 02.7 `dropInboxCoverage` 语义复核 | Met | 清 `covered`、留 `attempt` |
| 03.1 Main 未读来自 Attention + 水位 | Met | `mainUnreadFrom`（`:4927`）只用 `mainAttentionForFrom` |
| 03.2 任何 Member 可 follow/unfollow，持久可重放 | Partial | 持久化与重放成立；**缺少成员门禁**（finding 3） |
| 03.3 @ / reply / marker 独立于 Main Attention | Met | 实测 Main reply 给非 follower `directCount:1, following:false` |
| 03.4 Thread 与 Main Attention 互相独立 | Met | 两套投影状态，读取互不干扰 |
| 03.5 `standing.owner` → `following` | Met | 类型、schema、Client fixture 均已改 |
| 03.6 既有账本未读不丢；重放覆盖迁移 | Partial | `legacy-main-attention.spec.ts` 覆盖旧形状；**新写入的 marker-only 读取被打不开**（finding 1） |
| 03.7 owner 与非 owner 对称（含唤醒） | Partial | follow/unfollow/read/standing 已断言；唤醒未断言且实际断裂 |
| 04.1 Human 建 Project 与 Agent 授权原子建立默认关注 | Met（派生） | Human 由 `createdAtSequence` 派生；Agent 授权写一行 |
| 04.2 不批量订阅 Thread | Met | 授权测试断言恰好一行、无 Thread 行 |
| 04.3 作者/accountable/Claim 自动 follow 规则保持 | Met | 相关代码路径未动；套件绿 |
| 04.4 撤销 owner 保留 Attention | Met | `project-owners.spec.ts` |
| 04.5 被撤销 owner 继续收到直到 unfollow | Met | `project-owners.spec.ts` 第二例 |
| 04.6 迁移既有账本保持未读连续 | Met | `legacy-main-attention.spec.ts` |
| 04.7 默认关注来源可在工具结果说明 | Missing | 无来源字段、无渲染（票据自身已记录） |
| 05.1 persona / core skill 稳定规则 | Met | `cordis.patch.yml:97`；skill 覆盖 follow 语义 |
| 05.2 自动 follow 结果说明对象/来源/到达/unfollow | Missing | 无工具结果承载 |
| 05.3 显式 follow/unfollow 语义完整 | Partial | 后果已说；「更早内容可读」缺失 |
| 05.4 active-Claim 拒绝说明后续动作 | Partial | 只有裸原因 |
| 05.5 读取行说明关注状态与后果 | Partial | Main 有 `Attention:` 行；Thread 行 following 时无后果；「mention 不等于 follow」只是隐含 |
| 05.6 呈现预算遵循统一机制 | Not verified | 相邻工作项未建，票据已声明延后 |
| 05.7 每场景有测试且断言语义 | Partial | 整段逐字 `toBe`；三个场景无测试 |
| 缝 1 普通投递与 owner 无关 | Met | `planInboxDelivery` 无身份输入 |
| 缝 2 Main 对称 follow/unfollow | Partial | Agent 侧成立；Human 侧 unfollow 是空操作 |
| 缝 3 授权只建 Main，不建 Thread | Met | 授权测试 |
| 缝 4 unfollow 后 @/reply/责任/reminder 仍到达 | Met | 实测 Thread 与 Main reply；reminder 测试 |
| 缝 5 active Claim 禁止 unfollow | Met（Thread） | `ledger.ts:1738`；Main stream 无此约束（文档需对齐） |
| 缝 6 身份撤销不隐式删 Attention | Met | `project-owner-removed` apply |
| 缝 7 Host 投递仍有界 | Partial | 渲染有界；覆盖语义外溢（finding 8） |
| 缝 8 Agent 指导与领域语义一致 | Partial | 自动 follow 说明缺失 |
| 缝 9 持久化与重放保留关注与连续性 | Partial | 旧账本成立；当前格式的 marker-only 读取失败 |

## Checks run

| Command or check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| `npx vitest run`（全量） | 121 files passed / 1 skipped，1394 tests passed / 1 skipped |
| `npm run check:docs` | OK：28 maintained documents、28 双语对、356 links resolved、56 files inside ceiling |
| `npm run check:comments` | OK：agent-team 2311/4150、tool-agent-team 96/280、scripts 1365/2800 |
| `npm run check:boundaries` | OK：106 files in 3 packages |
| `git diff --check HEAD` | Clean（无空白错误） |
| 实测探针：非 owner follower 唤醒 | Fail——Human 发言后 follower `unreadCount: 1`，`affectedMembersOf` 为 `[]` |
| 实测探针：follower 发言唤醒 Human | Fail——`affectedMembersOf` 为 `["member:f1"]`，Human 不在内 |
| 实测探针：非成员 follow Main stream | Fail——提交成功，`memberInbox` 返回 `previewText: "secret project talk"`，`readMainStream` 同时抛 `not_project_member` |
| 实测探针：marker-only Main 读取后重开账本 | Fail——`invalid Main stream read receipt` |
| 实测探针：Human unfollow Main stream | Fail——提交成功，`following` 仍为 true，可重复提交 |
| 实测探针：授权覆盖已有 follow | Fail——未读从 2 静默归 0 |
| 实测探针：离开 Workspace 后重开 | Fail——仍 `following: true`，离开期间消息计为未读 |
| 提交信息规范 | Pass——5 条均为单行 Conventional Commits，无 body |

全量测试套件在这些缺陷下仍然全绿：上述每一条都需要一个当前不存在的断言才能暴露。

## Unverified scope and residual risk

- **`4fba0a1` 与 `10a0aa4`**（同一 patch 应用了两次，discussion panel 恢复）不在本工作项范围内，未评审，仅记录为范围外。
- **Human 在 dev profile 的实际体感**：自动化无法验证，仍是工作项唯一未勾选的完成条件。finding 1 会直接阻断 Host 启动，因此这项试用当前不可能进行。
- **`npm run test:browser`** 未运行。范围内没有提交改变 Web bundle 组装、Client 加载、slot 接管或可见 UI（唯一的 client 改动是 `51f58d8` 里一个测试 fixture 的字段改名），因此按 `AGENTS.md` 的「narrowest applicable check」选择不跑。
- **票据 05 条件 6（统一呈现机制）** 无法在此评审：相邻工作项 `agent-tools-context-rendering` 尚未建立。
- `humanOwnerFloor` 不再参与未读判定后，未能量化出行为差异：v2 的 Main source 只存在于版本采纳之后，构造不出让它产生区别的输入。
- finding 1 的修复方向（按当前构建的推导结果决定是否修）尚未验证；它是一种推测的最小改法，需要一次实现加测试才能确认。

## Review record

- Spec sources: `.scratch/active/attention-delivery-model/README.md`、`DESIGN.md`（§已确认的目标模型、§默认 Attention、§unfollow 的边界、§Main stream 纳入同一体系、§迁移原则、§验收测试缝）、`issues/01`–`05` 全部验收条件
- Standards sources: `AGENTS.md`（Architecture guardrails、Code and documentation conventions）、`docs/AGENTS.md`、`docs/development/start-and-checks.md`（check:comments 预算与引用规则）
- Uncommitted and untracked changes included: 无。工作树在 `7558dfd` 上干净；评审过程中产生的探针测试文件已删除，`git status --short` 为空。
