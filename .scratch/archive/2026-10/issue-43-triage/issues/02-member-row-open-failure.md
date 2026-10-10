# 02 — 成员行点击失败不再被静默吞掉

**What to build:** 点一个成员行、而这次打开失败时，界面要么成功切换要么给出提示——不再出现「侧栏高亮已经切走、座位没动、也没有任何报错」的状态。

**Blocked by:** None — can start immediately
**Status:** complete

背景：`openMemberSessionImpl`（`packages/client-agent-team/src/client/index.ts`）先
`enterMemberSession()` 改导航快照、再 `ctx.layout.selectPanel(null)`，最后才
`ctx.uiWorkspace.openSession(sessionId)`。而 `openSession` 的契约是同步 `void`
（`ui-workspace/src/client/navigation.ts`），内部 `replaceMain` 首行 `sessions.retain`
在该 id 不在 Client 目录时**同步抛** `sessions.retain: unknown session <id>`。
新成员的 sessionId 由 Host 生成，Client 要等 `api-session/added` 才知道，
所以「成员刚创建而目录未刷新」这个窗口是真实存在的。

- [x] `openMemberSessionImpl` 包住 `openSession`，捕获失败
- [x] 失败时回退导航快照：`enterMemberSession(snapshot.memberSessionId)` 或 `exitMemberSession()`
- [x] 上行一条可见提示（沿用行已有的 rowAlert 通道，新增 locale 键 `openAgentSessionFailed`）
- [x] `memberSessions.add(sessionId)` 保持原位置——改它会改变 `returnTo` 的计算，
      曾因此让正常路径的 `aria-current` 失效（回归测试已抓住）
- [x] 测试：`packages/client-agent-team/tests/agent-row-open-failure.client.spec.tsx`
      （两条：失败时有 alert 且不高亮；成功时无 alert 且高亮）
- [x] 回归：`packages/client-agent-team` 282 passed / 0 failed
- [x] CHANGELOG `Unreleased` 记一条 Fixed

补记：`slots.ts` 的 `openMemberSession` 类型加了可选第二参 `reportFailure`，
两个 slot 面（侧栏、会话）都同步了。
