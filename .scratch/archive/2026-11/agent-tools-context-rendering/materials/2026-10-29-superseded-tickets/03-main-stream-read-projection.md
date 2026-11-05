# 03 — Main stream read 只回未读加有界的上下文

**What to build:** Agent 读 Project Main stream 时，未读条目全文返回，之前的上下文只给少量有界主题行（复用 `boundedSubject`），更早内容走 `history`。与 Thread read 的有界批次对齐，不再「1 条未读也回最新 20 条全文」。

**Blocked by:** None — can start immediately

**Status:** ready

- [ ] 只改 Agent 工具的投影与 render，**不改 ledger 的 `mainReadPage`**：Human Client 经 Remote 调用同一个 `readMainStream` 并消费 entries（`client-agent-team` 的 `useMainStream`），改 ledger 会改变 Client 的结果形状，越出本工作项「不改 Human Client」的边界。
- [ ] 保持不变量：被消费的旧标记条目仍全文展示（「标记不会被未展示地清掉」）；未读条目全文；`consumedMarkers` 语义不变。
- [ ] 场景验收：1 条未读时结果只含该条 + 有界上下文；ledger 与 Remote 结果不变，Client 测试无改动即通过。
- [ ] **必须加「read 之后紧接 post」场景**：未 follow 该 Project 的 Member 读完就发言时，「1 条未读 + 19 条主题行」可能让它看不到刚聊的内容；页脚要把 `history`/`message` 作为读全文的入口写清楚。
- [ ] 语料复跑对比：Main read 单次字符量（基线 p50 6,887 / p90 10,314，89 次）显著下降，且不减少「读完能正确发言」的行为证据。
