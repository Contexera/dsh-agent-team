# 隐式状态机审计 · 深入轮

- **状态：** 01–14 全部验收并归档；修复已落地并合入（`c4a8134b`，2026-11-13）。
- **最后检查：** 2026-11-12，基线 `796024fc`，结果在当前工作区。
- **起点：** [已归档的第一轮](../implicit-state-machines/README.md)。它覆盖 `7076dbd` 的 129 个源文件、68 组逻辑状态机和协调器，10 张票全部验收。本轮复核既有地图和后续新增的状态面。
- **本轮问题：** 第一轮回答了“有哪些状态机、哪些已复现的转移错误”。它没有系统回答：每个状态是否都有生产者和消费者？每个失败是否都有人能看见？同一个事实在不同 surface 上是否会读出不同结果？重启、取消、晚到结果之后，权威是否仍然一致？哪些不变式只写在注释里？
- **当前前沿：** 无未结票。[收口复核](materials/11-closure-audit.md) 列出保留的语义和重开条件；只有新增数据或可复现故障才重新开工。
- **完成证据：** 选中的风险均有源码、真实入口或故障注入证据；最终项目、类型、lint、文档、界面和浏览器验证通过。
- **正式文档出口：** [Host 权威](../../../../docs/architecture/host-authority.zh.md)、[工具与 preset](../../../../docs/architecture/tools-and-preset.zh.md)、[Client 与 Remote](../../../../docs/architecture/client-and-remote.zh.md)、[前端设计](../../../../docs/frontend-design/README.md) 与 [CHANGELOG](../../../../CHANGELOG.md)。

## Tickets

| 票 | 状态 | 结果 |
| --- | --- | --- |
| [01 · 附件归属](issues/01-attachment-cache-ownership.md) | complete | 重试不覆盖首个请求接受的文件，清理不删受保护的附件。 |
| [02 · 更新检查](issues/02-update-check-confirmed-result.md) | complete | 确认无更新才撤下旧提示；读失败保留上次结果。 |
| [03 · Worker 结束确认](issues/03-worker-confirmed-ending.md) | complete | 只有写入 ledger 才报告已结束，重复 stop 不绕过失败。 |
| [04 · 订阅接纳与关闭](issues/04-subscription-admission-and-shutdown.md) | complete | 临时读失败保留队列，关闭等待 Webhook 在途处理。 |
| [05 · 工具可用性](issues/05-tool-availability-truth.md) | complete | Agent 的工具提示与执行守卫一致。 |
| [06 · 恢复通知覆盖](issues/06-recovery-inbox-coverage.md) | complete | 恢复通知未覆盖的事实仍可后续送达。 |
| [07 · 讨论读取归属](issues/07-thread-open-owns-reads.md) | complete | 晚到的历史不能进到另一讨论或同一讨论的下一次打开。 |
| [08 · 回复归属](issues/08-discussion-reply-scope.md) | complete | 在途发送只占用原讨论，回执只清理实际发送的草稿。 |
| [09 · 转 Task 归属](issues/09-discussion-promotion-scope.md) | complete | 切走后不被晚到回执跳回。 |
| [10 · 关注归属](issues/10-discussion-follow-scope.md) | complete | 关注回执和读回结果归于正确的讨论。 |
| [11 · 通知省略验证](issues/11-notice-overflow-evidence.md) | complete | Main 和 Task reminder 省略后仍可按提示读取；保留唤醒规则。 |
| [12 · 关闭再打开后的回复重试](issues/12-reply-reopen-before-receipt.md) | complete | 真实 Host 验证延迟或丢失回执均只落一条。 |
| [13 · 主对话导航后的发送重试](issues/13-main-send-survives-navigation.md) | complete | 主消息、讨论和 Task 复用草稿提交，旧回执不改当前页面。 |
| [14 · 侧栏拖动顺序](issues/14-sidebar-order-latest-drag.md) | complete | 旧迁移不覆盖新拖动，同列表按顺序保存。 |

## 阅读顺序

1. [范围与深入问题](materials/00-scope-and-questions.md)：这一轮问什么，和第一轮的区别。
2. [覆盖差集](materials/01-coverage-delta.md)：第一轮之后新增的 13 个文件，以及既有文件里的新职责。
3. [Worker](materials/02-worker.md)：最大的新增状态面。
4. [Extra tool grants](materials/03-tool-grants.md)：第二个新增状态面，含一处已静态确认的文档/代码范围不一致。
5. [派生面](materials/04-derived-surfaces.md)：owner guidance、sidebar order、shortcuts、clipboard。
6. [延后项](materials/05-deferred-items.md)：第一轮留下的 5 类，逐条对当前代码。
7. [全域深入切片](materials/07-deep-slices.md)：六条审计线及原候选。
8. [深入轮实证](materials/08-verified-round.md)：01–07 的结果。
9. [讨论写入实证](materials/09-discussion-write-evidence.md)：08–10 的结果、12 的旧行为复现。
10. [通知容量、发送重开与侧栏排序](materials/10-recovery-and-closure.md)：11–14 的结果。
11. [收口复核](materials/11-closure-audit.md)：剩余候选裁决、重开条件和最终验证。

## 边界

- 归档是历史，不是当前实现权威；本轮只引用它的结论和证据，不重新解释它的状态名。
- 当前行为以 `packages/` 源码和测试为准；材料里的行号对应 2026-11-11 的 HEAD（`796024fc`）。
- 不引入全仓 FSM 框架、统一 async 层或新的状态仓；这条第一轮的决定继续有效。
