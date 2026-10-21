# 换代机制的测试覆盖实况（A 选项成本的关键输入）

Vera · 2026-10-20 · 供 spec 的 A 段引用

## 一句话

**换代机制不是整体没测，是「崩溃恢复那一半测了、暂停/交还输入那一半没测」。** A 重写时要补的是特定一半。

## 逐方法实证

cc 协调器新增的 7 个方法，在 Team 测试里**全部零直接引用**（`grep -rl <method> packages/agent-team/tests/` = 0）：

`capturesFor`、`claimContinuationLatch`、`handBackInput`、`holdClaimedInput`、`isHoldingInput`、`returnHeldInput`、`scheduleCheckpointContinuations`

**更关键的是入口也没测**：`holdClaimedInput` 只被 `packages/agent-team/src/index.ts:3147` 的准入闸门调用，而 `needsAdmissionGate` 在 Team 测试里**零引用**。

⇒ **「准入闸门 → 暂扣输入 → 失败时还回」整条链路，Team 测试一行未覆盖。**

## 但有的一半是测了的（别误判成整体无覆盖）

- `recoverPendingTransition` / `repairContinuations` **有测试**：`packages/agent-team/tests/context-continuity-host.spec.ts:169` 起。
- 该测试注释还明确写了另一条分支由 Member 生命周期套件端到端覆盖（真实重启），断言扎实（`isTransitioning` 前后态、`executeTransition` 未被提前调用）。
- 也就是说**崩溃恢复路径有护栏，暂停/交还路径没有**。

## 对 A 的成本含义

重写要补的**不是 `handBackInput` 一个函数**，而是这三个构成的一套时序：

| 方法 | 职责 | 行数 |
|---|---|---|
| `holdClaimedInput` | 准入时暂扣输入 | 11 |
| `returnHeldInput` | 正常释放 | 7 |
| `handBackInput` | 换代未发生/失败时原样还回 | 57 |

**且需从零写失败路径测试——测试工作比这 75 行代码本身更花时间**，因为它要构造"换代中途失败"的时序，而这正是最容易写错的地方。

**好消息**：`recoverPendingTransition`/`repairContinuations` 那半边有现成测试可借，不用从零设计。

## 我没验的

- 没有实际构造一次"换代失败"来观察 hand-back 是否真的把输入原样还回（那是运行时行为验证，需要注入失败）。
- 没有核 cc 自身仓库是否有这部分的测试（`node_modules` 里不带测试，无从而知）。
