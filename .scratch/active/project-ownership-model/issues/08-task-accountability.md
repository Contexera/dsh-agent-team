# 08 — Task 负责人、转交与验收限制

**What to build:** 每个 Task 有一个负责人：Agent owner 建的默认是自己，Human 建的可以在 owners 中选，不选就是 Human；可转交给本项目 owner 或 Human。没执行过该 Task 的 Agent owner 可以验收，执行过的不行，这时 Human 收到“需要你验收”。从讨论派生的 Task 记录不可变的来源，卡片显示在来源讨论里。必须动手的事立即通知负责人；Agent owner 离开、被归档或删除时，它负责的 Task 自动转回 Human。

**Blocked by:** 06（07 的 Human 看板收尾可并行，不阻塞本票）

**Status:** 已实施（最终规则版本 2，无 v3；开发中间 v2 账本不承担公开迁移承诺，见 [`materials/2026-10-25-final-v2-decisions.md`](../materials/2026-10-25-final-v2-decisions.md)）

- [x] Task 带 `accountable`（旧 Task 读为 Human）与 `sourceThreadRefs`；`team/task-accountable-changed` 与 `transfer` activity
- [x] 权限与拒绝码按 spec §4；Agent accept / close / reopen 在本票交付，accept 要求从未持有该 Task 任何 Claim（含已释放）
- [x] 责任事件按角色进入 Inbox direct 级并 immediate 投递，与 Attention 无关（activity marker 计入 direct；inbox-delivery 对 activity 事实一律 immediate）
- [x] owner 撤销、离开 Workspace、归档、删除在同一 operation 中把其负责的 open Task 转回 Human；Project 归档对全部 owner 生效；已结束 Task 不批量改写，reopen 前失效 accountable 须先转交
- [x] 看板 `relation: 'accountable'` 与 `needsAcceptance`；有来源的 Task 不进 Main stream；来源讨论 `threadHistory` 返回派生 Task 卡投影，Client 在讨论时间线按创建位置渲染
- [x] `team_task` 增加 `accept` / `close` / `reopen` / `transfer`，`team_message.start` 支持 accountable 与来源；persona 与 `team-domain-model` 同步
- [ ] suspend 时 UI 显示“负责人已暂停”（Host 保留 owner 与 accountable、通知等待恢复，仅缺界面提示；归入 09 批次一并交付）
- [ ] Agent 侧 `team_thread` 渲染来源讨论的派生 Task 卡（Host `threadHistory` 已返回 `taskCards`，工具 schema 未透出；归入 09 批次一并交付）
