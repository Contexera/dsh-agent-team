# Workspace、Session 与存储复用

[English](workspace-session-storage.md) | 中文

本文说明如何复用 Harness 存储，以及如何保存 manager Session 的指针。生命周期决策见 [Host 权威](host-authority.zh.md)，导航见 [Client 与 Remote](client-and-remote.zh.md)。

## Workspace 复用与 Member Session

Team 读取 Harness 现有的 Workspace 投影，不另建 Workspace store 或 Session tree。Client 不创建 Workspace；用户需要回到普通 Session 界面完成创建。

Member Session 会出现在普通列表中，但尚未激活的 Member 不能从那里恢复：普通 preset registry 刻意不声明 `team-member`。请从 Team 面板恢复，或修复 bundle 后重启，不能向普通 registry 添加 Team fallback。

修改本页涉及的实现前，先读 Team 源码、测试及 [Harness 导航](../harness-navigation.zh.md) 链接的契约。恢复逻辑需要故障窗口或组合测试的证据，不能依赖静默回退。

## 私有存储设施

Host 自行持有 SQLite-backed `DomainFacility`，文件位于 `$DSH_HOME/storages/agent_team.sqlite`。开关 bundle 不会改动全局 storage route，也不会重建无关的使用方。

该存储首次打开时全新创建，不读取或迁移旧的 `agent_team.json`。backend 是以本包名称导出的 vendored fork：`@contexera/dsh-agent-team/sqlite-backend`，源码在 `packages/agent-team/src/vendor/storage-sqlite/`。

fork 的原因和 loader 不得重新引入的启动约束，统一见 [存储与交付](../development/storage-and-delivery.zh.md)。

## 已存储 Session 的读取与兼容

Message source 由生产者署名。Session format V4 要求持久 source 使用生产者自己的 kind，写入时拒绝旧的 `{ kind: 'plugin', plugin: … }` wrapper。

已发布的 V3 历史只在读取时转换：kind 改为 `plugin:<producer>`，删除 `plugin` 键，保留 `form`、`sections` 和 `summary`，不改写磁盘。

读侧按精确身份识别本 bundle 当前和改名前的 producer id，以及它们经 V3 转换后的形状。识别逻辑集中在 `packages/agent-team/src/context-source.ts`，以及各自持有 id 的两个 per-Member 生产者中。

Team 没有写侧 Session 修复流程。Harness 迁移链拒绝的格式在重试时仍会被拒绝；Team 报告 `session-refused`，不改写文件。

Host 的完整存储读取统一经过 `packages/agent-team/src/stored-session-reader.ts`：执行一次 `open → read → close`，保证关闭 handle，并把失败归为五类：

- `missing`：没有持久日志；
- `refused`：确定性的格式拒绝，附带可用的文件位置；
- `corrupt`：日志损坏；
- `io`：存储或系统错误；
- `unknown`：未分类错误。

消费方按类别决定策略，不匹配 Harness 错误文本。当前绑定的激活对任何读取失败都停止；唤醒判定遇到不可读 Session 时选择 resume；携带输入的重放只跳过退役 Session 的 `refused` 或 `corrupt`。persistence 接口变化只需在这个读取模块适配。

模块同时识别有类型的 `SessionPersistenceCorruptionError`，以及 JSONL backend 以普通 `Error` 抛出的 `corrupt session log` 文案，包括包装后的 cause。未识别的错误归为 `unknown`，由调用方保守处理。

激活失败后，`recoverMember` 会按 [Host 恢复顺序](host-authority.zh.md#哪些操作会唤醒-member以及-member-卡住时怎么选) 重试激活。暂时性读取失败可能恢复，确定性的格式拒绝则重复同一诊断。重试不等于修复格式。

`AgentTeamMemberDiagnostic` 为 availability 和 presence 补充结构化原因，不增加持久状态。其类别包括读取失败（`session-refused`、`session-unreadable`）、组合与激活（`preset-composition`、`activation`）、换代与执行（`rollover`、`runtime`），以及已提交配置的应用失败（`capability-apply`、`model-apply`）。

诊断包含 detail，以及可用的文件位置、Session id、source 和观测时间。它们在运行时派生，不持久化。

## Team manager Session

Host 持有一个专用 [Team manager](../domain-model.zh.md#team-manager) Session。持久目的地保存在私有 `agent_team_manager` domain 的 `pointer` 表中，与 Team 共用 SQLite 文件，但不进入 operation ledger。

唯一一行保存 `{sessionId, workspaceId, previousSessionIds?}`；可选的历史 id 让被替换的 manager 仍可识别为 Team 历史，不含该字段的旧记录仍可读取。

`workspaceId` 只用于恢复和展示，不是 Session 是否存在的第二权威。pointer store 打不开时记录日志，manager 保持 unavailable，不阻止 Host 启动或 Team ledger 打开。

首次创建先让 Harness Workspace controller 初始化默认 Workspace，再按 registry 顺序选择第一个可用 Workspace。无可用项时返回 `no-workspace`，不创建 Session。

已有 Session 只在路径与其存储 cwd 完全相同的 Workspace 中恢复。启动时只预恢复可读的已注册 Session，不创建新 Session；pointer 缺失或 Session 已归档时留待下一次 open。

### 打开与替换规则

公开 open 与替换共用一条串行链。并发首次 open 只创建一个 Session；同一 expected id 的并发替换只创建一个后继。过期调用方只观察当前 Session，不再创建。

已有 pointer 只在 Session 已归档，或存储读取明确报告 `missing` 时才允许替换。`refused`、`corrupt`、`io`、`unknown` 及 pointer 读写失败都返回 `unavailable`，保留 pointer。

### 发布与归档

替换先持久化 pointer，再发布后继并立即取消旧 manager 的授权。旧 handle 停止后，Host 归档旧 Session，保留日志。后继留在活跃列表，前代进入 Workspace 归档视图。

发布后的归档尽力执行：失败只记警告，不回滚后继，不删除历史。Workspace 归档与 pointer 持久化属于不同权威，竞态中可能短暂不同步；下一次 open 通过替换已归档 manager 收敛，不依赖跨权威原子事务。

### manager 私有资源

manager 私有资源位于 `$DSH_HOME/agent-team/manager`：`memory.md`、`notes/` 和 `skills/`，都不是 ledger fact。隔离的 skill roots 及优先级见 [Host 权威](host-authority.zh.md#member-capabilities-与-skills)。

manager 的记忆由专用 preset row 注入，不经过 Member context 插件。该 row 先向 Host 确认当前 Agent 正是现任 manager，再读取私有 `memory.md`，注入与 Member 同构的有界索引：先给完整基线，文件变化后只提示旧副本已过期。

索引按 Session 的实际 cwd 说明私有目录的位置，因为 manager 在某个 Workspace 内运行，而不是在所有 Workspace 之外。
