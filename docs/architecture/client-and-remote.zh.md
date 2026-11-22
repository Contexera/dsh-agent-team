# Typed Remote 与 Client 边界

[English](client-and-remote.md) | 中文

本文说明通信契约、Client 激活顺序，以及 Host 事实与浏览器展示的边界。持久决策见 [Host 权威](host-authority.zh.md)，manager Session 指针见 [存储复用](workspace-session-storage.zh.md#team-manager-session)。

## Typed Remote

Team service 上的 `@Remote` 声明是 `scripts/generate-typert.mjs` 的输入。脚本使用 Harness 的 `WorkspaceAnalyzer` 和 `FaceModelEmitter`，在 `packages/agent-team/lib/` 生成 Host 与 Client 产物。

```text
Host face declaration → generate:typert → Typert Host + Remote client → ctx.remote.$mount(...) → Client remote service
```

`InvocationDescriptor` 是本地反射元数据，不是线上消息；通信字段必须使用显式类型。修改声明与测试后重新生成，并运行 typecheck 和 build，不能手改生成文件。

读取请求应明确用途。`view` 只有在需要整个请求范围的 Task、Thread、Claim 目录时才设置 `includeCatalog`，供模型侧 `team_view` 展示。Client 不请求该目录，只渲染当前页。

`managerSession({})` 解析 Host 持有的 manager，不接受调用方指定身份。`newManagerSession({expectedSessionId})` 只替换调用方看到的那一代；id 过期时返回当前 Session，不另建一代。

两者共用结果联合：`ready` 带 Session 和 Workspace id，`no-workspace` 表示普通空状态，`unavailable` 带结构化 Host 诊断。

`sessionOwnership({sessionIds})` 将当前和保留的 Team Session 分类为 `manager` 或 `member`，依据是私有 manager 历史与 Member ledger，涵盖已归档或尚未激活的 Session。id 前缀和 preset 标签都不是归属依据。

## Remote 失败词汇

生成的 Remote 方法返回 `RemoteResult`：`{ ok: true, value }` 携带业务结果，`{ ok: false, error }` 携带失败。稳定的 `code` 用于分支，`details` 随之收窄，无需类型断言。

- `unread_required`、`stale_revision`、`main_unread_required` 等业务拒绝保留为类型化结果，不转成 Remote 错误。mention 与关联回复直接投递，不存在邀请后重发的步骤。
- 需要 Client 单独处理的预期跨 Remote 失败使用 `RemoteError`，由所属模块扩展 `RemoteErrorDetailsMap`。Team 在两端共同编译的公开 types 入口声明 code。
- `team/attachment-not-found` 只表示确认整个缓存条目已不存在。非法 UUID、越界路径、缺失或损坏的 metadata、缺失 payload、I/O 和 payload 读取失败仍是通用 Host 错误。
- Client 按 code 分支，不解析供人阅读的 message。未知 code 和未分类 Host 异常以 `gateway/internal` 到达，各分支都要保留通用回退。
- 附件预览缓存成功读取的图片字节。确认缺失只在本次挂载显示过期，不写负缓存；后续挂载可重读。其他读取失败或解码失败保留文件名并提供重试，不能打开空预览。
- `openAttachment` 与 `attachmentApplications` 从同一份已验证缓存条目取得 payload 路径，再调用服务端桌面的 opener 或应用列表。它们不接受 Client 路径，不能借此打开任意 Host 文件。无桌面的 Host 返回 `opened: false` 和空应用列表。

## Client 插件与 slot 组合

外部 Client 插件不接管最外层布局，仍由 Harness Shell 持有。Team 增加全局面板和设置页，并在 Team mode 中替换两个位置：

```text
sidebar.panellist           additive Team row, order 20
main (key agent-team)       Team panel, priority -100
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
settings.section            additive Team settings page, order 5
settings.section.icon       Team mark on that page's nav row
```

激活时先挂载 `agentTeamRemote`，等到 `remote.agentTeam` 可用后再注册面板、导航行和替换项。`dsh.client.inject` 描述模块依赖，不保证执行顺序或服务就绪；slot 声明可能稍后出现时，使用 `ctx.slots.inject()`。

### 面板归属与恢复

选中 Shell 的 Team 导航行即进入 Team mode；选择其他面板则退出。selection 为 null 时不退出，因为嵌入 Member Session 时会清空面板，但必须保留 Team mode。Team 自己的退出行会显式清空面板。

恢复时重新选中 Team 面板；若挂载时已有其他面板被选中，就保留该面板并退出 Team mode。

### manager 导航

manager 目的地只负责进入 Session，不是另一套 Team 对话界面。`manager: true` 尚未解析出 id 时，`main` 的 conversation 替换项显示加载或错误状态，并调用 `managerSession({})`。

收到 `ready` 后，通过 Harness Workspace controller 打开 Session，记录运行时 id，再让出主区，由原生 Conversation 和 composer 接管。离开后才返回的结果会被丢弃。

`unavailable` 保留 Host 诊断和重试，不显示可发送的 Team composer。`no-workspace` 退出 Team 并进入 Harness 的选择或创建 Workspace 流程。

浏览器只持久化 `manager: true`；`managerSessionId` 和 `returnToSessionId` 仅在运行时保留，冷启动必须重新向 Host 解析。

当前 manager Session 在屏时，Session header 用「新开对话」替换 preset 标签。它以当前 id 调用 `newManagerSession({expectedSessionId})`，打开后继并更新运行时目的地。若刷新并入的早先目录请求尚不包含 Host 返回的 id，打开时会做有界重试。

显式 Team 导航会关闭 manager 目的地。退出时恢复仍然存在的普通 Session；冷启动若发现 manager 已占据主区，就从 Host 返回的 Workspace 选择最新可见的非 Team Session。没有返回目标时，走 Harness 默认 preset 和 Workspace 选择的新建流程。

### 普通 Session 复用与 manager 控件

创建守卫包装公开的 `ISessions.create`。隐式 preset 的空白候选先向 Host 查归属；Team-owned id 在继续创建前被排除，普通空白和显式 preset 请求保持不变。

归属读取失败时不重试不安全候选；读取期间若插件销毁，创建被拒绝，既不创建 Session，也不让调用方一直等待。

该守卫只阻止空白复用。[manager 归档](workspace-session-storage.zh.md#发布与归档) 将旧历史移出活跃列表。从普通列表查看当前 manager 时仍保持固定组合。

manager 在屏时，临时 slot 替换隐藏 hero preset picker、header preset label 和 permission control；切到其他 Session 就释放，还原 Harness 控件。这只是展示，不是授权锁。Host 组合与执行守卫见 [工具与 preset](tools-and-preset.zh.md#team-manager-preset)。

### Slot 声明权威

父 slot 的 `children` 同时决定渲染位置与声明权威。Team 的 `sidebar.workspaces` 替换项不得重新声明 `sidebar.workspaces.directoryFlow`，Harness SlotCore 会拒绝存活的重复声明。

不要复制私有 WorkspaceBrowser、ConversationRoot、Shell 或 CSS。使用公开服务与导出，例如 `ctx.workspaces.pickDirectory()`；公开契约无法满足需求时，应记录限制，而不是静默依赖内部实现。

## Client 数据与展示边界

展示组件不接触 `ctx`、operation ledger 或 Host class。数据与回调通过 slot owner props、运行时 props、声明的 store 或注入的 face 传入。展示只消费 Host 投影和本地导航状态，不自行创造持久事实。

### Thread 与 Inbox

Project composer 默认创建无 Task 的 Thread，用默认关闭的「作为任务」控件原子创建 Task。无 Task 的 Thread 保留回复、读取、关注和 Inbox 行为；提升为 Task 前不显示状态、Claim 和 resolution 控件。提升不做乐观更新，成功后重读 Thread 与补充投影。

Human Client 读取 Host 的 Inbox 投影，不另建 Inbox 权威；打开页面不确认未读。「收件箱 / Inbox」合并各 Workspace 的完整未读队列与徽标，mention 只参与计数，不是准入条件。

Human 另有 Agent Inbox 不包含的「最近活跃」：读者写过 Message 的 Thread，无论是否关注。按最新活动排序，每个 Workspace 最多十条，合并页最多五条。

### 本地导航与设置

浏览器持久化 Team mode、Workspace 选择、最近的 Project 或 Thread、Inbox 页位置及 manager 目的地 token。未读和 Attention 归 Host；解析后的 Session id 与返回目标仅在运行时保留，重新进入时向 Host 解析。

Thread 页面或讨论侧栏的每次打开都有独立读取范围。切换时丢弃前一次打开尚未返回的历史、未读和关注者结果，即使之后回到同一 Thread 也一样。

侧栏 Projects/Agents 顺序保存在 Team Host row 的 `sidebarOrder`，与 Remote 默认值合并并按浏览器缓存。按拖动顺序保存，写入期间只保留最新待写顺序；缓存丢失后从 Host 读回。

设置许可编辑器通过 `toolCatalog` 发现 Host 全局与 live Member scope 的名称，不读取普通 Agent scope；通过 `remote.settings` 读取已保存名单。它只写 `extraToolGrants`，携带开始编辑时的 revision。

编辑器不使用共享表单将失败压成 boolean 的适配器，因为必须区分 `settings/conflict`、`settings/rejected` 和传输失败。

名单、Human 身份和目录各自有独立的加载与失败状态。冲突保留本地草稿，重读最新值，并要求核对后再次保存，不自动重放。名单读取失败不能变成 `[]`。

### 复用 Harness composer

嵌入的 Member Session 使用未经修改的 Harness composer。Team 不替换 composer 位置、不注册 trigger source，也不增加 dock 提示条。

trigger-menu overlay 属于 `conversation.composer.bar` 的 children，替换该项也会接管 overlay 的渲染义务。Team 不另加命令或 Member 引用入口。

普通 Session 与 Member Session 共用 composer 和词汇。复用公开 Harness primitives 与 `--dsw-*` token，使用 CSS Modules，并保持 Team mode 恢复和窄屏布局。
