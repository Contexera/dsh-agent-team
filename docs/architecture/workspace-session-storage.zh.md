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

Shipped bundle composition 只通过 public per-domain route table 把 `agent_team` domain 路由到 SQLite backend。其他 domains 保持 JSON default。SQLite medium（`$DSH_HOME/storages/agent_team.sqlite`）在首次 routed open 时全新创建。旧的 `agent_team.json` medium 永远不会被读取或迁移。是否移动或删除由 operator 决定。该 backend 是收归自有包名下的 vendored fork（`@contexera/dsh-agent-team/sqlite-backend`，见 `packages/agent-team/src/vendor/storage-sqlite/`）。两个问题都归 [`development/storage-and-delivery.zh.md`](../development/storage-and-delivery.zh.md)：fork 为何存在，loader 行不得重新引入的启动约束。

dsh `0.1.7-rc.1` 线上 message source 由生产者署名。Session format V4 要求每条持久 source 携带生产者自身的 kind。退役的 `{ kind: 'plugin', plugin: … }` wrapper 会在写入准入被拒。released V3 历史由上游在读时转换。转换做三件事：改名为 `plugin:<producer>`、删掉 `plugin` 键、保留 `form`/`sections`/`summary`。磁盘上永不改写。

读侧对本 bundle 全部三个生产者 id 的两种形状，按精确身份识别。识别收敛在一处：`packages/agent-team/src/context-source.ts`，与各自持有 id 的两个 per-Member 生产者。

早期版本内置的启动期写侧修复（`session-remediation.ts`）随 V4 切换一并移除。它发布的正是 V4 写入拒绝的 wrapper，针对的 0.1.5 前自定义 kind 在读时转换之前就被 released 迁移链拒绝。没有修复路径。此类 artifact 在每次重试中都保持确定性的 `session-refused` diagnostic。

Host 的每一次逐 Session stored 读取都经过同一个 seam。`packages/agent-team/src/stored-session-reader.ts` 负责一次 `open → read → close`，句柄保证关闭。它把所有失败归一为五类：`missing`、`refused`、`corrupt`、`io`、`unknown`。其中第二类是确定性格式拒绝，携带 artifact 路径。消费方按类别选择策略，绝不匹配 Harness 错误文案。当前绑定激活与 checkpoint seed 解析对任何失败 fail-closed。carried-input replay 只对已退役世代的确定性 `refused`/`corrupt` 跳过。handoff 重建与 token 测量降级。timeline 在不可读祖先处截断 lineage。它以 `incompleteFrom` 显式报告，而不是静默断链。DSH persistence 接口变化只需在这个模块内适配一次。上游 JSONL backend 的 corruption 系列以裸 `Error` 抛出。seam 内部以这个稳定文案前缀识别。文案一旦变化即退化为 `unknown`。所有消费方对 `unknown` 走保守路径。

成员重启是对格式拒绝的有界自愈。激活失败带 `session-refused` diagnostic 时，`recoverMember` 会重跑激活。瞬时性拒绝因此恢复。确定性拒绝则把同一失败重放进刷新后的 diagnostic，因为已不存在写侧修复。

激活 diagnostic 是结构化的。`AgentTeamMemberDiagnostic` 携带三样东西：`class`、detail，以及适用时的被拒 artifact 路径。它的取值有六种：`session-refused`、`session-unreadable`、`preset-composition`、`rollover`、`runtime`、`activation`。availability/presence 仍是仅有的用户可见状态。diagnostic 是投影派生态，绝不持久化。ledger 仍是唯一 Team 权威。
