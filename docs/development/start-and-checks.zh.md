# 开始与检查

[English](start-and-checks.md) | 中文

## 适用范围
本文记录本仓库的维护流程。命令的具体定义仍以根目录 `package.json`、各 package manifest 和 `scripts/` 为准。命令发生变化时，先改配置，再更新本文。

## 开始开发

新 clone 或 worktree 请先按[环境准备步骤](environments-and-install.zh.md#沙箱与-ci-环境)操作。只安装依赖不会链接已认证的 Harness，也不会生成 Host 测试加载的产物。文档检查不需要检出 Harness。

使用 `corepack pnpm install` 安装依赖，不要运行 `npm install`。仓库从根目录发布一个 npm bundle。`pnpm-workspace.yaml` 虽然匹配 `packages/*`，但三个源码目录都没有独立的 manifest，不能单独安装。该文件仍负责 peer 解析、依赖构建审批和发布时间例外规则。

## 检查梯度

先跑最贴近改动的检查，再按影响范围补齐交付检查：

| 改动 | 先跑什么 | 交付前 |
| --- | --- | --- |
| 只改维护文档 | `npm run check:docs` | 改了 lane 目录，再跑 `npm run check:e2e-docs`；改了 DSH 基线说明，再跑 `npm run check:versions`。 |
| Host、Ledger、权限、持久化或 Worker | `npm run test:unit` 或 `npx vitest run <spec-path>` | `npm test` 和 `npm run typecheck`。 |
| Client 状态、DOM 交互或错误文案 | 运行 `packages/client-agent-team/tests/` 下对应的 `*.client.spec.tsx`。 | 影响可见 UI 或组装时，还要过下方的浏览器门禁。 |
| Bundle、preset、slot、Remote 激活或组装后的 Web | `npm run test:browser -- <lane>` | 不带过滤参数的 `npm run test:browser`；改动横跨 Team 流程或准备发布时加 `--deep`。 |
| 发布包 | `npm run build` | 按[发布手册](../release-runbook.zh.md)核验。 |

提交前运行 `git diff --check HEAD`。只报告实际运行过的检查；应跑而没能跑的，说明原因。

### 命令速查

- `npm run generate:typert`：从 `packages/agent-team/src/` 的 Host face 生成 Typert Host/Remote artifacts。
- `npm run typecheck`：先生成 Typert，再检查 Host、tools、Client 及 `tsconfig.scripts.json` 列出的 Node 脚本，包括 Session trace 和 Team 性能入口。
- `npm run check:docs`：检查双语配对与切换链接、大纲层级、相对链接与标题锚点、单个内容块的长度上限，以及索引是否覆盖所有维护文档。检查范围还包括根目录与三个源码目录的 README，以及根目录的贡献指南。
  - `node scripts/check-docs.mjs --budgets` 列出各文件最长的内容块，不执行门禁。
- `npm run check:e2e-docs`：核对 lane 目录、浏览器 runner 和场景文件是否一致。
- `npm run check:core-skills`：把随包 skill 的出厂契约变成机械检查，覆盖两处 root——`packages/agent-team/core-skills/`（Member）与 `packages/agent-team/manager-skills/`（团队管理会话）。检查五件事。front matter 的 `name` 与目录同名。`description` 说明真实触发场景。skill 摆到模型面前的文本不超过 `scripts/check-core-skills.mjs` 中的审定字符预算；随包脚本在汇总行里报告，不计入预算。所有相对链接都不越出 skill 目录，安装器只复制该目录。`references/` 下的每个文件都被 `SKILL.md` 链接。Member 的 root 至少要有一个 skill。
  - manager 的 root 随包交付六份引导 skill（`team-management-guide`、`team-operations`、`team-event-loops`、`manager-domain-model`、`manager-memory`、`manager-session-evidence`），门禁容许它为空，因为内容不是构建依赖。
- `npm run check:boundaries`：检查[包之间的依赖边界](generated-and-seams.zh.md)。`packages/*/src/` 下的文件不得用相对 specifier 跨越自己所在的 package 目录，去引用另一个 package。`import type` 豁免。运行时已被擦除。测试文件不在范围内：它们本就要把目录接起来。跨接缝的正确方式是用声明的 subpath，例如 `@contexera/dsh-agent-team/remote`。
- `npm run check:versions`：把已认证版本一致性变成机械检查。CI tag、setup tag、开发指南、README、架构文档、兼容性基线、bug 报告占位符必须声明同一个 DSH 基线，双语都要。该基线必须是每个 `@deepseek-ai/dsh-*` peer 区间的下界。它只断言互相一致，从不写死版本号。在任何 release lane 上都不用改门。动过任何版本字符串后单独跑它。
- `npm run check:comments`：检查 `packages/*/src` 与 `scripts/`，排除 `vendor/`。注释不得引用发布包读者无法解析的 `.scratch/`、工作项编号或验收标准；裸的 `issue #<n>` 和已文档化的 Team 实体 `Task #<n>` 可以保留。
  - 源码及 `packages/*/tests` 的注释不得包含大写待办标记或被注释掉的代码语句。Lint 抑制须带 ` -- <reason>`；禁止 `@ts-ignore` 和 `@ts-nocheck`，`@ts-expect-error` 须附解释。
  - 仅对源码：独立单行注释去除停用词后若剩一至五个词，不得只是重复下一行的词，包括 camelCase 标识符和复数。
  - 刻意不设行数预算：注释是否值得保留靠定期阅读审查。`node scripts/check-comments.mjs --budgets` 只打印每个 scope 的注释水位表，不做判定。
- `npm run check:scratch`：把归档工作区的规则变成机械检查。索引与工作项目录一致、每个工作项有入口 README、归档 README 里的链接可解析、已封存的票只有带 `> 已归档` 说明时才允许保留进行中状态、月份总览覆盖该月全部工作项。归档 spec 与 materials 里的历史代码引用不在范围内；不需要相邻 Harness 检出。CI 的 `checks` job 在每次 PR 与 push 上运行它；需要 Harness 的 lane 仍跳过工作历史。
- `npm run check:facades`：只比不写。按相邻 Harness checkout 重算 path facades。已提交的 `tsconfig*.json` 或 `.generated-harness` 标记只要与生成结果不同就报错。给 `scripts/sync-paths.mjs` 加了 subpath，就不可能不带上重新生成的 facades。它由 `npm test` 捆绑执行。全新 clone 必须先重新生成 facades，见 [`environments-and-install.zh.md`](./environments-and-install.zh.md)。
- `npm test`：先生成 Typert、跑 `check:facades`、`check:docs`、`check:e2e-docs`、`check:core-skills`、`check:boundaries`、`check:versions`、`check:comments` 与 `check:scratch`，再运行全部 Vitest project。
- `npm run test:ci`：在 CI 的 build 与 typecheck 已生成 Typert 后，检查依赖 Harness 的 facades，再运行全部 Vitest project。CI 的 `checks` job 会在 Linux 与 Windows lane 之前统一运行仓库级静态与卫生检查，因此两条 lane 使用这个聚焦命令，不改变本地 `npm test` 的完整契约。
- `npm run test:unit`（或 `npx vitest run --project unit`）：仅运行 5s 预算的快速单元测试。`vitest.config.ts` 集中管理全部超时预算，划分为六个互斥 project：`unit`（5s）、`integration`（60s）、`worker-composition`（60s test / 30s hook）、`worker-long`（120s test / 30s hook）、`benchmark`（900s，由 `DSH_BENCH_STORAGE=1` 显式启用）与 `shared-host`（30s test/hook）；单个测试文件不得再使用 `vi.setConfig` 或内联超时参数。
- Worker composition 车道更宽的 hook 预算让卡住的原生清理可以结束，不会把测试自己的失败藏成 10 秒 fixture hook 超时。
- Client 测试台（`packages/client-agent-team/tests/harness.tsx`）会让「渲染中的 shipped slot entry 崩过」的 spec 直接失败。shipped error boundary 会把异常吞掉、只经 `console.error` 报告，没有这道护栏时页面已经消失而套件仍然全绿。该测试台同时补齐 jsdom 缺的浏览器 API（`ResizeObserver`、`document.fonts`）与完整的 `conversation` service 面。缺一个 observable 成员不是「少一个方法」，而是 renderer hook cache 里的 `WeakMap.set(undefined)` 抛错。
- Vitest 通过 `scripts/isolate-dsh-home.setup.ts` 给每个测试文件一次性 `DSH_HOME`。隔离的是各 Member activation 的 `$DSH_HOME/agent-team/members/member:*` 私有 memory。需要特定 home 的测试自行保存/恢复该变量（见 `member-lifecycle.spec.ts`）。启动不会自动清理账本不认识的 Member 目录。显式 Member remove 才删除该 Member 的私有 memory。介质重置后的旧目录须由操作者手动删除 `member:` 目录。
- 测试套件钉死一个时区（`Asia/Shanghai`，在 `vitest.config.ts` 里），因为时间渲染按契约就是**依赖时区**的。座位陈述的是读者自己的钟，同一条期望否则会在不同 runner 上读成不同的钟点——CI 是 UTC，维护它的机器是 UTC+8。钉的时区**刻意不是 UTC**，这正是断言保持锋利的原因：一个伸手去拿 `getUTCHours` 的 formatter 会渲染出不是读者钟点的时刻，就在这里红。因此涉及时日的测试可以直接断言字面钟点，而**不必**去读 runner 的时区来凑自己的期望值。
- `npm run build`：先由受限 Node cleaner 清空 Host、tools 与 Client 三个 package 的 `lib/`。再生成 Typert、构建三个源码目录，并用 Harness 的 `tsdown` 构建 Client bundle。这样删除源码后遗留的旧产物不会进入 pack。`clean:build-outputs` 只跑同一个 cleaner，用于 `lib/` 过期或只构建了一半的树。最终发布物仍是一个根 npm 包。
- `npm run lint`：运行 oxlint。
- `npm run duplication`：用 `.jscpd.json` 对 `packages` 与 `scripts` 跑 jscpd。它的输出只是"值得看一眼的地方"，不是结论。移动或重构过的代码同样会被报成重复。
- `npm pack --dry-run`：检查根 bundle 的发布内容。`prepack` 会先跑完整 build。所以它是发布前置步骤，不是日常检查。
- `npm run check:artifact`：回读 `npm pack` 真正会装进 tarball 的内容，拒绝会以破损形态发布的产物。三种是：混入的 `.ts`/`.tsx` 源码；缺失的 `cordis.patch.yml`；目标不在 tarball 内的运行时相对导入。最后一项在本地任何检查里都看不见，因为工作树里每个文件都在。跑完 `build`、发布之前跑它。
- `npm run check:public-baseline`：把 `@deepseek-ai/dsh-*` peer 声明的已认证 DSH 基线与每一处手工重述基线的公开面比对。公开面是两个 README 与 Harness 仓里置顶的兼容性讨论。解析不出来的面算失败、不算跳过。改写 README 不会让检查悄悄掉出覆盖范围。需要 `gh`。`--offline` 跳过讨论读取，只用于本地迭代。

两项发布门禁的执行顺序见[发布手册](../release-runbook.zh.md)。

### 浏览器门禁与预览模式

迭代时，从 [lane 目录](e2e-lanes.zh.md)挑选相关场景。例如：

```sh
npm run test:browser -- team-manager team-inbox-and-recovery
```

定向执行仍会构建和暂存 bundle，但不检查整个套件的截图是否齐全。影响组装后的 bundle、Client 加载、slot、Remote 激活、manifest 或可见 UI 时，交付前须运行完整门禁。默认用简短的 Team 冒烟场景；`npm run test:browser -- --deep` 会用完整流程替换该场景。

修改可见 Team UI 或升级 DSH 时，还要运行 `node scripts/audit-ui-parity.mjs`。它会核对随包参照以及焦点可见性、控件尺寸等设计规则，但不能代替[检查真实浏览器证据](generated-and-seams.zh.md)。

| 模式 | 命令 | 适用场景 |
| --- | --- | --- |
| UI fixture | `npm run preview:ui` | 不用凭据即可查看 Team UI；意外调用模型时会明确失败。 |
| 浏览器验收 | `npm run test:browser` | 在 Chrome 中复现组装后 Web 的无凭据检查。 |
| 实时预览 | `npm run preview` | 与真实模型交互。先通过平时使用的凭据配置导出 `DEEPSEEK_API_KEY`；不会回退到 replay。 |

三条命令都会构建 bundle，把它和依赖暂存为 profile package，再启动 Harness 官方 Web scaffold。命令行 overlay 不能代替这种安装：它可能覆盖 profile 中的配置行，使供 Human 使用的设置表单无法写入。如果 Team 配置行导入失败，先确认暂存包是否注册到 profile，以及依赖是否随包暂存。

运行器使用临时 profile，正常退出时会清理；浏览器运行器还会删除临时写入 Harness 的测试文件。浏览器不在 `/usr/bin/google-chrome` 时设置 `CHROME_PATH`。浏览器验收不会运行两条预览命令；改动共用的 scaffold 或 profile 解析后，须分别验证受影响的预览模式。
