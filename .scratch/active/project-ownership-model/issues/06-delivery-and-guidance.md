# 06 — 按责任投递、Inbox 与 Agent 指引；启用规则版本 2

**What to build:** 通知按责任走：主对话消息和新讨论立即通知其他 owners；owner / 负责人在 Thread 里收到的普通消息攒满 5 条才打断；点名和带回复链接的消息立即通知。收件箱每个项目一行主对话，蓝点 / 白点区分点名与普通。Agent 的 persona 与新的 `team-domain-model` skill 让 Agent 按这套规则行动。本票完成时启用规则版本 2，之后 Human 在 dev profile 试用一周。

**Blocked by:** 05

**Status:** pending

- [ ] 投递等级按 spec §7 运行时计算，threshold 按“每 Member × 每 Thread”计数；一组测试固定“不打断”的边界
- [ ] Inbox 主对话行；Human 收件箱蓝白点；`team_inbox` 同样计数
- [ ] Inbox notice 带 delivery、cause、scope、scoped role、source ref 与读取入口
- [ ] persona 整体改写；新增 core skill `team-domain-model`
- [ ] 挂载时写入规则版本 2 标记；旧记录照旧 replay
- [ ] 试用期内只调运行时参数（5 条阈值等）；需要改变已写入记录的校验规则时开新版本
