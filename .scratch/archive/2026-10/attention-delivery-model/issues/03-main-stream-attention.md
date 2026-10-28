# 03 — Main stream 改由 Attention 决定普通未读

**What to build:** Main stream 与 Thread 使用同一套 Attention 语义：follow 某 Project 的 Main stream 后，别人的普通 Main 消息、新 discussion Thread 和 owner 变更都会作为普通未读到达；不 follow 则只有 @ 和回复到达。Agent Project owner 与普通 Agent Member 都能显式 follow/unfollow 自己的 Main stream；Human 的 Main stream Attention 随 Project 派生且强制存在。读取进度各自独立，不再由「是不是 owner」派生未读区间。

**Blocked by:** 01 — Thread 普通更新改由 Attention 决定是否立即唤醒（已完成）

**Status:** complete — 领域行为、持久化、唤醒和工具面已落地

- [x] Main stream 的普通未读由「该 Member 对该 Project Main stream 的 Attention + 读取水位」派生；`ownerSinceFrom` 身份区间与 `humanOwnerFloor` 不再参与普通未读判定
- [x] Agent Member 能 follow/unfollow Main stream，结果持久化、可重放、有读取水位；Human 的派生 Attention 不能 unfollow；未 follow 时 Main stream 的普通更新既不进 Inbox 也不唤醒
- [x] @、回复、Main stream direct marker 与责任 marker 仍独立于 Main stream Attention 到达，unfollow 不阻挡它们
- [x] 同一 Member 的 Thread Attention 与 Main stream Attention 是两个独立对象，互不影响，读取进度分别记录
- [x] `standing.owner` 字段改为 `following`；tool 的 Main stream 结果与 Client 的 Main stream 面板不再依赖身份派生未读
- [x] 既有账本上的未读 Main 工作不丢失；重放校验覆盖迁移后的持久表示
- [x] 测试覆盖 owner 与非 owner 在 follow / unfollow / 读取 / 唤醒上的对称结果

## 实施说明

- 新增 `AgentTeamMainAttention`（Member × Project）与 `AgentTeamMainAttentionKey`，是 Main stream 自己的行，**不**复用 Thread ref——给它一个合成 Thread ref 会把它塞进 Thread 索引。
- `AgentTeamInboxDelta` 新增可选 `mainAttention`（set/removed），与 `mainMarkers` 一样「仅在确有变化时出现」，因此旧记录保持存储字节不变。
- `mainUnreadFrom` 改为只认该读者自己的 Main attention 行；`mainStandingFrom` 的 `owner` 布尔换成 `following`。
- **Human 的 Main attention 是派生的，不存储**：`humanMainAttentionFrom` 从 Project 的 `createdAtSequence` 起算，只有读取水位（`humanMainWatermarks`）落库。这保住了「Human 身份恒定、不存储」的既有原则，也不必改 `team/project-created` 的存储形状。
- Agent 获得 owner 身份时，授权操作原子写入 `startMainAttention(memberId, projectRef, sequence)`——从授权点起算，不继承历史 backlog。
- 生命周期同步：`member-removed` / `member-archived` 收回 Main attention（原 `dropMainWatermarks` 改为 `dropMainAttention`）；`project-owner-removed` 与 `member-workspace-left` **不再**动 attention——撤回所有权不是 unfollow。
- 新 operation kind `team/main-attention-changed`：schema、重放校验、协议表、`changeScopesOf`、`touchedThreadRefs` 全部补齐。
- 踩过的两个坑，均已修正：
  1. `changeAttention` 内部再调 `changeMainAttention` 会自 `enqueue` 死锁；改为共享非重入的 `writeMainAttention`。
  2. unfollow 的 `removed` 一度按 `this.state` 快照判断，重放时投影不同导致校验失败；统一按「Human 派生 → 无行」判定。

## 留给 05 的部分

- `team_attention` 工具尚未接受 `projectRef`：其 schema、render 与 status 查询仍只覆盖 Thread 面。领域能力已就绪，工具面与文案归 05。
