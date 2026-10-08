# 开始与检查

[English](start-and-checks.md) | 中文

## 适用范围
本文记录本仓库的维护流程。命令的具体定义仍以根目录 `package.json`、各 package manifest 和 `scripts/` 为准。命令发生变化时，先改配置，再更新本文。

## 开始开发
本仓库是独立的外部 DSH bundle。最终用户只需要安装发布包。本地开发和真实 Web 验证需要相邻的 `../deepseek-harness` checkout。

```text
../
├── deepseek-harness/
└── dsh-agent-team/
```

安装依赖使用仓库 README 规定的命令：

```sh
corepack pnpm install
```

`pnpm-workspace.yaml` 并不把 `packages/*` 声明为 workspace member。本仓库只发布一个根 npm 包。三个 `packages/*` 目录是这个 workspace 的构建目标，而不是可独立安装的 package。但该文件仍是承重配置。它关闭自动 peer 安装，并携带本仓库依赖的构建许可与发布年龄设置。因此不要因为某个目录没有自己的 manifest 就改动或删除它。根项目的 `node_modules` 和相邻 Harness checkout 提供本地开发所需的包与源码映射。

## 检查梯度
根据改动范围运行最小但足够的检查：

```sh
npm run generate:typert
npm run typecheck
npm run check:docs
npm run check:core-skills
npm run check:boundaries
npm run check:versions
npm run check:facades
npm test
npm run build
npm run lint
npm run duplication
npm pack --dry-run
npm run check:artifact
npm run check:public-baseline
git diff --check HEAD
```

这些命令的职责如下：

- `npm run generate:typert`：从 `packages/agent-team/src/` 的 Host face 生成 Typert Host/Remote artifacts。
- `npm run typecheck`：先生成 Typert，再检查 Host、tools 和 Client 三个源码目录。
- `npm run check:docs`：把 [`AGENTS.md`](../AGENTS.md) 的规则变成机械检查。检查六件事。第一，每份维护文档都有双语配对，切换器双向指对。第二，每对文档共享同一标题大纲：标题数量与层级一致。第三，所有相对链接可解析。第四，每个 `#fragment` 都指向目标文档真实存在的标题。第五，没有渲染块超出脚本中记录的单文件上限。第六，两个索引与现存文档集完全一致。同时覆盖四组 README 配对与仓库根的贡献指南配对。仓库根与每个 package 各一份 README，各自使用自己的切换器写法。只改文档时单独跑它即可。`node scripts/check-docs.mjs --budgets` 只打印单文件最长块表，不做判定。
- `npm run check:core-skills`：把随包 skill 的出厂契约变成机械检查。检查五件事。front matter 的 `name` 与目录同名。`description` 说明真实触发场景。整个 skill 不超过 `scripts/check-core-skills.mjs` 中的审定字符预算。所有相对链接都不越出 skill 目录，安装器只复制该目录。`references/` 下的每个文件都被 `SKILL.md` 链接。
- `npm run check:boundaries`：把下文的 package 接缝变成机械检查。`packages/*/src/` 下的文件不得用相对 specifier 跨越自己所在的 package 目录，去引用另一个 package。`import type` 豁免。运行时已被擦除。测试文件不在范围内：它们本就要把目录接起来。跨接缝的正确方式是用声明的 subpath，例如 `@contexera/dsh-agent-team/remote`。
- `npm run check:versions`：把已认证版本一致性变成机械检查。CI tag、setup tag、开发指南、README、架构文档、兼容性基线、bug 报告占位符必须声明同一个 DSH 基线，双语都要。该基线必须是每个 `@deepseek-ai/dsh-*` peer 区间的下界。它只断言互相一致，从不写死版本号。在任何 release lane 上都不用改门。动过任何版本字符串后单独跑它。
- `npm run check:facades`：只比不写。按相邻 Harness checkout 重算 path facades。已提交的 `tsconfig*.json` 或 `.generated-harness` 标记只要与生成结果不同就报错。给 `scripts/sync-paths.mjs` 加了 subpath，就不可能不带上重新生成的 facades。它由 `npm test` 捆绑执行。全新 clone 必须先重新生成 facades，见 [`environments-and-install.zh.md`](./environments-and-install.zh.md)。
- `npm test`：先生成 Typert、跑 `check:facades`、`check:docs`、`check:core-skills`、`check:boundaries` 与 `check:versions`。再运行 Vitest。
- Vitest 通过 `scripts/isolate-dsh-home.setup.ts` 给每个测试文件一次性 `DSH_HOME`。隔离的是各 Member activation 的 `$DSH_HOME/agent-team/members/member:*` 私有 memory。需要特定 home 的测试自行保存/恢复该变量（见 `member-lifecycle.spec.ts`）。启动不会自动清理账本不认识的 Member 目录。显式 Member remove 才删除该 Member 的私有 memory。介质重置后的旧目录须由操作者手动删除 `member:` 目录。
- `npm run build`：先由受限 Node cleaner 清空 Host、tools 与 Client 三个 package 的 `lib/`。再生成 Typert、构建三个源码目录，并用 Harness 的 `tsdown` 构建 Client bundle。这样删除源码后遗留的旧产物不会进入 pack。最终发布物仍是一个根 npm 包。
- `npm run lint`：运行 oxlint。
- `npm run duplication`：用 `.jscpd.json` 对 `packages` 与 `scripts` 跑 jscpd。它的输出只是"值得看一眼的地方"，不是结论。移动或重构过的代码同样会被报成重复。
- `npm pack --dry-run`：检查根 bundle 的发布内容。`prepack` 会先跑完整 build。所以它是发布前置步骤，不是日常检查。
- `npm run check:artifact`：回读 `npm pack` 真正会装进 tarball 的内容，拒绝会以破损形态发布的产物。三种是：混入的 `.ts`/`.tsx` 源码；缺失的 `cordis.patch.yml`；目标不在 tarball 内的运行时相对导入。最后一项在本地任何检查里都看不见，因为工作树里每个文件都在。跑完 `build`、发布之前跑它。
- `npm run check:public-baseline`：把 `@deepseek-ai/dsh-*` peer 声明的已认证 DSH 基线与每一处手工重述基线的公开面比对。公开面是两个 README 与 Harness 仓里置顶的兼容性讨论。解析不出来的面算失败、不算跳过。改写 README 不会让检查悄悄掉出覆盖范围。需要 `gh`。`--offline` 跳过讨论读取，只用于本地迭代。

这两道门是发布期检查而非日常检查。[`release-runbook.md`](../release-runbook.md) 给出了它们在一次发布里的执行顺序。

影响 browser bundle、Client module、slot、Remote activation、bundle manifest 或可见 UI 的改动，还要运行：

```sh
npm run test:browser
```

改动 Team 控件或界面的可见 UI 变更，额外运行机械的设计语言审计（含 shipped 参考 tripwire）：

```sh
node scripts/audit-ui-parity.mjs
```

该审计把 Team Client 的 CSS/TSX 与 `docs/frontend-design/principles-and-language.md` 中的设计语言契约对照。对照五项：焦点可见性、控件节奏、图标语义、硬编码颜色、shipped 参考是否存在。任何可见 UI 改动后、每次 DSH 升级后都应运行。

测试会先 build，然后在临时 profile 中复制已构建 package，启动 Harness 官方 Web scaffold，用 `/usr/bin/google-chrome` 跑真实 journey。`CHROME_PATH` 可以覆盖浏览器路径。沙箱 setup 会在基础镜像没有浏览器时，把 Playwright 自带的 chromium 装到该路径。测试结束后会清理临时 profile 和 Harness 测试文件。

预览与浏览器验证分为三条显式路径：

```sh
# 真实模型交互；启动前要求 DEEPSEEK_API_KEY
npm run preview

# 无模型 UI 检查；加载隔离的 Team fixture，意外模型调用会明确失败
npm run preview:ui

# 无凭据、可重复的组装浏览器验收
npm run test:browser
```

`preview` 与 `preview:ui` 都使用临时 profile、临时 storage 和已构建 package，输出本地 URL。`Ctrl+C` 后清理。`preview` 固定使用 Harness 的真实 DeepSeek adapter，不会因缺少凭据静默切换到 replay。凭据缺失时在 build 和启动前失败。`preview:ui` 固定使用 keyless route-only adapter，初始 fixture 不触发模型。任何误触发的模型请求都会以明确错误终止，不能伪装成可用的真实交互。

三条通道都会把本 bundle 及其声明的依赖闭包暂存到临时 profile，再把暂存副本作为 profile package 声明。声明形态即 `dsh plugin add` 留下的形态：一条 `file:` 依赖、profile 自身 `node_modules` 下的链接、`dsh.profile.bundles` 中的一项。scaffold 从 `profile.layers` 构建出的 computed generation 解析插件 import。只有在该处声明的暂存副本才会贡献 Team 各行。这些行来自 bundle 自己的 `cordis.patch.yml`。

命令行 overlay 并不是等价的挂载方式。Host 行的 Human profile 表单写入 profile 文档，而更靠后的层（home patch 或命令行 overlay）声明同一行时，config editor 会拒绝这次写入。拒绝理由是 `overridden by a home patch or command-line overlay`。表单因而始终不可写。完全未被 scaffold 声明的暂存 bundle 既解析不到自己的行，也解析不到依赖闭包。全部 Team 行报 `failed to import` 且读不到任何模块解析错误。无密钥 fixture 随后会因 `ctx.agentTeam` 为 `undefined` 失败。

`test:browser` 不覆盖这两条 preview 通道。改动 scaffold composition 或 profile resolution 之后，必须手工启动它们各一次。

`test:browser` 固定使用 keyless、确定性的 Host/Client 驱动，不读取真实 provider 凭据。代表性链路从已有 Thread 开始。Human 两次确认邀请未关注 Agent。随后验证 Agent Inbox 读取/回复、Human Channel 与 Thread、页面 reload 后的 Host 持久事实。退出 Team mode 后验证普通 DSH surface 恢复。
