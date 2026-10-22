# 07 — Task board 投影与 `team_task`

**What to build:** Human 的项目看板、全局看板与 Agent 的 `team_task board` 读同一份 Host 投影，不再从已加载的消息窗口推算。`team_claim` 并入 `team_task`，工具总数仍为 7。本票不改变任何校验规则。

**Blocked by:** 06

**Status:** pending

- [ ] Task board 投影：可见项目的 open Task、状态、执行者、来源、我与它的关系，每项目已完成最近 5 条
- [ ] `team_task` 的 list / board / claim / done / release / accept / close / reopen / promote；`team_view` 的 active task threads 段删除
- [ ] 一个 30 条消息之前创建、无人触动的 `in_progress` Task 出现在看板进行中列
