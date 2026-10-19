# 08 — 审查带出的护栏（2026-10-15）

**Status:** complete

从本次审查的实际数据出发，加了三条约束。每条都先测过"它能否真的失败"。

## 1. 注释预算棘轮：`scripts/check-comments.mjs`

**为什么加**：仓库有很强的棘轮文化——persona 有 `PERSONA_CHARACTER_BUDGET`、文档有 `BLOCK_CHARACTER_CEILINGS`，都是"只能降、要升必须写理由"。**只有注释是有政策没仪表**：根 `AGENTS.md` 写了原则，背后没有东西在量。

证据（审查前 12 个提交的注释占比，单调爬升、无人察觉）：

```
9a29b279  24.8%
498cb09e  24.9%
9d577da8  25.1%
c6d7d133  25.2%
3cd93567  25.3%   ← 审查前
1db10e49  23.7%   ← 审查后
```

**设计**（照抄仓库已有棘轮）：每 scope 一个数、只算整行注释、排除 `tests/` 与 `vendor/`、超标即失败、出路是精简或在提交里说明理由后上调。

**当前值**（2026-10-15 审查后审定）：

| scope | 注释行 / 预算 | 余量 |
| --- | --- | --- |
| `packages/agent-team/src` | 3999 / 4150 | 151 |
| `packages/client-agent-team/src` | 1885 / 1950 | 65 |
| `packages/tool-agent-team/src` | 239 / 280 | 41 |
| `scripts` | 1841 / 1900 | 59 |

**余量的定法**（第一版定得太紧，只剩 1 行，等于墙）：量了审查前 39 个提交的注释增量——有增量的提交平均加 28 行（client 24、tool 18、scripts 36），单次最大 93 行。所以余量取"能吸收一次普通提交、连续漂移约十次才触发"：约 3% 加小 scope 的 40 行下限（tool 总量才 239 行，一个函数的 doc 块就占一成）。实测：模拟 +28 行通过，+200 行触发。

**已知局限**（写在脚本头部）：它是代理指标，让总量成为受审数字，不证明任何单条注释挣得位置。

## 2. 引用可解析性

注释不得引用 `.scratch/`、工作项编号、验收标准——发布包的读者打不开它们，且 `.scratch/AGENTS.md` 明说工作历史不是权威。

**两个刻意的豁免**（都验证过）：
- 裸的 `issue #<n>` 保留：`issue #7` 经 `gh issue view` 验证是真实 GitHub issue，属第 5 类豁免。
- `Task #<n>` 保留：它是 `docs/domain-model.md` 定义的领域实体（Task 创建序号），不是工作项编号。第一版正则用了 `i` 标志，把 18 处领域引用误报，已修正。

**修掉的 2 处真引用**：`TeamWorkspaceBrowser.tsx`、`client/index.ts` 的 `(issue 03 criterion N)`，保留推理、去掉死引用。

## 3. `AGENTS.md` 的流程规则

审查中最重要的教训：**验收注释改动不能只看测试绿**。三次翻车，三次 `npm test` 都绿：

| 翻车 | 测试 |
| --- | --- |
| 区间合并吞掉 69 行代码 | 绿 |
| 极大连续段吞掉相邻保留块 | 绿 |
| 全局折叠误伤原有双空行 | 绿 |

测试测行为，注释是文本。已写进根 `AGENTS.md`：批量删注释要审 diff（每条被删行要么是注释、要么是空行）、以注释块为单位而非合并区间、不要规范删除范围之外的空白、子 agent 报告的行号必须先对当前文件校验。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm test`（含新 gate） | 1125 passed / 1 skipped，exit 0 |
| `npm run check:comments` | OK |
| 预算超标能否抓到 | 是（把 tool 预算改成 10 → 立即失败） |
| 引用违规能否抓到 | 是（注入 `.scratch/x.md` + `task #99` → 立即失败） |
| `check:docs` | OK（双语条目、outline、ceiling 全部满足） |
| CI 是否覆盖 | 是（两个 lane 都跑 `npm test`） |

## 未做

- `jscpd` 的 `minLines` 从 6 降到 4 可以抓到 `ledger.ts` 三个 `bounded*` 的重复，但对注释类重复机械判定容易误报，先不动。
- 140 条重构建议仍在 `refactoring-candidates.md`，未实施。
