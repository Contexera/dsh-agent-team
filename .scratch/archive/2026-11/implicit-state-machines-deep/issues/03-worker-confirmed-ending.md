# 03 — Worker 停止只回报已落账的终态

**What to build:** Worker 进程已经结束但终态还没落账时，Web 和 Agent 都不能把它报成确认结束。Agent 可以用稳定拒绝码区分等待、写入失败和明确拒绝。
**Blocked by:** None — can start immediately
**Status:** complete

- [x] 已观察的终态等待落账仍有时限，不因重复停止而绕过确认或触发第二次写入。
- [x] 注入写入失败后，Agent 停止重试、Human 停止回执和 Thread/列表投影都不会报告确认结束。
- [x] Worker 工具输出保留结构化拒绝码；续跑回执明确区分回执时刻的执行状态和现在的状态。
