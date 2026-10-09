# 状态机、数据请求与诊断日志

**Status:** in-progress — 6 票中 01、02、03、04 已完成（票面 Status=complete）；05 可开工、尚未认领；06 等 05 与 04 的规模结论。
**Last checked:** 2026-10-09，代码尖端 `e02f2862`（树 `55e8cb15b2fede6086988784fed4cadb7a426180`，04 完成后；02 完成基线 `07083c48`／树 `eab0126afc217248ac807aa1f2e73f071a6d9435`；01/03 验收基线 `25c5d571`／树 `1bb8603eb669d077e97264dd11b047af4a2107b6`；均本地未推）。
**Current frontier:** [04 有界投影](issues/04-bounded-projections.md)已 complete（一笔 `e02f2862`：Claim 按 Task 分桶、`view` 的 catalog 由 `includeCatalog` 显式索取、Inbox 行按返回量物化、observations 补 `hasMore`；读数与契约表在 [materials/read-cost-accounting.md](materials/read-cost-accounting.md)），等 Vera 终审；可开工 [05 通知与恢复追踪](issues/05-notification-recovery-trace.md)；[06 规模验收](issues/06-scale-and-failure-acceptance.md)等 05 完成，并接收 04 留下的两条（address book 返回体 ∝ 活跃 Task 数、票 03 的 view/线程读未收编与查询键无 Thread 维度）。02 的四片与票面记录见其完成记录。nmem 当前不可用，本目录是续接入口。
**Completion conditions:**

- [x] 已提交的配置与实际执行结果可以区分；失败重试补做未完成效果，不重复提交业务事实。
- [x] 一个 Member 的长时等待不阻塞其他 Member；同一 Member 的顺序、停止与关闭语义明确。
- [x] 相同查询共享读取，过期响应不能覆盖新结果，断线重连后仍能取得当前事实。
- [x] 频道目录、消息分页、成员状态和 Inbox 摘要各自只读取需要的数据；规模实验验证请求数、返回量和扫描成本。
- [ ] 一次操作能关联账本提交、执行结果、通知失败与重试；日志不包含凭据、私有记忆或重复的完整消息正文。
- [ ] 初始验证中的 Harness `WeakMap` 错误已查明；受影响的定向测试和浏览器流程通过，剩余成本与限制有明确结论。
- [ ] 实现后的公开行为和维护流程已移入正式文档，所有 ticket 已完成或明确关闭，再归档本工作项。

**Formal-doc exit:** Host 执行语义进入 [Host authority](../../../docs/architecture/host-authority.md) 与 [domain model](../../../docs/domain-model.md)；读取与 Remote 契约进入 [Client and Remote](../../../docs/architecture/client-and-remote.md)；刷新和错误呈现进入 [refresh / accessibility](../../../docs/frontend-design/refresh-copy-accessibility.md)。同步受影响的 package README、测试与中英文文档；只有实际实现的行为进入正式文档。

## 范围

围绕三个问题推进，不按 Host、Client、日志层分别做一次横向重写：

1. **状态机：** 谁拥有状态，哪些状态是推导值，任意一步失败后怎样继续。
2. **数据请求：** 一次交互触发多少读取，返回多少数据，扫描多少历史，旧响应能否回写。
3. **日志：** 能否由请求或 Member 标识查清提交、执行、失败与恢复的关系。

保留现有账本单一权威、Task 状态推导、Host 权限与 revision 检查、非乐观持久修改、范围变化订阅。Client 缓存不是第二份业务权威；不预设新状态机库、查询库、日志平台或存储迁移。

01、03、02（四片 `6cbd0285`、`fc6af976`、`4bb66b58`、`07083c48`）与 04（`e02f2862`）已落在本地提交（未推）；05/06 尚未开始，接口与并发策略仍随各票收敛，因此暂不建立 `spec.md`；发布未发生。

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
