# 01 — 被拒时结构化带回(通道 C)

**What to build:** `team_message reply` / `team_claim` 的写被拒时,tool result 不再只给计数,而是把新内容直接渲染进来,并显式给出下次写入的正确 `baseRevision`——模型在被拒的同一个 tool result 里拿到新事实和凭据,不需要再单独调一次 `team_thread read`。两类分开:`unread_required` 渲染未读 fact 正文(revision 字段已有,只补正文);`stale_revision` 渲染 `(baseRevision, currentRevision]` 之间的增量 fact,并把当前 revision 显式作为下次 baseRevision 写出。
**Blocked by:** None — can start immediately
**Status:** complete — 落地见 `b36f249a`;门禁 1100 passed / 0 failed;Reeve review 通过

- [x] `unread_required` 的 tool result 渲染未读 fact(与 read 同形,标注 [unread]/[direct]),并写出「读完这些后,用 revision N 作为 baseRevision 重发」
- [x] `stale_revision` 的 tool result 渲染增量 fact + 当前 revision 作为下次 baseRevision
- [x] 单元:两类拒绝的渲染形状;渲染的 fact 集合与 read 同口径
- [x] 集成:模拟竞态时序(读到写之间队友插话),断言现在 0 次额外 read 往返
- [ ] 复测口径:能单独统计「通道 C 缩短了多少次往返」(与通道 B 的收益分开)
