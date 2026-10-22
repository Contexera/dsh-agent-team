# 01 — Team 自持换代协调器（缩水版）+ Host 换代 durable op

**What to build:** Member 换代由本仓自持协调器驱动，替换 cc 的 `ContextContinuityCoordinator`。v2 缩水：换代只发生在「消息到达 idle Member」边界（notifyMember/activateMember 判定），不再有 turn 中途准入闸门，因此**不搬** `holdClaimedInput`/`returnHeldInput`/`handBackInput`/`captureQueuedInput`/`captureClaimedInput`/`needsAdmissionGate` 整套。只保留：idle 边界 swap、pending-transition 崩溃恢复、checkpoint 续接修复。唤起消息不由 carried-input 携带（其唯一生产者是 rollover 工具结果，删工具后恒为空），而由激活末尾的 Inbox 重导出（`index.ts:3292` 现有机制）投递。**新增 durable op `team/member-session-recycled`**（actor=host/system，domain version 升级）：`rolloverMemberSession` 要求 member actor（`ledger.ts:797`）、`renewMemberSession` 要求 human actor（`:766`），Host 自动换代无账可落。durable schema 是 strict 联合：新 op 新增，旧 op（`member-session-rollover` 等）只停生产、保留 decode，字段一个不能删。host 6 接口（`subjectForAgent`/`log`/`projectionForSubject`/`agentForSubject`/`rolloverIdentity`/`executeTransition`）不改。
**Blocked by:** None — can start immediately
**Status:** complete

**Outcome (2026-10-21):** 已落地。`team/member-session-recycled` 进 strict 联合，并在 live 换代时记录 `inputFromSeq`；协调器按 idle 边界执行，legacy pending（`turnEndSeq===-1`）视为 spent 丢弃。与票面计划的差异：保留了一个 pre-step retiring gate（只 reject，不发模型请求），输入改用 ledger 边界 + 旧日志重放恢复，而不是依赖 Inbox 重导出。

- [x] 以 git 历史 `2b8d3eef` 的 `context-management.ts`（369 行）为底恢复，逐方法对齐现役语义（16 个旧方法中只取唤醒换代所需子集，闸门相关方法不取）
- [x] **每搬一个方法跑一次对应测试，不全搬完再跑**
- [x] 新 durable op：`team/member-session-recycled` 进 `spec.ts`（strict 联合新增成员），ledger 写路径 + fold 处理 + 测试；旧 op 的 decode 保留不动
- [x] 崩溃恢复半边借现役测试形状（`context-continuity-host.spec.ts:169` 起）重写为自持版，**断言形状改为无 handoff**：legacy pending（`turnEndSeq===-1`）视为 spent 丢弃（否则历史日志里的未完成 pending 让新代永久卡 isTransitioning）
- [x] 删除的闸门方法在原调用点（`index.ts:3115/3120/3126/3127/3147/3152/3153`）一并清除（与 04 协同，但调用点收缩属本票）
- [x] `packages/agent-team/src/` 无 cc import；typecheck 0 错；`npm test` 绿（基线 1149+1 skip；先 `node scripts/sync-paths.mjs` 再跑）
