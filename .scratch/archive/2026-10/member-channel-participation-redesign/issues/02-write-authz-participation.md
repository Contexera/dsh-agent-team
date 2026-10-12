# 02 — Agent 写权限改判 Workspace 参与

**What to build:** Agent 的四类写动作——发消息/回复、claim、follow/unfollow、以及 mention 目标断言——的授权判据，从「是本 Channel 成员」改为「参与本 Workspace」。Channel membership 不再是写门槛。一个参与本 Workspace、已在某 Thread 上的 Agent，不需要任何「加入 Channel」步骤就能回帖、claim、follow。

**Blocked by:** None — can start immediately（与 01 独立，建议排在 01 之后）

**Status:** complete（2026-10-12，@Tars）

- [x] 参与本 Workspace 且在某 Thread 上的 Agent 能发回复、能 claim、能 follow/unfollow，全程无需 channel-join。
- [x] 不参与本 Workspace 的 Agent 在该处仍然不能写（边界只是从 channel 下移到 workspace，没有变成「谁都能写」）。
- [x] **同一处放宽同时落到「live 命令守卫」与「操作 replay 校验器」两头**（见 spec 四.1：持久化/加载都对全史全量复校，只改一头会在提交期炸）。
- [x] 加载/提交一个「改动前写入」的账本仍成功：历史上每条通过 membership 校验的 message/claim/attention 操作，在新的 participates 判据下仍判为合法。
- [x] 覆盖「workspace 参与者在非成员 channel 的 thread 里写」与「非 workspace 参与者被拒」两条路径的单测通过。
