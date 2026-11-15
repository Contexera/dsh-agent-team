# 05 — 第二轮测试消融（2026-11-02 之后新增的 67 个 Spec）

**What to deliver:** 针对 `2026-11-02`（`2026-11/test-ablation`）之后新增的 67 个 Vitest spec 进行覆盖冗余审查、弱断言强化与代表性故障注入验证，输出消融记录至工作项 `materials/` 并保持故障检出率不降反升。
**Blocked by:** 02, 03
**Status:** complete
**Required context:**
- Binding review constraints: [spec.md §5](../spec.md#5-设计审查补充约束2026-11-14)（按本票编号适用）。
- Work-item entry: [README.md](../README.md)
- Binding decision D6 in [spec.md](../spec.md)
- Methodology reference: `.scratch/archive/2026-11/test-ablation/README.md`
- Growth baseline in [01-test-suite-audit.md](../materials/01-test-suite-audit.md) §1
**Background:**
- 2026-11-02 消融实验验证了“删减重复用例 + 补强弱断言 + 独立临时 worktree 注入生产故障对比失败情况”的有效流程。
**Boundaries:**
- Included: 识别 2026-11-02 之后新增的 ~67 个 spec 文件（通过 `git log` 与上一轮基线 `e1bf7c4c` 对比），梳理跨用例与跨层级重复（例如已被 E2E/Host 覆盖的浅层重复、相同配置矩阵的冗余拆分、只测中间态却漏检真实副作用的弱断言），在临时 worktree 进行代表性故障注入对比验证后落地精简，并将实验记录保存至 `materials/03-round2-ablation.md`。
- Excluded: 不得在缺少独立故障对比验证的情况下盲删覆盖边界分支、鉴权、幂等、并发或崩溃恢复的测试；不修改 `packages/*/src/` 生产代码（临时故障仅用于临时 worktree，实验后清理）。

## 对照证据

固定精简前后提交和相同生产基线，逐故障记录注入 diff、两侧运行命令、失败测试和断言；环境错误及普通超时不能冒充检出。每项删减映射到保留场景；依赖 E2E 的删减必须在故障版本运行对应 E2E，未验证则保留。结论仅覆盖实测故障集合。

## Acceptance Criteria

- [x] 通过与 `e1bf7c4c` 基线比对明确列出新增 spec 清单，并给出每项保留/合并/裁剪/补强的依据。
- [x] 至少设计并执行 15 种以上覆盖新近领域（Worker 巡检/停止/设置、订阅/Webhook 重试与目录、人类头像/档案、大账本与渲染等）的代表性故障注入实验，证明精简后全部故障均可检出（并补强发现的弱断言）。
- [x] 实验记录写入 `.scratch/active/test-system-overhaul/materials/03-round2-ablation.md`，临时 worktree 清理干净；全仓 `npm run typecheck`、`npm test`、`npm run lint` 全绿。

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
