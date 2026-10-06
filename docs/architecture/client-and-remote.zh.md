# Typed Remote 与 Client 边界

[English](client-and-remote.md) | 中文

## Typed Remote
Remote methods 通过 Team service 的 `@Remote` annotations 声明。`scripts/generate-typert.mjs` 使用 Harness `WorkspaceAnalyzer` 和 `FaceModelEmitter`，在 `packages/agent-team/lib/` 下生成 Host 和 Client artifacts。

稳定流程如下：

```text
Host face declaration
        │ generate:typert
        ▼
Typert Host artifact + Remote client artifact
        │ ctx.remote.$mount(...)
        ▼
Client remote service
```

`InvocationDescriptor` 是 local reflection metadata，不是 wire message。Wire request 和 response fields 保持为显式 typed values。修改 Remote 时更新 declaration 和 tests，重新生成，然后运行 typecheck/build；不要手工编辑 artifact。

## Remote failure vocabulary
生成的 Remote methods resolve 为 `RemoteResult`。`{ ok: true, value }` 携带业务结果，`{ ok: false, error }` 携带失败：稳定的 `code` 是判别字段，`details` 随 `code` 收窄，无需 cast。

- 业务拒绝——`unread_required`、`stale_revision`、`confirmation_required`——保持 result union：它们是 Client 已经建模的正常控制流，不是 Remote error。
- 需要 Client 独立分支的预期跨 Remote 失败以 `RemoteError` 抛出。owner 通过向 `RemoteErrorDetailsMap` merge 声明自己的 code。Team 把 codes merge 进两个 face 共同编译的公开 types 入口。Team 的第一个 code 是 `team/attachment-not-found`：attachment read 把已消失的 cache entry 与其他一切失败分开。
- Client 按 `code` 分支，绝不解析 message 文本——message 只是人类诊断，不是契约。未知 code 与未分类的 Host 异常以 `gateway/internal` 到达，因此每个分支都保留通用 fallback。attachment preview 把 not-found 结算为过期 chip，不缓存任何其他失败，让下一次渲染重试 Host。

## Client plugin 和 slot composition
Team browser plugin 是 external Client plugin。Shipped Shell 继续拥有 outer layout。Team 增加一个 additive footer action，并动态 shadow 三个 seats：

```text
sidebar.footer.action       additive Team entry
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
sidebar.settings            Team shadow, priority -100
```

Browser activation 顺序是：

```text
Client plugin apply
  → ctx.remote.$mount(agentTeamRemote)
  → ctx.inject(['remote.agentTeam'], ...)
  → register Team footer and mode shadows
```

`dsh.client.inject` 描述 client module graph；它不保证 apply order、service readiness 或 slot declaration order。如果 declaration 可能稍后出现，使用 `ctx.slots.inject()`。它让 registration 跟随 declaration lifetime，并随 owning fiber disposal。

Team mode 同时拥有 shell 的 main panel selection。进入 team mode、或在其中导航时，只要 shipped global panel（插件管理页）还占着中栏，就把中栏交回 conversation panel：也就是 Team shadow 的那个 seat。离开 team mode 后，Team 不再碰这个 selection。

Slot parent 的 `children` declaration 同时是 render site 和 render authority。两个存活的 parent entries 不能声明同一个 child slot。特别是 Team 的 `sidebar.workspaces` shadow 不得重新声明 shipped `sidebar.workspaces.directoryFlow`。即使 Team entry priority 更高，Harness SlotCore 也会拒绝这个 duplicate。不要复制 private WorkspaceBrowser、ConversationRoot、Shell 或 private CSS 来规避它。

Team feature 需要现有 Harness capability 时，使用 public service 或 package export。对于 directory selection，先检查 `ctx.workspaces.pickDirectory()` 和 `host.pickDirectory` path，再考虑 Team-specific picker。如果 public contract 无法表达目标 composition。记录这个 limitation，选择 Team-owned plugin 或新设计。不要静默依赖 private implementation details。

## Client data 和 presentation boundary
`packages/client-agent-team/src/client/` 下的 components 不接触 `ctx`、operation ledger 或 Host classes。Data 与 callbacks 通过 Client slot contract 进入，包括 owner props、runtime props、declared store 或 inject face。Presentation layer 消费 Host projections 和本地 navigation state，不自行发明 durable facts。

UI work 的边界如下：

- Channel composer 默认创建 taskless Thread，并提供默认关闭的「作为任务」控件以原子创建 Task。 taskless Thread 保留 normal read/reply/inbox behavior，但在 promotion 前隐藏 Task status、Claims 和 Task-resolution controls。 Promotion 是 durable、non-optimistic 的 Host mutation。成功后 Client 重新读取 Thread 和 supplemental projections，而不是本地合成 Task。

  Human Client 消费 Host 的 Inbox 投影（「收件箱 / Inbox」队列：合并各 Workspace 的徽标与页，覆盖读者的整片未读：mention 只在其中计数，绝不是准入条件。外加该读者写过 Message 的「最近活跃」段（回复过的 Thread 无论是否 follow 都算他的。按最新活跃降序，Host 侧每个 Workspace 上限 10，合并到页面上最多 5 条，永不进入 agent 的 Inbox）），但绝不维护并行 Inbox authority；打开页不确认任何内容。 Thread reads 使用 Host projections（`readThread`、`threadHistory`）和 Host mutations（replies、promotion、Task actions）。 当前 Thread UI 不提供 Attention controls 或 observations。其 Host Remote methods 留给后续自有 UI。 Browser 会持久化 Team navigation mode、Workspace selection、最近选中的 Channel 或 Thread 以及 Inbox 页位置（回到 Team 时恢复位置）。但不持久化 unread 或 Attention。

  Agent Inbox 仍由 Host 持有，并通过 `team_inbox` 提供。
- Sidebar row order（Channels/Agents）是每个 browser 的 Human presentation preference，保存在 `localStorage`。加载时折叠到 Remote default order 上（保留的 refs 保持顺序，移除的 refs 丢弃，新的 refs 追加）。它从不成为 ledger fact。Whole-row native drag 复用 Harness list interaction model，它是 Team-owned rows 唯一的重排控件。
- 嵌入的 Team Member Session 使用未修改的 shipped composer。Team 不注册任何成员会话的 composer 表面：不接管 seat、无 trigger sources、无 dock 提示条。rc.1 把 trigger-menu overlay 移进了 `conversation.composer.bar` 的 children（接管者会一并继承渲染义务并使 overlay 悬空）。且 Team 自有的命令/成员引用入口相对 shipped 词汇表不再有不可替代的价值，因此一并移除。普通会话与 Member Session 共享同一 composer 与词汇表。
- 有对应能力时复用 public Harness primitives 和 `--dsw-*` theme tokens。
- CSS 保持在 CSS Modules 中；不要 import private Harness CSS。
- Runtime presence 必须与 Claim 和 Task state 分离。
- Task resolution controls 会修改 Task 和 Claim。Closed Task 对 replies 和 new Attention 是 terminal。reopen 会恢复 open Task，但不会恢复此前的 Attention。
- Message、Activity、Claim 和 Task 的 presentation 要保持区分且用户可读。不要暴露 opaque refs 或 internal enums。
- Durable mutations 不做 optimistic update；失败时保留 input，并渲染下一份 Host projection。
- 保持 Team mode enter/leave、refresh recovery、slot restoration 和 narrow layout behavior。

UI redesign 已完成。需要理解当时的取舍时，查 [`.scratch/archive/2026-08/ui-redesign/`](../../.scratch/archive/2026-08/ui-redesign/)；它是历史设计背景，不是当前实现权威。UI 改动的当前验收规则见 [`development/README.zh.md`](../development/README.zh.md)。
