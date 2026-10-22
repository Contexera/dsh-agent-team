# 03 — Task 责任：负责人、Agent 验收与任务看板

**What to build:** 每个 Task 有一个负责人：Agent owner 建的默认是自己，Human 建的可以在 owners 中选，不选就是 Human；负责人可以转交给本项目的 owner 或 Human。没有执行过这个 Task 的 Agent owner 可以验收它，执行过的不行，这时 Human 收到“需要你验收”。从讨论派生的 Task 记录不可变的来源，卡片显示在来源讨论里。必须动手的事（被指定、待验收、认领释放后没人接、重开）立即通知负责人，即使它没有 follow；其余状态变化只体现在任务看板上。Human 看板与 Agent 的 `team_task board` 读同一份 Host 投影。Agent owner 离开、被归档或删除时，它负责的 Task 自动转回 Human。

**Blocked by:** 02

**Status:** pending

- [ ] 首次挂载时追加 `team/rules-version-adopted`（版本 3）；claim-done/release 的责任 marker、Agent resolution、生命周期转交只作用于版本 3 之后的记录
- [ ] `team_claim` 并入 `team_task`（list / board / claim / done / release / accept / close / reopen / promote / transfer），工具总数仍为 7；各 action 的权限与拒绝码按 spec §4
- [ ] Task 带 `accountable`；旧 Task 读为 Human；任何时刻 open Task 的负责人都是该 Project 的当前 owner 或 Human
- [ ] Agent accept 要求该 Agent 从未持有该 Task 任何 Claim（含已释放）；违反时 `self_acceptance_forbidden`
- [ ] `sourceThreadRefs` 只在新建 Task 时写入、限同一 Project、之后不可改；卡片显示在每个来源 Thread 中；不向来源 Thread 写入任何事实
- [ ] 责任事件按角色进入 Inbox direct 级并 immediate 投递，与 Attention 无关；负责人无验收资格时 Human 同时收到“需要你验收”
- [ ] Task board 投影：可见 Project 的 open Task、状态、负责人、执行者、来源、我与它的关系，每 Project 已完成最近 5 条；`team_view` 的 active task threads 段删除；Human 项目看板四列与全局看板三列改读该投影，不受消息分页影响
- [ ] Owner 撤销、离开 Workspace、archive、remove 在同一 operation 中把其负责的 open Task 转回 Human 并留下 Activity；suspended 时保留，UI 显示“负责人已暂停”
- [ ] 一个 30 条消息之前创建、无人触动的 `in_progress` Task 出现在看板进行中列（防止回到“已加载窗口”口径）

## 验收方式

在真实项目上：从一段讨论派生两个 Task 并转交其中一个；执行过的 Agent owner 尝试验收被拒，Human 收到“需要你验收”；另一位未执行的 Agent owner 验收成功；撤销一个仍负责 Task 的 Agent owner，Task 回到 Human。Human 看板与 `team_task board` 内容一致。
