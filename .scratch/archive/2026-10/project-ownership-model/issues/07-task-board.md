# 07 — Task board 投影与 `team_task`

**What to build:** Human 的项目看板、全局看板与 Agent 的 `team_task board` 读同一份 Host 投影，不再从已加载的消息窗口推算。`team_claim` 并入 `team_task`，工具总数仍为 7。本票不改变任何校验规则。

**Blocked by:** 06

**Status:** complete

- [x] Task board 投影：可见项目的 open Task、状态、执行者、我与它的关系，每项目已完成最近 5 条；来源字段随 08 的 `sourceThreadRefs` 加入
- [x] Human 项目看板与全局看板改读同一份 Host `taskBoard` 投影，不再从有界 project 读取窗口推导；项目看板已完成列因此固定为每项目最近 5 条，全局看板覆盖待处理、进行中、待验收
- [x] `team_task` 的 board / list / claim / done / release / promote；`team_view` 的 active task threads 段删除。accept / close / reopen 的 Agent 责任权限与 accountable 一起在 08 交付，不计入本票已完成范围
- [x] 一个 30 条消息之前创建、无人触动的 `in_progress` Task 出现在 Agent 看板进行中列；Host 回归测试用 40 条后续消息覆盖读取窗口

Host `taskBoard` 与 Remote 方法、Agent `team_task`、Human 项目看板与全局看板现在都读取同一份投影。项目看板的已完成列由 Host 固定为每个项目最近 5 条；全局看板展示所有可见项目的待处理、进行中、待验收任务。Client 保留旧 fixture 在缺少新 Remote 方法时从已加载窗口显示项目卡片的回退，仅用于兼容旧运行时，正式挂载始终使用 Host 投影。
