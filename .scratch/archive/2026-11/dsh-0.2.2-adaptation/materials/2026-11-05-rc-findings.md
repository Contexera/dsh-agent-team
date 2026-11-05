# DSH 0.2.2-rc.1 变更调研（对 dsh-agent-team 的影响）

调研日期：2026-11-05。

证据方式：只读。`../deepseek-harness` 停留在 tag `dsh-v0.2.1-rc.2`，未切换、未修改；所有上游文件内容通过 `git show <tag>:<path>`、`git grep <tag>`、`git diff <tagA> <tagB>` 读取。发布事实来自 `npm view`、`npm pack` 解包后的 `package.json`、`gh release view dsh-v0.2.2-rc.1`。本仓库代码用当前工作树核对。

## 1. 版本事实

| 项 | 值 | 来源 |
| --- | --- | --- |
| tag | `dsh-v0.2.2-rc.1`，commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db` | `git log -1 dsh-v0.2.2-rc.1` |
| tag 时间 | 2026-11-04 15:54:45 +0800（release 合并提交） | 同上 |
| GitHub release | `v0.2.2-rc.1`，published 2026-11-04T13:07:14Z，prerelease | `gh release view dsh-v0.2.2-rc.1` |
| npm `@deepseek-ai/dsh@0.2.2-rc.1` | published 2026-11-04T09:20:32Z | `npm view @deepseek-ai/dsh time` |
| npm dist-tags | `latest = 0.2.1-rc.5`，`next = 0.2.2-rc.1`，`alpha = 0.2.2-alpha.3` | `npm view @deepseek-ai/dsh dist-tags` |
| `@deepseek-ai/dsh-storage-sqlite` | `0.2.2-rc.1`（published 2026-11-04T09:23:07Z）；dist-tags 为 `latest = 0.0.1-rc.1`（陈旧值）、`next = 0.2.2-rc.1`、`alpha = 0.2.2-alpha.3` | `npm view` |
| Node 要求 | `engines.node >= 24.9.0` | tag 根 `package.json`；npm tarball 内 `package/package.json` 一致 |
| 宿主 vendor 版本 | cordis `~4.1.0`、loader `~1.1.0`、include `~1.1.0`、timer `~1.2.0`、schemastery `~3.19.0` | npm tarball `package/package.json` 的 dependencies |
| 0.2.2 线已有 tag | alpha.2、alpha.3、rc.1；无 alpha.4、无 rc.2 | `git tag -l 'dsh-v0.2.2*'` |
| npm 上 `0.2.2-rc.1` 的 dsh-* 包 | `dsh-tool-fs`、`dsh-fs-observation-policy`、`dsh-session-projection`、`dsh-storage-domain`、`dsh-agent`、`dsh-client-ui-sidebar`、`dsh-agent-preset-registry`、`dsh-typert-protocol` 均已发布该版本 | 逐个 `npm view ...@0.2.2-rc.1 version` |

本仓库当前状态：`engines.dsh = ">=0.2.1-rc.2 <0.2.2"`；peerDependencies 里 50 余个 `@deepseek-ai/dsh-*` 同为 `>=0.2.1-rc.2 <0.2.2`；devDep `@deepseek-ai/dsh-storage-sqlite = 0.1.5-rc.2`；`node_modules` 中全部 dsh 包为 `0.2.1-rc.2`，cordis 为 `4.0.5`。

## 2. alpha.3 → rc.1 的增量

- 提交数 4，其中 2 个合并提交：`#7790`（alpha.3 线的 vendor 发布分支）、`#7870`（rc.1 发布）。alpha.3 tag 指向 vendor 分支上的 `05b1cae8db`，其主分支父提交为 `b3f1904e86 (#7724)`，之后是 `41ef8c47a3 (#7790)`、`66491b05e3 (#7870)`。
- `git diff --stat dsh-v0.2.2-alpha.3 dsh-v0.2.2-rc.1` 结果为 387 个文件、387 行增、387 行删，全部是 `package.json` 里的一行版本号。**没有源码、配置、文档内容改动。**
- 唯一实质变化是 vendor 从预发布转正：`cordis 4.0.6-alpha.2 → 4.1.0`、`cosmokit 1.8.7-alpha.2 → 1.9.0`、`group 1.0.6-alpha.2 → 1.1.0`、`hmr 1.0.21-alpha.2 → 1.1.0`、`include 1.0.11-alpha.2 → 1.1.0`、`loader 1.0.7-alpha.2 → 1.1.0`、`logger-console 1.0.6-alpha.2 → 1.1.0`、`schemastery 3.18.6-alpha.2 → 3.19.0`、`timer 1.1.8-alpha.2 → 1.2.0`。提交 `60d811de43`。
- 结论：alpha 阶段对 alpha.3 源码的判断在 rc.1 仍然成立；需要新增核对的是 vendor 转正（cordis 4.1.0）与 rc 之后的最终默认值，而不是新的功能提交。
- upgrade guide 目录：rc.1 树上 0.2.2 相关的 guide 放在 `docs/upgrade-guide/v0.2.2-alpha.2/`（13 篇）和 `docs/upgrade-guide/v0.2.1-rc.2/`（`session-projection-handles`、`conditional-tools` 等，源码核对后确认描述的是 0.2.2 的变更）；**没有 `v0.2.2-rc.1/` 目录**，rc.1 自身未新增 guide。按 `.agents/skills/dsh-create-upgrade-guide/SKILL.md`，目录名取写 guide 时的根 `package.json` 版本，因此目录名不等于“破坏发生在哪个版本”；判断真实归属要以源码 tag 为准（下文对 `session-projection-handles`、`conditional-tools` 都做了这种核对）。

从当前认证基线 `0.2.1-rc.2` 到 rc.1 共 2642 个提交；rc.1 的 release notes 是对比 `dsh-v0.2.1-rc.5` 写的，所以 rc.2→rc.5 之间的三段变更（`v0.2.1-rc.3`、`v0.2.1-rc.4` 的 guide）也在同一批接触面里，不能只看 0.2.2 的 guide。

## 3. 按接触面的事实

### 3.1 fs 观察策略与 apply_patch 的最终默认值

- rc.1 的 `packages/bundle/base/cordis.patch.yml:292-300`：`fs-observation-policy` 行带 `disabled: true`，其后的 `tool-fs` 行 `config.applyPatch: false`。
- rc.1 的 `packages/bundle/web-app/presets/standard.patch.yml:31`、`presets/cordis.patch.yml:34`、`presets/ptc.patch.yml:31`、`apps/cli/config/examples/ptc.yml:10` 全部为 `applyPatch: false`。
- `packages/fs/tool-fs/src/index.ts:53` 的 schema 默认值是 `z.boolean().default(false)`，所以未写 config 的行（我们的 `team-member` preset 就是这种）拿不到 `apply_patch`。
- 最后一次改动默认值的提交是 `e1609fe164`（2026-11-02，`fix(fs): temporarily disable apply_patch in shipped defaults`，只改 base 与 Web standard 两行）；rc.1 之前没有提交再把它打开（`git log -S'applyPatch: true'` 无更新的提交）。提交信息里的 “temporarily” 没有说明条件或期限。
- 官方文档与配置冲突：rc.1 树上 `.agents/notes/implemented/feature/2026-10-29-shipped-fs-mutation-defaults.md:13`、`docs/upgrade-guide/v0.2.2-alpha.2/fs-observation-policy-default-off/guide.md`、`docs/tool-catalog.md:33` 仍写 “`dsh-base` 与 Web standard 的 `applyPatch` 为 `true`”。**以配置为准：rc.1 交付的是 `false`。**
- release notes（英文）明确写了 “Add `apply_patch`, disabled by default” 与 “Disable read-before-write and external-change checks by default while retaining sandbox limits and Review”。
- `fs-observation-policy` 是纯事件插件，不注册服务；它占用 `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 三个**单决策槽**且不调用 `next()`（`packages/fs/fs-observation-policy/src/index.ts:115-141`）。其 README 写明“shipped compositions leave it off”。
- 我们的现状：`cordis.patch.yml` 的 `team-member` preset 既没有 `fs-observation-policy` 行，也没给 `tool-fs` 写 config。0.2.1-rc.2 的 `packages/bundle/base/cordis.patch.yml:292` 是无 `disabled` 的挂载行，所以当前 Member 的先读后写来自宿主平面的这一行；rc.1 把该行禁用后，Member 不再有该约束。
- 是否能在 preset 内单独挂一个 `fs-observation-policy` 实例来只约束 Member：未确认。单决策槽 + agent 作用域事件订阅能否成立需要实测（见“未确认”）。

### 3.2 Session Projection：register/handle/stateOf、checkpoint

- rc.1 `packages/session/session-projection/src/index.ts`：`register(definition)` 返回 `Promise<ProjectionHandle<S>>`；运行时值是可调用的 thenable（仍可当 disposer 调用，但该用法已弃用）；`ProjectionHandle` 提供 `stateOf(session)`、`readerFor(session)`、`dispose()`（`:51-78`、`:322-340`）。
- registry 级 `stateOf(session, key)` 仍存在，返回 `unknown`，每个 key 每个 registry 首读打一次 warning（`:449-470`，源码内 `@deprecated` 注释）。
- `SessionProjectionStateMap` 已移除，`SessionProjectionMap` 保留（`src/types.ts:42`）。
- 该变更确实属于 0.2.2，而非 `v0.2.1-rc.2` 目录名暗示的 0.2.1 线：`dsh-v0.2.1-rc.5` 的同一文件仍是旧的同步 `register` + `SessionProjectionStateMap`，`dsh-v0.2.2-alpha.2` 起才有 `ProjectionHandle`。
- 我们受影响的三处：
  - `packages/agent-team/src/index.ts:895` 在 `[Service.init]` 内用 `ctx.effect(() => register(...))`，没有 await，也没有保留 handle。
  - `packages/agent-team/src/index.ts:530` 读自有 `contextContinuity` key（可改为 handle.stateOf）。
  - `packages/agent-team/src/index.ts:689` 在 `measureStoredContext` 里读 `agent-loop` 的 `'inbox'`。`inboxProjectionDefinition` 是包内定义（`packages/core/agent-loop/src/inbox.ts:26`）；`dsh-agent-loop` 的 package exports 只有 `'.'`，其 index 也未导出它。rc.1 的 `AgentRegistry` 只补了 `turnBoundaryOf()`（`packages/core/agent/src/index.ts:306`），没有对应的 inbox 读法，所以“改用 owning domain service”对 `'inbox'` 没有现成路径。
- checkpoint 释放语义：guide `v0.2.2-alpha.2/projection-released-checkpoint` 说明释放的 unit 保留为 predecessor，`checkpoint(session)` 仍返回最后一行，但不再推进；新 Session 不建 cell；unit 退出 `snapshot()`、`summaryKeys()`、`restoreFloor()`、`restore()`、`viewCheckpoint()`、`hydrate()`。本仓库不调用 registry 的 `checkpoint()`（已 grep 确认），该项对运行时代码无直接接触；只影响“释放后 key 消失”这类测试断言，我们目前没有此类断言。

### 3.3 模型选择：`installModelSelection` 与 `ModelSelectionRef`（alpha 调研未覆盖）

- rc.1 `packages/core/agent/src/runtime-types.ts:197` 给 `Agent` 增加 `readonly model: Model`。
- rc.1 `packages/core/agent/src/model-selection.ts:157`：`installModelSelection(agentCtx)` 只保留一个参数，用于安装“模型切换提示”的 pre-step 监听；第二个参数与 `ModelSelectionRef` 类型都已删除（0.2.1-rc.2 是 `installModelSelection(agentCtx, selection: ModelSelectionRef)`）。
- 新的选择入口是 `AgentModel.select(selection)`（同文件 `:112`），它把 `model/selection` 事件写进会话日志。
- 路由固定：rc.1 `packages/core/agent-loop/src/agent.ts:636-639` 在 `agent/request` 之后校验，若 proposed 的 provider/model/reasoningEffort 与步骤开始时固定的选择不同就直接抛错，提示改用 `agent.model.select()`。只改 `maxTokens` 不受影响。
- 我们的用法：`packages/agent-team/src/index.ts:17` 导入 `installModelSelection` 与 `ModelSelectionRef`；`:458` 用 `Map<..., ModelSelectionRef>`；`:2675` 构造 `{ current, assembled: undefined }`；`:2687` 传两个参数。升级后类型检查必然失败，运行语义也需要改成 `agent.model.select(...)`。

### 3.4 parentSession / origin

- rc.1 `packages/core/session/src/types.ts:107-122`：`parentSession` 的注释是“子 Agent 会话的直接创建者；普通 fork 省略该字段，历史普通 fork 可能残留源 id；字段存在本身不把会话归类为 subagent，分类看 `origin`”；`origin` 的类型只有 `'subagent'`。
- rc.1 `packages/core/session/src/index.ts:126` 校验：`origin` 不是 `undefined` 或 `'subagent'` 时抛错。
- 普通 fork 不再写 `parentSession`；client 端的 subagent 关系现在要求 `origin === 'subagent'`（`packages/api/session-controller/src/client/sessions/lineage.ts:64`，0.2.1-rc.2 的同位置只看 `parentSessionId`）。
- release notes：`Run ordinary conversation forks independently instead of treating them as subagents, while preserving creator relationships for real subagents.`
- 我们写 `parentSession` 但不写 `origin`（Member 换代时记录前序会话）。rc.1 允许这种写法，不会报错也不会让会话从列表消失，但字段语义已变成“subagent 的直接创建者”，与我们的用途不一致；README/架构文档里的解释会变成错的说法。

### 3.5 工具的按步骤准入（alpha 调研未覆盖，属新破坏面）

- rc.1 `packages/core/tools/src/index.ts:99`：`ToolRuntime` 类改名为 `ToolsService`（末尾保留 `export { ToolsService as ToolRuntime }` 兼容别名，`:412`）。源码核对：`dsh-v0.2.1-rc.5` 仍是无 `when`/`ResolvedToolSet` 的旧实现，本项属于 0.2.2。
- `register(definition, options)` 新增 `options.when`（`:128`）；`AgentLoop` 每步解析一次条件得到 `ResolvedToolSet`，工具声明、Native 分发、PTC 绑定都用这一步的集合（guide `v0.2.1-rc.2/conditional-tools`）。
- `get(name, scope?, toolSet?)`、`schemas(scope?, toolSet?)`、`definitions(...)` 增加了可选的 `toolSet` 参数；新增 `resolve(context)`（`:264`）和 `executable(name, scope?, toolSet?)`（`:251`）。
- `system-prompt/assemble` 不再携带工具数组，返回 `tools` 字段会被忽略；`AssembleContext` 改为携带 `toolSet`。改动工具声明的插件必须迁移。
- `ToolsService.Config` 把 `mode`、`maxParallelSubCalls` 改为 `z.never()`（已移除）；release notes 说 PTC 改为通过配置 overlay 启用。
- 我们的用法：`ctx.tools.register` 均不带 `when`，不受条件准入影响；`packages/agent-team/src/index.ts:2818/2824` 的 `ctx.tools.get('team_message', scope)` 与 `ctx.tools.schemas(scope)` 用在 `validateMemberPreset`（preset 校验，非 prompt 组装回调），拿到的集合与“无 when”一致；`packages/agent-team/src/member-compaction.ts:81` 只监听 `system-prompt/assemble` 做预算裁剪，不读 `assembly.tools`。因此这一项是“应回归”，不是“必须改代码”。

### 3.6 存储：`KvUnit.deleteRecords` 与兼容版本（alpha 调研未覆盖，属必须适配）

- rc.1 `packages/storage/storage/src/backend.ts`：`KvUnit` 新增必需方法 `deleteRecords(table, keys)`（`:140`）；`KvUnitDescriptor.compatibleVersions` 的语义扩到两种 layout，读列出的旧版本时不重写，写入时按当前版本重新打戳；`StorageErrorCode` 增加 `'unknown-state'`（`src/error.ts`）。
- rc.1 `packages/storage/storage-domain/src/domain.ts:80-100` 新增 `KvTable.deleteMany(keys)`；`:366` 通过 `unit.deleteRecords` 批量删除，`unknown-state` 会隔离整个 domain。
- 官方 `storage-sqlite@0.2.2-rc.1` 已实现 `deleteRecords` 与事务化版本打戳（`packages/storage/storage-sqlite/src/unit.ts:123`、`:140-180`）。
- 我们把 `dsh-storage-sqlite@0.1.5-rc.2` 的实现在 `packages/agent-team/src/vendor/storage-sqlite/` 里做了 vendor fork，文件头写明“同步流程见 docs/dsh-release-compatibility.md”，并且 `scripts/sync-paths.mjs:48` 把 `@deepseek-ai/dsh-storage-sqlite` 指向相邻 harness 的源码。rc.1 的 `KvUnit` 要求 `deleteRecords`，我们的 fork 没有它 → 对着 0.2.2 的 `KvUnit` 类型必然编译失败；一旦上层（我们或某个 domain）调用 `deleteMany`，运行时会直接缺方法。
- 我们自己的 domain 目前只用 `delete`/`put`/`update`，没有 `deleteMany`；所以运行时缺口暂时不触发，但类型缺口立即触发，且 vendor 同步是发布适配的固定动作。

### 3.7 settings.section.icon

- rc.1 `packages/client/ui-settings/src/client/contract/slots.ts:59-66` 新增 `settings.section.icon`（`kind: 'list'`、`inline: true`，owner props 为 `{ size, active }`），注释明确“注册 id 必须等于目标 section 的 id，未匹配的 id 不渲染”。
- 渲染处 `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:88-94`：`renderSlot('settings.section.icon', { size: 16, active: row.id === active }, { only: row.id, fallback: navIcon(row.id) })`。
- 我们的 `packages/client-agent-team/src/client/settings-nav-icon.ts` 是 MutationObserver + CSS 覆盖的临时方案，文件头自述“Remove the whole thing once the Harness exposes an icon on settings.section”。我们的 section id 是 `team-settings`（`packages/client-agent-team/src/client/index.ts:461-463`），可以直接对齐注册。

### 3.8 右键菜单

- rc.1 `packages/client/ui-context-menu/src/client/index.ts:23` 提供 `ctx.contextMenus`；导出 `ContextMenuTarget`、`ContextMenuTargetMap`、`ContextMenuIcon`、`useContextMenu`；`contextMenu.icon` 是 keyed slot，action 图标接受 `{ key, src? }`。
- 破坏面：`MenuTarget` → `ContextMenuTarget`，`menuTarget`/`useMenuTarget` → `contextMenuTarget`/`useContextMenuTarget`，无别名（guide `v0.2.2-alpha.2/context-menu-target`）。
- 我们的 client 里没有旧名（已 grep `MenuTarget`/`menuTarget`）；`TeamRowMenu.tsx` 是自有菜单实现，未接 `ctx.contextMenus`。

### 3.9 侧栏与主面板

- rc.1 `packages/client/ui-sidebar/src/client/contract/slots.ts` 新增 `sidebar.panellist.actions`（面板“更多”菜单行）；`SidebarSectionInjected` 增加 `setPinned`、`trackEntryClick`，hooks 增加 `entryPins`、`entryActions`。
- rc.1 `packages/client/ui-workspace/src/client/contract/slots.ts:139-163`：`sidebar.workspaces.directoryFlow`、`sidebar.session.row.leading`（新增 `inline: true`）、`sidebar.session.row.trailing`（新增，非交互图标，hover 时隐藏）、`sidebar.session.row.hover` 保留。
- `sidebar.workspaces`（`kind: 'single'`）与 `sidebar.workspaces.directoryFlow` 的声明未变；`main` 仍是 keyed slot（`packages/client/ui-layout/src/client/index.ts:75`）。
- 我们的接管面：`sidebar.panellist`（`index.ts:127`）、`main`（`:134`）、`sidebar.workspaces` → `TeamWorkspaceBrowser`、`settings.section`（`:461`）。新增的 owner props 对我们是增字段，组件少声明不报错；但 `TeamSidebarProps` 是我们自己抄的镜像类型，需要跟着核对一遍。我们未渲染 `directoryFlow`，也未重复声明子 slot。

### 3.10 引擎与宿主契约

- guide `v0.2.1-alpha.3/plugin-engines-dsh`：插件兼容性判定只看 `engines.dsh`，存在该字段时 peer 规则被忽略；`PluginCompatibility.requirements` 取代旧 `peers`（后者在我们的 0.2.1-rc.2 基线里已经是 `requirements`，不属于新增破坏）。
- `packages/boot/app-boot/src/plugin-compatibility.ts` 的 `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)` 在 rc.1 与 rc.2 完全相同；我们的 `packages/agent-team/src/environment-check.ts` 用法不变。
- 因此引擎区间必须同时改三处：根 `engines.dsh`、全部 `@deepseek-ai/dsh-*` peer 区间、以及 `.github/workflows/ci.yml:45` 的 `DSH_HARNESS_TAG`（`scripts/check-version-consistency.mjs` 要求 peer 与 `engines.dsh` 的下界都等于 CI 里认证的基线）。
- `cordis 4.1.0`：`vendor/cordis/src/fiber.ts`（182 行改动）、`reflect.ts`（56 行）等 8 个文件的改动集中在“原始配置/生效配置分离、service provision 记录、依赖释放”；release notes 表述为“统一配置访问、条目变更和持久化行为”。我们依赖 `isolate: { agentPresets: true }` 的 group 隔离与 `!!js` 延迟表达式，是否有可观察变化：未确认，需要一次真实启动 + `npm run test:browser`。

### 3.11 其它 0.2.2 变更（与本仓库无直接做工作量）

- Node 最低版本 24.9：本机 `node -v` 为 v24.15.0，满足；CI 与文档若写死更低的版本号才需要跟进。
- `@deepseek-ai/dsh-official-bundles` 接管官方组合包列表，app-boot 不再导出；我们只从 app-boot 取 `evaluatePluginCompatibility`/`getDshRuntimeVersion`，不受影响。
- Session API 拆出“读快照”和“持续订阅事件、运行状态、投影”的独立接口；我们不读 `session/control`/`observeProjections` 流。
- Web Fetch 不再拒绝非公网地址（安全姿态变化）；我们的 `tool-web` 行开了 `fetch: true`，Member 的抓取范围随宿主策略放宽。
- `tool-subagent` 有 507 行改动（模型选择、preset 选择重写），我们不用宿主 subagent 工具；但“preset 往返后委派工具暂时缺失”的修复说明这条路径此前不稳，我们自己的 preset mount 不受它保护。
- 新增 ja/es/fr/de/ru/pt 六套界面语言；新增实验插件（`subagent_oar`、Developer tools 统计、变更请求与工作树）、Trajectory/预览等 UI 改动：不构成本仓库的工作项。
- `PTC` 相关的 `ABORTED` 分类、`birpc` 控制通道、SSH 协议 2→3：我们把 Member 固定在 native 呈现（`tool-presentation.mode: native`），不接触 PTC。

## 4. 适配分类

### 4.1 必须适配（不改就跑不起来或类型不过）

1. `engines.dsh` 上限与全部 dsh peer 区间放宽到覆盖 `0.2.2-rc.1`；devDep `@deepseek-ai/dsh-storage-sqlite` 升到 `0.2.2-rc.1`（当前 `0.1.5-rc.2` 与基线也不匹配）。
2. `installModelSelection` 双参调用与 `ModelSelectionRef`：改为单参 + `agent.model.select(...)`；三处引用（`index.ts:17/458/2675/2687`）。
3. vendored `storage-sqlite` 同步到 0.2.2 契约：至少补 `deleteRecords`，并评估 `compatibleVersions` 与 `unknown-state`（我们 fork 自 0.1.5-rc.2，落后两个 minor）。
4. `ctx.sessionProjections.register(...)` 改为 await 并持有 `ProjectionHandle`；自有 `contextContinuity` 读取改用 `handle.stateOf`；删除已失效的 `SessionProjectionStateMap` 模块增强（`context-projection.ts:95`）。
5. `stateOf(session,'inbox')`（`index.ts:689`）必须有明确结论：短期沿用已弃用的 registry 读法，或改为自己折叠 `agent/inbox/spliced` 事件。

### 4.2 应回归（不改代码，但需实测确认行为）

1. `npm run test:browser` 全量：侧栏 drawer/窄屏、`sidebar.panellist.actions`、context menu 统一、会话行 leading/trailing、会话列表图标、composer 发送态、chat 渲染。
2. Member 的 `fs-observation-policy` 与 `apply_patch` 取向：确认 rc.1 下 Member 确实失去先读后写（默认值来自 base 行已禁用），并确认最终取向。
3. `cordis 4.1.0` 下的启动与隔离：group `isolate`、`!!js` 延迟表达式、patch 行持久化、`dsh plugin` 安装链路。
4. 工具准入改造后的 Team 工具可见性：`validateMemberPreset` 的 `schemas(scope)` 判定在 rc.1 是否仍能拦下缺工具的 preset。
5. `agent/request` 只改 `maxTokens` 的压缩路径：确认 rc.1 的路由固定校验不误伤（`member-compaction.ts:152`）。
6. Host 侧 Web Fetch 放宽后，Member 工具的凭据/网络行为是否仍符合预期。

### 4.3 可选优化（不是适配工作量）

1. 用 `settings.section.icon` 替换 `settings-nav-icon.ts` 的 DOM hack（注册 id 用现有的 `team-settings`）。
2. 给 Workspace/Project 列表接 `ctx.contextMenus`，替换自有行菜单。
3. Member 会话行用 `sidebar.session.row.trailing` 展示状态图标（当前用自有面板行）。
4. 补齐 ja/es/fr/de/ru/pt 六套 locale（当前仅 zh/en，缺失会回落英文）。
5. `KvTable.deleteMany` 可用于批量写入路径（我们先无此需求）。

## 5. 需要拍板或实测的问题

1. `engines.dsh` 新区间怎么写：`>=0.2.1-rc.2 <0.2.3`（跨线兼容）还是 `>=0.2.2-rc.1 <0.2.3`（只认新线）；peer 区间是否同步收窄。这是取舍，不是事实问题。
2. Member 是否保留“先读后写”。若要保留，需要在 preset 内挂 `fs-observation-policy`——该插件占用单决策槽，能否在 agent 作用域内成立、是否与宿主 disabled 行冲突：**未确认**，需要一次最小实验。
3. Member 是否开 `apply_patch`。rc.1 的默认是关；官方 commit 自称 “temporarily”，后续可能再翻转，方案要能承受这一行再次变化。
4. `parentSession` 的用途：继续写（语义错但无害），还是只依赖 ledger 的 `previousSessionForMember`。rc.1 不会拒绝前者。
5. `'inbox'` 投影读取的长期路径：官方没有为它提供 owning-service 读法，是否自己折叠事件，取决于是否愿意承担 Harness 事件语义的维护成本。

## 6. 未确认

- 在 `team-member` preset 内单独挂 `fs-observation-policy` 是否可行、是否只影响该 Member（单决策槽 + 作用域事件订阅的组合未实测）。
- `cordis 4.1.0` 对我们 group 隔离、`!!js` 表达式、patch 行持久化的可观察影响（只读了 diff，未运行）。
- rc.1 之后默认值是否再次翻转（`apply_patch` 的 “temporarily” 无期限说明）。
- npm `@deepseek-ai/dsh-storage-sqlite` 的 `latest` 指向 `0.0.1-rc.1`，该 tag 指向的包内容与当前线的关系未核对（我们不用 `latest`，用显式版本）。
- 0.2.1-rc.3/rc.4 三段 guide（`attachment-read-access`、`independent-session-forks`、`ptc-caller-cancellation`、`session-follow-activation`、`web-file-downloads`、`model-listing-refresh`、`reasoning-body-props`）只做了标题级核对，未逐篇重读；其中 `independent-session-forks` 与 3.4 的 fork 语义相关，适配时应补读。
