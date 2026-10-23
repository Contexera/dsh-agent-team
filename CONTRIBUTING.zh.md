# 为 dsh-agent-team 贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你愿意投入时间。本仓库是 DeepSeek Harness 的外部 opt-in bundle：从仓库根目录发布一个 package，`packages/` 下有三个构建目标，并以一个钉住的 Harness checkout 作为验证基准。每个改动都必须满足的规则在 [`AGENTS.md`](AGENTS.md)；这一页写给准备开 PR 的人。

## 动手之前

- **先把环境契约装起来。** 开发与验证都需要相邻的 Harness checkout（`../deepseek-harness`），安装一律走 `corepack pnpm`——不要用 `npm install`，它会破坏 workspace 的符号链接。安装步骤、生成产物与钉住 tag 的规矩见 [`docs/development/README.zh.md`](docs/development/README.zh.md)。
- **改边界先对齐。** Host authority、Team ledger、面向模型的工具面、Client slot 接线由 [`AGENTS.md`](AGENTS.md) 与 [`docs/architecture/README.zh.md`](docs/architecture/README.zh.md) 守住。先开 issue 把形状谈定，比写完再重来便宜。
- **只想报告问题？** 用 issue 模板。它会把安装问题先引到版本核对上——「装完就坏」的报告大多是 DSH 版本不匹配。
- **动手前先说清楚给谁用。** 开一个 issue，写明你要的结果、这结果是给谁的、以及**已经存在**的那个问题——不要拿着一个方案来找 merge。
- **自动化或 AI 辅助的贡献者？** 动手之前先读 [`AGENTS.md`](AGENTS.md) 与 [`docs/README.md`](docs/README.md)——规则和这个仓库强制的架构都在那里，被拒的 PR 大多是漏了其中之一。驱动 agent 的人来回答上面那些问题、并对结果负责；agent 不替他回答，缺上下文时要问清楚再等，而不是猜。

## 开 PR 之前先验证

按改动面选最小充分的一组检查，再逐级加大：

| 改动涉及 | 要跑 |
| --- | --- |
| `docs/` 下的 Markdown 或 README 配对 | `npm run check:docs` |
| `packages/agent-team/core-skills/` 下的 skill | `npm run check:core-skills` |
| 类型、Host 逻辑、测试 | `npm run typecheck` 与 `npm test` |
| 可见 UI、Client 加载、slot takeover、Remote 激活 | 以上全部，加 `npm run test:browser` |
| 构建产物、`exports`、manifest、发布布局 | 以上全部，加 `npm run build` 与 `npm pack --dry-run` |

`npm test` 会先跑六道机械门：`check:facades`、`check:docs`、`check:core-skills`、`check:boundaries`、`check:versions` 与 `check:comments`，再跑 Vitest。完整阶梯（含 `lint`、`duplication`）见 [`docs/development/start-and-checks.zh.md`](docs/development/start-and-checks.zh.md) §「检查梯度」。

**只写真正跑过的检查**，并说明它覆盖了什么。别人复现不了的结论，会让 review 多走一轮。

## CI 会跑什么

一个 PR 跑两条 lane：`ubuntu-latest` 与 `windows-latest`。两条 lane 执行同一套六步环境契约——corepack shim、钉住的 Harness checkout、Harness 安装与构建、本仓库安装、bundle 构建、path facade——然后跑 `npm run typecheck` 与 `npm test`。**只改文档**的 `master` push 会跳过门禁，PR 永远不跳。`npm run test:browser` 故意不进 CI，浏览器验收是本地步骤：改动可见时，这份证据要你自己附上。环境契约本身、以及必须与钉住 tag 一起改动的三个文件，见 [`docs/development/environments-and-install.zh.md`](docs/development/environments-and-install.zh.md) §「沙箱与 CI 环境」。

## PR 里应该有什么

- **目标分支是 `master`**；`master` 前进后 rebase 你自己的分支即可，`master` 的历史不会被重写。
- **每个 commit 一行 Conventional Commits**——`type: lowercase imperative summary`（`feat`、`fix`、`chore`、`refactor`、`test`、`perf`、`docs`）——不带正文。PR 以单个 squash commit 落地，历史留下的就是这行标题。
- **每处改动都要说**，不只是最显眼的那处：正文只覆盖一半 diff，reviewer 就得反推另一半。
- **用户可见的改动要更新 [`CHANGELOG.md`](CHANGELOG.md)**，写在 `Unreleased` 下。所谓实质性，指用户或调用方会碰到的改动：新行为、改了的契约、否则会踩上的修复。没有可观察差异的重构、内部改名、机械性改动不挣一条 bullet——在 PR 里说明即可。一条 bullet 只写一个主题，文风沿用文件已有的写法；并保持 `Unreleased` 是全文唯一的这样的段：发布流程会消费掉它，见 [`docs/release-runbook.zh.md`](docs/release-runbook.zh.md) §「发布材料」。
- **维护中的文档是双语配对**：改 `foo.md` 时，同一次改动里一并改 `foo.zh.md`；具体路由规则见 [`docs/AGENTS.md`](docs/AGENTS.md)。
- **可见改动要证据**：桌面与 390×844 的截图，加上键盘/焦点与 dialog/menu 状态，口径见 [`docs/frontend-design/README.zh.md`](docs/frontend-design/README.zh.md)。
- **生成文件保持生成**：不要手改 `packages/agent-team/lib/typert.*`，也不要手改生成的 `tsconfig*.json` path facade——改 `scripts/sync-paths.mjs` 后重新生成。
- **不要改动相邻的 Harness checkout。** 需要改它的改动属于上游，或者走公开扩展点。
- **偶发失败的测试**：把竞态说清楚并证明它——确定性复现胜过重试；用重试盖住真实的丢失，等于把造成它的缺陷藏起来。
- **别夹带**：credentials、临时 profile、浏览器 overlay、生成的测试文件、浏览器产物、构建残留都不要进提交；提交前保证 `git diff --check` 干净。

## 什么样的改动不会被合并

这些会被最先挡下，所以先自己核一遍：

- **改动了相邻的 Harness checkout。** 这类改动属于上游，或者走公开扩展点。
- **投机的 registry、兼容层、兜底权威或重复的 store。** 每个领域概念只保留一个权威的 formatter/projection。
- **手改了生成文件**——`packages/agent-team/lib/typert.*` 或生成的 `tsconfig*.json` path facade。改生成器后重新生成。
- **把无关改动捆在一起**，或者正文只覆盖了一部分 diff。
- **只改了双语文档配对的一半**——改了 `foo.md` 却没改 `foo.zh.md`，或反过来。
- **用重试盖住偶发失败的测试。** 把竞态说清楚、用确定性复现证明它；用重试盖住真实的丢失，等于把造成它的缺陷藏起来。
- **夹带残留**——credentials、临时 profile、浏览器 overlay、生成的测试文件、浏览器产物、构建残留。提交前让 `git diff --check` 保持干净。

修 bug 的 PR 要链接**已经发生过的那次失败的证据**——一个 issue、一段失败日志，或一个复现。这里的 review 要的是证据不是风格，一个无从复现的修复，看起来就是一个在找理由的改动。

## 这里怎么做 review

日常工作发生在 Agent Team 的 Thread 里：改动和它背后的证据一起被审。部分 commit 与 review 由团队的 agent 成员撰写，也可能收到来自 `hoplite` bot 的自动 PR。Review 要的是证据，不是风格。合并一律是 `master` 上的 squash commit；发布是**批量**的，不是持续发布——见 [`docs/development/environments-and-install.zh.md`](docs/development/environments-and-install.zh.md) §「Profile 模式与发布节奏」。

拿不准这个改动是否被需要？先开 issue，比被拒的 PR 便宜。
