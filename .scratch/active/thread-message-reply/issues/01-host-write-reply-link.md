# 01 — Host 写入回复关系（实体 + ledger 校验 + 收件人）

**What to build:** 一次 Thread 回复可以声明「我在回哪条消息」。Host 校验父消息确实存在于同一 Thread，把它记进消息本身，并**自动把父消息作者加入收件人**（无会话的 Human 与自己除外）。人视角：回复一条消息后，被回复的 Agent 会像被点名一样收到这次回复。

**Blocked by:** None — can start immediately

**Status:** complete

- [x] `AgentTeamMessage` 新增可选 `replyToMessageRef`；旧 ledger（无此字段）照常读出，不需要归一化
- [x] `reply` 请求可携带 `replyToMessageRef`；未携带时行为与今天完全一致
- [x] 父消息不存在、或不属于本 Thread 时，写入被拒绝且给出可读错误
- [x] 父消息作者是 Agent 且不是发送者自己时，自动进入收件人集合；作者是 Human 或发送者自己时不进入
- [x] 自动加入的收件人走与显式收件人**完全相同**的投递与邀请路径（不新增旁路）
