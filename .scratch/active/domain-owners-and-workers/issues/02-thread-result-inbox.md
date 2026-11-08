# 02 — 原 Thread 留结果，发起者收到 Inbox 通知

**What to build:** Project owner 可把一次 Worker 委派绑定到现有 Task 或讨论 Thread。Human 能在原 Thread 看见执行和终态；发起者在 Inbox 得到指向同一事实的通知。
**Blocked by:** 01 — 从成员 Session 派出 Codex Worker
**Status:** pending

- [ ] Task 和讨论 Thread 都能绑定；Host 从目标得出 Project 并校验 owner，拒绝不存在、相互矛盾或无权的目标。发起后归属不随当前页面、目录、成员 Session 或 Task 转派改变。
- [ ] 同一 owner 同时发起两个独立任务，一个成功一个失败，反序结束时各回正确 Thread。Thread 不依赖 owner 发帖，Inbox 提醒发起者；不再向父 Session 另发一份完整结果。
- [ ] Task 在运行期间关闭或被验收时，结果仍作为执行事实可查，Task 保持原状态；终态和通知不会因重复回调而重复。重启发现没有确认终态的记录时显示“结果未确认”，不自动重跑。
- [ ] Worker 输出中的指令或提及只按内容展示。Claim、accountable 和独立验收沿用现有规则；完成执行不自动验收，owner 的现有引导和 Team domain skill 说清责任。
- [ ] 浏览器实测 Thread 结果和 Inbox 去向，覆盖有 Task 与无 Task 的 Thread、失败、窄屏与普通 DSH 恢复。
