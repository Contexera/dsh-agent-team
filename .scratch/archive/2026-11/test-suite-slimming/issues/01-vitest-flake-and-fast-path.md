# 01 — 修复 Skill 监听并发 Flake、消除 Webhook/Tick 空等并收敛高频 Spec 重复启动

**What to deliver:** 根治 `manager-skills.spec.ts` / `member-skills.spec.ts` 在全量并发运行时的 1s 超时竞态，为 `intakeWebhookDelivery()` 入队后补齐即时泵送以消除 `5,000ms` 轮询空等，消除订阅集成测试中的 `1,000ms` 空等，并收敛高频集成 Spec 的重复冷启动开销。
**Blocked by:** None — no ticket blockers
**Status:** complete
**Required context:**
- Work-item entry: [README.md](../README.md)
- Binding decisions `D1`, `D2`, `D3` and Boundaries in [spec.md](../spec.md)
- Source & tests:
  - `packages/agent-team/src/member-skills.ts` (`MemberPrivateSkillProvider`, `FileSystemSkillProvider`)
  - `packages/agent-team/tests/manager-skills.spec.ts`, `packages/agent-team/tests/member-skills.spec.ts`
  - `packages/agent-team/src/index.ts` (`intakeWebhookDelivery`, `pumpWebhookAdmissions`) & `packages/agent-team/src/subscription-webhook.ts` (`WEBHOOK_PUMP_INTERVAL_MS = 5_000`) & `packages/agent-team/src/subscription-runtime.ts` (`SubscriptionScheduler.runTick`, `TICK_MS = 1_000`)
  - `packages/agent-team/tests/subscription-runs.spec.ts`, `packages/agent-team/tests/subscription-host.spec.ts`, `packages/agent-team/tests/worker-steer.spec.ts`
  - `packages/agent-team/tests/manager-member-adjust.spec.ts`, `packages/agent-team/tests/manager-session.spec.ts`, `packages/agent-team/tests/manager-project-adjust.spec.ts`, `packages/agent-team/tests/manager-writes.spec.ts`, `packages/agent-team/tests/manager-reads.spec.ts`
  - `packages/client-agent-team/tests/team-inbox.client.spec.tsx`, `packages/client-agent-team/tests/team-mode-conversation.client.spec.tsx`, `packages/client-agent-team/tests/team-human-attention.client.spec.tsx`
  - `vitest.config.ts`
**Background:**
- Baseline numbers and root-cause details in [01-baseline-diagnosis.md](../materials/01-baseline-diagnosis.md) §1–§2 and §4.3.
**Boundaries:**
- Included:
  - 修复 `manager-skills.spec.ts:94-102` 与 `member-skills.spec.ts:100-112` 在 `SkillRegistry.collectCache` 命中后等待 `FileSystemSkillProvider` Chokidar `awaitWriteFinish`（默认 `200ms + 100ms`）突破 `vi.waitFor` 默认 `1000ms` 的并发竞态（保持生产默认监听稳定性阈值不变；若注入测试参数仅用于测试夹具）；
  - 在 `packages/agent-team/src/index.ts` 的 `intakeWebhookDelivery()` 写入 `queued` 记录并释放写锁/事务返回时触发 `void this.pumpWebhookAdmissions()`，并保持既有 `admissionPumpTimer` 重试兜底及单通道并发排他锁语义不退化；
  - 消除 `subscription-runs.spec.ts`（基线 7,763ms）与 `subscription-host.spec.ts`（基线 6,809ms）中无需真实等待 1,000ms timer 的启动或过期间隙睡眠，优先复用 `scheduler.runTick()` 等现有可控推进点；
  - 对 `manager-member-adjust.spec.ts`（19 次 `realHarness()`）、`manager-session.spec.ts`、`manager-project-adjust.spec.ts`、`manager-writes.spec.ts`、`manager-reads.spec.ts` 与 `team-inbox.client.spec.tsx`（25 次 `mountTeamApp`）等重型 spec，在不泄漏跨测试可变状态的前提下复用只读前置夹具/共享 `beforeAll` 容器，降低 `integration` 总累计耗时；
  - 严禁通过 `vi.setConfig` 或放大单测超时掩盖性能问题（超时策略归属 `vitest.config.ts`）。
- Excluded: 不修改 `../deepseek-harness`；不删除任何既有回归断言；不改动 `scripts/e2e/`（由票据 `02` 与 `03` 负责）。

## Acceptance Criteria

- [ ] 连续运行至少 3 次全量并发 `npx vitest run`（不降并发、不单独重跑）全部 100% 通过，`manager-skills.spec.ts` 与 `member-skills.spec.ts` 0 超时失败。
- [ ] `intakeWebhookDelivery()` 提交后可立即触发 `pumpWebhookAdmissions()` 处理，且既有的 Webhook 队列限流、并发串行化、重试退避（`subscription-retry.spec.ts`、`webhook-entry.spec.ts`、`subscription-runs.spec.ts`）全部通过。
- [ ] `vitest run --reporter=json` 全量墙钟耗时与累计 file 耗时相对 `617d8847` 基线（`25.44s` 墙钟 / `119.19s` 累计）可观测下降，且未新增任何 `vi.setConfig` 或跨测试状态污染。
- [ ] `npm run typecheck`、`npm run lint`、`npm test` 全部通过。

**Evidence to return:** changes, checks and observed results (including 3 consecutive `vitest run` results and before/after timings), unverified scope, and deviations
