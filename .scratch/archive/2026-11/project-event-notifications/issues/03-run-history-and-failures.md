# 03 — 运行记录、失败处理与更新

**What to build:** owner 能查看订阅最近的运行情况，能更新脚本、手动试运行。连续失败的订阅会自动暂停，并通知全部 owner。规则见 `spec.md` §4.2（第 6 条）、§4.6。
**Blocked by:** 02
**Status:** complete

- [x] 每次运行都记录：触发方式、开始时间、耗时、退出码或超时、事件数、stdout 和 stderr 各自末尾 8 KiB，以及关联身份（subscriptionRevision、scriptHash、deliveryRef/runRef、attempt）和结构化错误类别。每个订阅保留最近 50 条，存在 Team 私有存储中，不写进账本，Host 重启后仍然保留；subprocess spill 副本的清理范围在执行器契约中规定。
- [x] `team_subscription logs` 和 Remote 都能读取运行记录；Human 和 owner 能看到 stdout、stderr，非 owner 的 Project 成员只能看到运行摘要（`spec.md` §4.6），并有测试覆盖。
- [x] 成功有唯一线性化点（输出被持久接受）：脚本 exit 0 但事件等待入队不算运行完成；`DSH_TEAM_LAST_SUCCESS_AT` 与连续失败计数使用同一概念。连续失败计数独立持久化，不用 50 条运行日志重建；测试覆盖“脚本成功但入队被阻塞”与“重试用尽”两种情况下计数和 last-success 的不同结果。
- [x] 连续失败 3 次自动暂停，写入账本，并在 Main stream 通知全部 owner（含 Human、已取消关注和暂停中的 owner）；`resume` 必须先试运行通过才能恢复，且只有 resume 提交成功才清零计数（试运行通过不清零）。只有定时和 webhook 运行计入失败次数，`test` 等试运行既不计入也不清零，并有测试覆盖。
- [x] `update` 必须先试运行，默认保留去重基线、不把试运行输出写入基线（避免吞掉两次轮询之间的新事件）；显式重新基线是独立动作；revision 冲突时拒绝。
- [x] 失败投递独立于运行记录：稳定 deliveryRef、最后错误、到期时间；工具提供 `replay`（deliveryRef + 版本选择：自动重试固定接收时版本，人工重放默认当前版本、可选原版本），重复重放按 requestId 幂等；运行记录淘汰后失败投递仍可查看。
- [x] `test` 只试运行、不发布事件、不改变去重基线，结果写进运行记录。
- [x] 删除订阅时，一并删除它的运行记录。
