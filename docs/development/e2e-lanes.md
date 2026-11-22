# E2E Browser Lanes

English | [中文](e2e-lanes.zh.md)

## Purpose

This catalog explains what each assembled Web scenario proves, which lower-layer tests to try first, and where to find the browser evidence. For the full check ladder, see [Start and checks](start-and-checks.md#verification-gradient).

## Test selection by risk

Start with a focused lane for slot, preset, layout, or cross-page changes. Run the full suite instead when changing shared scenario setup or the runner. The default suite uses the short `team-journey` smoke; use `--deep` for the complete Team journey or a release.

```sh
node scripts/run-browser-test.mjs --list
npm run test:browser -- team-timeline-and-shell -t "four same-origin"
npm run test:browser -- --deep
```

Use the Node runner directly to list lanes without building. A lane selector matches a file name; `-t` narrows test names inside the selected files. Filtered runs still build and check available images, but skip the full `1440`/`390` width requirement. Check `artifacts/browser/summary.json` for lanes, timings, and the failed phase.

## Full-run scheduling

The unfiltered runner keeps `team-journey` and `team-manager` in a serial heavy batch because running them beside other full Harness scenarios caused hook timeouts. The deep profile replaces `team-journey` with `team-journey-deep`.

The remaining lanes run in a batch with at most two workers by default after the heavy batch. Targeted runs or runs with custom Vitest flags keep their requested arguments and are never reshaped automatically.

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
- **Trigger:** Broad Team shell redesign, cross-surface navigation changes, deep visual regression review, or release acceptance.
- **Required evidence:** `artifacts/browser/ui-01/` to `ui-06/` (`1440` and `390` viewports), zero console warnings/page errors, clean ordinary DSH restore.
- **Not responsible for:** Replacing the focused Inbox, Manager, Worker, Settings, Subscription, or Main/Board lane contracts.
- **Scale and cost:** 1 deep test.

### `team-inbox-and-recovery`

- **File and command:** `scripts/e2e/team-inbox-and-recovery.e2e.ts` — `npm run test:browser -- team-inbox-and-recovery`
- **Real Web/Harness contract:** Human Inbox delivery, offline retry/recovery, consecutive messages, expired attachment vs broken image distinction, and keyboard navigation.
- **Lower-layer tests:** `packages/agent-team/tests/dm-delivery-lane.spec.ts`, `attachments.spec.ts`, and Client Inbox specs.
- **Trigger:** Inbox UI, attachment rendering/fallback, offline retry, or Inbox keyboard navigation changes.
- **Required evidence:** `artifacts/browser/ui-07/`, plus the offline states in `ui-08/`; keyboard focus/navigation checks.
- **Not responsible for:** Host ledger replay invariants or non-Inbox Team surfaces.
- **Scale and cost:** 2 tests.

### `team-main-stream-and-board`

- **File and command:** `scripts/e2e/team-main-stream-and-board.e2e.ts` — `npm run test:browser -- team-main-stream-and-board`
- **Real Web/Harness contract:** Main stream posting, discussion/Task creation, Project owner dialog, Task board card focus (keyboard/mouse), and taskless thread ref-chip navigation.
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
- **Required evidence:** `artifacts/browser/timeline-anchor/`, `ui-09/`, and `multi-web-{desktop,mobile}.png`; scroll-offset stability probes.
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
- **Required evidence:** `artifacts/browser/worker-thread/` and Worker settings images in `ui-09/`.
- **Not responsible for:** Worker diagnostic row cap or stop-button isolation (covered by `team-worker-lifecycle`).
- **Scale and cost:** 2 tests.

## Aliases

| Selector | Target lane | Reason |
| --- | --- | --- |
| `team-settings-nav-icon` | `team-settings-and-tools` | Preserves selector compatibility after lane consolidation (`scripts/browser-runner.mjs`) |
