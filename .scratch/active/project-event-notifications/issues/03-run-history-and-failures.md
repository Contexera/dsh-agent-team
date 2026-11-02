# 03 — 运行记录、失败处理与更新

**What to build:** owner 能查看订阅最近的运行情况，能更新脚本、手动试运行。连续失败的订阅会自动暂停，并通知全部 owner。规则见 `spec.md` §4.2（第 6 条）、§4.6。
**Blocked by:** 02
**Status:** pending

- [ ] 每次运行都记录：触发方式、开始时间、耗时、退出码或超时、事件数、stdout 和 stderr 各自末尾 8 KiB。每个订阅保留最近 50 条，存在 Team 私有存储中，不写进账本，Host 重启后仍然保留。
- [ ] `team_subscription logs` 和 Remote 都能读取运行记录；非 owner 的 Project 成员也能读。
- [ ] 连续失败 3 次自动暂停，写入账本，并在 Main stream 通知全部 owner；`resume` 必须先试运行通过才能恢复。
- [ ] `update` 必须先试运行，并重新写入去重基线；revision 冲突时拒绝。
- [ ] `test` 只试运行、不发布事件，结果写进运行记录。
- [ ] 删除订阅时，一并删除它的运行记录。
