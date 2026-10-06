# 环境与安装

[English](environments-and-install.md) | 中文

## 沙箱与 CI 环境
测试与类型系统不是自包含的：40+ 个 `@deepseek-ai/dsh-*` 包全部从相邻 Harness checkout 解析（`src/` 与已构建的 `lib/` 都要在）。沙箱 agent 与 CI runner 必须复刻这个布局，而不是自行发明。

这适用于任何全新环境：新 clone **或 `git worktree`**。worktree 不携带主 checkout 中被 gitignore 的 `node_modules/` 与 `lib/`，因此下面的步骤在那里同样要从头执行。跳过步骤 4（链接与构建）不会在启动时报缺模块，而是稍后以 host 测试中大面积 preset 解析假失败的形式出现。

**checkout 目录名就是契约。** Harness 必须 clone 为相邻的 `../deepseek-harness`——所有脚本的默认 fallback 名——并 checkout 最新认证 release tag。带 tag 后缀的相邻 checkout（`../deepseek-harness-<tag>/`）只属于隔离认证环境（见 [dsh-release-compatibility.zh.md](../dsh-release-compatibility.zh.md) 3.2 节）。把工具指向它是大面积假挂的根因。非默认名的 checkout 必须显式设置 `DSH_HARNESS_DIR`。

**按顺序准备：**

1. 先 `corepack enable pnpm` 落地 shim，再 clone `../deepseek-harness`，checkout 最新认证 release tag（当前 `dsh-v0.2.0-rc.2`，随认证前进），然后 `corepack pnpm install`（workspace 全量一次到位）、`corepack pnpm build:lib` 与 `corepack pnpm build:native-system`。 shim 是必需的：认证 Harness 自身的 script 内部会调裸 `pnpm`（`build:lib`、`build:web`），而 `corepack pnpm` 只在自己进程内解析。缺了 shim 这些步骤会以 `pnpm: not found` 失败。 两个仓库的 `packageManager` 都锁 `pnpm@11.7.0`，shim 因此解析到该版本，而非环境预装的任意版本。

   native 这一步是独立的构建，不会由别处替我们完成。host addon 被 gitignore：Harness 的 `test` script 会在自己的 Vitest 之前用 `build:native-system` 构建它。本仓库是直接对那个 checkout 跑 Vitest。全新 clone 缺了它会表现为宿主 Team 激活失败（`Agent is not an active Team Member`），而不是缺模块报错。 `--host-addon-only` 在非 Linux/macOS 上直接退出、不构建，因此该步骤在所有平台都安全。 不要复用上一次构建遗留的 `lib/` 或 `node_modules/`——旧产物可能掩盖声明或运行时不兼容。
2. 工作流需要 `test:browser` 时，用 `corepack pnpm build:web` 构建 Harness `apps/web` dist；workspace install 已备好其依赖。
3. 在本仓库内用 `corepack pnpm install` 安装依赖。绝不能运行 `npm install`：它会静默破坏指向相邻 checkout vendor 包的 workspace 符号链接，故障随后才以误导性的 `Cannot find module 'zod'` 暴露。
4. 用 `node scripts/link-harness-packages.mjs` 把 Harness 的 workspace、其 vendor 包与相邻的 context-continuity 引擎链接进本仓库 `node_modules`。再 `npm run build` 构建 bundle。引擎按 `scripts/continuity-dir.mjs` 的解析结果提供。相邻 checkout（日常开发对引擎工作树）会被链接进 `node_modules`，此时该 checkout 必须已构建（`npm run build`）。干净 checkout/CI 则直接用根 `dependencies` 从 registry 装好的那份，不再链接。`DSH_CONTEXT_CONTINUITY_DIR` 可把解析指向另一个 checkout。宿主测试从本仓库根按真实 `node_modules` 查找解析 preset row 与 bundle 自身的未发布 row（如 `@wowyuarm/dsh-agent-team/member-context`）。它与已发布 bundle 的 profile 安装布局一致。
5. 用 `node scripts/sync-paths.mjs` 对准全新 checkout 重新生成 TypeScript path facades。全新 clone 不能信任仓库里已提交的 facades。没有任何 npm script 会重写它们：跳过这一步 facades 指向的仍是生成时固化的旧路径。`npm test` 里那道只读门 `check:facades` 正是对这种不一致报错。`sync-paths` 同时生成测试 harness 需要的 `@deepseek-ai/dsh-client-locale/src/*` 通配映射。
6. 冒烟验证：`npm run typecheck && npm test`。全绿 = 环境正确；大面积假挂（见下）= 环境不对——先修环境，再查 diff。

**环境变量：**

| 变量 | 何时需要 | 说明 |
| --- | --- | --- |
| `CHROME_PATH` | `test:browser`（可选） | 默认 `/usr/bin/google-chrome`；仅当沙箱 Chrome 不在默认位置时设置 |
| `DSH_CONTEXT_CONTINUITY_DIR` | 仅隔离 checkout 场景 | 把引擎解析指向另一个 `dsh-context-continuity` checkout；日常保持未设——先找相邻目录，再退回 registry 装好的那份 |
| `DSH_HARNESS_DIR` | 仅认证场景 | 指向带 tag 后缀的相邻 checkout；日常保持未设——默认名即契约 |
| `DEEPSEEK_API_KEY` | `npm run preview` | 真实模型预览缺它即刻失败；测试与浏览器路径从不需要 |

**环境错误而非代码错误的症状**。大面积 `TypeError ... reading 'UNLOADING'` / `FiberState` undefined 失败 = Vitest 解析到了缺失或过期的 Harness checkout。`Cannot find module 'zod'` = npm 破坏了 pnpm 链接：但若来自 `generate:typert`，那是它自己配置的那条链接出了问题（见 生成文件）。先修环境，再查 diff。

**工作树上方不得有遗留 `node_modules`。** TypeScript `typeRoots` 与 Node 模块解析都会沿祖先目录上爬，home 目录下一次误跑 `npm install` 留下的 `node_modules\@types` 会把它的类型静默注入每次编译。实测表现为 harness 构建报出 lockfile 解释不了的 React 19 类型错误（实际锁的是 18）。全新 checkout typecheck 报出 lockfile 无法解释的类型错误时，先逐级检查祖先目录有无遗留 `node_modules`，再查代码。

**checkout 指针集中化且 fail-fast。** `scripts/harness-dir.mjs` 是所有消费方（Vitest、`sync-paths`、`build-client`、`generate-typert`、浏览器/预览 runner）共同解析的单一事实源。`DSH_HARNESS_DIR` 设定时优先。其次读 `sync-paths` 写下的 `.generated-harness` 标记（测试自动跟随 facade 生成时的同一 checkout——认证轮生成后忘了带 env 也不会让两者劈叉）。最后落到默认相邻名。解析出的目录不存在时立即中止，列出相邻真实存在的 Harness checkout 与修复指引，而不是等到跑测才炸出上面那些远端症状。

**引擎指针：checkout 或已安装的包。** `scripts/continuity-dir.mjs` 是 `@wowyuarm/dsh-context-continuity` 的唯一解析源。`DSH_CONTEXT_CONTINUITY_DIR` 优先。其次是相邻的 `dsh-context-continuity` checkout：对着引擎工作树开发，`link-harness-packages.mjs` 会把它链接进 `node_modules`，`generate-typert.mjs` 会把它预置进分析包。最后是根 `dependencies` 装到 `node_modules/@wowyuarm/dsh-context-continuity` 的那份（干净 checkout/CI，无需链接）。解析不到任何包布局时立即 fail-fast，并列出尝试过的候选与修法。

**引擎的安装契约。** 引擎以 `@wowyuarm/dsh-context-continuity` 发布；根 manifest 将它声明为常规 dependency。profile 安装会把它随 bundle 一起装进来：profile 的 pnpm 以 `autoInstallPeers: false` 运行，没人提供的 peer 对谁都解析不到，而 `shipping.spec.ts` 的 boot-critical closure 关卡把 dependencies 也算作可达 root。因此 CI 不需要任何引擎步骤：`pnpm install` 会把已构建好的包装进来，链接脚本也会跳过那次会指向自身的链接。引擎前进时改这一个条目并提交 `pnpm-lock.yaml`；本地若解析到相邻 checkout，必须保证那份已构建（在其目录里 `npm run build`）。

**CI lanes。 ** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) 在干净的 `ubuntu-latest` 与 `windows-latest` runner 上运行 typecheck 加完整测试套件——pull request、push 到 `master`、手动 `workflow_dispatch` 都会触发。 两条 lane 执行上面相同的六步环境契约。Windows lane 的每一步经 git bash（`shell: bash`）运行，因为默认 pwsh 会破坏反斜杠续行。harness 包经目录 junction 链接，无需 symlink 权限。 范围护栏：无 coverage matrix、无发布自动化、无 `test:browser`——浏览器验收始终是本地步骤。 Windows lane 是文件系统标识符类 bug（issue #7/#8）的回归防线。 唯一可调变量是 `DSH_HARNESS_TAG`；认证推进该 tag 时，workflow 的 env、本文档与 [`.hoplite/settings.json`](../../.hoplite/settings.json) 三处同步更新——三处靠手工保持一致。

若该次 tag 推进同时移动了 DSH peers，必须在同一改动里提交 `pnpm-lock.yaml`。CI 以 `frozen-lockfile` 安装，而本地装一次就会就地重写 lockfile，把这个不一致一直掩盖到 CI 上才暴露。 开发脚本（`build-client`、`run-browser-test`、`run-preview`、`run-ui-preview`）已做 Windows 硬化，在该平台经 git bash 运行，本地 Windows 开发遵循同一环境契约。

## 外部安装验证
发布形态是根 bundle：

```sh
dsh plugin --profile web add @wowyuarm/dsh-agent-team
dsh web
```

本地目录安装：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-agent-team
dsh web
```

`cordis.patch.yml` 是 bundle patch 的入口。它将 Host、Client 和 invariant rows 加入 opt-in profile，并在隔离的 `agentPresets` scope 中挂载 `team-member` roster。普通 Session 的 shipped/user preset roster 不应被 Team bundle 改写。

插件页会把这个 scope 容器渲染成一个组件行并显示「已关闭」；这是预期现象，无需在这里做任何操作。容器是组合载体而不是功能插件，它自身没有可匹配的 live entry，而 Loader 对 group 条目一律按启用处理；真正在运行的是它内部列出的那几行。web 与桌面构建的渲染一致。

真实安装验证必须使用已构建 package 的发布布局。直接 symlink 到源码可能绕过 profile 内的 peer fallback，导致与真实安装不同的结果。`scripts/team-ui.e2e.ts` 和 `scripts/team-ui.preview.ts` 已采用复制 package 的方式。

### Profile 模式与发布节奏

日常自用与开发验收使用两个并存 profile，互不干扰：

- **稳定模式**（`--profile web`）：依赖 npm 发布版（`^0.1.x` 语义化范围），pnpm lockfile 锁定已装版本。发布后需按**精确版本号**安装 `dsh plugin --profile web add @wowyuarm/dsh-agent-team@X.Y.Z`：直接 `update` 可能在 lockfile 仍钉着旧解析的情况下报「Already up to date」。见 [`release-runbook.md`](../release-runbook.md) §6。
- **开发模式**（`--profile web-dev`）：依赖 `link:` 本地检出，rebuild + 重启即用最新代码。注意宿主加载的是构建产物 `packages/*/lib/`。改完源码只重启而不 `npm run build`，Member Session 仍会拿到旧工具清单（工具清单在激活时从当前运行代码派生）。先 build 再重启才生效。

启动运行时必须与安装形态匹配。稳定 profile 由发布版 dsh（全局安装的 `@deepseek-ai/dsh`，宿主全程运行 `lib/` 构建产物）启动。checkout 里的 `pnpm dsh`（tsx + tsconfig paths，宿主运行 `src/` 源码）只能启动 `link:` 安装的 profile。npm 安装的 bundle 周围没有 tsconfig paths，其 harness 依赖会解析到各包的 `lib/`，与宿主的 `src/` 实例形成两份模块。`dsh-scope` 的 scope 标签是模块内 Symbol，跨实例不一致。Member 激活的 preset 校验会以 `selected preset is not team-enabled` 失败，表现为稳定 profile 全体 Agent 不可用（2026-08 诊断确认）。见到该症状时，先核对启动用的 `dsh` 是发布版还是 checkout 的 `pnpm dsh`。

发布节奏是批量的：两次发布之间，操作者将本地构建日常自用，作为轻量验收渠道——日常使用反馈等同有效验证。agent 与贡献者按检查梯度选择最窄检查即可，不必为每个小改动要求完整验收；累积若干修复与优化、在日常使用中稳定后，再批量发新版。发布流程本身——前置检查、检查阶梯、发布材料、打 tag 与发布、发布后核验——见 [`release-runbook.md`](../release-runbook.md)。

每次发布后随即把稳定 profile 装到该版本（按精确版本号，理由见上）。稳定 profile 与开发 profile 共享全局 ledger 存储（`$DSH_HOME/storages/`）。稳定 profile 停留在旧版而 ledger 已被新版写入时，启动会因记录 schema 校验失败而崩溃（2026-08 的 0.1.1 即是这种"写得出、读不回"的中间版本）。

本 bundle 的最低兼容版本是 DSH `0.2.0-rc.2`。DSH 的 JSONL Session persistence 会自行迁移已发布的旧格式（v0/v1/v2 → V3 → V4）。旧格式 Session 数据无需手动处置。不要为 Team ledger 或 Member Session 添加迁移、读取旧格式或静默回退逻辑。

### 重写与推送历史

本地 ref 可能是 `master` 上不存在的内容的唯一副本：`backup-pre-*` 分支与钉住它们的本地-only tag 就是这样一族，删除不可逆。反方向同样不可逆——本仓库是公开的，push 出去的历史收不回来。

重写历史之前——对已提交内容 `reset --hard`、`rebase`，或会丢弃独占内容的 amend。先把当前 tip 存成 `backup-pre-<说明>-<YYYYMMDD>` 分支。若这一族 ref 本身要被删除，则先 `git bundle` 成单个文件。没有备份时，被弃 commit 的唯一锚点只剩 `git reflog`，而 `git gc` 会清掉不可达对象。2026-09-12 那次 0.1.11 打磨轮的重写没有建 backup ref，被替换的 commit 只在 reflog 里。

push 之前对确切 refspec 跑一次 dry-run，并要求输出里只有你打算发布的 ref：

```sh
git push --dry-run origin master    # 发布版再加版本 tag
```

出现第三个 ref，就说明有本地-only ref 会进公开仓库——停下先处理。`git push --all` 与 `git push --tags` 会绕过这道闸门，永远不是发布命令。发布时的 push 就是这条栅栏再加上版本 tag；它前后的完整顺序见 [`release-runbook.md`](../release-runbook.md) §5。
