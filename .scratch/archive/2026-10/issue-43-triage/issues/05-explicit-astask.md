# 05 — sendMessage 的 asTask 改为显式（breaking）

**What to build:** 直接调 Remote `sendMessage` 而省略 `asTask` 时，不再默默创建一个 Task。
要建 Task 就显式传 `asTask: true`。三条入口的行为从此一致。

**Blocked by:** Operator 已批准破坏性变更；本 ticket 需在 CHANGELOG `Unreleased` 先记一条 Changed 再动代码
**Status:** complete

背景：`ledger.ts` 里 `const asTask = request.asTask !== false`——只有显式 `false` 才不建。
而模型侧的 `team_message` 工具是 `asTask: args.asTask === true`（默认不建），
Client 输入框的开关默认也是 `false`。**同一个概念三条入口两个方向**，
只有直调 Remote 的调用方会踩到。

已排查的调用方：Client 的 `TeamChannelPage` 已经在显式传值（`asTask`），
模型工具也在显式传。所以受影响的是**外部直调 Remote 的调用方**（含 operator 自己的 `team-bridge`）。

- [x] `asTask` 语义改为显式：`ledger.ts` 改 `request.asTask === true`，缺失即不建 Task
- [x] 类型注释改成「缺省不建；传 true 才建」，删掉原 "Omitted/true keeps the released-client atomic path"
- [x] `assertSameMessage` 的碰撞校验同步为 `request.asTask === true`
- [x] `docs/` 下无 `asTask` 表述，无需同步（grep 确认）
- [x] 测试：省略 → 无 Task；显式 `true` → 建 Task；显式 `false` → 无 Task
- [x] 现有测试修正：3 处依赖旧缺省（`agent-team.spec.ts:2022` 两处 + `1714` 两处），均已补 `asTask: true`
- [x] CHANGELOG `Unreleased` 记一条 **Changed**，写明行为变化与迁移（想要旧行为补 `asTask: true`）

实现注记：
- 受影响面比预期小——Client 的 `TeamChannelPage` 与模型工具本就显式传值，
  所以真正的行为变化只落在直调 Remote 的外部调用方。
- 为定位那 3 处依赖旧缺省的用例，临时给 `withTask` 的报错塞了 stack，定位后已还原。
