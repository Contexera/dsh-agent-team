# Workspace、Session 和 storage reuse

[English](workspace-session-storage.md) | 中文

Team 读取现有 Harness Workspace projection。它不创建第二套 Workspace store 或 Session tree。当前 Client 不调用 `ctx.workspaces.pickDirectory()` 或 `ctx.workspaces.create()`。需要创建 Workspace 时，用户回到普通 Session UI。

Member sessions 出现在普通 Session list 中。Host 保持 Member Agent live 时，它们可继续读取。Cold Member session（suspended Member、activation failed，或 Host 尚未完成 restoring）无法通过 generic Session UI resume。这条路径会在 ambient shipped preset registry 中解析 session 记录的 preset。这个 registry 刻意不声明 bundle-private `team-member` 定义。因此 resume 会明确失败，也不会用错误 composition 重建 history。请通过 Team panel resume 这些 Members，或使用健康的 bundle 重启。不要给 ambient registry 增加 Team fallback。

修改 Workspace、Session、storage、persistence 或 Thread Inbox 时，先读相关 Team source/tests。再读下面五篇：

- `../deepseek-harness/docs/subsystems/workspace.md`
- `../deepseek-harness/docs/subsystems/session.md`
- `../deepseek-harness/docs/subsystems/storage.md`
- `../deepseek-harness/docs/subsystems/persistence.md`
- `../deepseek-harness/docs/defensive-patterns.md`

Team ledger 仍是唯一的 Team durable authority。Recovery 和 teardown 改动需要 failure-window 或 composition evidence。不能依赖 silent fallback。

Host 为 `agent_team` 自己持有 SQLite-backed `DomainFacility`，不修改全局 storage route，因此开关 bundle 不会重建无关的 storage consumers 及其 Session controller。其他 domains 保持 JSON default。SQLite medium（`$DSH_HOME/storages/agent_team.sqlite`）在首次 routed open 时全新创建。旧的 `agent_team.json` medium 永远不会被读取或迁移。是否移动或删除由 operator 决定。该 backend 是收归自有包名下的 vendored fork（`@contexera/dsh-agent-team/sqlite-backend`，见 `packages/agent-team/src/vendor/storage-sqlite/`）。两个问题都归 [`development/storage-and-delivery.zh.md`](../development/storage-and-delivery.zh.md)：fork 为何存在，loader 行不得重新引入的启动约束。

dsh `0.1.7-rc.1` 线上 message source 由生产者署名。Session format V4 要求每条持久 source 携带生产者自身的 kind。退役的 `{ kind: 'plugin', plugin: … }` wrapper 会在写入准入被拒。released V3 历史由上游在读时转换。转换做三件事：改名为 `plugin:<producer>`、删掉 `plugin` 键、保留 `form`/`sections`/`summary`。磁盘上永不改写。

读侧对本 bundle 每个生产者 id 的新旧两套、两种形状，按精确身份识别，因此改名前的 Session 仍可读。识别收敛在一处：`packages/agent-team/src/context-source.ts`，与各自持有 id 的两个 per-Member 生产者。

早期版本内置的启动期写侧修复（`session-remediation.ts`）随 V4 切换一并移除。它发布的正是 V4 写入拒绝的 wrapper，针对的 0.1.5 前自定义 kind 在读时转换之前就被 released 迁移链拒绝。没有修复路径。此类 artifact 在每次重试中都保持确定性的 `session-refused` diagnostic。

Host 的每一次逐 Session stored 读取都经过同一个 seam。`packages/agent-team/src/stored-session-reader.ts` 负责一次 `open → read → close`，句柄保证关闭。它把所有失败归一为五类：`missing`、`refused`、`corrupt`、`io`、`unknown`。其中第二类是确定性格式拒绝，携带 artifact 路径。消费方按类别选择策略，绝不匹配 Harness 错误文案。当前绑定激活对任何失败 fail-closed；唤醒判定把读不出的 Session 当作 resume；carried-input replay 只对已退役世代的确定性 `refused`/`corrupt` 跳过。DSH persistence 接口变化只需在这个模块内适配一次。上游 JSONL backend 的 corruption 系列以裸 `Error` 抛出。seam 内部以这个稳定文案前缀识别。文案一旦变化即退化为 `unknown`。所有消费方对 `unknown` 走保守路径。

成员重启是对格式拒绝的有界自愈。激活失败带 `session-refused` diagnostic 时，`recoverMember` 会重跑激活。瞬时性拒绝因此恢复。确定性拒绝则把同一失败重放进刷新后的 diagnostic，因为已不存在写侧修复。

激活 diagnostic 是结构化的。`AgentTeamMemberDiagnostic` 携带三样东西：`class`、detail，以及适用时的被拒 artifact 路径。它的取值有六种：`session-refused`、`session-unreadable`、`preset-composition`、`rollover`、`runtime`、`activation`。availability/presence 仍是仅有的用户可见状态。diagnostic 是投影派生态，绝不持久化。ledger 仍是唯一 Team 权威。

## Team manager Session

Host 持有一个专用的 [Team manager](../domain-model.zh.md#team-manager) Session。它的持久目的地是私有 `agent_team_manager` domain 中唯一的 `pointer` 行，与 Team 同在一个 SQLite 文件里，但在 operation ledger 之外。该行存 `{sessionId, workspaceId, previousSessionIds?}`；可选 lineage 让替换后的旧 manager 仍被识别为 Team-owned history，没有该字段的旧 pointer 仍可读。

`workspaceId` 只用于恢复与展示，不是第二套存在性权威。pointer store 打不开时只记日志，manager 保持 unavailable，Host 启动与 Team ledger 不受影响。

首次创建先请 shipped Workspace controller 初始化默认 Workspace，再按 registry 顺序取第一个可用 Workspace；一个都不可用时返回 `no-workspace`，不创建 Session。已有 Session 只在路径与其存储 cwd 完全相同的 Workspace 中恢复。启动时的 pre-restore 会恢复可读的已注册 Session，但从不创建新 Session；pointer 缺失或对应 Session 已归档时，留给下一次 open 处理。

公开 open 与替换共用一条串行链。并发首次 open 只创建一个 Session；针对同一 expected id 的并发新开也只创建一个后继；迟到调用方观察当前 Session，不再另建。对已有 pointer，只有 Session 已归档，或 stored read 明确报 `missing`，才允许替换。`refused`、`corrupt`、`io`、`unknown`、pointer read 与 pointer write 失败都返回 `unavailable` 并保留 pointer。

替换先持久化 pointer，再发布后继并立即取消旧 manager 的授权；旧 handle 会被停止，Session 历史仍在所属 Workspace 的普通列表中可见并可归档。Workspace 归档与 pointer 持久化属于两套权威，竞态中两者可以短暂不同步；下一次 open 会通过替换已归档的 manager 收敛，而不是依赖跨权威原子事务。

manager 私有资源位于 `$DSH_HOME/agent-team/manager`：`memory.md`、`notes/` 与 `skills/`。它们不是 ledger fact。manager 的 skill provider 扫描两处：随 bundle 发布的只读 manager skills（`packages/agent-team/manager-skills/`，排前）与这个私有 `skills/` 目录。Member 的 core skills 是另一个 root，不会进入 manager；manager 的这两处也不会进入 Member 或普通 Session。

manager 的记忆通过自己的 preset row 进入上下文，不经过 Member context 插件：该 row 先问 Host「这个 Agent 是不是当前 manager」，再从私有 root 读 `memory.md`，注入与 Member 同构的有界索引块——先一份完整 baseline，文件变化后只给一条「旧副本已过期」的提示。块内按本次 Session 的实际 cwd 说明私有 root 的位置，因为 manager 是在某个 Workspace 里运行，而不是在所有 Workspace 之外。
