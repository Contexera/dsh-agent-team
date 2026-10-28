# Review 03 — 修复复核与归档结论

**复核日期：** 2026-10-28

## 结论

实现层面的 blocker、major 和测试缺口已关闭，工作项可以归档。Human 的 dev profile 体感试用仍是后续日常运行验收，不作为实现归档条件。

## 已关闭问题

- 旧式 `team/thread-read` snapshot 不再把后加的 `Attention.source` 当作冻结字段校验；legacy read delta 会从已有 Attention 行继承来源。真实 dev-profile 副本 25,575 条操作重放通过。
- Main stream 普通更新、discussion card 和 owner 变化按 Main Attention follower 集合唤醒，非 owner follower 不再出现“有未读但没有唤醒”。
- 试用指标脚本改为按历史时点的 Attention 统计，并使用空 projection 开始折叠，避免最终状态污染历史统计。
- 模型可见描述、core skill、persona、follow 结果和 status 查询统一到 Attention 语义；显式 follow 结果说明更早内容仍可通过 read/history 获取。
- 普通 Thread 失败唤醒重试和 source-less legacy snapshot 均有回归测试。

## 最终验证

- `npm test`：1420 passed / 1 skipped
- `npm run test:browser`：9/9 passed
- `npm run build`、`npm run typecheck`、文档、core skill、边界和 artifact 检查通过
- `scripts/team-trial-metrics.ts`：真实 dev-profile 副本重放和统计通过

## 已确认的边界

Human 的 Main stream Attention 随 Project 派生且强制存在，不能 unfollow；Agent Member 可显式 follow/unfollow。这个边界已同步到正式双语文档、测试和模型指导。
