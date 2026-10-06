# 发布 Runbook

[English](release-runbook.md) | 中文

本文是发布 `@wowyuarm/dsh-agent-team` 一个版本的操作流程。它存在的意义是：维护者只看这一页就能跑完一次发布，包括那些因为曾经有缺陷流到用户手里才加上的检查。它不是行为规范——行为由源码与测试定义；而「这个 bundle 支持哪条 DSH 线」是另一个问题，由 [`dsh-release-compatibility.md`](dsh-release-compatibility.md) 负责。认证决定 peer 范围，本文决定承载该决定的版本如何到达 npm。

## 1. 谁决定什么

- **版本号与发布时机由维护者决定。** 发布不会从 CI、日程或攒下来的 diff 自动开始。修复走 patch，新能力走 minor；在 `0.x` 内，只承载兼容性的变更走 patch。
- **发布材料必须逐字过目后才能发。** 先写 `CHANGELOG` 条目与 GitHub Release 正文，把逐字稿贴进工作 Thread，得到明确同意才发。对方向的认可不等于对措辞的认可。
- **已发布的 `name@version` 永久有效。** npm 不会复用版本号，即使撤销发布也不会。元数据写错只能用新的 patch 修——绝不重新发布、不改写历史、不把 tag 移到已存在版本的身后。

## 2. 前置检查

1. **读懂变更集。** `git log --oneline v<上一个版本>..HEAD`，然后逐个读 feature commit 的 diff。commit message 会低估改动范围；只有 bundle 的用户能看见或调用的改动才算面向用户。
2. **起草材料**，然后送审（§4）——没有批准的文案就不发布。
3. **扫版本面。** `npm run check:versions` 会回读每一处重述已认证 DSH 基线的地方并拒绝分裂的基线：它以 `.github/workflows/ci.yml` 里的 harness tag 为准，要求其余每一处声明同一个版本，并要求每条 `@deepseek-ai/dsh-*` peer 范围的下界都能接纳它。
   - 这些位置的清单在 [`scripts/check-version-consistency.mjs`](../scripts/check-version-consistency.mjs)——不要手工维护第二份。
   - `.hoplite/settings.json` 里的声明位于一个 JSON 字符串中、引号是转义的，所以朴素的 `grep` 在那里什么都找不到；这道门读得对。
   - 这些位置只在该版本真正发布的同一轮里推进。
4. **扫正文里被本次发布证伪的句子。** 在维护文档里检索那些以「发布尚未发生」为前提的表述——`latest` 是 `<上一个版本>`、某项能力被描述为尚未发布、某个 peer 范围被描述为待定，或一条把更旧的 DSH 线与最后仍支持它的 bundle 版本配在一起的 warm-line pin。修正文档的当前状态声明确实属于发布提交的一部分；改写已发布的历史则不属于（§7）。
5. **确认工作树没有未提交的构建输入。** `prepack` 是 `npm run build`，而 `packages/*/lib/**` 在发布的 `files` 白名单内，所以未提交的 `src/` 改动会被打进 tarball。白名单之外的未跟踪文件（`scripts/`、`.scratch/`）不会被打包，也不阻塞发布。绝不要为了让工作树干净而 stash 或回退其他 Member 的工作——先弄清那是谁的。
6. **清楚 CI 会做什么、不会做什么。** 发布提交自身那一次运行必须在**两条 lane** 上都绿，然后才打 tag（§5）。纯文档推送根本不会产生运行：`ci.yml` 忽略 `**.md`、`docs/**`、`assets/**`，所以它的证据是 `git diff --check`、链接解析，以及从远端读回。

## 3. 检查阶梯

按此顺序执行；任何一步失败都中止发布，修好后从失败的那一步重跑。

| 命令 | 它拦下什么 |
| --- | --- |
| `npm run typecheck` | 针对已认证 harness checkout 的类型错误。 |
| `npm test` | 测试失败，以及它捆绑的五道机械门：`check:facades`、`check:docs`、`check:core-skills`、`check:boundaries`、`check:versions`。 |
| `npm run build` | 构建错误；这也是发布时 `prepack` 会跑的东西。 |
| `npm run lint` | lint 发现的问题。 |
| `npm run test:browser` | 组合、Remote 挂载、slot 接管或普通 DSH 恢复被破坏。需要相邻的 `../deepseek-harness` checkout；浏览器验收是本地步骤，从不在 CI 运行。 |
| `npm pack --dry-run` | 本身不拦什么——把文件数记进发布报告。 |
| `npm run check:artifact` | 会以破损形态发布的产物：混入的 `.ts`/`.tsx`、缺失的 `cordis.patch.yml`，或目标不在 tarball 里的运行时相对导入。要在 `npm run build` **之后**跑。 |
| `npm run check:public-baseline` | 与 manifest 的已认证基线发生漂移的公开面（两个 README 与置顶的兼容性讨论）。 |
| `git diff --check v<previous>..HEAD` | 发布改动集里任意位置的空白符损坏。裸 `git diff --check` 只看**未暂存**的改动，所以发布提交一旦落地它就静默通过——而梯子正是在那时跑的。 |

## 4. 发布材料

**`CHANGELOG.md`** 顶部新增 `## [X.Y.Z] - YYYY-MM-DD` 段，一条一个主题，措辞与 Release 正文英文部分一致。实现者写的 `## [Unreleased]` 是完整性清单，不是可直接用的草稿。

**GitHub Release 正文**两种语言都要有：中文在前、英文在后，顶部带语言切换器，新增功能 / 体验优化 / 问题修复 / 其他变更 四段在英文侧镜像。

- 开篇一句话点明上一个版本，结尾是安装块、兼容性一行与 Full Changelog 对比链接。
- 文风对齐 DeepSeek Harness 自己的 release notes：约八条、每条一句话，点出主题而不是它的各个子行为。
- 不要写指标、内部名词与文件名；陈述这个版本**是什么**，而不是它改了什么。
- GitHub 会重写裸 HTML 锚点 id，所以切换器的跳转从 0.1.7 起就没生效；切换器那一行仍是规定形状，等维护者决定。

**置顶的兼容性讨论**位于 `deepseek-ai/deepseek-harness`（discussion 4303），是一个没有同步路径的公开面——`check:public-baseline` 就是为此存在。维护方式是在我们自己的三条评论上轮转：贴新的发布评论、把上一个版本折进版本历史评论、然后按 node id 删掉我们自己上一条发布评论——先贴、再核验、后删除。绝不编辑或删除别人的评论；该讨论除了我们这三条，本来就合理地带着外部评论与回复。

## 5. 发布

推送或发布**之前**先断言四条发布语义：

1. tag 恰好是 `v<package.json version>`——manifest 与 tag 之间不得漂移。
2. 预发布后缀与 GitHub Release 的 prerelease 标记一致；稳定版不得被标为 prerelease。
3. 发布命令必须显式指名 dist-tag——`npm publish --tag <dist-tag> --access public`，稳定版用 `latest`、预发布用它自己的 tag。npm 会拒绝在默认 tag 下发布预发布，所以省略 `--tag` 根本表达不了这笔发布：运行会停在这里，而不会移动 `latest`。
4. 占用 `latest` 的发布绝不把它往回移：当前 `latest` 必须 semver 上低于即将发布的版本。

```sh
git add package.json CHANGELOG.md
git commit -m "chore: release X.Y.Z"
git push --dry-run origin master            # 栅栏：这里必须只列 master
git push origin master
```

等这一次运行在两条 lane 上都绿（§2.6）之后再打 tag：

```sh
git tag vX.Y.Z
git push --dry-run origin vX.Y.Z            # 栅栏：这里必须只列这个 tag
git push origin vX.Y.Z
npm publish --tag <dist-tag> --access public
```

显式 refspec 与它们的 dry-run 栅栏是承重的，不是仪式。本地克隆可能带着改写前的备份分支与仅本地 tag，其提交是刻意不进远端的，而 `--all` / `--tags` 会把它们静默推上去。本仓库是公开的：推错的 ref 无法收回。如果某次 dry run 列出了第三个 ref，停下来查清那是谁的。

先推 master 再打 tag 不花任何代价，却让 tag 的证据是诚实的：认证一个 tag 的那次运行，就是该 tag 所指提交自己的那次运行。只有当还没有任何东西引用这个 tag 时才允许重新指向它——没有 GitHub Release、没有 npm 版本、没有消费方。

## 6. 发布后核验

1. `npm view @wowyuarm/dsh-agent-team dist-tags.<dist-tag>`——等于 §5 发布时所用的那个 tag 值 `X.Y.Z`。占用 `latest` 的发布同时会移动 packument 自身的 `version`；预发布停在自己的 tag 上，`latest` 留在原处。
2. GitHub Release 存在、带显式标题，两种语言段落都能渲染。
3. 置顶的兼容性讨论里能看到新的发布评论。
4. 稳定 profile 按**精确版本**安装：`dsh plugin --profile web add @wowyuarm/dsh-agent-team@X.Y.Z`。直接 `update` 可能报「Already Up to date」，因为 lockfile 钉住了解析结果；不能让 profile 停留在「读更新的 ledger、跑更旧的 bundle」的状态——两个 profile 共用 `$DSH_HOME/storages/`。
5. 在**空目录里全新安装**，确认 bundle 是从 registry 加载的——不是从 checkout，也不是通过源码软链接。
6. §2 第 4 步修正过的正文，从 `raw.githubusercontent.com` 读回来仍然正确，而不只是在工作树里正确。
7. `npm run check:public-baseline` 针对已发布版本为绿。

刚发布后 registry 的读取会滞后：版本文档可能先于完整 packument 可用，于是 `npm view <name>` 可能短暂报旧版本，或对一个已经上线的包报 `E404`。绝不要为了「修」滞后而重新发布——轮询 packument，或用 tarball URL 安装来证明产物。

## 7. 绝不

- 绝不重新发布、撤销发布，或移动已被某个发布引用的 tag。`npm deprecate` 是唯一被认可的清理手段。
- 绝不改写已发布的发布材料——已经发布过的版本的 `CHANGELOG` 条目、Release 正文或发布评论。在下一个 patch 里向前修。唯一例外是几分钟内发现的 factual 错误，经维护者同意后更正。
- 绝不在认证通过之前放宽 `peerDependencies`；范围声明就是支持声明。
- 绝不从带有未提交构建输入的工作树发布。
- 绝不 `git push --all` 或 `git push --tags`。
- 绝不在共享工作树里 `git add -A`；只暂存自己的路径。
