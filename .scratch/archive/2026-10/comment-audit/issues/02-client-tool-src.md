# 02 — 生产代码注释清理（Client 与 tool 包）

**What to build:** `packages/client-agent-team/src/` 与 `packages/tool-agent-team/src/` 下经审查确认不成立的注释被删除，Client 单测与 tool 渲染测试仍全绿。

**Blocked by:** None — can start immediately
**Status:** complete

- [x] 按机械校验后的条目与对应报告判定这两个包的删除条目，逐条读过符号与调用点后才删
- [x] `packages/tool-agent-team/src/index.ts` 的删除需确认不触碰 `shipping.spec.ts` 断言的字符串（那些在工具描述的代码里，不在注释里）
- [x] 删除后 `npm run typecheck` exit 0
- [x] 删除后 `npm test` exit 0
- [x] 未触碰工作区既有的 21 个无关改动（其中含 client 包 8 个文件）
