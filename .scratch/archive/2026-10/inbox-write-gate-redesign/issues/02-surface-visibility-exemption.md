# 02 — 可见面豁免(通道 B)

**What to build:** 写入门在 `unread_required` 之前加一段判定:未读非空时,Host 检查这些未读 fact 是否每一条都已在该成员**当前可见面**(`agent.session.surface.nodes`)上完整出现。全中 ⇒ 豁免 unread_required(不落账、不推进 readThroughSequence、不消耗 marker);缺任何一条 ⇒ 维持挡,走通道 C 的结构化拒绝。

判据按消息类型三类分流(依据 `packages/agent-team/src/index.ts:3809-3856` `notificationText` 与 `:3859-3862` `boundedNotificationBody`):DM 全文可作证;direct mention 全文但防 8 KiB 截断,被截的那条不中;普通(非 direct)消息只有一行计数,结构上不豁免;`notifications.slice(0,8)` 与 `detailedFactCount >= 20` 两道粗截断切掉的同样不中。此前的 `tool/result`(read)渲染过的与通道 A 重叠,天然中。

**Blocked by:** None — can start immediately(与 01 并行;01 只动 tool 渲染层,本票动 Host 写入门)
**Status:** complete — 落地见 `45e801b1`;门禁 1120 passed / 0 failed;三套测试各带变异验证;Reeve review 通过(issue 1 已修 `751b9ce7`,issue 2 记为已知边界)

- [x] 写入门新增可见面豁免判定,顺序在 `unreadFor` 之后、revision 比对之前;全中方豁免,否则维持现状
- [x] 三类分流判据正确:DM 全文中;direct mention 未截断中、被截不中;普通消息与两道粗截断切掉的不中
- [x] 豁免不落账:不推进 readThroughSequence、不消耗 direct/activity marker
- [x] 上下文划界:compaction/rollover 后旧事件不在 surface.nodes ⇒ 豁免自动失效,回退为维持挡(fail-closed)
- [x] 实现复用 `member-context.ts` 的观测方式,继承 SessionSeq/SessionLogOffset 数域纪律(seq = log.length 连续性契约),不另造转换——写错不抛异常、只静默配错事件,这是本票最易出错处
- [x] 单元:豁免真值表(unread 空 / 全中 / 缺一条 / 截断 / 普通消息 / compaction 后失效)
- [ ] 复测口径:能单独统计「通道 B 豁免了多少次 unread_required」(与通道 C 的收益分开)
