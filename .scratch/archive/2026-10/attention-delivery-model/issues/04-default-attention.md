# 04 — 默认 Attention 与身份变化

**What to build:** Human 建立 Project、Agent 获得 owner 身份时，自动建立对 Main stream 的默认关注；accountable、Claim executor、Thread 作者的自动 follow 规则保持。身份被撤销时，已存在的 Attention 不因身份变化而被静默删除，权限与责任按现有规则变化。新的默认关注不会一次性把某个 Agent 塞进该 Project 的所有现存 Thread 或未来新开的 Thread。

**Blocked by:** 03 — Main stream 改由 Attention 决定普通未读（已完成）

**Status:** complete — 领域行为在 03 中一并落地，本票补齐验收测试

- [x] Human 创建 Project 与 Agent 获得 owner 身份，都在同一原子操作里建立对 Main stream 的默认关注；结果可重放、幂等
- [x] 授予 owner 身份不批量订阅该 Project 现存或未来 Thread；新 discussion Thread 通过 Main stream 的普通未读到达 owner
- [x] Thread 作者、accountable、Claim executor 的自动 follow 与 reopen / close / transfer 的既有 Attention 规则保持，测试锁定不回归
- [x] owner 身份被撤销时不删除既有 Main stream / Thread Attention；open Task 按现有规则转回 Human，权限与责任变化不受影响
- [x] 被撤销 owner 的 Agent 会因保留的 Attention 继续收到 Main stream 普通更新，直到它自己 unfollow；该行为在测试中明确表达
- [x] 迁移已存在的账本：为既有 Project 的 owner 建立 Main stream 默认关注，且不破坏其未读连续性
- [x] 默认关注在工具结果里可说明来源（见 `agent-tools-context-rendering`），但不因缺少来源信息而猜测原因

## 实施说明

- **Human 的默认关注走派生，不写 durable 行**：`humanMainAttentionFrom` 从 Project 的 `createdAtSequence` 起算，只有读取水位（`humanMainWatermarks`）落库。这守住了「Human 身份恒定、不存储」的既有原则，也不必给 `team/project-created` 增加 inbox delta、改动其存储形状。
- **Agent owner 的默认关注由授权操作原子写入**：`team/project-owner-added` 的 delta 带一个 `startMainAttention(memberId, projectRef, sequence)`，从授权点起算，因此不继承历史积压。
- 授权**只写 Main stream 一行**，不写任何 Thread Attention——测试断言 `mainAttention` 恰好新增 1 行，且授权前已存在的 Thread、授权后新开的 Thread 都不产生 Thread Attention。
- 身份变化与 Attention 的分离在测试中逐条钉住：
  - `project-owner-removed` 保留 Main stream Attention（撤回所有权 ≠ unfollow）；
  - `member-archived` / `member-removed` 收回它（离开团队 ≠ 退订，是无处可投）；
  - `member-workspace-left` 同样收回。
- 迁移零成本：既有账本上 Human 的未读由派生自动接上（`createdAtSequence` 就是旧 `humanOwnerFloor` 的同一事实），Agent owner 的授权记录本来就在，重放即得。
