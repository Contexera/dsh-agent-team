# 05 — 撤销成员管理（Remote + Client UI）

**What to build:** 移除「人工管理 Channel 成员」这件事：`joinChannel` / `removeChannelMember` 的对外 Remote 入口删除，Client 里对应的「管理成员 / 成员面板增删」UI 控件移除。Channel 成员关系此后完全由参与派生（票 03），不再有人工增删入口。这些操作的账本 apply/validate 分支**保留**，供旧账本 replay。

**Blocked by:** 03（可见范围先改为派生，删掉人工加入才不会让已拉入的 Agent 从 team_view 消失）

**Status:** complete（2026-10-12，@Tars）

- [x] 对外不再有「加入/移除 Channel 成员」的 Remote 调用路径与 Client 控件；UI 上找不到管理成员入口。
- [x] 旧账本里的 channel-member-joined / removed 操作仍能加载、replay，不抛错（apply/validate 分支保留）。
- [x] 删 UI 后 `npm run test:browser` 通过；桌面与 390×844 两档截图确认无「管理成员」控件残留，且成员/频道面板的 loading / empty / error 状态、键盘与焦点可达性正常。
- [x] 影响到的 maintained 文档（host-authority / client-and-remote / domain-model 等按 docs/AGENTS.md 路由）与受影响 package README、测试在同一改动内更新；中英文档对保持同步。
- [x] 相关单测/组件测试通过。

**实现备注：** ledger 的 `joinChannel`/`removeChannelMember` 方法与 index.ts 的两个 Remote 入口、Client 的 `team-membership.ts`、Channel 页「管理成员」弹层、编辑频道成员区、侧栏成员菜单项全部移除；apply/validate 分支未动。测试侧改为「冻结旧账本」回放：真实历史操作在删除入口前用 HEAD 源捕获、以字面量固化进 agent-team.spec.ts（`legacyRemovalLedger` / `legacyJoinLedger`），验证旧账本仍可加载、validate、repair、防伪造；operation-protocol 两个 kind 转 `replayOnly` 行。`test:browser` 6/6 过，截图无管理成员控件。文档：domain-model（Channel 定义 + 参与层级）、model-and-time、sidebar-browser、components（中英对）、两份 package README、CHANGELOG（Unreleased）。
