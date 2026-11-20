# dsh-agent-team / deepseek-harness 导航

[English](harness-navigation.md) | 中文

当 Team 的改动依赖 Harness 的能力时，从这里开始查。Team 的行为由本仓库定义；所用服务和扩展点的约定由 Harness 定义。

## 1. 从正确版本的源码开始

按[开发环境指南](development/environments-and-install.zh.md)准备指定版本的 `../deepseek-harness`。下表中的 Harness 路径都相对于该仓库。先读对应的上游指南，再用源码和测试核实约定。

如果公开扩展点不够用，记录限制，再选择由 Team 自己实现插件或调整设计。不要为了 Team 的改动改变普通 Harness 的行为。详见[仓库架构规则](../AGENTS.md#architecture-guardrails)。

## 2. 按改动类型查找约定

| 改动 | Team：先看这里 | Harness：再查这里 |
| --- | --- | --- |
| Host、账本或生命周期 | [Host 职责](architecture/host-authority.zh.md)、`packages/agent-team/src/{index,ledger,spec,types}.ts` 和 Host 测试 | `docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/subsystems/storage.zh.md` |
| 面向模型的工具或 preset | [工具约定](team-collaboration/tools.zh.md)、`packages/tool-agent-team/src/` 和 [cordis.patch.yml](../cordis.patch.yml) 中隔离的 preset | `docs/cookbook/adding-a-tool.zh.md`、`docs/subsystems/permission-presets.zh.md`、`docs/subsystems/system-prompt.zh.md` |
| Client 插件、slot 或加载 | [Client 与 Remote](architecture/client-and-remote.zh.md)，再看 `packages/client-agent-team/src/client/` | `packages/client/AGENTS.md`、`docs/subsystems/client-modules.zh.md`、`docs/subsystems/slots.zh.md`、`docs/cordis-tutorial/02-lifecycle-and-effects.zh.md` |
| 类型化 Remote、RPC 或生成文件 | `packages/agent-team/src/index.ts` 中的 Host `@Remote` 声明和[生成脚本](../scripts/generate-typert.mjs) | `docs/subsystems/typert.zh.md`、`packages/typert/{generator,loader,protocol,registry}/`、`packages/api/remotes/` |
| Workspace、Session 或目录选择 | [Workspace、Session 与存储](architecture/workspace-session-storage.zh.md)及 `packages/client-agent-team/src/client/index.ts` 中读取 Workspace 的代码 | `docs/subsystems/{workspace,session,working-directory,storage}.zh.md` |
| 持久化、回放或 Thread 收件箱 | [Host 职责](architecture/host-authority.zh.md)、[收件箱与消息](team-collaboration/attention-and-messaging.zh.md)和账本测试 | `docs/subsystems/{storage,persistence}.zh.md`、`docs/defensive-patterns/` |
| CSS、基础组件或响应式布局 | [界面设计指南](frontend-design/README.zh.md)，再看目标组件及其 CSS Module | `docs/web-styling.zh.md`、`packages/client/AGENTS.md`、`packages/client/ui-primitives/` |
| 发布或安装插件包 | [兼容性记录](dsh-release-compatibility.zh.md)、[package.json](../package.json) 和 [cordis.patch.yml](../cordis.patch.yml) | `apps/cli/reference/README.zh.md`、`docs/user/develop/basic/publish.zh.md` |
| Web 实际运行验收 | [浏览器场景](development/e2e-lanes.zh.md)、`scripts/e2e/` 和本次运行的输出 | `docs/testing.zh.md` 和 `packages/client/` 下的测试 |

## 3. 验证接入边界

- **Host 或持久化：**只保留一条持久化提交路径。新增模型可见输入时，用 Session 日志作为证据。生命周期改动同时验证包内行为与实际组装结果；涉及存储或回放时，测试故障与恢复，不要用静默回退掩盖问题。
- **Remote：**`InvocationDescriptor` 是反射元数据，不是在线路上传输的数据。按[生成文件流程](development/generated-and-seams.zh.md#生成文件)重新生成、检查类型、构建，并确认产物稳定。不要手改 `packages/agent-team/lib/typert.*`。
- **Workspace：**Team Client 读取 `ctx.workspaces.list`，不负责选择目录或创建 Workspace。用户在普通 DSH 界面完成这些操作。保留 Workspace ID 的品牌类型以及由 Host 管理工作目录的约定。
- **Client 或 Web：**按[仓库浏览器检查规则](../AGENTS.md#choose-checks-for-the-change)验证，并确认普通 Session 没有获得 Team 的工具、引导或界面。不要把临时覆盖配置、浏览器测试或生成文件提交到 Harness。

## 4. 安装或开发插件包

不需要相邻 Harness 源码的安装方式见[快速开始](../README.zh.md#快速开始)。本地构建与验证按[开发环境指南](development/environments-and-install.zh.md)和[检查指南](development/start-and-checks.zh.md)操作，其中也说明何时运行预览或浏览器测试。

根目录的包清单通过 `dsh.bundle.patch` 指向 `cordis.patch.yml`。补丁把 Host 挂载在 `contexera-agent-team-scope` 中，并为 `team-member` 和 `team-manager` 使用独立的 `agentPresets` 注册表。Client 和 invariant 条目位于该组之外。

本地运行 `generate:typert` 时会用到 Harness 的 `WorkspaceAnalyzer` 和 `FaceModelEmitter`。`scripts/sync-paths.mjs` 生成根目录的 TypeScript 路径配置：测试使用 Harness 源码，类型检查和构建使用声明文件。不要手工编辑这些配置，也不要添加 `include` 或 `files`。

## 5. 维护查阅路径

指定的 Harness 版本变更时，重新核对上游路径与约定。实现细节写在各自所属的文档里；引用 `.scratch/` 中的材料时，标明是设计或历史记录，不是现行约定。
