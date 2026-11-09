# issue #64 与当前 Team 行为（2026-11-09，Team `261b888`）

[issue #64](https://github.com/Contexera/dsh-agent-team/issues/64) 请求模板和批量添加成员，报告跨 Workspace 引入后还在沿用原会话。维护者解释引入是让同一个 Agent 跨 Workspace 工作，提出由一个 Agent 创建并管理全局 Agent。当前设计承接后一个提议。

| 现有行为 | 对设计的影响 | 证据 |
| --- | --- | --- |
| 引入只改变 Workspace 参与，不创建或移动 Session；同名 handle 可存在于参与范围不重叠的 Workspace。 | 组建新团队用创建，复用现有成员要确认目标 Workspace 和稳定 member ref。 | [领域模型](../../../../docs/domain-model.md)、`ledger.ts` 的 `joinWorkspace` 与 handle 校验 |
| Web 创建显式选模型，固定传 `team-member`。Host 请求结构接受 preset 字符串，已提交后才尝试挂载和激活。 | 管理工具只提供 `team-member`；模型目录沿用 Session controller 的 `modelCatalog()`。现有成员创建入口也须提前拒绝 `team-owner`，否则会留下无法用作成员的账本记录。已创建与已激活分别报告。 | `TeamAgentsPanel.tsx`、Client `index.ts` 的 `loadModels`、Host `index.ts` 的 `addMember` / `activateMember` |
| Host 当前主要校验 provider 注册和部分 effort，模型元数据查询失败可能放行。 | 管理工具用 Harness 已有模型目录核对新指定的路线，区分未知路线和目录失败；已提交回执的重放不重新受此检查。 | Host `index.ts` 的 `assertModelRoute`；Harness `packages/api/session-controller/src/catalog.ts` |
| `createProject` 支持初始成员，校验目标 Workspace 参与；撤掉 owner 与退出 Project 是两件事。 | 可以先建成员，再用已有操作创建带初始成员的 Project，最后授予 owner；授予只要求目标 Workspace 参与和合格的状态，授予本身也构成 Project 参与；撤 owner 不一律清空 Task 责任。 | `ledger.ts` 的 `createProject`、`projectOwnerChangeProblem`、`accountabilityReturnsFrom` |
| Human Remote 的成员更新要求 handle 和 description，能力更新先保存、后在轮次边界应用。 | 工具的局部更新要在同一 Host 操作内合并字段，不能拿工具旧快照补齐；要报告已保存但还没应用的结果。 | `types/requests-results.ts` 的 `AgentTeamUpdateMemberRequest`、Host `index.ts` 的 `updateMember` |
| 暂停与恢复是现有 Host 操作，当前没有 Web Remote 或按钮。 | 管理工具直接复用 Host 操作；与 Web 行为对比只适用于两边都有的操作。 | Host `index.ts` 的 `suspendMember` / `resumeMember`；Client `index.ts` 的 Remote 绑定 |
| 永久移除是 Host 内部操作，会删成员的私有目录。Web Client 没有永久移除 Remote 或按钮；归档保留数据。 | 不提供永久移除工具，也不能把 Human 指向不存在的 Web 操作。 | Host `index.ts` 的 `removeMember`、`archiveMember`，Client `TeamAgentsPanel.tsx` |
| 成员鉴权绑定 Host 持有的活 Agent；写操作可在成员队列和账本队列等待。 | 管理权限也绑定当前活 Agent，在写入接收前检查撤权，不能只在工具开始时查 Session id。 | Host `index.ts` 的 `memberForAgent`、`enqueueLifecycle` / `enqueueAddition`，`ledger.ts` |
