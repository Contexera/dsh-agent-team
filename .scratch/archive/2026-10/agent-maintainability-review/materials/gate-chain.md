# 检查执行链调查材料

调查对象：`dsh-agent-team` 的「规则声明 → 检查器覆盖 → `npm test` → CI 实际运行 → 服务端 required checks」链条。
只读审查；未修改主工作区业务代码、测试、CI、hooks；未提交/推送。

## 1. 快照前提

| 项 | 值 |
| --- | --- |
| 仓库 | `/home/yu/projects/dsh-agent-team` |
| HEAD | `001f8f1f feat: let a reader resize the discussion panel` |
| 工作区 | 有未提交改动：7 个 Client/测试文件 + `scripts/team-ui.e2e.ts`，另有 2 个 untracked `.scratch/active/*` 目录；本次调查未触碰 |
| 相邻 Harness | `../deepseek-harness` HEAD `687f282e86`，`describe --tags` = `dsh-v0.2.1-rc.2` |
| Node / 包管理 | `pnpm@11.7.0`（`packageManager` 字段），Node v24.15.0（`nvm` 默认） |
| 远端 | `origin` = `https://github.com/Contexera/dsh-agent-team.git`；本地无 `origin/master` 引用（未 fetch），远端事实全部经 `gh api` 取得 |

实验均在 `/tmp/gate-*` 隔离目录内进行；每次实验后核对主工作区 `git status --short` 与初始一致（见第 5 节）。

## 2. 实际执行链

`package.json` 的 `test` 脚本（原文顺序）：

```
test = generate:typert && check:facades && check:docs && check:core-skills
       && check:boundaries && check:versions && check:comments && vitest run
```

`.github/workflows/ci.yml` 两个 job（`linux` / `windows`，内容同构）依次执行：
`checkout → corepack enable → clone pinned Harness → pnpm install/build:lib/build:native-system → pnpm install → link-harness-packages + npm run build → node scripts/sync-paths.mjs → npm run typecheck → npm test`。

由此得到的事实：

- CI 实际执行 = `build` + `sync-paths`（写入）+ `typecheck` + 上述 7 个 gate + Vitest。
- **不在** CI：`lint`、`duplication`、`test:browser`、`check:artifact`、`check:public-baseline`、`audit-ui-parity`、`verify-desktop-strip-boot`。
  - 验证命令：`grep -n "lint\|duplication\|test:browser\|check:artifact\|check:public-baseline\|audit-ui-parity" .github/workflows/ci.yml` → 仅命中第 11 行注释 `# no release automation, no test:browser (that stays a local acceptance step)`。
- 触发条件：`pull_request`（全部）、`push` 到 `master`（`paths-ignore: **.md / assets/** / docs/**`）、`workflow_dispatch`。
- 权限：`permissions: contents: read`，无发布/写权限。

服务端 required checks（`gh api`，只读）：

```
gh api repos/Contexera/dsh-agent-team/branches/master/protection --jq 'keys'
→ allow_deletions, allow_force_pushes, allow_fork_syncing, block_creations,
  enforce_admins, lock_branch, required_conversation_resolution,
  required_linear_history, required_signatures, url

gh api repos/.../branches/master/protection/required_status_checks
→ 404 {"message":"Required status checks not enabled"}

gh api repos/.../rulesets → []
```

`enforce_admins: false`、`required_pull_request_reviews` 为空、`required_status_checks` 未启用、无 ruleset。

近期真实 run（`gh run list --workflow=ci.yml`，15 条）：

- 最近一次成功 push run：`39193498206`，headSha `48e50043`，2026-10-19T03:11:27Z，success。
- 该 run 之后仍有 3 个本地提交（`b0359e2d`、`5096e900`、`001f8f1f`）未出现在任何 run 的 headSha 中。
- 同期有 3 个 PR run 失败/成功混合（dependabot 三个 PR，其中 react 升级 PR 为 `failure`）。

## 3. `check-package-boundaries.mjs` 正负实验

脚本实现：`scripts/check-package-boundaries.mjs`，91 行。扫描 `packages/*/src` 下 `*.ts|*.tsx`，用单条正则
`\bimport\s*(type\s+)?[^'"()]*?from\s*(['"])(\.[^'"]*)\2|\bimport\s*\(\s*(['"])(\.[^'"]*)\4\s*\)` 匹配，`import type` 豁免，跨出本包目录的相对路径报错。

实验方法：每次在 `/tmp/gate-b1`（或 `gate-b2`）新建 `scripts/` + `packages/{alpha,beta}/src`，复制脚本原件，写入单个样本文件，运行 `node scripts/check-package-boundaries.mjs`，记录退出码。

### 3.1 正样本（非法，应报错）

| 样本 | 退出码 | 判定 |
| --- | --- | --- |
| `import { beta } from '../../beta/src/beta.ts'` | 1 | 正确报错 |
| 多行 `import {\n beta,\n} from '../../...'` | 1 | 正确报错 |
| `export const l = () => import('../../beta/src/beta.ts')` | 1 | 正确报错 |
| `import { type B } from '../../beta/src/beta.ts'`（内联 type） | 1 | 与头注释不一致：`verbatimModuleSyntax: false` 下该行会被完全擦除（见 3.3） |
| 注释里的 import（`// import {...}`） | 1 | 误报 |
| 块注释里的 import | 1 | 误报 |
| 字符串字面量里的 `"import x from '../../...'"` | 1 | 误报 |
| 无扩展名说明符 `'../../beta/src/beta'` | 1 | 正确报错 |

### 3.2 负样本（合法，或应报错但漏检）

| 样本 | 退出码 | 判定 |
| --- | --- | --- |
| `import type { B } from '../../beta/src/beta.ts'` | 0 | 正确豁免 |
| `import { local } from './local.ts'`（包内） | 0 | 正确放行 |
| `export { beta } from '../../beta/src/beta.ts'` | **0** | **漏检**：re-export 是运行时跨包引用 |
| `export * from '../../beta/src/beta.ts'` | **0** | **漏检** |
| `export * as ns from '../../beta/src/beta.ts'` | **0** | **漏检** |
| `import '../../beta/src/beta.ts'`（side-effect） | **0** | **漏检** |
| `const m = require('../../beta/src/beta.ts')` | 0 | 仓库为纯 ESM，属可接受范围 |
| `packages/alpha/src/nested/lib/escape.ts` 中的跨包 import | **0** | **漏检**：`IGNORED_DIRECTORY` 含 `lib`，`src/**/lib/**` 整目录被跳过 |
| `case.mts` / `case.cts` 中的跨包 import | **0** | **漏检**：`SOURCE_PATTERN = /\.tsx?$/` 不含 `.mts`/`.cts` |
| `import '../../beta/src/beta.ts'`（`..` 但仍在包内） | 0 | 正确放行（`relative()` 不以 `..` 开头） |

### 3.3 内联 `type` 的误报是否有实际影响

`verbatimModuleSyntax: false`（`tsconfig.json:12`、`tsconfig.types.json:12`、`tsconfig.build-deps.json:12`）。

实验：`/tmp/emit` 内用仓库自带 `tsc` 编译
`import { type B } from './b.ts'; export const a: B = 1`，产物 `out1/a.js` = `export const a = 1;`（import 语句被完全擦除）。

`grep -rn "import {[^}]*\btype [A-Za-z]" packages/*/src --include=*.ts --include=*.tsx` → **35 处**，全部为包内或外部包导入，当前没有跨包的内联 type 写法，所以该误报目前是**休眠缺陷**而非现行失败。真实代码中 `grep -rn "from '\.\./\.\./" packages/*/src`、`export .* from '\.\./'`、`^import '\.` 三者均为 0 命中。

### 3.4 反证尝试

- 是否仓库已禁用 `.mts`、re-export、side-effect 写法？`find packages -path '*/src/*' -name '*.mts' -o -name '*.cts'` → 0；`src/**/lib/` 目录 → 0。所以三项漏检目前**无存量触发**。
- 是否能靠 TS 编译器或 lint 兜住？CI 跑 `typecheck`（`tsc -p packages/*/tsconfig.json`），re-export 与 side-effect import 类型检查完全合法，不会报错；`lint`（oxlint，未启用 typescript plugin）不在 CI，且无 `no-restricted-imports` 配置（无 `.oxlintrc*`）。
- 判定：漏检真实存在、当前零触发；内联 type 误报真实存在、当前零触发。二者都是"检查器的语法覆盖不等于规则"的证据，不是现行红灯。

## 4. 检查器自身的行为测试与可达性

| 检查器 | 有无行为测试 | 依据 |
| --- | --- | --- |
| `check-package-boundaries.mjs` | 无 | `grep -rln` 于 `packages scripts` 只命中脚本自身与 `check-*` 互引，无 spec 引用 |
| `check-comments.mjs` | 无 | 同上 |
| `check-docs.mjs` | 无 | 同上；支持 `--root` 但没有测试使用 |
| `check-core-skills.mjs` | 无 | 支持 `--root`，无测试使用 |
| `check-version-consistency.mjs` | 无 | 支持 `--root`，无测试使用 |
| `check-artifact.mjs` | 手工负对照（脚本头注释声明曾验证：删除 `cordis.patch.yml`、塞入 `.ts`、收窄 `lib/**` 各自变红） | 脚本头注释，无自动化 |
| `check-public-baseline.mjs` | 无 | 依赖 `gh` |

`vitest.config.ts` 的 `include` 只有 `packages/*/tests/**/*.spec.ts|client.spec.tsx`，`scripts/` 下无测试文件被收集。

`check-artifact.mjs` 的独立正负实验（`/tmp/gate-artifact`，自建 `package.json` + `cordis.patch.yml` + `lib/`）：

```
lib/index.js = export { beta } from '../../packages/beta/src/beta.js'
→ exit 1, "x relative imports with no shipped target (1): lib/index.js -> ../../packages/beta/src/beta.js"

lib/index.js = export { beta } from './ok.js'
→ exit 0, "ok all 1 runtime relative imports resolve to shipped files" / "Artifact is complete and clean."
```

结论：`check-artifact` 的跨包相对导入规则确实生效，且是当前唯一能拒绝"跨包相对引用进入产物"的检查——但它不在 CI，也不在 `npm test`。

## 5. hook 状态

```
ls -a | grep -Ei 'husky|lefthook|pre-commit'    → 无
grep -n 'husky|lefthook|pre-commit|lint-staged' package.json pnpm-workspace.yaml → 无命中
ls .git/hooks/ | grep -v sample                 → 空
git config --get core.hooksPath                 → 未设置（exit 1）
find .hoplite -type f                           → 仅 .hoplite/settings.json
```

`.hoplite/settings.json` 只有 `scripts.setup`（环境搭建 + `npm run typecheck && npm test` 冒烟），`scripts.check` 的 `command` 为 `null`，`scripts.run`/`archive` 同样为 `null`。

结论：**本地无提交/推送 hook，无 pre-commit 检查入口**。唯一自动反馈是手动 `npm test` 与 CI。

## 6. CI 未覆盖项与文档口径

文档现状：

- `docs/release-runbook.md:32`：「`npm test` | Test failures, and the **five** mechanical gates it bundles: `check:facades`, `check:docs`, `check:core-skills`, `check:boundaries`, `check:versions`。」——`check:comments` 已在 `test` 中（`package.json` 与 `docs/development/start-and-checks.md:57` 均为 6 个 + Vitest），runbook 少列一个，数字与枚举自相矛盾（列了 5 个，实为 6 个）。
- `docs/development/start-and-checks.md` 的 "Verification gradient" 列 17 条命令，但未标注哪几条在 CI、哪几条只在发布前。CI 里实际只跑其中 6 条（`generate:typert`、`typecheck`、`check:facades`、`check:docs`、`check:core-skills`、`check:boundaries`、`check:versions`、`check:comments` + Vitest，严格说是 `test` 的子集 + `build`/`sync-paths`）。
- `docs/release-runbook.md` 的表格已明确 `check:artifact` / `check:public-baseline` / `test:browser` / `lint` 是发布前置或本地步骤，这一处口径是准确的。

## 7. facade 与 CI 的可复现基线障碍

**这是本次调查中最需要主 agent 裁决的一条**，因为它直接决定"`npm test` 能否在干净 clone 通过"。

观测：

```
npm run --silent check:facades
→ facade drift: tsconfig.json, tsconfig.types.json, tsconfig.build-deps.json differ from the generated output
→ exit 1

npm test   (完整跑)
→ 在 check:facades 步骤失败，exit 1；未进入 check:docs 与 Vitest
```

逐项核对：

- `node scripts/sync-paths.mjs` 后 `--check` 变绿（exit 0，`facades match the generated output (514 Harness mappings)`）。
- 漂移内容：Harness 在 `dsh-v0.2.1-rc.2` tag 之后新增的映射（`@deepseek-ai/dsh-experimental-session-search`、`experimental-ralph-bundle`、`experimental-terminal-bundle`、`experimental-badge-skill-bundle`、`experimental-session-titles-bundle`、`experimental-translator`、`experimental-client-ui-cot-translation`、`experimental-plugin-market-bundle`、`experimental-client-ui-claude-code-mods`、`dsh-cua/*` 等），`diff` 共 148 行新增。
- 已提交的 `tsconfig.json` 不含 `experimental-session-search`（`git show HEAD:tsconfig.json | grep -c` → 0），而 Harness 当前 checkout 的 `tsconfig.base.json` 含（`git show dsh-v0.2.1-rc.2:tsconfig.base.json | grep -c` → 1）。即：本地 facade 是按更早的 Harness base 生成的，Harness checkout 在 `dsh-v0.2.1-rc.2` 前后发生过变化。
- 本地 HEAD 的 facade 是 `b0359e2d`（`refactor: make the audit's comments structural`，2026-10-19）手工加的 `human-settings` 映射，而非整表重生成。

反证尝试与限制：

- CI 用的是 `git clone --depth 1 --branch dsh-v0.2.1-rc.2`，与本地 `687f282e86` 同一 tag。若该 tag 的 `tsconfig.base.json` 确含上述映射，则 CI 的 `sync-paths`（写入）会覆盖工作区 facade，随后 `npm test` 里的 `check:facades --check` **在 CI 内会通过**——CI 那一步显式先写再查，这是它不红的原因。
- 因此这条的正确表述是：**本地干净 clone 上 `npm test` 不通过**（`check:facades` 是 `test` 的第一道 gate），而 CI 因先写 facade 而掩盖了同一份漂移；提交的 facade 已经落后于所声明的 Harness tag。
- 未验证：远端 CI 在 `b0359e2d` / `5096e900` / `001f8f1f` 三个提交上是否真的跑过、是否绿。`gh run list` 中没有这三个 headSha 的 run。

主工作区保护：本实验执行了 `sync-paths` 写入，随后用备份还原并 `git checkout --` 恢复，最终 `git status --short` 与初始状态一致（7 个 M + 2 个 untracked，无 tsconfig 变更）。

## 8. 候选结论（7 条，按用户影响排序）

### G1 已证实缺陷：本地 `npm test` 在干净 clone 上失败于 `check:facades`，CI 用同一命令先写后查掩盖了它

- 要求来源：`docs/development/start-and-checks.md:57`「`test` ... runs `check:facades`」；`ci.yml` 的 `Regenerate TypeScript path facades` 步骤注释自称「sync-paths is not part of any npm script」。
- 证据：第 7 节。`npm test` exit 1；`check:facades` exit 1；`sync-paths` 后 exit 0。
- 失败条件：任何在 Harness checkout 与 committed facade 生成时间之间拉过 Harness 的本地环境；对 CI 不触发（先写）。
- 反向裁决：不是"facade 该提交"的问题——它是生成物，且 `check:facades` 的设计目标就是拒绝陈旧 facade。矛盾点在于 `test` 依赖一个"需要先手动跑 `sync-paths`"的前置，而这条前置没有出现在 `npm test` 内，也没有出现在 `docs/development/start-and-checks.md` 的 gradient 顺序里（该文档把 `check:facades` 列为独立步骤，但 `test` 也含它）。
- 处理路径：二选一——(a) 把 `sync-paths`（写入）移进 `test` 之前并让 `check:facades` 只做校验，语义变成"检查你是否忘了重新生成"；(b) 保持现状但把 `test` 拆成 `test:gates`（不含 facades）与 `test`（含），文档写明新 clone 的第一步。当前状态是两者都没做：CI 里先写，本地没有。
- 未覆盖：远端在最近 3 个提交上的真实 run 结果。

### G2 已证实的检查缺口：`check-package-boundaries.mjs` 漏检 re-export、side-effect import、`.mts/.cts`、`src/**/lib/**`

- 证据：3.1/3.2 表格，真实 CLI，退出码 0。
- 触发条件：`export { x } from '../other-pkg/src/x.ts'`、`export * from ...`、`import '...'`、把文件命名为 `.mts`、或在 `src/` 下建 `lib/` 子目录。
- 反证：当前 0 命中（3.4）。因此是**潜力缺口**，不是现行违规。
- 误报面：注释、块注释、字符串字面量中的 `import ... from '../..'` 会红（3.1），内联 `type` 会红（3.1 + 3.3，当前 35 处包内/外部导入不受影响，跨包暂无）。
- 判定：脚本头注释声称「The import-kind logic is deliberately statement-based rather than a single regular expression」，实际仍是单条正则——注释与实现不一致，这一条本身就是维护成本（读者会信任头注释）。
- 处理路径：若有收益，用 TypeScript 编译器 API 或 `ts.createSourceFile` 遍历 `ImportDeclaration` / `ExportDeclaration` / `CallExpression(import)`，而不是继续扩正则；或者明确把规则收窄为"只约束 `import` 语句"并同步头注释。是否值得做取决于是否真的出现过跨包泄漏（`check-artifact` 是最后一道防线，见 G5）。

### G3 已证实的检查缺口：`check:artifact` / `check:public-baseline` 是唯一的产物级防线，但不在 CI、不在 `npm test`

- 证据：`ci.yml` 无这两个命令（grep 0 命中）；`package.json` 的 `test` 不含；`docs/release-runbook.md:37-38` 明确定位为发布前置。
- 正向验证：第 4 节 fixture，跨包相对导入 exit 1，包内 exit 0。
- 影响：`packages/*/lib/**` 在 `files` allowlist 内且 `prepack = npm run build`，所以"某次提交让产物跨包相对引用"只会在发布时被拦；若跳过 runbook 直接 `npm publish`，`prepack` 只做 build，不会跑 `check:artifact`。
- 反证：这是**成本取舍**，不是缺陷——`check:artifact` 需要 `npm pack --dry-run`，在 Windows runner 上成本高，且 build 已在 CI。文档口径也准确。但它意味着"发布纪律"是唯一保障，没有机械强制。
- 处理路径：若要把发布前置变成强制，最小做法是在 release runbook 加一条"publish 前必须 `check:artifact` 且截图 exit code"，或加一个 `workflow_dispatch` 的 release-check job（不阻塞 PR）。不建议把 `npm pack` 塞进每个 PR。

### G4 已证实的执行缺口：本地无任何 hook，`lint` 与 `duplication` 只在手动阶段

- 证据：第 5 节（4 项检查全部为空/未设置）；`.hoplite/settings.json` 的 `check` 命令为 `null`；`ci.yml` 无 lint/duplication。
- 影响：oxlint 当前 3 条 warning（`context-continuity-host.spec.ts:375`、`:409` `no-unsafe-optional-chaining`，`vendor/storage-sqlite/index.ts:161` `no-useless-spread`），exit 0——warning 不阻断，即使本地跑了也不会红。`duplication` 从未在任何自动路径运行。
- 反证：`lint` 是 `corepack pnpm dlx oxlint@1.76.0`，需要一个未固定在 lockfile 的网络下载（版本已 pin），在 CI 里加会引入额外网络依赖与时间；`duplication` 的脚本头注释明确"treat its output as a place to look, never as a verdict"——把它做成 gate 与设计意图冲突。所以不入 CI 是有理由的取舍，不是疏漏。
- 处理路径：若要 hook，只能做"快反馈"（`check:boundaries` + `check:comments` + `check:docs`，秒级），把 `lint` 作为 warning-only 保留。前提是 G1 修好，否则 hook 也会红在 facades 上。

### G5 已证实的检查缺口：`check-artifact` 是跨包泄漏的唯一机械防线，而它不受 CI 约束（与 G2、G3 交叉）

- 证据：G2 的漏检 + G3 的不在 CI。两者组合意味着"跨包相对导入进入 `src/`"在 PR 阶段完全不可见（`check:boundaries` 漏，`check:artifact` 不跑），只在发布时可能被看到（若执行 runbook）。
- 反证：`tsconfig` 的 paths facade 把 `@deepseek-ai/*` 映射到 Harness 源码，本仓库三个包之间只有 `@contexera/dsh-agent-team/*` 子路径；跨包相对导入会让 `tsc -p packages/*/tsconfig.json` 报"不在 include 范围"吗？——`packages/agent-team/tsconfig.json` 的 `include` 是 `["src", "tests"]`，若 `src` 内引用 `../../client-agent-team/src/x.ts`，该文件不在 `include` 内但会被作为依赖引入并类型检查，**不会报错**。所以 typecheck 确实兜不住。
- 判定：真实缺口，触发概率低，后果是产物断裂（用户侧 `Cannot find module`）。

### G6 已证实的文档不一致：`docs/release-runbook.md:32` 说 "five mechanical gates"，实际 `npm test` 含 6 个

- 证据：`package.json` 的 `test` = 6 个 `check:*` + Vitest；`docs/development/start-and-checks.md:57` 列了 6 个；runbook 列了 5 个（漏 `check:comments`）。
- 影响：只影响读者，不改变行为。但它是"规则声明"层的事实错误，恰好落在本调查的链条起点。
- 反证：`check:comments` 是 2026-10-15 之后加入的（脚本头注释记录该审计日期），runbook 未跟随更新。属文档维护滞后，成本极低，一条改动。

### G7 未验证：远端 required checks 状态

- 已取得的事实（只读 `gh api`）：`required_status_checks` 未启用（404）；`rulesets` 为空数组；`enforce_admins: false`；`required_pull_request_reviews` 为空；`allow_force_pushes: false`、`allow_deletions: false`。
- 结论：**master 上没有任何 required check**。CI 绿不是合并必要条件；直接 push `master` 也合法（仅被 `paths-ignore` 与人工纪律限制）。
- 未验证项：这三个未跑过 CI 的本地提交（`b0359e2d`、`5096e900`、`001f8f1f`）是否会在下次 push 时被 CI 拒绝。按 G1 的分析，CI 会先写 facade 再查，理论上 3 个 gate 应绿；`b0359e2d` 手工往 facade 加了 `human-settings` 映射，`sync-paths` 也会生成同一行，所以不冲突。
- 反证尝试：不能用推送验证（任务禁止）。也不能用 `gh api` 查"未推送提交的 CI 结果"——它们没有 run。

## 9. 800/200 规则落地所需的现有能力缺口（只提机制要求，未安装任何东西）

前提：`grep -rn "800\|max-lines\|max-len\|lineLength" scripts/*.mjs .jscpd.json` 仅命中 `check-core-skills.mjs:32` 的 `8000-character` 预算注释，**仓库目前没有任何文件行数/行长检查**。

现有可复用的机制（已读过源码，具备"逐文件基线 + ratchet + 新文件默认拒绝"模式的三处）：

1. `check-comments.mjs` 的 `COMMENT_BUDGETS`：按 scope 记一个数字，超过即红；不存在的 scope 报"add a row"，即新 scope 默认拒绝。
2. `check-docs.mjs` 的 `BLOCK_CHARACTER_CEILINGS`：按文件记 `[english, chinese]` 数对，文件不存在也报错（双向对齐）。
3. `check-core-skills.mjs` 的 `SKILL_CHARACTER_BUDGET`：单值。

若 800/200 要落地，机制要求：

- 基线形态必须是**逐文件路径 → 上限**的映射，而不是全仓总量：`check-docs` 与 `check-comments` 都已是这个形状，可直接复用。
- 必须区分文件范围：生成物（`packages/*/lib/**`、`tsconfig*.json`、`typert.*`）、`vendor/`、`.d.ts`、测试、`.css` 需要各自的裁决。`check-comments.mjs` 已有 `IGNORED_DIRECTORY` + `EXCLUDED_DIRECTORY` 的先例。
- 换行与字符计数必须显式定义：`check-comments.mjs` 已经踩过 `relative()` 在 Windows 返回 `\` 的坑（源码注释记录了这一点），说明计数实现必须做 `split(/[\\/]/)` 或等价处理。
- 重命名不能重置基线：需要 key 为规范化相对路径，且"旧路径消失 + 新路径出现且更大"应视为失败而非新基线。现有三个脚本都**没有**这个能力——`check-docs` 只做"记录的文件是否存在"，不检测改名。
- 现有脚本都支持 `--root <dir>`（`check-docs`/`check-core-skills`/`check-version-consistency`），这是唯一可复用的测试挂钩——但没有任何测试使用它。新增检查的验收样例应当用它，在 `/tmp` fixture 上跑正负样本，而不是在主工作区建文件。
- 目前**没有**任何检查脚本有自己的 spec（第 4 节），所以新规则若沿用现有模式，就同样没有行为测试；这是既有成本结构，不是新规则引入的。

## 10. 快照与污染核对

调查期间在主工作区执行过的写操作，全部已还原：

| 操作 | 还原方式 | 核对 |
| --- | --- | --- |
| `node scripts/sync-paths.mjs` 写入 3 个 tsconfig | `cp` 备份还原 + `git checkout -- tsconfig.types.json tsconfig.build-deps.json` | `git status --short` 无 tsconfig 变更 |
| `npm test` | 只读，但在 `check:facades` 处 exit 1，未跑 Vitest，未产生 `lib/` 变更 | `git ls-files 'packages/*/lib'` 仍为 0（`lib/` 被 gitignore） |
| `npm run lint` | `corepack pnpm dlx` 可能写 pnpm store，不写仓库 | 无新增 untracked 文件 |
| `/tmp/gate-*`、`/tmp/emit`、`/tmp/facade-bak` | 仓库外 | 不涉及 |

最终 `git status --short`：

```
 M packages/client-agent-team/src/client/TeamChannelPage.tsx
 M packages/client-agent-team/src/client/TeamChannelPanel.tsx
 M packages/client-agent-team/src/client/TeamPanelHandle.tsx
 M packages/client-agent-team/src/client/channel.module.css
 M packages/client-agent-team/src/client/conversation.module.css
 M packages/client-agent-team/src/client/panel-width.ts
 M packages/client-agent-team/tests/panel-width.spec.ts
 M scripts/team-ui.e2e.ts
?? .scratch/active/agent-maintainability-review/
?? .scratch/active/channel-page-redesign/
```

与调查开始时逐行一致（用户未提交改动未被触碰）。

## 11. 可运行的最窄检查（供复核者复现）

```sh
# 边界检查器正负样本（隔离目录，不污染仓库）
rm -rf /tmp/gate-b1 && mkdir -p /tmp/gate-b1/{scripts,packages/alpha/src,packages/beta/src}
cp scripts/check-package-boundaries.mjs /tmp/gate-b1/scripts/
echo "export const beta = 1" > /tmp/gate-b1/packages/beta/src/beta.ts
echo "export { beta } from '../../beta/src/beta.ts'" > /tmp/gate-b1/packages/alpha/src/case.ts
(cd /tmp/gate-b1 && node scripts/check-package-boundaries.mjs); echo "exit=$?"   # 期望 0（漏检）

echo "import { beta } from '../../beta/src/beta.ts'" > /tmp/gate-b1/packages/alpha/src/case.ts
(cd /tmp/gate-b1 && node scripts/check-package-boundaries.mjs); echo "exit=$?"   # 期望 1（命中）

# facade 漂移
npm run check:facades; echo "exit=$?"

# 远端事实（只读）
gh api repos/Contexera/dsh-agent-team/branches/master/protection --jq 'keys'
gh api repos/Contexera/dsh-agent-team/rulesets
gh run list --workflow=ci.yml --limit 5 --json headSha,conclusion,createdAt
```
