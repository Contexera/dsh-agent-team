# Thread Inbox / Team Member Context

状态：archived — 2026-08-20 已完成。这里保存 Thread Attention、durable Inbox、五工具、Human Inbox 和 Member context 切换的历史方案与 tickets；当前合同以 [`../../../../docs/team-collaboration/README.md`](../../../../docs/team-collaboration/README.md)、源码和测试为准。

## 历史阅读顺序

1. [`spec.md`](spec.md)：已确认的阶段合同快照。
2. [`ticket-plan.md`](ticket-plan.md) 与 [`issues/`](issues/)：实施依赖和完成记录。
3. [`design/thread-inbox-member-context.md`](design/thread-inbox-member-context.md)：设计草案。
4. [`research/raft-tools-prompt-2026-08-19.md`](research/raft-tools-prompt-2026-08-19.md)：外部产品一手资料调研。

## 当前实施状态

```text
01  Cut Over to Durable Thread Attention       complete
02  Make Agent Thread Collaboration Pull-Based complete
03  Wake Members from Durable Inbox State      complete
04  Human Inbox and Thread Attention UX        complete
05  Equip Team Members for Work and Memory     complete
06  Preview Modes and Whole-Trace Acceptance   complete
```

当前没有需要保留的持久 Team 数据。Ticket 01 已直接切换到新模型，Ticket 02 已验证最终五工具的拉取式 Agent 协作协议，Ticket 04 已完成 Human Inbox/Thread surface，Ticket 05 已交付完整 coding Member 与私有 memory，Ticket 06 已拆分 live/UI/replay 三条开发路径并完成 whole-trace acceptance；不得引入旧工具名、旧 Follow/Delivery 路径、双读写、迁移或兼容层。Host/ledger、五个工具、durable Inbox wake、命令、Client、Remote、preview 和 assembled browser trace 均已通过对应验证。

## Compaction / 接续恢复

发生会话 compaction、handoff 或新的 Agent 接手时，先读 `AGENTS.md`、`docs/README.md`、`docs/team-collaboration/README.md` 和当前源码/测试；只在需要追溯替换旧模型的原因时再读本归档。不要仅凭 M1/M2 历史资料推断注意力、未读、mention、投递或 Team prompt 行为。

本目录中的 tickets 已全部关闭。后续实现改变当前合同或维护流程时，更新正式 `docs/`、package README 和测试，不回写本归档来模拟现状。
