# 07 — Session fold 增量与 pressure notice 状态

> 已归档：本票未实施，续作见 [session-fold-incremental](../../session-fold-incremental/README.md)。

**What to build:** `context-management` 与 clock context 用 Session event cursor 取代每次事件的全量 `ownEvents()` fold；pressure notice「是否已送达」改成增量 Session 状态；progress-nudge reconcile 按受影响 Member 合并批次。
**Blocked by:** None — can start immediately
**Status:** ready

- [ ] 真实会话（133,596 事件、其中非流式 19,534）上一次 fold 的绝对量下降；一个回合连折 10 次的开销从 ≈43 ms 降到与事件数基本无关
- [ ] **验收输入必须是真实会话日志**：合成形状会低报（合成 0.12 ms vs 真实 0.19 ms/次），不能拿合成数据当证据
- [ ] boundary、pressure、progress 语义不变；rollover / compact / 恢复路径行为不变
- [ ] 变动只影响 Session 侧投影，不触碰 ledger 权威与记录级校验
