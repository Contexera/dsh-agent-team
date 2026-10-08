# 生成物、接缝与 operation

[English](generated-and-seams.md) | 中文

## UI 改动与浏览器证据
可见 UI、Client bundle、slot、Remote activation 或交互行为改动必须运行 `npm run test:browser`。该脚本把本次 journey 的截图写入 Git 忽略的 `artifacts/browser/`，不会覆盖归档证据或制造工作区 diff。检查截图时至少覆盖：

```text
1440×960：信息层级、空/加载/错误状态、控件密度与普通 DSH 恢复
390×844 ：无横向溢出、关键内容可见、modal/menu 位于视口内
键盘     ：焦点可见、Tab/Enter/Space/Escape 行为、dialog/menu 的 accessible name
状态     ：提交失败保留输入；durable mutation 以 Host 返回投影为准
```

浏览器本地的呈现偏好（如 Team 侧栏 Channels/Agents 行序，`dsh.agent-team.sidebar-order`）属于 UI 偏好持久化：改动其口径时按上表验证拖拽与刷新后的 reconcile。

这组截图是本次变更的人工审查材料，不是像素级 snapshot test。完成一个 UI 工作项后，只有能说明验收结论的少量代表图可以提交到 `.scratch/archive/YYYY-MM/<work>/validation/`，并必须附带文件名、验收点和复跑命令。调试截图、重复截图、录屏、浏览器日志和每次 test run 的完整图片集保持在 `artifacts/` 或 `.scratch/local/`，不得提交。

## 生成文件
以下文件由脚本生成，不要直接编辑：

- `packages/agent-team/lib/typert.host.*`
- `packages/agent-team/lib/typert.remote-client.*`
- `tsconfig.json`
- `tsconfig.types.json`
- `tsconfig.build-deps.json`

Remote artifacts 使用 `scripts/generate-typert.mjs` 生成；TypeScript path facades 使用 `scripts/sync-paths.mjs` 生成。修改输入后重新运行生成脚本，并检查生成结果是否稳定。

```sh
npm run generate:typert
node scripts/sync-paths.mjs
```

`tsconfig*.json` path facades 不应添加 `include` 或 `files`；它们需要保持对当前仓库文件和相邻 Harness source/declaration 的匹配行为。

`generate:typert` 分析的是 Harness checkout 内的一份 Host face 副本，因此它自己准备那个临时包的外部依赖：context-continuity 引擎的已构建声明被复制进去，而 `zod` 从本仓库根安装链接过去——POSIX 上是 symlink，Windows 上是目录 junction（那里真正的 symlink 需要特权）。`zod` 必须保持为链接：复制会把 zod 自己的声明放进被分析的包内，分析器的 reachable-files 遍历会因此排入一个 program 从未加载的声明文件，以 `TypeError` 而非可诊断错误终止；反之链接若解析不到，才会以每个引用文件都报 `TS2307: Cannot find module 'zod'` 的形式暴露。

## Package 接缝与模块布局
发布物是一个根 npm 包 `@contexera/dsh-agent-team`，由根 `package.json` 及其 `exports` map 声明。三个 `packages/*` 目录没有自己的 manifest：它们是这个单一包的构建与导出接缝，各自有构建目标和 `exports` 条目。

```text
@contexera/dsh-agent-team               根 manifest，一个发布包
├── packages/agent-team         → ./host、./types、./typert、./remote 等
├── packages/tool-agent-team    → ./tools
└── packages/client-agent-team  → .（插件入口）与 ./client
```

因此消费方一律通过声明的 subpath（`@contexera/dsh-agent-team/host`、`/remote`、`/types`、`/tools`、`/client`）访问，而不是用相对路径进入另一个目录的 `lib/`。生成的 `tsconfig*.json` facades 与 Client bundler 都映射这些 subpath；源码层跨接缝写相对导入，等于绕过"让生成产物可替换"的那份契约本身。`scripts/harness-dir.mjs` 是这些映射解析相邻 Harness checkout 的唯一指针。

Host 源码刻意保持扁平。`packages/agent-team/src/` 按文件划分 authority 与接缝，有三个结构锚点——`index.ts` 是 composition root 与 Remote adapter，`ledger.ts` 是 durable authority，`spec.ts` 与 `types.ts` barrel 持有 record schema 与公开类型。其余每个文件都是一个 earned seam；它们各自的归属见 [`architecture/README.zh.md`](../architecture/README.zh.md)。

由此有两条机械结论，遵守它们比事后修复便宜：什么算 earned seam，以及为什么薄改名要删掉而不是留作接缝。两条都随归属规则写在 [`architecture/package-ownership.zh.md`](../architecture/package-ownership.zh.md) 里。

## 新增一条 Host operation
一条 durable Team operation 是一个纵切 authority 层的完整切片，不是按层拆分的任务清单。类型、record、commit、projection 与读表面要在同一次改动里配齐；ledger 会拒绝自己无法 replay 的 record，因此半成品切片会明确报错，而不是静默通过。

```text
types/operations.ts   operation record 类型
spec.ts               该 kind 的 record schema
ledger.ts             commit 方法 + per-kind change scope + 校验 + projection application
index.ts              授权并分派的 @Remote(...) action
types/requests-results.ts   公开的 request 与 result 形状
```

必须同时改动的六个机械表面：

1. **Kind 与 record。** 在 `spec.ts` 中把 operation kind 作为 `z.literal` 加进它的 record schema，并在 `types/operations.ts` 加上带类型的 record。
2. **公开形状。** 在 `types/requests-results.ts` 加上 request 与 result 类型；`types.ts` 是公开 barrel 会自动 re-export，不需要逐 operation 编辑。
3. **Commit。** 加上由 `operationBase(...)` 与下一个 sequence 构造 record 的 ledger 方法，以及它会唤醒的 change scope。
4. **校验与 projection。** 扩展 ledger 的 per-kind commit 校验与校验入口，并加上把该 record 应用到 projection 的 case。replay 正确性就在这里——加载时没有应用的 projection 会与 durable table 分叉。
5. **Host 与 Remote。** 在 `index.ts` 加上 `@Remote('<action>')` 方法：授权、以 Human 或 Member actor 分派给 ledger、发出 committed receipt。
6. **测试与文档。** 覆盖 commit、replay、授权与 projection 效果；然后更新该事实的归属文档（边界改 `architecture/README.md`，语义改 `domain-model.md`，面向模型的契约改 `team-collaboration/README.md`）。

**那六个面不会问的一个问题：崩溃重导。** 对这个 operation 驱动的每一个进程内效果——一次唤醒、一次销毁、一次激活、一个外部文件副作用——回答：如果进程在 commit 与效果之间死掉，由哪个 durable state 重导它，而这次重导是否幂等？效果是在 replay **之后**重导的，而不是由 replay 代替；它是一句问句，而不是第七个面。[`host-authority.md`](../architecture/host-authority.md) 记录了 Host 自己的那些重导。

invariant companion 是"被覆盖"而不是"要扩展"：`invariant.ts` 在 mount 时与每次 commit 后校验整个 durable ledger，所以只要新 operation 能 replay，它的 durable record 就自动纳入覆盖。覆盖止于 durable table——上面那句问的进程内效果没有 invariant。只有当新 record 形状需要 projection validator 尚未断言的关系时才扩展它。

这份清单依赖两条边界：

- operation-kind 语义集中在 `ledger.ts`。不要为了缩短文件把它们拆到新模块，也不要把 `spec.ts` 的 record schema 抽成共享 helper——per-kind 的空壳是刻意的，而一个 kind 的校验只有与它的 projection 放在一起才有意义。
- 新 operation 不等于新 service。它经由现有 ledger 与现有 Remote adapter 进入；不新增 store、不新增平行 projection、不新增第二个 authority。

验证用 `npm run typecheck`、最窄的 Host 测试目标，以及当该 operation 到达 Client 时的 `npm run test:browser`。`npm run check:boundaries` 会随 `npm test` 一起跑，若改动用相对路径而非声明 subpath 跨越 package 就会失败。
