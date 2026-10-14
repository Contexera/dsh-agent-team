# 证据摘录(2026-10-14)

来源:@Vera 的账本统计与 raft 源码取证(Thread fact 23207 + DM 2026-10-14T11:02:37+08:00),以及 @Reeve 对 raft clone(/tmp/raft-source,已删)与本仓源码的复核。raft 许可证不允许搬代码,以下只记语义与出处。

## 1. 我们自己的实测数据(Vera,全账本 6 工作区 953 次 team 工具调用)

- 75 次摩擦(7.9%) = 48 次「没先读就被拒」(unread_required)+ 23 次真抛错 + 4 例其他。
- 连续报错只有 4 段、最长 2 次,无一段到 3 ⇒ **不会卡死**;但每次唤醒注定白付一次往返(48/75 = 64%,约 5 秒)。
- 19 例「照规矩先读仍被拒」中 13 例是真竞态:读完到写完之间队友插话,凭据(baseRevision)作废。Vera 逐条对过时序:队友发言落在读后 10 秒。
- 「报错不指路」那层已修完(10 种恢复提示全补 + 注册表 + 禁手写测试,四笔已推)。

## 2. raft 的 Freshness 门(出处:packages/server/src/routes/internalAgentApi.ts,约在 4662-4760 行段)

- 门从「这个 agent 读过吗」变成「**这个模型**看过吗」。服务端注释原话:
  > Durable legacy read-ish cursors cannot prove the model actually saw the messages; delivery ack state is volatile inbox state.
  ⇒ 服务端明确拒绝用投递确认/已读位置当证明;**只有 runtime 知道自己的模型看到了什么,只有它能作证**。
- 发送门计算:`latestFreshnessSeq`(会话内最新锚点)与 `attestedBoundarySeq = min(客户端凭据 seenUpToSeq, latestFreshnessSeq)`;中间的新消息数 > 0 且未 continueAnyway ⇒ hold。
- **挡住之后**(renderHeldResponse,约 4768 行起):返回 held 响应,内嵌 `heldMessages`(新消息正文,排除自己发的与 exact 已见的)、`newMessageCount`、`seenUpToSeq`、可省略带计数。SDK 侧转成 `interrupted` outcome:`interrupt.context`(给模型看的文本)+ `resume.idempotencyKey`(同一把键重发即过)+ 可选 `cancel.argv`。⇒ 「被拒 → 自己去读 → 再发」两步压成一步。
- **序号顺序不是提交顺序**(约 2430-2438 行服务端注释):持 seq 100 的事务可能在 101 之后提交 ⇒ 读位置只走**已安定的前缀**(settled prefix,按时间窗),新行照常返回但暂不算已读;延迟推进补齐。
- **读窗口必须与先前边界无缝接上**(`canAdvanceModelSeen`,约 2425-2427 行):latest/before 页安全条件是含最老行或与先前游标重叠;after 页安全条件是锚点 ≤ 先前游标。有 hidden gap 的读只记 exact、不推进高水位。

## 3. raft 客户端 SeenFrontier(packages/shared/src/agentOps/frontier.ts 文件头注释,FH-EXT-001 六条)

1. Per-target 永不合并:seq N 在 A 证明不了 B;thread 与其父是不同 target。
2. 只有无 `around` 的连续读能推高水位,且只能推到服务端算的边界(model_seen_up_to_seq);稀疏 drain(inbox.check)只记 exact。
3. 单调向前:回看更旧的消息不压低水位。
4. **被动信号绝不推进**——被叫醒的提示、通知、inbox 列表都不算「看过」。
5. 无 frontier ⇒ 省略见证 ⇒ 服务端挡住(fail-closed,丢状态安全)。
6. **按模型上下文划界**(RFC 072 §7.10):换会话或 compaction 后,旧上下文的记录不再作证;跨上下文是替换不是合并。contextId 由 daemon 写文件(spawn/resume/compaction 三种原因;resume 复用旧 id),CLI 只在 contextId 匹配时认账。

## 4. 本仓现状(Reeve 复核,行号为 2026-10-14 工作树)

### 4.1 写入门(Host 投影驱动)

- `packages/agent-team/src/ledger.ts:3713-3719` `deferredThreadWrite`:先 `unreadFor(actor, thread)` 非空 ⇒ `unread_required`;否则 `baseRevision !== thread.revision` ⇒ `stale_revision`。
- `unreadFor` 的「未读」判定(ledger.ts:3334-3349 `isUnreadFact`)= attention 的 `readThroughSequence` 之后的 follower-visible fact ∪ direct marker ∪ activity marker。**这是 Host 记的「读位置」,由模型的 read 调用推进,不是投递确认**——与 raft 拒绝的「volatile inbox state」不是同一物,但它仍然只覆盖「主动 read」一条通道。
- `prepareReadReceiptFrom`(ledger.ts:3234-3264):read 把 `readThroughSequence` 推进到本批已读的最高 sequence;direct marker 是稀疏确认,不进连续水位。

### 4.2 投递路径(Host 是 runtime 的宿主)

- Team Inbox notice:`index.ts:3652-3723` `notifyMember` — 从账本重导出 unread 摘要,作为 `UserMessage`(source.kind = `@wowyuarm/dsh-agent-team`, form='notice')`agent.steer()` / `agent.followup()` 注入。Host 日志自己写明「queued for the Member's next step, **not yet read by the model**」。
- DM:`index.ts:2289` 附近,同样形态的 `user/message`,header 为「Direct message from @…」。
- steer 语义(`packages/core/agent/src/runtime-types.ts:224-231`):steer 进 inbox.nextStep;step 被接受后,claimed 消息作为 `user/message` 事件**写入 session log 并进入可见面**(被 pre-step 拒绝则不进 log)。

### 4.3 「模型可见面」的 Host 侧观测(设计的关键支点)

- Harness `@deepseek-ai/dsh-session/surface`(packages/core/session/src/surface.ts):session log 是 append-only 真相源;**surface 是「产生 LLM 消息的事件的有序视图」**,`surface.nodes: readonly SessionSeq[]` = 当前模型可见事件。replacement(压缩摘要)shadow 被替换区间 ⇒ **被压缩掉的事件自动不在可见面上**。
- 已有先例一:`packages/agent-team/src/member-context.ts:52-63` — Team 自己已经用 `agent.session.surface.nodes` + `snapshotEvents` 查「某条自家消息当前是否在可见面上」。
- 已有先例二:`deepseek-harness/packages/skill/tool-skill/src/index.ts:362` — Harness 自家插件用 `new Set(agent.session.surface.nodes)` 判可见性。
- read 的 tool result 同样是可见面上的 `tool/result` 事件。

⇒ **raft 那句「只有 runtime 知道模型看到了什么」在我们的架构里不推出「必须客户端记账」**:raft 的 runtime(模型进程)与 server 分属两个进程,所以必须客户端记账上传递证;我们的 Host 与成员 runtime 同进程,session log / surface / inbox 全在 Host 手边,Host 就是「知道模型看到了什么」的那一层。
