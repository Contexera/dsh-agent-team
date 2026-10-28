# 01 — Thread 普通更新改由 Attention 决定是否立即唤醒

**What to build:** 一个 Agent follow 了某个 Thread 后，别人发的每条普通消息都立即唤醒它；不 follow 则完全不产生普通未读。同一个 Agent 在是否 Project owner 上得到完全相同的待遇——身份不再改变 Thread 普通消息的投递速度。Owner 的「攒 5 条才打断」这一档取消，被 @、被回复、责任 Activity 和 Task reminder 的到达不受影响。

**Blocked by:** None — can start immediately

**Status:** complete

- [x] Thread 普通消息的投递判定只看「该 Member 是否 follow 这个 Thread」；`owns(projectRef)` 从该判定中移除，Project owner 与非 owner follower 得到同一结果
- [x] follow 后 1 条普通消息即产生唤醒；不 follow 时普通消息既不产生未读也不唤醒
- [x] 未读推导（Inbox 计数、剩余未读数、读后水位推进）与投递判定使用同一个 Attention 事实，两者不会出现「有计数但从不唤醒」或「唤醒了却读不到」的分歧
- [x] @、回复自己的消息、责任 Activity、Task reminder 四条路径的投递等级与到达结果不变，有测试锁定
- [x] `INBOX_THRESHOLD_UPDATES`、threshold 触发档与 owner 特殊文案从投递路径中消失；测试不再表达「owner 攒 5 条」
- [x] 移除 owner 的 5 条 threshold 不破坏同一 Member 在多个 Thread、多个 Project 下的有界合并：一次唤醒的通知仍是有界、可重派生、可去重的
- [x] 投递判定与通知文案在单测覆盖下改完；`docs/team-collaboration/attention-and-messaging.*`、`docs/architecture/host-authority.*`、core skills 中描述旧投递等级与 owner threshold 的段落同步更新，`CHANGELOG.md` 记录该用户可见变化

## 实施说明

- `planInboxDelivery` 只剩一个投递等级；`InboxDeliveryInput` 不再接受 `owns`，`InboxDeliveryPlan` 不再输出 `summarizedThrough`。
- 进程内 `summarizedThrough` 的读写随 01 一并摘除（`InboxNoticeDelivery`、`coverInboxFacts`、`beginInboxDelivery`、`dropInboxCoverage`），因为它已无数据来源；02 的剩余工作是确认 `covered` 单独足以承担去重与重试，并补对应测试。
- 通知文案里的 `Your role:` 保留（说明该 Thread 为何进入视野），删去 `Delivery: immediate/threshold` 一行；Main stream 段落的 `Delivery: immediate` 一并删除。
- 连续多条 commit 不会叠加通知：未读的上一条通知被替换而非追加（`removeExpectedTeamWake` 路径保持）。
