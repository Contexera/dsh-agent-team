# 04 — scripts/ 注释清理

**What to build:** `scripts/` 下经审查确认不成立的注释被删除，各检查脚本仍按原语义运行。

**Blocked by:** None — can start immediately
**Status:** complete

- [x] 按机械校验后的条目判定 `scripts/` 的删除条目（71 条通过机械校验）
- [x] `scripts/harness-dir.mjs` 与 `scripts/dsh-peers.mjs` 的文件头解释的是外部解析契约，按第 2 类保留
- [x] 删除后 `npm run check:docs`、`check:facades`、`check:boundaries`、`check:versions` 全部 exit 0
- [x] `scripts/team-ui.e2e.ts` 与 `scripts/team-ui.ui-preview.ts`、`scripts/audit-ui-parity.mjs` 有工作区既有改动，删除前先确认行号仍有效
