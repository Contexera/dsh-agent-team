# inbox 写入门重设计 — 决策快照(草案,待 thread 收敛)

2026-10-14 @Reeve。依据:materials/evidence.md(全部结论有源码行号或 raft 出处)。

## 问题重述(human 的目标,不是「补文案」)

写入门现在的形态:**只有「主动 read」一条通道能证明「看过」**。这造成两类摩擦:

1. **48 次「没先读就被拒」**:其中一部分是模型确实没见过新消息(该挡),另一部分是新消息**已经通过 Team notice / DM 注入进了模型可见面**(direct mention 与 DM 注入的是正文,模型看到了内容;普通消息只注入计数),但 Host 的读位置没动 ⇒ 照样挡。每次挡都白付一次往返。
2. **13 例真竞态(stale_revision)**:读完拿到 token、写入前队友插话 ⇒ 乐观锁凭据作废。这**不是缺陷**,是乐观锁在正常工作;缺陷在于被拒后只回「过期了,自己去重读」,把「读新内容」这一步推回给模型,多一整个往返。

human 的两句话对应两个改动方向:①不一定非要 agent 先读,而是 harness 能说明「该消息已在 agent context 中」;②挡住之后结构化带回新消息。

## 核心设计判断:我们不搬 raft 的客户端账本

raft 的 SeenFrontier 之所以长在客户端,是因为它的 runtime 与 server 是两个进程,server 无法知道模型看到了什么。**我们的 Host 与成员 runtime 同进程**:session log、`surface.nodes`(当前模型可见面)、inbox 全在 Host 手边,且本仓 `member-context.ts` 与 Harness 自家 `tool-skill` 都已在用 surface 判可见性。

⇒ raft 六条规则里,我们按「已有物」重新满足,而不是照抄账本:

| raft 规则 | 我们的满足方式 |
|---|---|
| 1. per-target 不合并 | 天然:判定按 (memberId, threadRef) 查,不跨 thread |
| 2. 连续读推高水位 | 通道 A(现役 read)保留,仍是主通道 |
| 3. 单调向前 | `readThroughSequence` 现语义不变 |
| 4. 被动信号不算看过 | **按「不算*读*」而非「不算*看过*」重新解释,并按消息类型分流**:普通消息的 notice 只有计数没有正文(恰好就是 raft 说的那类)⇒ 不豁免;DM 与未截断 direct mention 是全文 ⇒ 进了可见面即「模型可见」 |
| 5. fail-closed | 无凭据 ⇒ 维持现在的挡 |
| 6. 按模型上下文划界 | **由 surface 语义免费得到**:compaction 后旧事件被 shadow、不在 `surface.nodes` ⇒ 自动不再作证;rollover 后新 session 的可见面只有 handoff + 之后的事件 ⇒ 同样自动失效。不需要 contextId 记账 |

### 关键取舍(这是和 raft 的本质分歧,要先讲清)

**raft 第 4 条「被动信号绝不推进」在我们这里不成立为「不算看过」,而是「不算*读*」。** 理由:

- raft 的「passive signal」指 wake hint / 通知列表这类**只有计数没有正文**的东西——模型从中看不到消息内容,当然不能作证。
- 我们的 Team notice / DM 分两类:**direct mention 与 DM 注入的是消息正文全文**(带每条 fact 的序列号与正文),**普通消息只注入一行计数**。前者一旦进了可见面,模型就**真的看到了内容**——这和「主动 read 后看到」在信息上等价。human 的第一句话说的正是这个:「harness 能说明该消息已在 agent context 中」。
- 但两者**不能等同**:read 有 inbox 语义(推进 readThroughSequence、清 direct marker、维护「你已 drain 此 thread」的 durable 事实),notice 只是被动展示。⇒ 设计保持两条通道语义分离:**只有 read 推进账本**;可见性只用于**豁免 unread_required 这一次挡**,不落账。

## 设计:写入门的三段判定(替换 `deferredThreadWrite` 的单一 unread 检查)

对一次带 `baseRevision` 的写(reply / claim mutation),按序:

1. **账本未读检查(通道 A,不变)**:`unreadFor` 为空 ⇒ 进第 3 步(revision 比对)。
2. **可见面豁免(通道 B,新增)**:未读非空时,Host 检查这些未读 fact 是否**每一条都已在该成员当前可见面上完整出现**。判定 = 该 member 的 `agent.session.surface.nodes` 对应事件集合中,存在覆盖全部未读 fact 序列号的本 plugin 事件,且每条 fact 的正文在该事件里**完整未截断**。**全中 ⇒ 豁免 unread_required,进第 3 步**(不推进 readThroughSequence,不消耗 marker——不落账);**缺任何一条 ⇒ 维持挡**,返回第 4 步的结构化结果。

   **判据按消息类型三类分流(Vera 验收口径,2026-10-14;代码依据 `index.ts:3809-3856` `notificationText` 与 `:3859-3862` `boundedNotificationBody`):**
   - **DM**:全文(`dmRelayText` 带完整 body)⇒ **可作证**,是通道 B 里最干净的一类。
   - **direct mention**:全文但经 8 KiB 截断,超出加「[Message body truncated…]」⇒ **可作证,但防截断**:判据是「正文完整出现」,被截的那条不中(它自己也提示了去 read,正好一致)。
   - **普通(非 direct)消息**:notice 里只有一行计数(`Thread X: N unread update(s) · newest at …`),**正文一个字都没有** ⇒ **结构上不可能中,不为它开口子**。
   - 另有 `notifications.slice(0, 8)`、`detailedFactCount >= 20` 两道粗截断 ⇒ 被这两道切掉的同样不中。
   - 此前的 `tool/result`(read)渲染过的,与 read 通道重叠,天然中。

   - **安全方向**:此通道只会把「现在挡」变成「现在放」,不会反过来;判据是「内容已在模型眼前」,不是「投递过」。
   - **上下文划界**:compaction/rollover 后旧事件不在 surface.nodes ⇒ 豁免自动失效,fail-closed 回「维持挡」。零新增状态。
3. **revision 比对(不变)**:`baseRevision !== thread.revision` ⇒ stale_revision。
4. **被拒时结构化带回(通道 C,新增,tool 渲染层)**:两处改法不同,分开(Vera 验收口径;现状 `ledger.ts:3620-3623` `unreadRequired` 已带 `revision`/`unreadCount`/`directCount` 只缺正文,`:3625-3629` `staleRevision` 只带 `expectedRevision`/`revision`):
   - **unread_required = 加正文**:渲染未读 fact(与 read 同形,标注 [unread]/[direct]),并显式写出「读完这些后,用 revision N 作为 baseRevision 重发」。revision 已有,只补正文。
   - **stale_revision = 加增量事实 + 当前 revision**:渲染 `(baseRevision, currentRevision]` 之间的增量 fact;当前 revision 已在 `revision` 字段,把它显式作为下次 baseRevision 写出。
   - **两步压一步**:模型在被拒的同一个 tool result 里就拿到了新内容和下次写入的正确凭据,不再需要单独一次 read 往返。这正是 13 例真竞态的修法(竞态无法消灭,但往返可以)。

### 显式不改的

- **read 的账本语义不变**:readThroughSequence、direct/activity marker、inbox 队列全部照旧。通道 B 不动账。
- **mention 直达语义不变**。
- **不引入幂等键**:raft 的 resume.idempotencyKey 解的是「held 之后同一条消息重发不重复」;我们的 baseRevision 已经是这把键(同一 revision 重发天然幂等,revision 变了就是新写)。通道 C 给的「当前 revision」即等价物。

## 预期收益(对应实测数据;Vera 2026-10-14 的 135 次 unread_required 分类探针)

Vera 把全部 `unread_required` 按「前一个 notice 带了什么」分类(read-only,脚本可重跑):

| 分类 | 次数 | 归属通道 |
|---|---|---|
| notice 带了 direct 正文 | 46 | 通道 B 可豁免 ⇒ 真省一次往返 |
| notice 只有计数 | 15 | 通道 B 结构上不中 ⇒ 只能靠通道 C 缩短 |
| 前面根本没有 notice | 74 | 通道 B 用不上 ⇒ 只能靠通道 C 缩短 |

⇒ **有 notice 在前的 61 次里,46 次(75%)正文确实到了可见面**,通道 B 是真收益;**接近一半(74/135)前面没有 notice**,那些是模型自己没读也没被通知,通道 B 对它们零帮助,只能靠通道 C 缩短往返。

- 13 例真竞态 ⇒ 通道 C 把「被拒→读→写」三步压成「被拒(拿到新内容+新凭据)→写」两步。
- 23 次真抛错不在本设计范围(那是参数/校验类,已由恢复提示注册表那四笔兜底)。

## 风险与未决(留给 thread 收敛)

1. ~~可见面判定的精度~~ **已收敛(2026-10-14 Vera 验收口径)**:正确形态是**按消息类型三类分流**,不是「摘要 vs 全文」整类判断——DM 全文可作证;direct mention 全文但防 8 KiB 截断;普通消息只有计数、结构上不豁免;两道粗截断(`slice(0,8)`、`detailedFactCount >= 20`)切掉的不中。判据与渲染口径已写入通道 B 判据节。
2. **surface 查询的成本**:写入门每写一次查一次。facts 序列号匹配需要先定义「本 plugin 事件覆盖了哪些 fact」的索引(可从事件 source 的 sections 携带 fact 序列号集合,避免解析正文)。**数域纪律(实现期最容易静默出错的一处)**:`surface.nodes` 里是 `SessionSeq`,而 `snapshotEvents` 吃的是 `SessionLogOffset`,两个数域靠「seq = log.length 的连续性契约」才对上(`member-context.ts:52-58` 注释专门写明)。通道 B 要按 fact 序列号匹配,正好踩在这个转换上;写错了不会抛异常,只会配错事件、静默放过或静默挡住。⇒ **实现必须复用 `member-context.ts` 的观测方式,继承其 SessionSeq/SessionLogOffset 数域纪律,不另造转换**。
3. **多 workspace / 多 session**:一个 member 只有一个 session,可见面判定天然 per-member,无此问题。
4. **human 提到的「可能揭示 inbox 模型设计缺陷」**:本设计把「看过」从「agent 读过」扩成「模型可见」,这正是对 inbox 模型的修正——「未读」的判官从「Host 账本单一记录」变成「账本 ∪ 可见面事实」。这个定性要写进最终架构文档。

## 验证计划(设计过审后)

- 单元:写入门三段判定的真值表(unread 空/可见面全中/可见面缺/ stale);通道 C 的渲染形状;compaction 后豁免失效的回归。
- 集成:模拟 Vera 的 13 例竞态时序,断言现在 0 次额外往返。
- 复测口径(**分通道计**,Vera 2026-10-14):48 次那类要能分出「通道 B 豁免了多少」「通道 C 缩短了多少」,否则说不清收益来自哪条;Vera 的分类探针改造成复测脚本。
