# auto-compaction-migration

- **Status:** archived — 2026-10-21 修复、文档与自动化验收完成并归档。真实模型质量与成本不在本轮证据内。
- **Last checked:** 2026-10-21
- **Frontier:** 已关闭，不再扩大范围。主 agent 最终复跑 `npm test` 为 1056 passed + 1 skipped；typecheck、lint、docs、browser 5 passed、build、artifact 与 diff 检查通过。换代提交中输入、提交失败、激活失败恢复、冷启动 pending 输入、已 claim 输入及两次恢复去重均有实测。已知队列删除/替换与 dispose 清空不可区分的边界见正式文档。
- **Completion conditions:** 已满足。最终实现与文档一致；无模型 context 工具；使用 DSH 默认引擎；pending 输入可由原始日志恢复；新换代失败可由公开恢复路径收敛且不激活旧绑定；旧日志仍可读且必要历史恢复有测；无消费者状态/写入口退出。真实模型摘要质量和生产成本没有本轮数据，不能声称已验证。
- **Formal-doc exit:** 已完成。当前行为进入 `docs/team-collaboration/memory-and-context.{md,zh.md}`、`docs/architecture/host-authority.{md,zh.md}`、相关 README 和 CHANGELOG。

## 当前决定（覆盖原规格的对应要求）

2026-10-21 用户提出使用 DSH 默认模板，并授权子 agent 修复本轮发现的问题和文档，最后由主 agent 验收 review。原 spec 中“必须保留 cc 七节模板”的约束已由此更新：直接挂载 DSH `BasicCompactionEngine`，不再保留 Team 摘要子类、模板副本和重复调用逻辑。保留全局 `0.256 / 0.08 / 65536` 参数；它不是所有模型固定 256K，部署方按需配置 profile policies。

新唤醒换代不再依赖模型工具或 pending intent。保留旧事件/operation 解码及必要恢复，与保留旧写入口、无消费者缓存不是同一件事。hidden `clearMemberContext` Remote、旧 renewal/rollover writer、只写不读的 `rolloverSeeds`、无人消费的 boundary 投影退出；handoff fixture writer 移测试。idle 有未处理普通输入时保守续用旧代。提交期间由 maintenance 暂停旧 loop，ledger 记录 `inputFromSeq`，旧代退役后从原始日志恢复输入；不在进程内暂存消息内容，不恢复旧工具或 handoff 文案。

## 复核材料

- `review-findings.md` — 2026-10-21 合入前审查记录，反映当时决定，不定义修复后行为。
- `implementation-checklist.md` — 本轮修复项、最终验证命令与结果、证据边界。
- `spec.md` 与 `issues/` — 原五票规格快照；上面的当前决定覆盖其模板、旧写入口及收缩范围要求，原快照不作完成状态权威。
- `materials/` — 早期调研与验收草案。handback 闸门材料随闸门删除已作废；模板强制保留结论被本轮决定覆盖。

## 背景

Task #117：弃用 dsh-context-continuity，回归引擎自动压缩与 Host 唤醒换代。迁移已真实删除外部依赖、四个模型 context 工具、judge/gate、advice 与 handoff 注入主体。跨代连续性依靠平时维护的 memory.md 与常规上下文注入，不发送换代仪式文本。
