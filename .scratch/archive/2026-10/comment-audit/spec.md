# 注释审查：决策快照

**日期**：2026-10-15
**触发**：Human 要求对 `dsh-agent-team` 当前全量代码做一次大规模注释审视（no-comments 流程）

## 问题

仓库注释规模与代码规模同量级，但缺少判据。机械统计（2026-10-15 基线）：

| 区域 | 文件 | 行 | 注释行 | 占比 |
| --- | --- | --- | --- | --- |
| `packages/agent-team/src` | 34 | 16268 | 4694 | 28% |
| `packages/client-agent-team/src` | 51 | 9824 | 1984 | 20% |
| `packages/tool-agent-team/src` | 3 | 1278 | 293 | 22% |
| `packages/agent-team/tests` | 45 | 19307 | 2677 | 13% |
| `packages/client-agent-team/tests` | 34 | 7779 | 1031 | 13% |
| `packages/tool-agent-team/tests` | 5 | 1361 | 200 | 14% |
| `scripts` | 26 | 7281 | 1768 | 24% |
| **合计** | **198** | **63110** | **12647** | **20%** |

形态分布：行注释 6432 条、JSDoc 块 1748 个、普通块注释 31 个、行尾注释 14 条。

## 判据（来自 no-comments skill，封闭清单）

只有五类注释可以保留：

1. license / 法律头
2. 由外部依赖、平台、协议强制、我们改不了的行为
3. `prettier-ignore` 及同类工具指令
4. 定义公开 API 契约的 doc comment（调用方可观察的参数、返回值、错误、不变量；不含实现细节）
5. 解释代码表达不了的约束的 issue / RFC / 链接

**不确定就删**，举证责任在注释那边。

两种情况必须分开：

- 注释在解释**外部强制的意外行为** → 保留。
- 注释在解释**我们自己代码里的意外行为** → 删注释，并把该符号标 `MUST KILL`，要求改名 / 抽取 / 加类型 / 重构，让行为本身一眼可见。

气味词（`IMPORTANT`、`do not remove`、`too risky`、`fine for now`、长篇理由）不是证据。判断前必须读代码。

## 仓库已有的相关约束

- 根 `AGENTS.md`：生产代码靠清晰的名字、类型和结构自解释；注释只解释非显然的约束、归属或原因，且不能是当前行为的唯一定义。
- 注释会随 `.d.ts` 和 `.js` 发布（`package.json` 的 `files` 含 `lib/**`），所以第 4 类豁免有实质意义。
- `packages/agent-team/tests/recovery-hints.spec.ts` 会扫描 `packages/agent-team/src` 与 `packages/tool-agent-team/src` 的源码文本，但先 `stripComments`，因此删注释不影响该门禁。
- `packages/agent-team/tests/shipping.spec.ts` 读 `packages/tool-agent-team/src/index.ts` 与 `packages/agent-team/src/recovery-hints.ts` 的源码文本并断言其中包含特定字符串；这些字符串位于**代码**（工具描述）而非注释，删注释不影响。
- 历史上已有一轮同类清理（PR #46 / commit `4e43bcc1`、`841a0abd`），当时只删了 5 条复述测试的注释。

## 本次方法

1. 按「行数 + 注释数 ×2」权重把 198 个文件切成 24 片，每片交给一个 `comment-sicko` 子 agent（read-only，陌生视角），只报告不改代码。
2. 收集 24 份报告。
3. 机械校验每条删除建议指向的行区间当前是否真的含注释语法，剔除过期行号与臆造条目。
4. 由主 agent 逐条判定，驳回改业务代码、越界、把正常代码当犯罪的条目。

（过程材料已在归档时删除，见 `README.md` 的「材料」节。）

## 基线（动手前）

- `npm test`：1125 passed / 1 skipped，exit 0
- `npm run typecheck`：exit 0
- 工作区：`master`，干净（另有 21 个与本工作项无关的 UI 重构改动，见"已知干扰"）

## 已知干扰

动手前工作区已存在 21 个非本工作项产生的改动（UI 重构：删 `TeamMembersAction.tsx` / `members.module.css` / `team.module.css`，改 sidebar 与 e2e 脚本），时间戳 2026-10-14 22:33–23:51。Human 决定不予处理、继续推进。**本工作项的删除操作必须避开这些文件**，否则 diff 会混在一起无法分开审查。

## 本轮范围决定（Human 2026-10-15 10:43）

- 删除档位：**全量**（生产代码 208 条 / 测试 135 条 / scripts 71 条，共 414 条通过机械校验的条目）。
- `MUST KILL`（140 条重构建议）：**只报告不实施**，整理成清单交 Human 决策。
