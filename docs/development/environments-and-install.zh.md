# 环境与安装

[English](environments-and-install.md) | 中文

## 沙箱与 CI 环境

Host 测试、类型检查和构建都需要相邻的 `../deepseek-harness`。新 worktree 也要安装自己的依赖并生成构建产物；它会在自己的上一级目录寻找 Harness。只改文档时，请直接看[检查梯度](start-and-checks.zh.md#检查梯度)。

Node 和 Corepack 需满足已认证 Harness 的 manifest 要求。首次配置按以下顺序操作：

1. 将 Harness 克隆到相邻的 `../deepseek-harness`，检出最新认证标签，当前是 `dsh-v0.2.2-rc.2`。执行 `corepack enable pnpm` 启用 shim，因为 Harness 构建脚本会直接调用 `pnpm`。Corepack 按各仓库的 `packageManager` 选择版本，两个版本不必相同。
2. 在 Harness 目录执行 `corepack pnpm install`、`corepack pnpm build:lib` 和 `corepack pnpm build:native-system`。Team 直接运行 Vitest，不会调用 Harness 的测试脚本来构建原生扩展。原生构建使用 `--host-addon-only`，会跳过不支持的平台。要跑浏览器测试或任一预览，再执行 `corepack pnpm build:web`。
3. 在 Team 仓库执行 `corepack pnpm install`。不要用 `npm install`，它可能破坏 pnpm 的链接。若遇到 `ERR_PNPM_IGNORED_BUILDS`，审查依赖的构建脚本，在引入依赖的同一次改动中用 `pnpm-workspace.yaml` 的 `allowBuilds` 明确允许或禁止。
4. 仍在 Team 仓库执行 `node scripts/link-harness-packages.mjs` 和 `npm run build`。这些链接和构建后的导出不只供 TypeScript 使用；Host 测试也从仓库根目录解析 preset。
5. 执行 `node scripts/sync-paths.mjs`，重新生成 TypeScript 路径映射，其中包括 locale 源码的通配路径。`npm run check:facades` 只对比，不会修复不一致。
6. 要完整验证环境，运行 `npm run typecheck && npm test`；日常改动按[检查梯度](start-and-checks.zh.md#检查梯度)选更有针对性的检查。

在可丢弃的沙箱中，可用 [`sh scripts/hoplite-setup.sh`](../../scripts/hoplite-setup.sh) 完成第 1–5 步并构建 Web。它会在已有的相邻 Harness 中强制检出认证标签，也可能清理构建残留；如果其中有需要保留的工作，不要运行。[Hoplite 配置](../../.hoplite/settings.json) 单独提供第 6 步作为 `check`。

| 环境变量 | 何时设置 |
| --- | --- |
| `DSH_HARNESS_DIR` | 选择其他 checkout 时设置，常用于[隔离认证](../dsh-release-compatibility.zh.md)；日常留空。 |
| `NODE_OPTIONS` | 需要覆盖沙箱 setup 默认的 `--max-old-space-size=4096` 时设置。 |
| `CHROME_PATH` | 如果浏览器不在 `/usr/bin/google-chrome`，在跑浏览器测试时指定。沙箱 setup 可用 Playwright Chromium 作备选。 |
| `DEEPSEEK_API_KEY` | 只供实时 `npm run preview` 使用；`preview:ui` 和 `test:browser` 不需要。 |

**先排查环境，再改代码。**

- **Harness checkout 不对：**共用解析器的脚本按顺序读取 `DSH_HARNESS_DIR`、`sync-paths` 写入的 `.generated-harness` 标记、默认相邻目录。找不到所选目录会立即报错。认证结束后，取消环境变量覆盖，清除仍指向旧 checkout 的标记，再按日常相邻目录重新生成映射。
- **Host 或 preset 测试成片失败：**先核对认证标签、Harness 的 `lib/` 和受支持平台上的原生扩展，再检查 Team 的链接和构建产物。`Agent is not an active Team Member` 或从未定义值读取 `UNLOADING` 都只是线索，不能单凭它们定因。
- **缺少 `zod`，或 React 类型和 lockfile 对不上：**先检查 pnpm 安装和链接。生成时报错则看 [Typert 暂存步骤](generated-and-seams.zh.md)。如果编译器找到了 lockfile 中没有的类型，检查祖先目录是否留有 `node_modules/@types`。

[CI](../../.github/workflows/ci.yml) 在 pull request、推送到 `master` 或手动触发时执行静态检查和 lint，无需 Harness。代码变动或手动触发还会运行 Linux 和 Windows 任务：缓存 pnpm store 和已认证的 Harness 构建，链接并构建 Team，重新生成映射，检查类型并执行 `test:ci`。Linux 还核验发布包、精简后的 Desktop 启动及 UI 一致性。CI 不运行浏览器验收。

认证升级时，同时更新 CI 标签、文档、peer 版本范围和 lockfile；CI 使用 `--frozen-lockfile` 安装。修改 lockfile 后，若 Vitest 或 `npm run duplication` 在启动时报错，分别检查 `@rolldown/binding-*` 或 `jscpd-*` 对应的平台条目是否还在。安装成功并不能证明这些条目齐全。

## 外部安装验证
发布形态是根 bundle：

```sh
dsh plugin --profile web add @contexera/dsh-agent-team
dsh web
```

本地链接开发请先构建 Team，单独使用开发 profile。以下命令在 Harness checkout 中执行。第一条只用于**新建** `web-dev`；重复运行会替换该 profile 原有的依赖和补丁。

```sh
corepack pnpm dsh --profile web-dev --from-default-profile web --dump-default-config
corepack pnpm dsh plugin --profile web-dev add link:/absolute/path/to/dsh-agent-team
corepack pnpm dsh --profile web-dev
```

`cordis.patch.yml` 是 bundle patch 的入口。它将 Host、Client 和 invariant rows 加入 opt-in profile。它在隔离的 `agentPresets` scope 中挂载 `team-member` 和 `team-manager` 的工具清单。普通 Session 的 shipped/user preset roster 不应被 Team bundle 改写。

插件页会把这个 scope 容器渲染成一个组件行并显示「已关闭」；这是预期现象，无需在这里做任何操作。容器是组合载体而不是功能插件。它自身没有可匹配的 live entry，而 Loader 对 group 条目一律按启用处理。真正在运行的是它内部列出的那几行。web 与桌面构建的渲染一致。

真实安装验证必须使用已构建 package 的发布布局。直接 symlink 到源码可能绕过 profile 内的 peer fallback，导致与真实安装不同的结果。`scripts/e2e/` 下的浏览器场景和 `scripts/team-ui.preview.ts` 已采用复制 package 的方式。

### 每个 DSH home 只允许一个 Host

同一个 `$DSH_HOME` 不能被两个正在运行的 Host 进程共用。定时器、订阅的私有 checkpoint 与账本投影都在这个 home 里，两个 Host 共用会重复触发运行、并让序号互相竞争。bundle 不对 home 加锁，这是运维约束：同时运行的每个 profile 都要使用独立的 `DSH_HOME`。调度权威见 [host-authority.md](../architecture/host-authority.md)。

### Profile 模式与发布节奏

日常使用和开发验收分别使用两个 profile：

- **稳定模式**（`--profile web`）：依赖 npm 发布版，pnpm lockfile 锁定已装版本。发布后需按**精确版本号**安装 `dsh plugin --profile web add @contexera/dsh-agent-team@X.Y.Z`。直接 `update` 可能在 lockfile 仍钉着旧解析的情况下报「Already up to date」。见 [`release-runbook.md`](../release-runbook.md) §6。
- **开发模式**（`--profile web-dev`）：依赖 `link:` 本地检出，rebuild + 重启即用最新代码。注意宿主加载的是构建产物 `packages/*/lib/`。改完源码只重启而不 `npm run build`，Member Session 仍会拿到旧工具清单。工具清单在激活时从当前运行代码派生。先 build 再重启才生效。

启动运行时必须与安装形态匹配。稳定 profile 由发布版 dsh（全局安装的 `@deepseek-ai/dsh`，宿主全程运行 `lib/` 构建产物）启动。checkout 里的 `pnpm dsh`（tsx + tsconfig paths，宿主运行 `src/` 源码）只能启动 `link:` 安装的 profile。npm 安装的 bundle 周围没有 tsconfig paths。它的 harness 依赖会解析到各包的 `lib/`，与宿主的 `src/` 实例形成两份模块。`dsh-scope` 的 scope 标签是模块内 Symbol，跨实例不一致。Member 激活的 preset 校验会以 `selected preset is not team-enabled` 失败。表现为稳定 profile 全体 Agent 不可用（2026-08 诊断确认）。见到该症状时，先核对启动用的 `dsh` 是发布版还是 checkout 的 `pnpm dsh`。

发布节奏是批量的。两次发布之间，操作者将本地构建日常自用，作为轻量验收渠道。日常使用反馈等同有效验证。agent 与贡献者按检查梯度选择最窄检查即可，不必为每个小改动要求完整验收。累积若干修复与优化、在日常使用中稳定后，再批量发新版。发布流程本身有五段：前置检查、检查阶梯、发布材料、打 tag 与发布、发布后核验。见 [`release-runbook.md`](../release-runbook.md)。

使用同一 `$DSH_HOME` 的 profile 共享 `storages/`。新版写入后，旧版读取 ledger 时可能无法通过记录校验。当前 Host 采用规则版本 9（见 [`ledger.ts`](../../packages/agent-team/src/ledger.ts) 的 `AGENT_TEAM_RULES_VERSION`）；ledger 采用该版本后，不支持它的旧构建会拒绝打开。

在新构建中打开 Team 之前，先按[发布手册](../release-runbook.zh.md)备份 `agent_team.sqlite`，再升级共享该数据库的每个 profile。

本 bundle 的最低兼容版本是 DSH `0.2.2-rc.2`。DSH 的 JSONL Session persistence 会自行迁移已发布的旧格式（v0/v1/v2 → V3 → V4）。旧格式 Session 数据无需手动处置。不要为 Team ledger 或 Member Session 添加迁移、读取旧格式或静默回退逻辑。

### 重写与推送历史

重写历史前，给需要保留的 commit 建立持久的本地引用。如果连引用也要删，先备份为 Git bundle。检查重写结果时，核对每个 commit 的内容，不要凭它在 rebase 列表里的位置判断。

推送前对确切的 refspec 做 dry-run，确认只包含要发布的分支或标签。发布时不要用 `git push --all` 或 `git push --tags`，具体步骤见[发布手册](../release-runbook.zh.md)。

## 容器里的无人值守工作

订阅与 reminder 都在 Host 进程内运行，不依赖外部调度器。occurrence 与到期时刻是持久事实，所以容器停着就什么都不跑，下次启动至多补发一次 reminder occurrence、并为每个到期订阅跑一次，且沿用它自己持久化的到期时刻，不会重新开一个窗口。调度的权威说明见 [host-authority.md](../architecture/host-authority.md)。

- **沙箱后端。** 每次运行都钉在 `workspace-write`，所以 Host 需要一个能真正执行它的后端：`bwrap`，或内核确实强制执行的 Landlock。`bwrap` 的判定是从 Host 自己的 `PATH` 上 spawn 探测一次并缓存在进程里，所以启动之后才装好的后端必须重启才生效；没有可用后端时，一条订阅也不会跑。
- **Shell 执行器。** 已挂载的执行器必须能应答某一 shell 家族（`bash` 或 `pwsh`）的探测，这个答案同样缓存在进程里。在另一家族下记录的脚本会直接失败，而不是被塞进它并未针对的 shell。
- **凭据。** 每个声明的引用都必须在 `$DSH_HOME` 的凭据存储里配好。运行环境是从零构造的——只有托管的 `DSH_TEAM_*` 事实加上解析出的引用——因此在 shell 配置里导出的 token 到不了脚本。没有声明凭据的订阅以匿名身份运行，而按出口 IP 限流的提供方会把这台容器的共享地址算到它身后所有客户端头上，不只是这个脚本。
- **Workspace。** Host registry 里的 Project Workspace 目录必须在容器里存在，因为运行就从那里开始：写死上一台机器绝对路径的脚本会失败，而不是读到旧树（见 [host-authority.md](../architecture/host-authority.md)）。
- **Webhook 入口。** 监听绑定在 `127.0.0.1:$DSH_TEAM_WEBHOOK_PORT`，通过隧道或反向代理对外发布，并且 `webhook.publicOrigin` 必须写这个公开 origin。origin 一变，已经注册到提供方的地址全部失效，需要重新 arm 订阅并登记新地址。

## 迁移之后

账本随 Host 一起搬走，所以时间表本身不需要修；要修的是它周围的部署事实。按这个顺序验证：

1. **Reminder 计时。** 建一条两分钟后的 `once` reminder：通知必须准点到达，`list` 里必须看到该 occurrence。这一步同时验证计时器、唤醒通道和账本，不碰任何订阅。
2. **沙箱、执行器与脚本内容。** 对一条 paused 订阅跑 `test`，读它的 category：`executor-missing`、`spawn-failed`、`shell-mismatch`、`workspace-missing`、`credentials-missing` 分别指名上面的一项前置。如果 trial 已经进到脚本、却死在上一台机器的路径上，那要修的是脚本，不是 Host。
3. **首个真实 interval。** 只有 trial 通过后再 resume，然后在 `team_subscription logs` 里确认第一次定时运行。只有脚本在自身输入读不到时会以非零 code 退出，`empty` 才算通过——否则「读不见」与「没有新事件」无法区分。能力恢复不等于订阅恢复，真实运行过才算。
