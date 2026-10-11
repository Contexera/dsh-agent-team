# dsh-agent-team 文档

[English](README.md) | 中文

这里是本仓库需要持续维护的正式工程文档。根 `AGENTS.md` 只保留每次工作都必须知道的规则；本目录的 [`AGENTS.md`](AGENTS.md) 负责文档改动与维护的路由——改动 `docs/` 下任何内容前先读它。具体流程、架构和跨仓库导航按需从这里进入。

## 文档入口

| 文档 | 用途 | 什么时候读 |
| --- | --- | --- |
| [`development/README.zh.md`](development/README.zh.md) | 安装、命令、生成物、live/UI preview、browser replay 和发布检查 | 开始开发、运行验证、修改 package 或发布布局 |
| [`development/start-and-checks.zh.md`](development/start-and-checks.zh.md) | 上手与检查梯度 | 开始开发，或判断一次改动该跑哪道门 |
| [`development/generated-and-seams.zh.md`](development/generated-and-seams.zh.md) | 浏览器证据、生成文件、package 接缝与新增 Host operation | 修改生成物、package 接缝或 Host operation |
| [`development/environments-and-install.zh.md`](development/environments-and-install.zh.md) | 沙箱/CI 环境与外部安装验证 | 在 CI 里跑，或验证已安装的 bundle |
| [`development/storage-and-delivery.zh.md`](development/storage-and-delivery.zh.md) | Ledger 存储路由、通知回归与交付前核对 | 修改存储路由、通知，或准备交付 |
| [`dsh-release-compatibility.zh.md`](dsh-release-compatibility.zh.md) | DSH 新版本的评估、隔离认证、安装验证和发布门槛 | DSH 发版、更新 peerDependencies 或排查跨版本安装失败 |
| [`release-runbook.zh.md`](release-runbook.zh.md) | 发布一个 bundle 版本的完整流程：前置检查、检查阶梯、发布材料、打 tag 与发布、发布后核验 | 要发布某个版本，或复核一次发布在出货前必须证明什么 |
| [`architecture/README.zh.md`](architecture/README.zh.md) | Host、tools、command、typed Remote、Client plugin 和 authority 边界 | 修改运行时、RPC、preset、Client 或持久化 |
| [`architecture/package-ownership.zh.md`](architecture/package-ownership.zh.md) | 三个 package 目录、唯一的发布 manifest，以及各接缝之间单向的依赖方向 | 修改 package 接缝、manifest 或 import 方向 |
| [`architecture/host-authority.zh.md`](architecture/host-authority.zh.md) | Host 拥有什么：ledger、生命周期、projection、Session 持久化、Attention、上下文压力、私有记忆与 member capabilities | 修改 Host 运行时、持久化、重放、Attention 或记忆行为 |
| [`architecture/tools-and-preset.zh.md`](architecture/tools-and-preset.zh.md) | 九个 model-facing 工具、各自定义在哪个模块，以及隔离的 `team-member` preset | 修改某个 model-facing 工具或 preset 挂载的内容 |
| [`architecture/client-and-remote.zh.md`](architecture/client-and-remote.zh.md) | typed Remote 声明、Client plugin 与 slot composition、Client 数据与呈现边界 | 修改 RPC、Client plugin 加载、slot 或 projection |
| [`architecture/workspace-session-storage.zh.md`](architecture/workspace-session-storage.zh.md) | 复用 Harness 的 Workspace、Session 和存储，而不另建并行 Team 状态 | 修改 Workspace 选择、Session 存储或 ledger 路由 |
| [`domain-model.zh.md`](domain-model.zh.md) | 稳定的 Agent Team 领域词汇 | 修改领域语义、类型命名或正式协作合同 |
| [`team-collaboration/README.zh.md`](team-collaboration/README.zh.md) | 已实现的九工具、Thread Attention、Inbox、读取、mention 与 mutation fence 合同 | 修改 Team 协作语义、模型工具或 Agent 通知时 |
| [`team-collaboration/model-and-time.zh.md`](team-collaboration/model-and-time.zh.md) | 协作模型与 Member 时间感知 | 修改 Thread、Task、Claim 的含义或时间提示 |
| [`team-collaboration/tools.zh.md`](team-collaboration/tools.zh.md) | 九个 model-facing 工具及全部工具共用的规则 | 修改某个工具的合同、ref 或它周围的 mutation fence |
| [`team-collaboration/attention-and-messaging.zh.md`](team-collaboration/attention-and-messaging.zh.md) | Attention、Inbox、mention、面向人类的消息与 ref 引用 | 修改通知、mention 投递或消息呈现 |
| [`team-collaboration/boundaries.zh.md`](team-collaboration/boundaries.zh.md) | Mutation fence、Human Remote 边界与 Team Member 上下文边界 | 修改谁能改什么，或 Member 能看到别的 Session 的什么 |
| [`team-collaboration/memory-and-context.zh.md`](team-collaboration/memory-and-context.zh.md) | Member memory、上下文压力归属、Agent notification 与 assembled acceptance | 修改记忆维护、上下文压力处理或验收必须证明什么 |
| [`frontend-design/README.zh.md`](frontend-design/README.zh.md) | Team Client 的长期 UI 设计体系：设计原则、布局骨架、排版、组件合同、可访问性基线与验证流程 | 修改 `packages/client-agent-team/src/client/` 的可见 UI 或交互时 |
| [`frontend-design/principles-and-language.zh.md`](frontend-design/principles-and-language.zh.md) | 设计原则与 DSH 设计语言对齐 | 决定复用哪些原语，或对齐 DSH 语言 |
| [`frontend-design/layout-and-typography.zh.md`](frontend-design/layout-and-typography.zh.md) | 布局骨架、排版、颜色与身份 | 修改布局、字阶或颜色 |
| [`frontend-design/components.zh.md`](frontend-design/components.zh.md) | 各组件合同 | 修改某个 Team 组件或其状态 |
| [`frontend-design/thread-and-composer.zh.md`](frontend-design/thread-and-composer.zh.md) | 时间线滚动、composer 与 mention、入口行、状态胶囊 | 修改滚动、composer、入口行或状态胶囊 |
| [`frontend-design/sidebar-browser.zh.md`](frontend-design/sidebar-browser.zh.md) | 侧栏浏览器与 Inbox 界面 | 修改侧栏浏览器或 Inbox 界面 |
| [`frontend-design/refresh-copy-accessibility.zh.md`](frontend-design/refresh-copy-accessibility.zh.md) | 刷新语义、文案、可访问性与演进 | 修改刷新行为、文案或可访问性 |
| [`harness-navigation.zh.md`](harness-navigation.zh.md) | 本仓库与 `../deepseek-harness` 的查阅路线、源码入口、已知接入陷阱 | 不确定应该查哪个 Harness 文档/package/source 时 |

## 文档规则

要修改或新增 `docs/` 下的文档？路由分支与维护纪律见 [`AGENTS.md`](AGENTS.md)——先读它。

## 从哪里开始

- **改 Host 或 domain：** 边界查 [`architecture/README.zh.md`](architecture/README.zh.md)，词汇查 [`domain-model.zh.md`](domain-model.zh.md)；`packages/agent-team/src/` 和测试是权威。需要决策来由时再按 `.scratch/README.md` 查 archive。
- **改 tools 或 preset：** 查 [`architecture/README.zh.md`](architecture/README.zh.md) 的对应章节，再查 Harness cookbook 和 subsystem 文档。
- **改 Client 或 UI：** UI 体系查 [`frontend-design/README.zh.md`](frontend-design/README.zh.md)，跨仓库路线查 [`harness-navigation.zh.md`](harness-navigation.zh.md)。
- **改安装、构建、测试或 Remote 生成：** 查 [`development/README.zh.md`](development/README.zh.md)，再看对应 `package.json` / script 的实际实现。
- **发布一个版本：** 流程与各道门查 [`release-runbook.zh.md`](release-runbook.zh.md)；放宽 peer 范围之前必须先做的认证查 [`dsh-release-compatibility.zh.md`](dsh-release-compatibility.zh.md)。
