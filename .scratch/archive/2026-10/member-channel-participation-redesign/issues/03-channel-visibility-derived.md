# 03 — Channel 可见范围由参与派生

**What to build:** 一个 Agent「在不在某 Channel」从「显式 membership 表」改为「在该 Channel 任一 Thread 里参与过」派生（对标 everParticipated 的做法），叠加历史账本里已有的显式 membership。team_view 以及 channel/thread 读取的可见范围过滤据此计算：Agent 一旦在某 Channel 的 Thread 里出现过，该 Channel 就出现在它的 team_view；从没参与过的 Channel 不出现。可见范围不得变宽到「整个 Workspace 的所有 Channel」。

**Blocked by:** None — can start immediately（与 01/02 独立）

**Status:** complete（2026-10-12，@Tars）

- [x] 一个在某 Channel 的 Thread 上参与过的 Agent，其 team_view 能看到该 Channel；从未参与过的 Channel 不出现。
- [x] 历史账本里通过 `channel-member-joined` 加入、但从未在任何 Thread 发言的显式成员，可见范围保持不变（派生 + 历史显式两者取并）。
- [x] 旧账本（含 channel-member-joined / removed 操作）仍能加载并复现相同可见范围——这些操作的 apply/validate 分支保留，不删（见 spec 四.2）。
- [x] team_view 不因本改动把「未参与的 Channel」暴露出来。
- [x] 覆盖「参与即可见 / 未参与不可见 / 历史显式成员仍可见」的单测通过。

**实现备注：** `isChannelMemberFrom` 改为「显式 membership ∪ 在该 Channel 任一 Thread 里 everParticipated」，且派生必须仍在 `participatesIn` 之内（否则离开 Workspace 后旧 Thread 会把 Channel 又露出来）。副作用：`allRecipientsFor`（`@all`）随之按派生口径展开——被点名进 thread 的人算「已参与者」，会被后续 `@all` 覆盖（已在 Thread 报给 @Reeve）。既有单测「withdraws only the target Workspace」最后一条断言由「rejoin 后 []」改为「rejoin 后该 Channel 回来」，因为它编码的是派生前的语义。
