# 01 — 测试生命周期自托管、异常安全与全局不变量守卫

**What to deliver:** 为 Host/Member 现有测试底座（`member-harness.ts`、`team-host-fixture.ts`、`host-harness.ts`）与 E2E `closeScenario()` 建立异常安全的自动生命周期托管、环境隔离恢复与默认 `validateLedger()` 守卫，彻底消除全仓 `cleanups` 泄漏与双重清理竞态，并完成 PR #96 遗留边界的收口。
**Blocked by:** None — no ticket blockers
**Status:** complete
**Required context:**
- Binding review constraints: [spec.md §5](../spec.md#5-设计审查补充约束2026-11-14)（按本票编号适用）。
- Work-item entry: [README.md](../README.md)
- Binding decisions D1, D2, and Boundaries in [spec.md](../spec.md)
- Existing harnesses: `packages/agent-team/tests/helpers/member-harness.ts`, `packages/agent-team/tests/helpers/team-host-fixture.ts`, `packages/agent-team/tests/helpers/host-harness.ts`, `scripts/isolate-dsh-home.setup.ts`, `scripts/e2e/support.ts`
**Background:**
- Audit details in [01-test-suite-audit.md](../materials/01-test-suite-audit.md) §2 and §3 (`subscription-retry.spec.ts`, `subscription-directory.spec.ts`, `team-view-directory.spec.ts`, `subscription-host.spec.ts`, `team-worker-subscription.e2e.ts`, `member-memory-dirs.spec.ts`).
**Boundaries:**
- Included: `onTestFinished`（及 `beforeAll` 场景适配）自动注册清理、分配前即注册清理、`try / finally` 释放链、`process.env.DSH_HOME` 保存与恢复、清理前自动 `validateLedger()`（含 `{ validateLedger: false }` 退出选项）、消除现有 `realHarness` 调用方中多余的 `cleanups` / `afterEach` 样板及双重 dispose 竞态、模块顶层 `mkdtempSync` 的 `process.once('exit')` 兜底、`closeScenario()` `try / finally`、`team-worker-subscription.e2e.ts` 迁入 `scenarioTempDir()`、清理 `member-memory-dirs.spec.ts` 未使用的 `mkdtemp` 导入。
- Excluded: 不修改 `packages/*/src/` 生产代码；暂不做领域快捷方法（`TestHuman` / `TestMember`）充血（由 Ticket 02 承担）；暂不做 Client `harness.tsx` 拆解（由 Ticket 03 承担）。

## Acceptance Criteria

- [x] `realHarness`、`mountTeamMemberHost`（在无外部 `cleanups` 或使用内部注册时）及 `host-harness` 均在创建临时目录/Context 后立即注册 `try / finally` 清理（通过 Vitest `onTestFinished`，`beforeAll` 挂载场景显式返回/对接 `afterAll`），初始化中途抛错不会残留 `root` 或未关闭的 fiber/storage。
- [x] `realHarness` 与 `mountTeamMemberHost` 覆写 `process.env.DSH_HOME` 前保存原值，并在清理 `finally` 中恢复原值。
- [x] `realHarness` 与 `host-harness` 在清理前默认执行 `validateLedger()`，并支持通过选项 `{ validateLedger: false }` 在损坏账本恢复测试中关闭该守卫。
- [x] 删除本票 Host/Member 与 Tool 中 `realHarness` 调用方（含 PR #96 的 13 个 `member-*.spec.ts`、`subscription-retry.spec.ts`、`subscription-directory.spec.ts`、`team-view-directory.spec.ts` 等）中手动导入/排空 `cleanups` 与重复最终释放的代码；保留作为重启/恢复被测动作的显式关闭。
- [x] `subscription-retry.spec.ts`、`subscription-directory.spec.ts`、`subscription-host.spec.ts` 顶层 `mkdtempSync` 临时目录均具备 `process.once('exit')` 清理兜底；`scripts/e2e/support.ts` 的 `closeScenario()` 使用 `try / finally`；`scripts/e2e/team-worker-subscription.e2e.ts` 迁入 `scenarioTempDir()`；`member-memory-dirs.spec.ts` 无未使用 `mkdtemp` 导入。
- [x] `npm run typecheck`、`npm test`、`npm run lint` 全绿，且运行完完整测试后系统 `tmpdir()` 无新增 `dsh-agent-team-*` / `dsh-team-*` 残留目录。

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
