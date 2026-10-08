# dsh-agent-team / deepseek-harness 导航

[English](harness-navigation.md) | 中文

日期：2026-09-18

本文是正式工程导航文档，记录已对照当前源码、测试或 Harness 文档核实过的跨仓库路线。package、脚本、slot 或安装方式变化时更新它。它不是 Harness 文档的替代品，也不改变产品决策；当前行为以源码和测试为准。

## 1. 两个仓库的职责分界

| 问题 | 先看本仓库 | 再看 `../deepseek-harness` | 权威性 |
| --- | --- | --- | --- |
| Team 领域对象、权限、ledger、Task/Claim/Attention/Inbox | `docs/domain-model.zh.md`、`docs/team-collaboration/`、`packages/agent-team/src/`、tests | 只查被消费的 DSH service contract | 本仓库实现 |
| Host 行为 | `packages/agent-team/src/{index,ledger,spec,types}.ts`、tests | Agent/Session/Workspace/Storage/Typert 的架构与相关 subsystem 文档 | 本仓库行为；Harness 拥有底层能力 |
| Model-facing tools 与 preset | `docs/team-collaboration/`、tool 源码、`team-member` preset | `docs/cookbook/adding-a-tool.md`、tools、permission-preset 文档 | Team 工具语义；Harness 扩展接口 |
| Client plugin、Team mode、UI | `docs/architecture/README.zh.md`、`docs/development/README.zh.md`、Client 源码 | Client modules、client loading notes、`packages/client/AGENTS.md`、shipped UI 源码 | 本仓库 UI 规则；Harness 加载/slot/React 边界 |
| Typed Remote | `docs/architecture/README.zh.md`、`@Remote` declarations、`scripts/generate-typert.mjs` | Typert 文档/源码与 API remotes | Harness 生成/装配；Team 方法 |
| 发布与 bundle 安装 | 根 README、`cordis.patch.yml`、根 manifest | Harness README、package cookbook、profile/bundle 文档 | Harness 安装器；本仓库 bundle 布局 |
| 真实 Web 验收 | development 文档、browser 脚本、被忽略的 artifacts | Harness Web scaffold、testing 文档、Client tests | 本次运行的脚本输出；archive 只保留里程碑证据 |

Harness 行为不确定时，先读上游文档，再读实现和测试。不要把 `.scratch/` 中的探索当作 API contract，也不要为了迎合猜测改写 Team 语义。若公共 API 无法表达目标交互，记录该限制并选择 bundle 自有的 plugin 或设计。

## 2. 按改动类型查阅路径

### Host、ledger 或生命周期

读本仓库源码/测试与 `docs/domain-model.zh.md`／`docs/team-collaboration/`；检查 `index.ts`、`ledger.ts`、`spec.ts`、`types.ts`，确认只有一个 authority 和一条 durable commit path。随后查阅 Harness 的 architecture、storage、workspace、Typert 与 defensive-patterns 文档及对应源码包。新增 model-visible input 需要 session-log 依据；生命周期应由 package tests 与真实 composition 覆盖。

### Model-facing tool 或 preset

读 Team collaboration 文档、tool 源码与隔离 preset。查阅 Harness 的 tool、permission-preset、system-prompt 文档与源码。Schema、canonical output、execute、presentation 是不同层；不要把 Host 变成 global tool。普通 Session 不得获得 Team tools 或 guidance。

### Client、browser bundle 或加载图

读 architecture 的 Client 章节、development 的 UI 验收规则与目标组件；查阅 Harness client-module 文档、client loading notes、`packages/client/AGENTS.md`、web styling、Cordis lifecycle tutorial，以及对应的 slot/runtime/sidebar/conversation/workspace/theme/module 源码。先 mount 生成的 Remote，再注入依赖它的 UI；declaration 可能稍后才出现时使用 `ctx.slots.inject()`。

parent entry 的 `children` declaration 同时是 render site 与 render authority。Team 的 `sidebar.workspaces` shadow 不得复制 shipped 的 `sidebar.workspaces.directoryFlow`；SlotCore 会拒绝重复的 live child declaration。复用 public exports 与 theme token，不要复用 shipped 的 private component 或 private CSS；component 通过 slot contract 取得数据，而不是直接接触 `ctx`。

### Typed Remote、RPC 或生成物

读 Team service declaration、types 与生成脚本；读 Harness 的 Typert generator/loader/protocol/registry 与 API-remote 源码。`InvocationDescriptor` 是反射元数据，不是 wire data。运行 `npm run generate:typert`、typecheck、build，并确认输出稳定。绝不手改 `lib/typert.*`。

### Workspace、Session 或目录选择

Team 读取 `ctx.workspaces.list`，不复制 Workspace 创建或浏览状态。读 Harness 的 workspace、session、storage 文档与源码，保持 branded Workspace ID 与 Host 拥有的 cwd 语义。当前 UI 不调用 `pickDirectory()` 或 `create()`；用户创建 Workspace 时回到普通 Session UI。

### Storage、persistence、replay 或 Thread Inbox

读 Team 的 ledger/projection/lifecycle 源码与 JSON/SQLite 测试，再读 Harness 的 storage、persistence、session-persistence、defensive-patterns 文档与源码。ledger 是唯一 durable authority；补充 failure-injection/恢复证据，而不是添加静默 fallback。

### CSS、primitives 或 responsive layout

先读目标组件与 CSS Module，再仅为背景读 architecture/development 与 UI 历史。查阅 Harness web styling、primitives/theme 源码与 Client 规则。先解决布局与 public primitive 复用，再处理样式；保持 CSS Modules、`--dsw-*` tokens、焦点、dialog/menu 名称与 390×844 reflow。

## 3. 外部 bundle 的安装与验证

已核实的安装方式：

```sh
dsh plugin --profile team-demo add @contexera/dsh-agent-team
dsh --profile team-demo
```

本地开发安装：

```sh
dsh plugin --profile team-demo add /absolute/path/to/dsh-agent-team
dsh --profile team-demo
```

`cordis.patch.yml` 通过 `dsh.bundle.patch` 暴露 patch，在 `wowyuarm-agent-team-scope` 中挂载 Host、Client 与 invariant rows，并在 `isolate.agentPresets` 内声明 Team preset 注册表与 `team-member` 定义行。普通 DSH roster 不变。

验证顺序是 `npm run typecheck`、`npm test`、`npm run build`、`npm pack --dry-run`，browser/bundle 改动再加 browser 测试。手动预览用 `npm run preview`；同时检查普通 Session 中不出现 Team tools、guidance 与 UI。不要把临时 overlay、browser test 或生成文件提交到 Harness。

## 4. 开发 checkout 依赖

`npm run generate:typert` 使用相邻 checkout 的 `WorkspaceAnalyzer` 与 `FaceModelEmitter`。`scripts/sync-paths.mjs` 生成根 `tsconfig*.json` facades，使 tests 走 Harness source、typecheck 走 declarations、build 走已构建 declarations。不要编辑这些 facades，也不要添加 `include`/`files`。

安装已发布的 bundle 不需要 sibling checkout；只有本地 Typert 生成、typecheck、build 与真实 browser 验证需要它。

## 5. 维护边界

本文引用的 Harness 路径与规则在 Harness 变化后必须重新核对。历史 session 与 `.scratch/` 只作背景。本文是查阅路线，不是重复的 manifest、命令清单或领域规范；那些事实属于各自的权威文件与 `development/README.zh.md`／`architecture/README.zh.md`。链接 archive 材料时必须标明其设计或历史性质。
