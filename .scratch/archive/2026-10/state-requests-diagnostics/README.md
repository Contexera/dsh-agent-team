# 状态机、数据请求与诊断日志

**Status:** closed — 6 票全部完成（票面 Status=complete），2026-10-09 归档为 `archive/2026-10/state-requests-diagnostics/`；Vera 的工作项级一次性终审在进行中（只读，不改代码树）。
**Last checked:** 2026-10-09，代码尖端 `12e83f13`（树 `85d9072f5b5a670f4d9cc63c6494fc87e34ff662`，06 完成后；05 完成基线 `63a9e623`／树 `1fd385f632596a31eb8f5ae36c8c820b019576b0`；04 完成基线 `e02f2862`／树 `55e8cb15b2fede6086988784fed4cadb7a426180`；02 完成基线 `07083c48`／树 `eab0126afc217248ac807aa1f2e73f071a6d9435`；01/03 验收基线 `25c5d571`／树 `1bb8603eb669d077e97264dd11b047af4a2107b6`；均本地未推）。
**Current frontier:** [06 规模与故障验收](issues/06-scale-and-failure-acceptance.md)已 complete（装置 `aster-host-scale-acceptance.mjs`：真实 sqlite 介质＋真实 Host，2 Workspace／6 Member／1000 Task／24 活跃／40 积压 Thread／长 Thread 补到 20,000 笔；读数与决定见票面完成记录）。三条实现修复：`04096133` 客户端 bench 补 `conversation` 桩与 jsdom `document.fonts` 并把「渲染出的随包 slot entry 崩溃」变成失败、`d4289ffb` Inbox 有界队列补 `hasMore` 与三处可见性、`c15c4a33` Thread 页补充读取失败后仍保留「加载更早消息」入口、`12e83f13` 修正 `activeTaskThreads` 注释。重要决定：提交后全量校验**保留**（不加快照／worker／存储迁移，20 万笔为复查阈值）、Inbox **不加游标**、地址簿目录范围与工具侧映射**保留**并记复查阈值；`WeakMap` 根因在夹具侧（含第二个潜在崩溃 `document.fonts`），未改产品代码。剩余：工作项已归档（本笔），结果与预期效果汇报在工作项级总结里交；Vera 的一次性终审进行中（对着代码树 `85d9072f…`）。
**Completion conditions:**

- [x] 已提交的配置与实际执行结果可以区分；失败重试补做未完成效果，不重复提交业务事实。
- [x] 一个 Member 的长时等待不阻塞其他 Member；同一 Member 的顺序、停止与关闭语义明确。
- [x] 相同查询共享读取，过期响应不能覆盖新结果，断线重连后仍能取得当前事实。
- [x] 频道目录、消息分页、成员状态和 Inbox 摘要各自只读取需要的数据；规模实验验证请求数、返回量和扫描成本。
- [x] 一次操作能关联账本提交、执行结果、通知失败与重试；日志不包含凭据、私有记忆或重复的完整消息正文。
- [x] 初始验证中的 Harness `WeakMap` 错误已查明；受影响的定向测试和浏览器流程通过，剩余成本与限制有明确结论。
- [x] 实现后的公开行为和维护流程已移入正式文档，所有 ticket 已完成或明确关闭，再归档本工作项。

**Formal-doc exit:** Host 执行语义进入 [Host authority](../../../../docs/architecture/host-authority.md) 与 [domain model](../../../../docs/domain-model.md)；读取与 Remote 契约进入 [Client and Remote](../../../../docs/architecture/client-and-remote.md)；刷新和错误呈现进入 [refresh / accessibility](../../../../docs/frontend-design/refresh-copy-accessibility.md)。同步受影响的 package README、测试与中英文文档；只有实际实现的行为进入正式文档。

## 范围

围绕三个问题推进，不按 Host、Client、日志层分别做一次横向重写：

1. **状态机：** 谁拥有状态，哪些状态是推导值，任意一步失败后怎样继续。
2. **数据请求：** 一次交互触发多少读取，返回多少数据，扫描多少历史，旧响应能否回写。
3. **日志：** 能否由请求或 Member 标识查清提交、执行、失败与恢复的关系。

保留现有账本单一权威、Task 状态推导、Host 权限与 revision 检查、非乐观持久修改、范围变化订阅。Client 缓存不是第二份业务权威；不预设新状态机库、查询库、日志平台或存储迁移。

01、03、02（四片 `6cbd0285`、`fc6af976`、`4bb66b58`、`07083c48`）、04（`e02f2862`）、05（`63a9e623`）与 06 的三条修复（`04096133`、`d4289ffb`、`c15c4a33`、`12e83f13`）已落在本地提交（未推）；接口在各票收敛后未再变动，因此全程未建立 `spec.md`；发布未发生。

## 推进顺序

| Ticket | 交付结果 | 依赖 |
| --- | --- | --- |
| [01](issues/01-member-configuration-effects.md) | 成员配置保存、生效、失败和重试可区分 | 无 |
| [02](issues/02-member-execution-isolation.md) | 成员之间的长时执行互不阻塞 | 01 |
| [03](issues/03-shared-client-reads.md) | 共享读取、过期响应保护和正确的重连刷新 | 无 |
| [04](issues/04-bounded-projections.md) | 按用途限制读取范围，消除逐任务全扫 Claim | 03 |
| [05](issues/05-notification-recovery-trace.md) | 消息通知失败与自动恢复能关联到原因和结果 | 01 |
| [06](issues/06-scale-and-failure-acceptance.md) | 规模、故障、浏览器与剩余校验成本有完整验收结论 | 02、04、05 |

```text
01 配置执行一致性 ─┬─> 02 成员执行隔离 ─────┐
                  └─> 05 通知与恢复追踪 ──┤
03 共享读取 ─────────> 04 有界投影 ─────────┴─> 06 整体验收
```

日志随每条业务路径交付：01 验证配置应用，03/04 验证读取，05 验证通知与恢复；不等全部重构结束再补日志。

## 续接方式

- 了解发现、基线与复现实验：读 [初始审查](materials/initial-audit.md)。该文档是基线快照，不是当前实现权威。
- 开始一条 ticket：先确认其依赖与当前代码，再更新本页的负责人、状态和阻塞。Ticket 自身包含独立的交付与验收条件。
- 接口发生变化时：先明确调用方可观察的成功、失败和重试语义；同一 Member 的停止是否中止待应用配置也是需明确的行为取舍，不由“改动最小”代替判断。
- 完成一条 ticket：记录实际运行的验证与剩余问题；原始日志、脚本和截图留在 Git 忽略目录，不放入 active 材料。
