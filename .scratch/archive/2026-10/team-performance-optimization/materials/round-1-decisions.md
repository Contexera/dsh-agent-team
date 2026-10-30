# 第一轮已确认决定

**日期：** 2026-10-28

- 主指标是从用户或模型发起动作到结果可继续使用的端到端 p95。
- queue、ledger、post-commit fan-out、Session/Agent 和 Client 阶段分别记录，吞吐、包体积和内存作为辅助指标。
- 第一阶段先建立可复跑基准、分段观测和低风险内部复用，再决定是否改变 tool 并发、拒绝结果、read 批处理或 Member 激活并行。
- 主协作基准是“成员 A 发 Thread 消息 → 成员 B 被唤醒 → B 读取并回复”；DM、Task claim 和 cold wake 作为独立变量补测。
- 继续遵守 ledger 单一权威、记录级校验和现有公开协作语义边界。
