# dsh-agent-team 文档

[English](README.md) | 中文

从这里查找与你的改动相关的工程指南。如果是安装插件或准备贡献，请先看[项目介绍](../README.zh.md)或[贡献指南](../CONTRIBUTING.zh.md)。

## 从哪里开始

- **配置环境或选择检查：**看[开发环境与检查](development/start-and-checks.zh.md)。需要定向运行浏览器测试时，查[场景清单](development/e2e-lanes.zh.md)。
- **修改 Host 或领域行为：**看 [Host 职责](architecture/host-authority.zh.md)和[领域模型](domain-model.zh.md)，再用 `packages/agent-team/` 的源码和测试核实行为。
- **修改工具或 preset：**看[工具与 preset](architecture/tools-and-preset.zh.md)和[协作工具约定](team-collaboration/tools.zh.md)。
- **修改 Client 界面或 Remote 行为：**看 [Client 与 Remote](architecture/client-and-remote.zh.md)和[界面设计指南](frontend-design/README.zh.md)。需要查上游接口时，看 [Harness 导航](harness-navigation.zh.md)。
- **修改生成文件或包的边界：**看[生成文件与包边界](development/generated-and-seams.zh.md)。
- **衡量 Team 在不同规模下的表现：**看[性能场景](development/team-performance.zh.md)。
- **认证 DSH 版本或发布插件包：**看[兼容性记录](dsh-release-compatibility.zh.md)和[发布手册](release-runbook.zh.md)。

## 文档入口

| 文档 | 用途 | 什么时候读 |
| --- | --- | --- |
| [`development/README.zh.md`](development/README.zh.md) | 环境配置、命令、生成文件、预览、浏览器回放和发布检查 | 开始开发、运行检查，或修改包和发布布局 |
| [`development/start-and-checks.zh.md`](development/start-and-checks.zh.md) | 环境配置与检查分级 | 开始开发，或判断本次改动需要哪些检查 |
| [`development/e2e-lanes.zh.md`](development/e2e-lanes.zh.md) | 浏览器端到端场景、Web 与 Harness 的约定、底层测试与触发条件 | 选择定向的 `test:browser` 场景，或核对 Web 应用的测试覆盖 |
| [`development/generated-and-seams.zh.md`](development/generated-and-seams.zh.md) | 浏览器证据、生成文件、包的边界以及如何新增 Host 操作 | 修改生成文件、包的边界或 Host 操作 |
| [`development/environments-and-install.zh.md`](development/environments-and-install.zh.md) | 沙箱/CI 环境与外部安装验证 | 在 CI 里跑，或验证已安装的 bundle |
| [`development/storage-and-delivery.zh.md`](development/storage-and-delivery.zh.md) | Ledger 存储路由、通知回归与交付前核对 | 修改存储路由、通知，或准备交付 |
| [`development/team-performance.zh.md`](development/team-performance.zh.md) | 可复用的 Team 性能场景、规模矩阵、Browser 加载、语义探针和当前约束 | 测量或修改性能敏感的 Team 路径 |
| [`dsh-release-compatibility.zh.md`](dsh-release-compatibility.zh.md) | DSH 新版本的评估、隔离认证、安装验证和发布门槛 | DSH 发版、更新 peerDependencies 或排查跨版本安装失败 |
| [`release-runbook.zh.md`](release-runbook.zh.md) | 发布前检查、发布材料、打 tag、发布与发布后核验 | 发布插件版本，或核对发布所需证据 |
| [`architecture/README.zh.md`](architecture/README.zh.md) | Host、工具、preset、类型化 Remote 和 Client 插件的职责边界 | 修改运行时、RPC、preset、Client 或持久化 |
| [`architecture/package-ownership.zh.md`](architecture/package-ownership.zh.md) | 三个包目录、发布用的包清单与单向依赖关系 | 修改包的边界、包清单或依赖方向 |
| [`architecture/host-authority.zh.md`](architecture/host-authority.zh.md) | Host 拥有什么：ledger、生命周期、projection、Session 持久化、Attention、上下文压力、私有记忆与 member capabilities | 修改 Host 运行时、持久化、重放、Attention 或记忆行为 |
| [`architecture/tools-and-preset.zh.md`](architecture/tools-and-preset.zh.md) | 面向模型的工具及其定义位置，以及隔离的 `team-member` 和 `team-manager` preset | 修改面向模型的工具或 preset 挂载的内容 |
| [`architecture/client-and-remote.zh.md`](architecture/client-and-remote.zh.md) | 类型化 Remote 声明、Client 插件与 slot 的组合，以及数据与呈现的边界 | 修改 RPC、Client 插件加载、slot 或投影 |
| [`architecture/workspace-session-storage.zh.md`](architecture/workspace-session-storage.zh.md) | 复用 Harness 的 Workspace、Session 和存储，而不另建并行 Team 状态 | 修改 Workspace 选择、Session 存储或 ledger 路由 |
| [`domain-model.zh.md`](domain-model.zh.md) | 稳定的 Agent Team 领域词汇 | 修改领域语义、类型命名或正式协作约定 |
| [`team-collaboration/README.zh.md`](team-collaboration/README.zh.md) | 协作工具、Thread Attention、Inbox 与写入边界 | 修改 Team 协作语义、模型工具或 Agent 通知时 |
| [`team-collaboration/model-and-time.zh.md`](team-collaboration/model-and-time.zh.md) | 协作模型与 Member 时间感知 | 修改 Thread、Task、Claim 的含义或时间提示 |
| [`team-collaboration/tools.zh.md`](team-collaboration/tools.zh.md) | 面向模型的工具与共用规则 | 修改工具约定、ref 或写入边界 |
| [`team-collaboration/attention-and-messaging.zh.md`](team-collaboration/attention-and-messaging.zh.md) | Attention、Inbox、mention、面向人类的消息与 ref 引用 | 修改通知、mention 投递或消息呈现 |
| [`team-collaboration/boundaries.zh.md`](team-collaboration/boundaries.zh.md) | Mutation fence、Human Remote 边界与 Team Member 上下文边界 | 修改谁能改什么，或 Member 能看到别的 Session 的什么 |
| [`team-collaboration/memory-and-context.zh.md`](team-collaboration/memory-and-context.zh.md) | Member memory、上下文压力归属、Agent notification 与 assembled acceptance | 修改记忆维护、上下文压力处理或验收必须证明什么 |
| [`frontend-design/README.zh.md`](frontend-design/README.zh.md) | Team Client 的设计原则、布局、排版、组件、可访问性与验证流程 | 修改 `packages/client-agent-team/src/client/` 的界面或交互 |
| [`frontend-design/principles-and-language.zh.md`](frontend-design/principles-and-language.zh.md) | 设计原则与 DSH 设计语言对齐 | 决定复用哪些原语，或对齐 DSH 语言 |
| [`frontend-design/layout-and-typography.zh.md`](frontend-design/layout-and-typography.zh.md) | 布局骨架、排版、颜色与身份 | 修改布局、字阶或颜色 |
| [`frontend-design/components.zh.md`](frontend-design/components.zh.md) | 各组件约定 | 修改某个 Team 组件或其状态 |
| [`frontend-design/thread-and-composer.zh.md`](frontend-design/thread-and-composer.zh.md) | 时间线滚动、composer 与 mention、入口行、状态胶囊 | 修改滚动、composer、入口行或状态胶囊 |
| [`frontend-design/sidebar-browser.zh.md`](frontend-design/sidebar-browser.zh.md) | 侧栏浏览器与 Inbox 界面 | 修改侧栏浏览器或 Inbox 界面 |
| [`frontend-design/refresh-copy-accessibility.zh.md`](frontend-design/refresh-copy-accessibility.zh.md) | 刷新语义、文案、可访问性与演进 | 修改刷新行为、文案或可访问性 |
| [`harness-navigation.zh.md`](harness-navigation.zh.md) | 本仓库与 `../deepseek-harness` 的查阅路线、源码入口、已知接入陷阱 | 不确定应该查哪个 Harness 文档/package/source 时 |

## 文档规则

编辑或新增本目录下的文档前，请先读[文档维护规则](AGENTS.md)。
