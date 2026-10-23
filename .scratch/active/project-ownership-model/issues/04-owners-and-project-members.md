# 04 — Agent owner 与 Project member 派生

**What to build:** Human 能在项目设置里给项目指定、撤销 Agent owner；Human 恒为 owner 且不可移除；被指定的 Agent 立即收到通知。项目可见性改由 Project member 派生规则决定，旧数据下 Agent 能看到的项目不减少。`team_view` 的项目行显示 owners 与“我的角色”，每轮 context 带“你是哪些项目的 owner”。

**Blocked by:** 03

**Status:** complete

- [x] `team/project-owner-added` / `team/project-owner-removed`（Human actor，`{ workspaceId, projectRef, memberId }`）；目标须为参与该 Workspace 的 enabled/suspended Agent；Human 不能被增删；写入与回放共用同一条规则；只在规则版本 ≥ 2 的段内合法。新 owner 的通知暂为提交后的运行时 notice（Main stream marker 在 05 有了 Main stream 之后替换），丢失时由 member-context 的 owner 块重新呈现
- [x] 成员离开 Workspace、归档、删除时由同一 operation 移除其 owner 身份（投影派生，记录不加 `ownerRemovals` 字段：结果可由 operation 本身确定，v3 的 transfer snapshot 再落盘）；暂停不影响
- [x] Project member：规则版本 ≥ 2 时在原有派生（旧显式 membership ∪ Workspace 内的 Thread 参与）上加 owners 与被 mention 者，并排除 archived/inactive；版本 1 行为不变（`@all` 展开仍用旧集合）。冻结的旧 ledger + 写入者/被点名者/旁观者在采用版本 2 前后对比，可见集合不减少
- [x] Human 项目编辑对话框的「负责人」区块（`view.rulesVersion >= 2` 才渲染）；`team_view` 项目行带 owners 与 `you: owner|member`（同样只在版本 2）；`member-context` owner 块（版本 2 起常驻，空列表也渲染以替换旧内容，随整段文本去重）

验证：版本 2 尚未对真实 ledger 启用，因此浏览器验证通过预览开关 `DSH_AGENT_TEAM_PREVIEW_RULES=1` 在临时 profile 上进行；该开关会让 ledger 无法被不带它的构建打开，只用于一次性 `DSH_HOME`。
