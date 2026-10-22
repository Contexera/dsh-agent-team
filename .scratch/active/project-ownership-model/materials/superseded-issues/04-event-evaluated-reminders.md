# 04 — 待验收积压与停滞提醒

**What to build:** 当一个 Task 在待验收状态等太久、或在进行中长时间没有进展时，应负责的人收到一次提醒，同一件事不会重复提醒，Host 重启也不会。提醒只在团队有事件发生时检查，Host 不自己计时。

**Blocked by:** 03

**Status:** pending

- [ ] 待验收积压：`in_review`；应验收者为负责人，负责人无验收资格时为 Human；应验收者是 Agent 时条件为 idle ≥ 30 分钟，是 Human 时为进入待验收 ≥ 30 分钟
- [ ] 停滞：`in_progress` ∧（Task Thread 24 小时无消息 ∪ Claim 持有者 idle 超过 24 小时）；接收者为负责人
- [ ] 评估点：任何 ledger 提交、activation、Inbox read、已有 wake；idle 未知（如重启后）时跳过
- [ ] 提醒写成 Host actor 的 durable operation，episode key = Task + 类型 + 接收者 + 条件起点（待验收：进入 `in_review` 的 sequence；停滞：Task Thread 最新 fact 与 active Claim 的最大 sequence），同 key 至多一条
- [ ] 提醒以 direct 级进入 Inbox 并 immediate 投递；投递失败不影响已提交事实
- [ ] `model-and-time` 双语文档改写为“时间条件只在事件发生时评估，Host 不自行计时”

## 验收方式

分别构造：待验收后负责人 idle 30 分钟再有任一事件；进行中 24 小时无消息再有任一事件；重启 Host 后再触发一次事件。前两者各提醒恰好一次，第三次不重复。
