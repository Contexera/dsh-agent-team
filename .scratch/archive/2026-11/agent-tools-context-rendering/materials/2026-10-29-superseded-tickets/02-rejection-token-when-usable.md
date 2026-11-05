# 02 — 拒绝结果里的 token 只在它真能用时出现

**What to build:** `unread_required` 拒绝不再无条件渲染 `Next write — baseRevision`。只有当带该 token 的重试真会提交时才渲染它；否则只给「先 read」的恢复路径。为此把 visible-surface 豁免从「只认 Team 写的 user message（通知、DM relay）」扩展到「Team 工具结果里已全文交付的事实」，判据改为结构化（按已交付的 fact sequence 记录），不再是正文子串匹配。`stale_revision` 保持现状（token 本就有效）。

**Blocked by:** None — can start immediately

**Status:** ready

- [ ] **结构化探针的落点先定并写进设计**：拒绝/read 把已交付的 fact sequence 记在 session 的什么位置（现有 `surface.nodes`/`snapshotEvents` 之外的什么结构），重启、压缩、结果被 `tool-result-pruner` 截断后分别怎么判。失败即关闭：记录缺失、被截断、对不上，都按未交付处理。
- [ ] activity 事实与被裁剪的正文（`NOTIFICATION_TRUNCATION_MARKER`）不豁免；短正文（`ok`、`done`）不得误命中——`team_view`、`history`、Thread card 的结果里都有短正文，子串匹配会大量误放，所以判据必须是结构化的。
- [ ] render 改动：条件渲染 token。**主动反转现有断言**——现在共 8 个用例断言 `unread_required` 带 token，全部列在这里，漏一个都会在跑全套时才爆：
  - `team-rejection-payload.spec.ts` 5 个：`:33`（带 facts 的普通形状）、`:53`（activity 事实）、`:68`（无 facts 的退化形状）、`:114`（team_task claim 侧）、`:135`（「never invents a second write token」——它同时锁「恰好一个 token」，条件渲染后要改成「无 token 时恢复句仍在、有 token 时仍恰好一个」）。
  - `team-tools-render.spec.ts` 3 个：`:495`（message 拒绝形状）、`:606`（claim 拒绝）、`:688`（Task resolution 拒绝）。
  - 改 render 之前先改测试；`stale_revision` 的用例不动（token 照旧有效）。
- [ ] ledger 层测试（真实 `deferredThreadWrite` 路径）：普通更新场景 拒绝 → 带 token 重试 → 提交；含 activity 事实的场景 仍拒绝且不渲染 token；豁免不写任何 ledger 状态（无 `team/thread-read` operation、watermark 不动、标记不消耗）。
- [ ] 恢复句一起改：`recovery-hints.ts` 的 `unread_required` 句子现在让人先 read（语料 183/188 次照做）；豁免生效时句子要指向「直接重试」，否则往返照样省不掉。
- [ ] 8 处说法一次对齐（含两个 package README 里逐字断言旧契约的句子、`boundaries.md(+zh)` 的「token 不出现在任何 typed rejection」、persona 与 core skill 的「a rejection supplies no write basis」）；`tools.md:75` 与 `:77` 的自相矛盾（「retry commits with no intervening read」vs「Recovery is still read-and-reconsider」）以一条准确的说法收口。
- [ ] 证据链写法订正（Vera 2026-10-29）：`team-rejection-payload.spec.ts` 头注释只锁「拒绝里能学到变化」，「重试必须能提交」只存在于文档。本条的性质是 **render 半边已落、gate 半边没落**，不是「代码自己的意图已实现」。
- [ ] 离线语料回放该形状（186 次 `unread_required` 场景分类：豁免可省往返的占多少）。
