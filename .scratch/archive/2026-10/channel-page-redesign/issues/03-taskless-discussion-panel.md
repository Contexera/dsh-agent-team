# 03 — 无 Task 的讨论在 feed 旁边打开，而不是另开一页

**What to build:** 一条无 Task 的讨论（taskless thread）的入口行不再走 Thread 页，而是在 Channel 页右侧 360px 的面板里打开。面板是这条讨论的完整面：头写它是什么、能「转为 Task」、能关；体按时间线读它的事实（日分隔 + run，与任何时间线同一套）；脚是普通 composer，用同一个 `thread:<threadRef>` 草稿键，所以在面板与 Thread 页之间往返时写了一半的回复不丢。带 Task 的入口仍然走 Thread 页——Claims 与验收在那里。

**Blocked by:** [01](01-channel-tabs-and-board.md)（面板与 feed 共享 `.feedStage` 的座位；页签整片切换时面板要退位）

**Status:** complete（2026-10-16，commit `facfd734`）

- [x] 点无 Task 的入口行 → 面板出现：头 `讨论 · #<channel>` + 「转为 Task」+ 关闭钮；锚消息正文可见；composer 在位；feed 时间线仍在（未跳页）；`readThread` 以该 threadRef 被调用。
- [x] 面板读成后其 feed 行的未读胶囊本地清零，不等下一次 Inbox 读取。
- [x] 面板里回复 → `reply` 以该 threadRef 被调用；提交后正文出现在面板体内。
- [x] 点「转为 Task」→ `promoteThread` 被调；成功后关闭面板，读者走进新 Task 的 Thread 页；返回频道后该行变成「打开 Task #N」。
- [x] 开面板后切「看板」→ 面板不在；切回「频道」→ 面板仍在（状态驻留）。
- [x] 关闭钮 → 面板消失。
- [x] 面板内没有 Claims 折叠、没有验收控件——无 Task 的 Thread 两者都没有。
- [x] 600px 以下面板覆盖整个 stage，而不是挤在一条读不下去的 feed 旁边。
- [x] 面板重新打开另一条讨论时读到的是新那条（`team-channel-panel-switch.client.spec.tsx`）。

**实现偏离（相对原 spec）：** 原设计的 `reserve` 是常驻预留 360px——开/关面板主列宽 Δ0、不折行。代价是 1440 视口下面板未开时也常驻一条空带、feed 每一行都为它付费。改为**仅打开时预留**：开关面板时重排一次，而那正是读者注意力已经移向面板的时刻（见 [spec.md](../spec.md) 布局一节）。

**明确不做（留待日后按需）：** 回复指定（`replyTo`）、引文块、行内动作、未读分界、面板内的 Claims 与验收。面板是「低强度、跨天、要 channel 上下文常在视野」的读法；上面这些都属于 Thread 页的完整面。
