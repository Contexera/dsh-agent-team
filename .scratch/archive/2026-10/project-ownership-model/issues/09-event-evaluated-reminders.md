# 09 — 待验收积压与停滞提醒

**What to build:** Task 在待验收状态等太久、或进行中长时间没有进展时，应负责的人收到一次提醒；同一件事不重复提醒，Host 重启也不会。提醒只在团队有事件发生时检查，Host 不自己计时。

**Blocked by:** 08

**Status:** done

- [x] 条件、评估点、episode 去重按 spec §9 与 durable contract §2.6（原工单 04 全部验收项保留在 `materials/superseded-issues/04-event-evaluated-reminders.md`）
- [x] `model-and-time` 双语文档改写为“时间条件只在事件发生时评估，Host 不自行计时”

## 实施记录（2026-10-25）

- Host 在 Team 事件后合并评估，不启动 timer；同一轮使用同一 `nowMs`。Agent 只使用当前 Host 进程可确认的 idle 起点，重启后为 unknown。
- 新增 Host-only `team/reminder-raised`。完整 episode 跨重启保留；私有未读 marker 只随所属 Task Thread read 消费，Inbox 与看板不消费。
- 责任 activity 未读时抑制且不消耗 episode；accept、close 与成员/Project 生命周期清理失效 marker。reminder 不进入公开 facts、不推进 revision、不移动状态或活动 baseline。
- Agent 的 reminder-only Inbox 更新走 direct + immediate wake；Human 由 Task Thread change scope 刷新。Inbox 显示待验收或停滞原因，系统提醒不使用 Human 头像。
- 同批补齐来源讨论的 Agent Task 卡（按创建 sequence 插入，卡片是当前投影而非 fact）及 Human 的「负责人已暂停」显示。
- 独立 review 后修复：成员移除/归档/离开与项目归档时补齐提醒 marker 清理（重放校验同步收紧）；写入边界重新核对候选，进展交错时不再发出过时提醒；`team_thread` read 呈现已确认的提醒并计入 acknowledged，reminder-only 唤醒不再回答「没有未读」；提醒评估只由事件入口触发，消除每次唤醒的重复全表扫描；暂停负责人不再阻断 Human 待验收提醒；Inbox 预览与最新来源判定一致。
- 最终验证：1279 单测通过、1 跳过；typecheck/build/lint、文档/注释/包边界检查通过；真实 Web 8/8；真实共享账本 24565 条完整重放通过。
- 首次以真实账本计算且 Agent idle 全为 unknown 时有 4 个 Human-time 候选（3 stalled、1 review-backlog）；评估只有事件入口，因此不会由计时器主动补写。
