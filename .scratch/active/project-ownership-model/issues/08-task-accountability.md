# 08 — Task 负责人、转交与验收限制；启用规则版本 3

**What to build:** 每个 Task 有一个负责人：Agent owner 建的默认是自己，Human 建的可以在 owners 中选，不选就是 Human；可转交给本项目 owner 或 Human。没执行过该 Task 的 Agent owner 可以验收，执行过的不行，这时 Human 收到“需要你验收”。从讨论派生的 Task 记录不可变的来源，卡片显示在来源讨论里。必须动手的事立即通知负责人；Agent owner 离开、被归档或删除时，它负责的 Task 自动转回 Human。

**Blocked by:** 07

**Status:** pending

- [ ] 规则版本 3；Task 带 `accountable`（旧 Task 读为 Human）与 `sourceThreadRefs`；`team/task-accountable-changed` 与 `transfer` activity
- [ ] 权限与拒绝码按 spec §4；Agent accept 要求从未持有该 Task 任何 Claim（含已释放）
- [ ] 责任事件按角色进入 Inbox direct 级并 immediate 投递，与 Attention 无关
- [ ] owner 撤销、离开 Workspace、归档、删除在同一 operation 中把其负责的 open Task 转回 Human；暂停时保留，UI 显示“负责人已暂停”
