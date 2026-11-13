# 材料索引

本目录保存深入轮前置调研和本轮复核证据。它不是实现规范；当前行为以 `packages/` 源码和测试为准。

| 文件 | 内容 | 证据等级 |
| --- | --- | --- |
| [00-scope-and-questions.md](00-scope-and-questions.md) | 这一轮问什么；与第一轮的区别；全域深入问题清单。 | 方法说明 |
| [01-coverage-delta.md](01-coverage-delta.md) | 第一轮 129 文件与当前 142 文件的差集；13 个新文件的归属。 | 已核对 `git ls-tree` 与 `COVERAGE.md` |
| [02-worker.md](02-worker.md) | Worker 委派的状态、事件、守卫、权威、恢复与开放问题。 | 源码细读 + 测试索引；未做故障注入 |
| [03-tool-grants.md](03-tool-grants.md) | extra tool grants 的 Host 设置、turn 冻结、失败收紧、Client 草稿与冲突。 | 源码细读 + 测试索引；发现一处文档/代码范围不一致 |
| [04-derived-surfaces.md](04-derived-surfaces.md) | owner guidance、sidebar order、shortcuts、clipboard 的派生面。 | 源码细读；其中 sidebar order 是第一轮 C16 的过时描述 |
| [05-deferred-items.md](05-deferred-items.md) | 第一轮延后项的当前代码结论。 | 逐条核对当前源码 |
| [07-deep-slices.md](07-deep-slices.md) | 六条全域深入切片，覆盖第一轮的 68 组和新增面。 | 地图 + 待验证问题 |
| [08-verified-round.md](08-verified-round.md) | 实际复核、修复和保留项。 | 逐项标注 |
| [09-discussion-write-evidence.md](09-discussion-write-evidence.md) | 讨论切换与晚到写入。 | 真实侧栏和 Web 探针 |
| [10-recovery-and-closure.md](10-recovery-and-closure.md) | 通知容量与发送重开。 | 真实 Harness 与 Web 故障注入 |
| [11-closure-audit.md](11-closure-audit.md) | 候选裁决、证据与再次启动条件。 | 按候选核对 |

## 证据分级

沿用第一轮的四级口径，避免把静态可疑写成已复现事故：

1. **已执行复现：** 有 failing test 或真实入口的观测记录，修复后有 green。
2. **已静态确认：** 源码路径、类型、调用顺序或测试断言已核对；不等于已发生用户故障。
3. **待验证风险：** 有具体证明步骤，但本轮未执行。
4. **现有测试锚点：** 只表示存在相关断言，不表示本轮重新执行过。

材料里没有第一级证据，除非明确写出命令和输出。所有“建议”都不是已实施结论。
