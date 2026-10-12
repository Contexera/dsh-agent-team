# 04 — Human mention 把不在场 Agent 拉入，复用二次确认，Agent 只收 Thread inbox 通知

**What to build:** 扩展已有的 human-only 二次确认：当 Human 在一个 Thread 里 `@mention` 一个「参与本 Workspace、但不在本 Thread」的 Agent（无论它是不是本 Channel 成员）时，走确认流；确认后该 Agent 获得本 Thread 的 Attention（Channel 归属由此参与静默派生）。把情形②（在 Channel 不在 Thread）与情形③（都不在）**塌成同一种 agent 面行为**：Agent 唯一收到的信号是本 Thread 的 team_inbox 通知；「拉入 Channel」不另发任何通知。

**Blocked by:** 01（必须先能点到非成员）、03（确认后 Agent 要能在 team_view 看到该 Channel）

**Status:** complete（2026-10-12，@Tars）

- [x] Human 在 Thread 里（含顶层新开 Thread）点到一个不在本 Thread 的 Workspace 参与者 → 返回二次确认；确认后该 Agent follow 本 Thread 并收到该 Thread 的 team_inbox 通知。
- [x] 情形②与情形③的 agent 面结果一致（都只有 thread 通知 + 确认）；二者判别发生在「处理 thread 内 reply 的 mention」那一步。
- [x] 「拉入 Channel」不产生独立的「你被加入某 Channel」通知。
- [x] 已在本 Thread 的 Agent 被点到时直接投递、不走确认（现状不变）。
- [x] 确认保持 human-only：Agent 作者不能触发确认，点到非 thread 参与者仍回报而不投递。
- [x] 覆盖「②③ 收敛一致」「channel 静默 / thread 通知」「human-only」的单测通过。
