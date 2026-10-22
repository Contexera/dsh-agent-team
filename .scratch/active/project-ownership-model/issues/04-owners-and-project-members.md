# 04 — Agent owner 与 Project member 派生

**What to build:** Human 能在项目设置里给项目指定、撤销 Agent owner；Human 恒为 owner 且不可移除；被指定的 Agent 立即收到通知。项目可见性改由 Project member 派生规则决定，旧数据下 Agent 能看到的项目不减少。`team_view` 的项目行显示 owners 与“我的角色”，每轮 context 带“你是哪些项目的 owner”。

**Blocked by:** 03

**Status:** pending

- [ ] `team/project-owner-added` / `team/project-owner-removed`；目标须参与该项目所在 Workspace；Human 不能被移除
- [ ] 成员离开 Workspace、归档、删除时同一 operation 移除其 owner 身份；暂停不影响
- [ ] Project member 按 spec §2 派生，取代旧的 Channel 可见性判断；用真实形状的旧 ledger 证明 Agent 可见集合不减少
- [ ] Human 项目设置页增删 owner；`team_view` 项目行与 `member-context` owner 角色块（内容不变不重复注入）
