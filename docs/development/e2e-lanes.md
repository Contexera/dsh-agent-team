# E2E Browser Lanes

English | [中文](e2e-lanes.zh.md)

## Purpose

This catalog maps every `scripts/e2e/*.e2e.ts` lane to its real Web/Harness contract, lower-layer Vitest coverage, trigger condition, and screenshot evidence. Source and tests remain the authority for behavior; this document routes test selection and acceptance checks.

Targeted runs (`npm run test:browser -- <lane>`) give fast surface feedback during development, but skip the full `[1440, 390]` dual-width completeness gate across all lanes. The default unfiltered run includes the short `team-journey` smoke. Add `--deep` when the complete cross-surface journey or its broad visual assertions are part of the change.

## Test selection by risk

| Change seam | First check | Before delivery |
| --- | --- | --- |
| Host, ledger, Remote, permissions, subscriptions, Worker state | `npx vitest run --project unit` or targeted integration spec | `npm test` and `npm run typecheck` |
| Client state machine, DOM interaction, error copy | Targeted `packages/client-agent-team/tests/*.client.spec.tsx` | `npm test` and `npm run typecheck` |
| Slot, preset, bundle manifest, ordinary DSH restore, geometry, multi-page | Targeted `npm run test:browser -- <lane>` | Unfiltered `npm run test:browser` and `node scripts/audit-ui-parity.mjs` |
| Cross-surface flow, `scripts/run-browser-test.mjs`, `scripts/e2e/support.ts`, release | Unfiltered `npm run test:browser` | `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:browser` |

## Full-run scheduling

The unfiltered runner keeps `team-journey` and `team-manager` in a serial heavy batch because running them beside other full Harness scenarios caused hook timeouts. The deep profile replaces `team-journey` with `team-journey-deep`.

The remaining lanes run in a bounded two-worker batch after the heavy batch. Targeted runs keep their requested Vitest flags and are never reshaped automatically.

Set `DSH_E2E_SCHEDULING=serial` on a constrained machine to force one serial batch. Set `DSH_E2E_MAX_WORKERS` to change the light-batch worker limit.

## Lane catalog

### `team-journey`

- **File and command:** `scripts/e2e/team-journey.e2e.ts` — `npm run test:browser -- team-journey`
- **Real Web/Harness contract:** Opt-in bundle activation, entering a Team Project, one Main/Task mutation, reload persistence, and restoring ordinary DSH mode.
- **Lower-layer tests:** `packages/agent-team/tests/` Host/integration specs and `packages/client-agent-team/tests/` Client specs.
- **Trigger:** Cross-surface Team entry/exit, workspace connection, sidebar/header/dialog integration, or ordinary DSH restoration changes.
- **Required evidence:** `artifacts/browser/team-journey-smoke/` (`1440` and `390` viewports), zero console warnings/page errors, clean ordinary DSH restore.
- **Not responsible for:** The deep visual matrix or exhaustive edge-case matrices for Inbox offline recovery, Worker diagnostics, or Settings conflicts.
- **Scale and cost:** 1 short test; included in the default full run.

### `team-journey-deep`

- **File and command:** `scripts/e2e/team-journey-deep.e2e.ts` — `npm run test:browser -- team-journey-deep` or `npm run test:browser -- --deep`
- **Real Web/Harness contract:** The complete cross-surface Team journey: shell geometry, Member/Project/Thread/Task/Claim/DM/Board mutations, attachment and responsive UI assertions, reload persistence, archiving, plugin exit, and ordinary DSH restoration.
- **Lower-layer tests:** The same Host/integration and Client specs as `team-journey`, plus the owning surface lanes for detailed behavior.
- **Trigger:** Broad Team shell redesign, cross-surface navigation changes, deep visual regression review, or release acceptance that explicitly includes the complete journey.
- **Required evidence:** `artifacts/browser/ui-01/` to `ui-06/` (`1440` and `390` viewports), zero console warnings/page errors, clean ordinary DSH restore.
- **Not responsible for:** Replacing the focused Inbox, Manager, Worker, Settings, Subscription, or Main/Board lane contracts.
- **Scale and cost:** 1 deep test (about 48s as a single lane in the current baseline).

### `team-inbox-and-recovery`

- **File and command:** `scripts/e2e/team-inbox-and-recovery.e2e.ts` — `npm run test:browser -- team-inbox-and-recovery`
- **Real Web/Harness contract:** Human Inbox delivery, offline retry/recovery, consecutive messages, expired attachment vs broken image distinction, and keyboard navigation.
- **Lower-layer tests:** `packages/agent-team/tests/dm-delivery-lane.spec.ts`, `attachments.spec.ts`, and Client Inbox specs.
- **Trigger:** Inbox UI, attachment rendering/fallback, offline retry, or Inbox keyboard navigation changes.
- **Required evidence:** `artifacts/browser/ui-07/` (`1440` and `390` viewports), keyboard focus/navigation checks.
- **Not responsible for:** Host ledger replay invariants or non-Inbox Team surfaces.
- **Scale and cost:** 2 tests (~12.42s single-lane historical record).

### `team-main-stream-and-board`

- **File and command:** `scripts/e2e/team-main-stream-and-board.e2e.ts` — `npm run test:browser -- team-main-stream-and-board`
- **Real Web/Harness contract:** Main stream posting, discussion/Task creation under rules v2, Project owner dialog, Task board card focus (keyboard/mouse), and taskless thread ref-chip navigation.
- **Lower-layer tests:** `packages/agent-team/tests/main-read-context.spec.ts`, `body-authored-mentions.spec.ts`, and Client Main/Board specs.
- **Trigger:** Main stream, Task board, ref-chip navigation, or Project owner dialog UI changes.
- **Required evidence:** `artifacts/browser/main-stream/`, `ui-04/`, `ui-02/` (`1440` and `390` viewports), focus assertions.
- **Not responsible for:** Full Team entry/exit restoration or Worker lifecycle.
- **Scale and cost:** 4 tests.

### `team-manager`

- **File and command:** `scripts/e2e/team-manager.e2e.ts` — `npm run test:browser -- team-manager`
- **Real Web/Harness contract:** Shipped Conversation integration with `team-manager` preset, Manager session replacement, reload recovery, stale-read guard, Sidebar/Project owner projection, and ordinary Session restoration.
- **Lower-layer tests:** `packages/agent-team/tests/manager-session.spec.ts`, `manager-writes.spec.ts`, `manager-reads.spec.ts`, and `manager-skills.spec.ts`.
- **Trigger:** `team-manager` preset, Manager session routing, `cordis.patch.yml` manager rows, or shipped Conversation slot changes.
- **Required evidence:** `artifacts/browser/team-manager/` (`1440` and `390` viewports), ordinary Session restoration.
- **Not responsible for:** `team-member` tool execution or live model quality.
- **Scale and cost:** 3 tests.

### `team-settings-and-tools`

- **File and command:** `scripts/e2e/team-settings-and-tools.e2e.ts` — `npm run test:browser -- team-settings-and-tools` (alias: `team-settings-nav-icon`)
- **Real Web/Harness contract:** Settings dialog Team tab identity/avatar conflict handling, narrow-width `[data-environment]` containment, and profile `extraToolGrants` grant/revoke/reconcile in assembled Web.
- **Lower-layer tests:** `packages/client-agent-team/tests/team-settings.client.spec.tsx` (including `TeamSettingsNavIcon` mark), `environment-check.client.spec.tsx`, `team-extra-tool-grants.client.spec.tsx`.
- **Trigger:** Settings slot, Human profile form, `extraToolGrants`, or `EnvironmentCheck` UI changes.
- **Required evidence:** `artifacts/browser/ui-09/`, `extra-tools/` (`1440` and `390` viewports).
- **Not responsible for:** Backend tool-gate enforcement inside `team-member` preset, or SVG path/verdict unit matrices already covered by Client specs.
- **Scale and cost:** 2 tests.

### `team-subscriptions`

- **File and command:** `scripts/e2e/team-subscriptions.e2e.ts` — `npm run test:browser -- team-subscriptions`
- **Real Web/Harness contract:** Read-only Project subscription display (no Human write controls), and published subscription event projection as script data in narrow/desktop layouts.
- **Lower-layer tests:** `packages/agent-team/tests/` subscription/webhook Host specs and `packages/client-agent-team/tests/` subscription specs.
- **Trigger:** Project subscription projection, event formatting, or subscription UI layout changes.
- **Required evidence:** `artifacts/browser/subscriptions/` (`1440` and `390` viewports).
- **Not responsible for:** Webhook HTTP ingress, retry scheduling, or cron trigger timing.
- **Scale and cost:** 2 tests.

### `team-timeline-and-shell`

- **File and command:** `scripts/e2e/team-timeline-and-shell.e2e.ts` — `npm run test:browser -- team-timeline-and-shell`
- **Real Web/Harness contract:** Thread/Main scroll anchoring across history load and arrivals, 4 concurrent same-origin Team pages, and keyboard shortcuts (`Meta+Alt+T` and global faces).
- **Lower-layer tests:** `packages/client-agent-team/tests/` timeline scroll and shortcut specs, and `packages/agent-team/tests/harness-lifecycle.spec.ts` (Host dispose/re-enable persistence).
- **Trigger:** Timeline scroll anchoring, multi-page Remote sync, or global shell shortcut changes.
- **Required evidence:** `artifacts/browser/timeline-anchor/`, `ui-09/` (`1440` and `390` viewports), scroll-offset stability probes.
- **Not responsible for:** Single-page Inbox or Manager flows, or Host plugin dispose/re-enable persistence.
- **Scale and cost:** 3 tests.

### `team-worker-lifecycle`

- **File and command:** `scripts/e2e/team-worker-lifecycle.e2e.ts` — `npm run test:browser -- team-worker-lifecycle`
- **Real Web/Harness contract:** Reading Worker diagnostics (5-row bound) in edit-Agent dialog and stopping one of two live Worker runs while leaving the other active.
- **Lower-layer tests:** `packages/agent-team/tests/` Worker lifecycle specs (`worker-long` project) and Client Worker UI specs.
- **Trigger:** Worker diagnostic UI, Worker stop action, or Worker status projection changes.
- **Required evidence:** `artifacts/browser/worker-inspect/`, `worker-stop/` (`1440` and `390` viewports).
- **Not responsible for:** Real Codex/Claude CLI protocol behavior.
- **Scale and cost:** 2 tests.

### `team-worker-settings-and-thread`

- **File and command:** `scripts/e2e/team-worker-settings-and-thread.e2e.ts` — `npm run test:browser -- team-worker-settings-and-thread`
- **Real Web/Harness contract:** Configuring the Worker delegation group on Team settings and observing a delegated Worker run in its own Thread.
- **Lower-layer tests:** `packages/client-agent-team/tests/team-worker-settings.client.spec.tsx` and Host Worker delegation specs.
- **Trigger:** Worker delegation settings UI, `team_worker` thread projection, or Worker failure terminal-state rendering changes.
- **Required evidence:** `artifacts/browser/worker-thread/` (`1440` and `390` viewports).
- **Not responsible for:** Worker diagnostic row cap or stop-button isolation (covered by `team-worker-lifecycle`).
- **Scale and cost:** 2 tests.

## Aliases

| Selector | Target lane | Reason |
| --- | --- | --- |
| `team-settings-nav-icon` | `team-settings-and-tools` | Preserves selector compatibility after lane consolidation (`scripts/run-browser-test.mjs`) |
