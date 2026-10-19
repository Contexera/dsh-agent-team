# 01 — 生产代码注释清理（Host 包）

**What to build:** `packages/agent-team/src/` 下经审查确认不成立的注释被删除，`npm test` 与 `npm run typecheck` 仍全绿，且包对外发布的 `.d.ts` 契约没有丢失调用方可观察的信息。

**Blocked by:** None — can start immediately
**Status:** complete

- [x] 按机械校验后的条目与对应分片报告判定 `packages/agent-team/src/` 的删除条目，逐条读过符号与调用点后才删
- [x] 五处 `do not remove during cleanup` 约束型注释按 ticket 05 的结论处理
- [x] 删除后 `npm run typecheck` exit 0
- [x] 删除后 `npm test` exit 0（1125 passed / 1 skipped 基线不减）
- [x] 确认 `recovery-hints.spec.ts` 的源码扫描门禁与 `shipping.spec.ts` 的文本断言仍通过
- [x] 未触碰工作区既有的 21 个无关改动
