# 02 — Host / Ledger 测试底座充血与 43 个内联 Spec 收编

**What to deliver:** 在 `packages/agent-team/tests/helpers/` 建立三层充血但零平行权威的 Host/Ledger 底座（`openTestLedger`、增强 `host-harness.ts` 并合并淘汰 `surface-harness.ts`、共享 `FakeEngines`、为底座挂载 `TestHuman`/`TestMember`/`TestProject`/`TestTask` 领域句柄），并定向迁移 43 个内联 `new Context()` spec、2 个 `surface-harness` spec 及 13 个核心 `member-*.spec.ts`。
**Blocked by:** 01
**Status:** complete
**Required context:**
- Binding review constraints: [spec.md §5](../spec.md#5-设计审查补充约束2026-11-14)（按本票编号适用）。
- Work-item entry: [README.md](../README.md)
- Binding decisions D3 (Host/Ledger section + 4 guardrails) and D4 in [spec.md](../spec.md)
- Deep-module guardrails & before/after target in [02-rich-foundation-analysis.md](../materials/02-rich-foundation-analysis.md)
- Helpers: `packages/agent-team/tests/helpers/host-harness.ts`, `packages/agent-team/tests/helpers/member-harness.ts`, `packages/agent-team/tests/helpers/surface-harness.ts`
**Background:**
- Audit inventory of the 19 Ledger-only files, 27 Host-boot files, `worker-host-thread.spec.ts`/`worker-stop.spec.ts` clones, and `member-acceptance.spec.ts` worked example in [01-test-suite-audit.md](../materials/01-test-suite-audit.md) §4 and [02-rich-foundation-analysis.md](../materials/02-rich-foundation-analysis.md) §2.
**Boundaries:**
- Included:
  - 新增 `openTestLedger()`（含自动 `onTestFinished` 释放与 `validateLedger()`）收编 ~19 个纯 Ledger spec；
  - 升级 `host-harness.ts` 增加 `prepare(ctx)` 钩子与可选配置（收编 ~27 个内联 `new Context()` + `AgentTeam` 的 spec），合并并删除 `surface-harness.ts`（迁移 `own-credential-superseded.spec.ts` 与 `surface-exemption.spec.ts`）；
  - 抽取 `FakeEngines` / Worker Host 启动 helper 消除 `worker-host-thread.spec.ts` 与 `worker-stop.spec.ts` 的大段克隆；
  - 为 `openTestLedger` / `hostHarness` / `realHarness` 提供 `TestHuman` / `TestMember` 领域句柄（自增 `requestId`、默认 `workspaceId`/`model`、`startTask`/`claimTask`/`acceptTask`/`reply` 等 `read->write->assertCommitted` 快捷链条、以及 `waitForIdle`/`queuedNotices`/`splicedNoticeTargets` 内省），保留 `.ctx`/`.agent`/`.memberId`/`.taskRef` 原生逃生舱；
  - 用新句柄重写精简 13 个 `member-*.spec.ts` 中高重复的 Given 仪式。
- Excluded: 不得在底座内实现平行状态机或隐藏断言；不修改 `packages/*/src/`；不强制改写本票范围外的稳定存量 spec。

## Acceptance Criteria

- [x] `surface-harness.ts` 已删除，`own-credential-superseded.spec.ts` 与 `surface-exemption.spec.ts` 改为使用 `host-harness.ts`。
- [x] `packages/agent-team/tests/` 中因缺 helper 而内联 `new Context()` 启动 Ledger 或 Host 的 spec（目标 ~43 个文件，确需底层手动构造 Cordis/Loader 异常加载的如 `loader-composition.spec.ts` 等除外并说明）已收敛到 `openTestLedger()` / `host-harness.ts`，且所有纯测试代码保留独立断言。
- [x] `worker-host-thread.spec.ts` 与 `worker-stop.spec.ts` 共用共享的 `FakeEngines` / Host 启动辅助函数。
- [x] `TestHuman` / `TestMember` 句柄 100% 委托真实生产方法（零平行权威），并已在 13 个 `member-*.spec.ts` 的 Given 阶段落地精简，保留原始逃生舱。
- [x] 仅统计 `packages/agent-team/tests/` 时，`jscpd`（`--min-tokens 70 --min-lines 10`）克隆数较迁移前显著下降；`npm run typecheck`、`npm test`、`npm run lint` 全绿。

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
