# DSH 0.2.2 alpha 变更调研（对 dsh-agent-team 的影响）

调研日期：2026-11-04。证据基线：`../deepseek-harness` 仓库 tags `dsh-v0.2.1-rc.5`、`dsh-v0.2.2-alpha.2`、`dsh-v0.2.2-alpha.3`，以及 npm `@deepseek-ai/dsh` 的发布记录与 dist-tags。

## 版本事实

- tag 有三个：alpha.1、alpha.2、alpha.3；**alpha.1 未发布到 npm**（npm 上只有 alpha.2，2026-10-27；alpha.3，2026-11-03）。
- 当前 dist-tags：`latest = 0.2.1-rc.5`，`next = 0.2.1-rc.5`，`alpha = 0.2.2-alpha.3`。
- 本仓库 `engines.dsh: ">=0.2.1-rc.2 <0.2.2"`，当前挡住所有 0.2.2；devDep `@deepseek-ai/dsh-storage-sqlite` 固定在 `0.1.5-rc.2`（npm 已有 0.2.2-alpha.2/3 版本）。
- 官方 upgrade guide 目录：Harness `docs/upgrade-guide/v0.2.2-alpha.2/`，共 13 篇。

## 变更摘要（按与本项目的接触面）

### 1. Session Projection 改造（影响最直接）

相关提交：#7347（`fcca540841`，alpha.2）、#7587（`945006c984`，alpha.3）、#7754（`eb1713f856`，alpha.3）。

- `sessionProjections.stateOf(session, key)` 标记 **deprecated**，仍可用但每次首读打 warning。新路径：`await register(definition)` 返回 `ProjectionHandle`，用 `handle.stateOf(session)`。`register()` 可能执行异步工作，官方要求 await 后再发布消费者。
- 本仓库两处受影响调用：
  - `packages/agent-team/src/index.ts` 中读自有 `contextContinuity` key——可直接改为保存 handle。
  - 同文件 `measureStoredContext` 里读 `agent-loop` 的 `'inbox'` key——官方指引是改用 owning domain service；Harness 自身处理同类读取的方式可参考 agent-preset-registry 的迁移（改走 `ctx.agents.turnBoundaryOf()` 一类 domain 方法）。
- 本仓库的注册处（`Service.init` 内 `ctx.effect(() => register(...))`）未 await 返回值，需按新契约调整为持有 handle。
- `checkpoint()` 语义变化：unit 释放后行**保留**为 predecessor（不再删除），优雅重启不再丢 Web 层投影值。凡是断言"释放后 key 从 checkpoint 消失"的测试会失败；官方迁移指引见 upgrade guide `projection-released-checkpoint`。
- 投影帧合并（`projection-event-frames` guide）：一个 committed event 一帧，`{key, value}` 变 `changes[]`。本仓库 Client 走自有 `remote.agentTeam` Remote，不直接读 `session/control` / `session/observeProjections` 流，无直接影响；若测试 harness 直读这些流则需迁移。
- 快照作用域（`projection-snapshot-scope` guide）：`snapshot(session, keys)` 只计算返回的 units；registry 的 `cachedSnapshot` deprecated；`session.list` summary 不再带 `contextBreakdown` / `contextPressure`。本仓库未直接依赖这三者。
- 第三方 key 变动：`agentPreset` 的 StateMap 声明被移除（迁移到 handle）；`turnBoundary` 改走 `ctx.agents.turnBoundaryOf()`。本仓库未直接读这两个 key。
- 新增 `onEventChanged` 事件级监听与 `readerFor`。

### 2. fork / parentSession 语义收窄

相关提交：`b096659245`（alpha.2）。

- `SessionHeader.parentSession` 语义收窄为"subagent 的直接创建者"；普通 fork 不再写该字段；消费方分类改用 `origin === 'subagent'`。
- 本仓库在 Member 换代 Session 时写 `parentSession`（`agents.create` 的 meta，用于崩溃恢复时回溯 lineage）。Member Session 无 `origin: 'subagent'`，按新规则会被当作"历史普通 fork"容忍——不会从列表消失，不破坏。
- 但语义上该字段现在陈述"此会话是某 subagent 的孩子"，与我们的用途（记录换代前序）不再一致。升级适配时需重新评估：是否继续写、是否换记录方式（如仅依赖 ledger 的 `previousSessionForMember`）。附带事实：ui-workspace 的会话树不再按 fork 关系重排（`placeFork` 逻辑删除）。

### 3. 文件系统默认行为翻转

相关提交链：alpha.2 引入 observation policy 默认开启 → alpha.3 中途默认开 apply_patch → `e1609fe164`（"temporarily disable"）。

- **alpha.3 最终态**：`fs-observation-policy` 行默认 `disabled: true`（write 不再要求先读、edit 不再拒绝外部变更文件）；`applyPatch: false`（dsh-base 与 Web standard preset 均为 false）。
- 本仓库 `team-member` preset 的 `tool-fs` 行未写 config，默认跟走：Member 将失去"先读后写"约束。
- 待拍板：Member 是否保持先读后写（保持则 preset 显式 `- {id: fs-observation-policy, disabled: false}`）；是否给 Member 开 apply_patch。
- 新增工具形态：`apply_patch`（hunk 上下文匹配）、guarded patch delete/move、workspace-changes 捕获每个 patch 路径。Web 标准 preset 的开关联动见 upgrade guide `fs-observation-policy-default-off`。

### 4. 新扩展点（可直接受益）

- **`settings.section.icon` slot**（`516ca64acb`，#7624，alpha.3）：设置导航图标的官方扩展点；注册 id 须等于目标 section id。本仓库 `packages/client-agent-team/src/client/settings-nav-icon.ts` 的 MutationObserver DOM hack（文件头注释自述"Remove the whole thing once the Harness exposes an icon on settings.section"）可整体删除替换。
- **结构化 context menu**（`411f157983` 等，alpha.2–3）：`ctx.contextMenus` 贡献体系 + `ContextMenuTargetMap` 声明合并（workspace / directory target 已内置）；`openResource` 新增 `destination: 'sidebar' | 'float'`；`sidebar.session.row.trailing` 新 list slot（非交互图标，hover 时隐藏）。注意 **breaking**：`MenuTarget` 改名 `ContextMenuTarget`、`menuTarget`/`useMenuTarget` 改名 `contextMenuTarget`/`useContextMenuTarget`，无兼容别名（upgrade guide `context-menu-target`）。本仓库未用旧名，无迁移成本；给 Team 的 Workspace/Project 列表加右键操作有了正规路径。
- **`getPendingRemoteEvents()`**（`a1473ddec6`，alpha.2）：Gateway 可查询未结算的 forwarded Remote 事件（event 名 + agentId），排障可用。

### 5. Preset / Subagent 行为（我们是重度消费者）

- 委派工具按 preset revision 共享注册，不再逐 Agent 安装（`f78984a497`）；新增 `agent-preset/prepare` serial 事件用于准备共享注册。
- preset 引用延迟到启动子 Agent 时才解析（`90e398328d`）。
- 方向：共享 preset（正是 team-member 模式）激活更快更稳。预期纯收益，升级后需跑 Member 激活相关测试确认。
- session format v0 迁移支持 subagent descriptor v1/v2（`dffda31215`）——与本仓库无直接接触。

### 6. 其它

- **Loader/Include journal**（`db1a3b3754` 等）：`EntryTree.write()` 删除改 `commit(change)`；Include 用 journal 与文件调和；**patch 拥有的运行时改动不再在重启后存活**（此前整个 patched tree 会写回 cordis.yml）。本仓库不 subclass EntryTree；但运行时改 patch 行的设想（如有）需重新考虑。
- **多语言**：新增 ja/es/fr/de/ru/pt 五种 UI 语言（含 settings 语言行、layout shortcuts 等）。本仓库只注册 zh/en 字典，未注册语言回落英文，不阻塞；补齐为可选后续。
- **cordis 接受带冒号的 entry id**（`9a26b453c3`）：对 Typert 生成的 bundle 是修复，有利无害。
- **移动端侧栏 drawer 化**（`788bae3674`）+ chat transcript 稳定性修复（`ae07093132`）：本仓库 `TeamWorkspaceBrowser` 接管 `sidebar.workspaces`，升级后需 `npm run test:browser` 回归。
- **composer prefill API**：alpha.3 中加了又 revert（`5c2826eae5`），净零变化。
- llm 请求 purpose 改为声明合并（`LlmRequestPurposeMap`）：本仓库未直接构造带 purpose 的请求，不受影响。
- 富文本引用与草稿恢复（`0e49f443dd`，基于 user-text）：影响 ui-conversation / ui-chat 的 composer 交互；本仓库 TeamComposer 是独立实现，暂无直接依赖，但 Team 内嵌 Member 会话走宿主 conversation 座位，升级后需目检。

## 适配清单（rc 后逐项重核）

1. `engines.dsh` 放宽（区间待定）；devDep `@deepseek-ai/dsh-storage-sqlite` 同步升级。
2. 迁移两处 `stateOf` 调用 + `Service.init` 中 await registration handle。
3. 删除 `settings-nav-icon.ts` DOM hack，改注册 `settings.section.icon`。
4. 拍板 team-member preset 的 fs-observation-policy / apply_patch 取向。
5. 评估 `parentSession` 写入是否仍符合新语义（或改为仅依赖 ledger lineage）。
6. 全量 `npm run test:browser`（侧栏 drawer、context menu、chat 渲染均有变动）。
7. （可选）补齐五语言字典；（可选）给 Workspace/Project 列表接 `ctx.contextMenus`。

## rc 后待重新核对的点

- rc 与 alpha.3 之间的增量 diff（尤其 fs 默认值的最终态——`e1609fe164` 自述"temporarily"，rc 可能再翻转）。
- upgrade guide 目录是否新增 v0.2.2-rc.x 层级。
- `@deepseek-ai/dsh-storage-sqlite` 是否有对应 rc 版本。
