# Team UI loading investigation

状态：archived — 2026-08-21 的调查与前两期修复已完成并合入。这里保留问题分析、方案取舍和当时的验证记录；当前性能行为以 `packages/`、测试和正式文档为准。

## 已交付

- Thread read 只推进读者私有水位，不再唤醒任何变更 scope。
- `changes()` 支持 workspace/channel/thread scope 与 `AbortSignal`；提交只唤醒受影响的 scope。
- Host 以追加式投影索引替代全量扫描，并只向可能受影响的 Agent 重算 Inbox hint。
- Client 以 `TeamChangeStream` 共享按 scope 的可取消 long-poll；Thread 首开改为一轮并行读取。
- 冷启动复用一次 `sessionPersistence.list()` 的结果。

稳定边界已进入 [`docs/architecture/README.md`](../../../../docs/architecture/README.md)、[`packages/agent-team/README.md`](../../../../packages/agent-team/README.md) 和 [`packages/client-agent-team/README.md`](../../../../packages/client-agent-team/README.md)。详细历史分析见 [`report.md`](report.md)。

## 验收记录

当时已完成 typecheck、单测、build、assembled browser journey、lint 和 `git diff --check`。新增覆盖包括 change scope 隔离、read 不唤醒、abort、Client 共享/取消和 Thread 首开并行。

本工作项没有保留可重复的 Small/Medium/Large 性能测量数据。后续若要建立性能预算、数据规模 fixture 或继续拆分有界读接口，应新建 `.scratch/active/` 工作项；不要把历史报告当作当前待办。
