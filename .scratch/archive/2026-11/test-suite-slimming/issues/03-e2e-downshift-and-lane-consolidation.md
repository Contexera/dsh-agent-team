# 03 — 7 个冗余 E2E 下沉迁移与 21→9 条 Surface Lanes 收拢

**What to deliver:** 在确保低层单测/集成测试 100% 接住等价契约后下沉删除 7 个冗余/错配 `.e2e.ts` 文件，并将剩余 21 个 `.e2e.ts` 按 UI 表面结构收拢为 9 条高内聚 Surface Lanes（含拆分 3,403 行 `team-journey.e2e.ts` 尾部与裁减过程态重复 `fullPage` 截图），在零覆盖丢失的前提下将全量 E2E 压至 ~75–90s。
**Blocked by:** 01, 02
**Status:** complete
**Required context:**
- Work-item entry: [README.md](../README.md)
- Binding decisions `D5`, `D6` and Boundaries in [spec.md](../spec.md)
- Target下层 specs & E2E files:
  - `packages/client-agent-team/tests/team-send-retry.client.spec.tsx`
  - `packages/client-agent-team/tests/team-edit-refresh-recovery.client.spec.tsx`
  - `packages/client-agent-team/tests/team-member-avatar.client.spec.tsx`
  - `packages/agent-team/tests/subscription-runs.spec.ts` / `packages/agent-team/tests/worker-composition.spec.ts`
  - `vitest.config.ts`
  - All 28 `scripts/e2e/*.e2e.ts` files & `scripts/e2e/support.ts`
**Background:**
- 28-file inventory and screenshot directory baseline in [01-baseline-diagnosis.md](../materials/01-baseline-diagnosis.md) §3.2.
**Boundaries:**
- Included:
  - **第一批（下沉补齐并删除 7 个 E2E）**：
    1. 核对 `team-edit-refresh-recovery.client.spec.tsx` 覆盖等价行为后删除 `team-edit-refresh-recovery.e2e.ts`；
    2. 核对 `team-send-retry.client.spec.tsx` 已完整覆盖附件上传重用与丢回执重发，并将 `team-main-reopen.e2e.ts`（Main tab 卸载重挂时的 delayed/lost 回执）与 `team-reply-reopen.e2e.ts`（讨论侧面板关闭重开时的 delayed/lost 回执）补入 `team-send-retry.client.spec.tsx` 且跑绿后，删除这 3 个 E2E 文件；
    3. 核对 `team-member-avatar.client.spec.tsx`（含补入 Deseret 辅助平面首字母 `'𐐨builder'` / `LONE_SURROGATE` 检查）后删除 `team-avatar-initial.e2e.ts`；
    4. 将 `team-worker-subscription.e2e.ts` 的 `intakeWebhookDelivery -> owner wakeup -> team_worker` 后端链路用例迁入 Host 集成测试（如对应集成 spec，如新建文件必须登记到 `vitest.config.ts` `integrationSpecs`）并跑绿后删除该 E2E 文件；
    5. 将 `team-manager-writes.e2e.ts` 第 7 步（lines 237–266）的 Sidebar 列表与 Project 编辑弹窗负责人投影校验（含桌面与 `390×844` 截图写入 `MANAGER_SHOTS`）并入 `team-manager.e2e.ts` 后删除 `team-manager-writes.e2e.ts` 与 `support.ts` 中废弃的 `MANAGER_WRITES_SHOTS`。
  - **第二批（将剩余 21 个 E2E 收拢为 spec `D6` 定义的 9 条 Surface Lanes）**：
    1. `team-journey.e2e.ts`（仅留 `UI01..UI06`，切出尾部 2747–3403 行；裁减无增量 layout/style 价值的过程态重复 `fullPage: true` 截图，确保 `ui-01`..`ui-06` 仍各有代表性桌面与 `390×844` 截图）；
    2. `team-inbox-and-recovery.e2e.ts`（`team-journey` 切出的 `UI07` + `UI08` + `team-attachment-recovery.e2e.ts`）；
    3. `team-main-stream-and-board.e2e.ts`（`team-main-stream` + `team-project-owners` + `team-board-task-focus` + `team-thread-ref-chip`）；
    4. `team-timeline-and-shell.e2e.ts`（`team-timeline-anchor` + `team-multi-page` + `team-bundle-toggle` + `team-shortcuts`）；
    5. `team-settings-and-tools.e2e.ts`（`team-page-identity` + `team-settings-nav-icon` + `team-environment-check` + `team-extra-tools`）；
    6. `team-worker-settings-and-thread.e2e.ts`（`team-worker-settings` + `team-worker-thread`）；
    7. `team-worker-lifecycle.e2e.ts`（`team-worker-inspect` + `team-worker-stop`）；
    8. `team-subscriptions.e2e.ts`（`team-subscriptions` + `team-subscription-event`）；
    9. `team-manager.e2e.ts`（`team-manager` + 原 `team-manager-writes` Step 7）。
  - 同 Lane 内按可隔离性与耗时收益合理组织 `it(...)` 用例（复用同文件共享 Browser，隔离 `BrowserContext`；仅在真正共置同一旅程状态且不破坏失败隔离度时复用已打开页面）；确保收拢后文件结构清晰可读、无超过 2,800 行的单体文件。
- Excluded: 不修改 `../deepseek-harness`；不改动任何产品行为的正确性与故障恢复断言；不删除跨宽度（1440px & 390px）与几何/focus/contrast 检查。

## Acceptance Criteria

- [ ] `scripts/e2e/` 下仅保留约定好的 **9 条** `*.e2e.ts` Surface Lane 文件 + `support.ts`，`team-journey.e2e.ts` 尾部已切出且行数显著下降，7 个下沉场景已在低层测试中具备等价断言并通过。
- [ ] 全量 `npm test` 全部通过；全量 `npm run test:browser` 全部通过，`assertScreenshotEvidence(artifacts, [1440, 390])` 通过，并人工审视新生成的 `artifacts/browser/` 代表性桌面与 `390×844` 截图无视觉退化，且未破坏任何 `UI01..UI09`、Worker、Subscription、Manager 关键截图表面。
- [ ] 全量 E2E 总耗时相对 `617d8847` 基线（`217.22s`）明显收敛（目标区间 `~75s–90s`），单 Lane 过滤执行实测 `<= 20s`（绝大多数 `6s–12s`）。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build && npm run check:artifact`、`node scripts/audit-ui-parity.mjs` 全部通过。

**Evidence to return:** changes, checks and observed results (full before/after E2E timings, single-lane spot checks, screenshot inventory audit), unverified scope, and deviations
