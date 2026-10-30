# Agent 可维护性与检查有效性审查报告

审查日期：2026-10-20。审查目标不是把 `dsh-agent-team` 改成“更整齐”，而是验证三件事：Agent 能否找到正确入口、能否以局部改动完成维护、改错后现有测试和检查能否以正确理由拒绝。

本报告区分四类结果：**已证实缺陷 / 已证实检查缺口 / 有依据的维护改进 / 合理保留或待验证**。有限抽样不能证明全仓没有未知缺陷。

## 0. 审查快照与限制

- Team HEAD：`001f8f1f00fea518ba95cfea24370f97e0b2f1f6`。
- 相邻 Harness：`687f282e8625c6b8d11ff58211a90524be2e4317`，tag `dsh-v0.2.1-rc.2`。
- 本地 Node `v24.15.0`，pnpm `11.7.0`。
- 审查过程中本地工作区发生过并发修改；按用户要求不把本地修改当审查对象。隔离实验基于 HEAD 在 `/tmp/dsh-agent-maint-review/repo` 完成，实验代码已还原。
- 隔离 Client 环境有一个限制：`generate:typert` 因 Harness 符号链接下的 rootDir 解析失败；我复制了主工作区现有 Typert 产物后运行 Client 测试。因此 Client 结果能说明“现有测试是否观察该行为”，不能替代完整生成链验收。
- 未运行 `npm run build`、`npm run test:browser`、真实模型 preview、GitHub 推送或远端配置修改。

## 1. 基线结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check:boundaries` | 通过 | 92 个源码文件未检出跨包相对导入 |
| `npm run check:comments` | 通过 | `client-agent-team/src` 正好 2020/2020，没有余量 |
| `npm run typecheck` | 通过 | 主工作区完整类型检查通过 |
| `npm run check:facades` | 失败 | 三个提交中的 tsconfig facade 与当前 Harness checkout 生成的内容不一致 |
| 全量 Vitest | 通过 | 80 个测试文件、1148 个测试通过，1 个文件/1 个测试跳过 |
| 持久化/协议/存储兼容目标测试 | 通过 | 122 个测试 |
| preset 隔离目标测试 | 通过 | 14 个测试 |
| Client slot/主面板/变化目标测试 | 通过 | 17 个测试 |

- 独立验证：`/tmp/dsh-agent-maint-review/fresh` 干净克隆中 `check:facades` 先报缺少 `.generated-harness`，退出 1；运行 `sync-paths.mjs` 后通过，但会改写三个已提交 facade 文件（共 444 行增、399 行删）。

`check:facades` 的失败由维护文档中的 setup 顺序解释：新环境必须先运行 `sync-paths.mjs`；但 `npm test` 又把只读的 `check:facades` 放在第一道检查，所以“按文档 setup”与“直接 npm test”之间有一个需要人为理解的前置。

## 2. 已证实缺陷

### F1：根 `AGENTS.md` 仍指向不存在的 preset 目录

- 位置：`AGENTS.md:59`。
- 现象：文档说 preset 在 `packages/agent-team/preset/`，该目录已经不存在；实际定义在 `cordis.patch.yml:19-25` 的 `dsh-agent-preset` 行。
- 影响：不了解仓库的维护者会先查错位置；这不是风格问题，是入口指错。
- 证据：`packages/agent-team/preset` 不存在；删除发生在 `72c53ad2`；仓库内只剩三处引用，另外两处是历史注释和否定断言。
- 建议：把根 AGENTS 的导航改成 `cordis.patch.yml` 的 preset 行；同时更新对应维护文档索引。低成本，不改变行为。

### F2：`docs/release-runbook.md` 的 `npm test` 检查清单漏掉 `check:comments`

- 位置：`docs/release-runbook.md:32`。
- 现象：文档写 “five mechanical gates”，列出 5 个；实际 `package.json` 的 `test` 串联 6 个检查和 Vitest。
- 影响：发布操作员按文档核对时会少理解一道门禁。
- 建议：更新 runbook，并让它避免手数数量；直接列出当前 6 个检查，或写成“`npm test` 串联的机械检查以 `package.json` 为准”。

## 3. 已证实检查缺口

### G1：master 没有服务端必需检查

- 证据：`gh api .../required_status_checks` 返回 404；rulesets 为空；`enforce_admins` 为 false；也没有本地 hook 安装机制。
- 影响：CI workflow 存在，不等于合并必须等 CI 绿。最近三个本地提交没有对应远端 run；是否推送和验收仍依赖人工纪律。
- 裁决：这是仓库当前发布流程的可执行事实，不是 workflow 语法问题。
- 建议：若仓库接受“发布由 runbook 管”的现状，应明确保留；若要机械约束，最小动作是给 master 配 required checks。审查任务禁止修改远端设置，所以本轮未处理。

### G2：包边界检查的正则覆盖不完整，且有反向误报

- 位置：`scripts/check-package-boundaries.mjs`。
- 证据来自隔离 fixture 的真实 CLI 正负样本，不是只读源码推断。
- 漏检：跨包 `export { x } from ...`、`export * from ...`、side-effect `import '...'`、`.mts/.cts`、`src/**/lib/**`。
- 误报：注释、块注释、字符串字面量中的 import 文本会失败；`import { type X } from '...'` 这种在当前 `verbatimModuleSyntax: false` 下会被擦除的形式也会被当成运行时导入。
- 当前存量：相关写法在主源码中为 0，所以这是潜在缺口，不是现行红灯。
- 建议：如果要保留这条规则，应改用 TypeScript 编译器 API 遍历 import/export，而不是继续扩正则；同时给检查器自身补 fixture 测试。若不扩覆盖，至少修改脚本头注释，让它不要再声称是 statement-based 检查。

### G3：产物级防线不在 CI，也不在 `npm test`

- 位置：`check:artifact`、`check:public-baseline`。
- 证据：fixture 证明 `check:artifact` 能拒绝产物中的跨包相对导入；但两个命令都不在 workflow，也不在 `npm test`。本轮没有运行真实构建产物检查。
- 影响：源码边界检查的漏检与产物检查不自动运行叠加后，跨包引用可能在 PR 阶段不可见，只能依赖发布纪律。
- 建议：不把它塞进每个 PR。更合理的是发布 runbook 明确“publish 前必须运行并记录退出码”，或者加一个手动 release-check workflow。

## 4. 测试有效性实验

### T1：幂等比较测试能识别真实业务错误

- 实验：隔离副本中删掉 `assertSameMemberAdd` 对 `description` 的比较，即同一 `requestId` 改 payload 不再冲突。
- 结果：`operation-protocol.spec.ts` 的 `team/member-added` 用例失败；失败点是“修改 payload 后仍返回已提交记录”，不是启动失败。
- 还原后：同一测试 114/114 通过。
- 结论：这条持久化/重放路径上的测试不是“永远为真”。它能识别该类幂等比较缺失。

### T2：Client 面板所有权逻辑存在未被测试观察的语义点

- 实验：把 `client/index.ts` 的“其他全局面板接管时退出 Team mode”改成直接返回。
- 结果：`slots.client.spec.ts` 仍 7/7 通过；相关 Client 测试未捕捉该语义变化。
- 限制：隔离副本中的 jsdom 主面板测试因 Harness 侧 `use-sync-external-store@1.6.0` 双重实例在加载阶段失败，所以不能证明所有渲染路径都绿；但 slot 级测试明确没有覆盖该行为。
- 结论：这是“测试绿了但行为语义变了”的真实例子。不是立即的产品 bug 证明，而是测试缺口。
- 建议：如果“选择其他全局面板必须离开 Team”是产品契约，应在现有 `main-panel.client.spec.tsx` 或浏览器验收中增加一条行为断言；如果它只是当前实现细节，应把契约说明清楚，不要靠隐式 effect 维持。

## 5. 可搜索性与超长文件

### S1：幂等判定功能正确，但检索路径长

- 事实：同一 requestId 的判定分布在 20 多个公共入口和 23 个 `assertSame*` 比较器；错误文案在 `ledger.ts` 与 `attachments.ts` 各有一份。
- 反证：`operation-protocol.spec.ts` 的闭合表在编译期强制每个 operation kind 声明重放行为，并在运行期测试同 payload/不同 payload；这降低了“忘记比较器”的风险。
- 分类：不是漏检缺陷。可以考虑把纯比较器集中到有领域名字的模块，让“请求相等性”可搜索；但不要为了行数拆出转发层。

### S2：`ledger.ts` 和 Host `index.ts` 超长是真实维护成本，但不能按行数机械拆

- `ledger.ts` 同时承载写请求、重放校验、投影应用、阅读模型和授权辅助。可无转发层移出的候选主要是纯比较器和 legacy normalizer；`validateOperation`/`applyTo` 与私有 Projection 状态耦合，拆开会制造额外公开面。
- Host `index.ts` 是 Typert Remote 面和组合根。Remote 方法如果为了行数移到另一个类，需要生成器输入和委托转发，收益不明确。
- 分类：有依据的维护改进，不是当前必须重构。优先改善入口和搜索路径，而不是设定硬性拆分。

### S3：Client 的恢复逻辑分散有明确原因

- 事实：Team mode、member session restore、panel ownership、mode marker 分布在不同 effect，因为它们订阅不同服务。
- 反证：slot 测试覆盖进入、退出、重复进入、卸载复原等核心行为；合并 effect 反而会引入跨服务顺序。
- 分类：合理保留。待验证的是上面 T2 的具体面板语义，而不是“分散即错误”。

### S4：命名黑名单没有找到足够证据

- `types.ts` 与 `types/` 并存是多一跳，但 facade 是公开导出契约，按领域拆分的目录方向明确。
- 生产源码中没有发现需要立即改名的 `utils/config/data` 级问题。
- 分类：合理保留。不要为命名规则破坏稳定 API。

## 6. 对 800/200 规则的裁决

仓库目前没有源码行数/行长机械检查。现有超长文件和超长行确实值得跟踪，但当前证据不支持直接安装一条全仓 800/200 硬规则。

若要落地，建议先做**逐文件基线检查**，而不是总量检查：

- 范围先限定手写生产源码；生成物、vendor、`.d.ts` 单独裁决；测试与 CSS 是否纳入需要单独证据。
- 每个已超限文件只能变短不能变长；新文件默认不得超过 800 行或 200 字符。
- 重命名不能重置基线；应按规范化相对路径和内容归属判断。
- 检查器自身必须有正负 fixture 测试；现有 `check-*` 支持 `--root` 的模式可以复用。
- 在本地 hook 前先修 G1/G3 层面的执行链问题；否则 hook 只会成为容易绕过的早反馈。

## 7. 建议的处理顺序

1. 修两个低成本文档缺陷：F1、F2。
2. 决定 facade 前置语义：要么把生成步骤明确接进 setup/test 前，要么让首次检查的错误指向 `sync-paths.mjs` 而不是裸文件缺失/漂移。当前状态会让新环境把环境前置当成代码失败。
3. 给 `check-package-boundaries.mjs` 补行为测试，再决定扩覆盖还是收窄声明。不要继续扩正则。
4. 决定 master 是否需要 required checks。若暂时不要，至少把“CI 不是强制门”写进维护流程，避免把绿色 workflow 当成不可绕过。
5. 对 T2 先确认产品契约，再决定是否补测试；不要为了让测试变红而强行改变实现。
6. 只有在完成上述检查后，再考虑 800/200 的逐文件 ratchet。

## 8. 证据位置

- 搜索与职责调查：`.scratch/active/agent-maintainability-review/materials/search-structure.md`
- 检查执行链调查：`.scratch/active/agent-maintainability-review/materials/gate-chain.md`
- 隔离基线与变异 patch：`.scratch/local/agent-maintainability-review/`
- 本报告：`.scratch/active/agent-maintainability-review/report.md`

临时 worktree `/tmp/dsh-agent-maint-review/repo` 仍保留，便于复查实验；其源码变更已还原到 HEAD。主工作区没有业务代码或测试改动来自本次审查。
