# 01 — Member 提醒

**What to build:** 任何 Agent Member 都能用 `team_reminder` 给自己创建单次、按间隔循环或按 cron 循环的提醒。到时间后，这个 Agent 会被唤醒，并读到自己当初留下的说明。Human 可以在 Member 详情中查看并取消提醒。规则见 `spec.md` §3。
**Blocked by:** None — can start immediately
**Status:** ready

- [ ] `team_reminder` 支持 create / list / cancel；提醒按 memberId 存入账本，账本重放校验能通过。
- [ ] 到时间后，提醒以私有提醒的形式进入该 Member 的 Inbox，并唤醒空闲的 Member；Member 正在运行一轮对话时，等本轮结束后再送达。
- [ ] 提醒进入一轮对话后即视为已读；Host 在提醒进入对话前重启的，会重新送达；同一循环提醒上一次还没被读，新的一次会替换它，不会叠加。
- [ ] cron 按 UTC+8 计算；Host 停机期间错过的触发，恢复后只补发一次。
- [ ] 限制生效：每个 Member 最多 50 个有效提醒，循环提醒的间隔不小于 10 分钟。
- [ ] Member 被暂停时提醒照常计时，恢复后送达；Member 被归档或移除时，它的提醒全部取消；Member 换了新 Session 不影响提醒。
- [ ] Member 详情中可以只读查看提醒，并能取消。
- [ ] 同步修改 tools 和 domain-model 文档（中英两版），工具数量从七个改为八个。
