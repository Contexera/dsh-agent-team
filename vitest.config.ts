import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { harnessDir } from './scripts/harness-dir.mjs'
import { standardDecoratorPlugin } from './scripts/standard-decorators.ts'

// Root tsconfig.json is the match-all resolution facade (no include) for
// files in THIS repo: its paths map routes every @deepseek-ai/dsh-* import to
// the sibling deepseek-harness checkout source, and our own packages to
// ./packages/*. Files inside the harness tree are matched by harness's own
// tsconfig.base.json (registered as a second project), which routes their
// imports back to harness source. paths must win over package exports so a
// second module-singleton copy can never load.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> => tsconfigPaths({
  // scripts/harness-dir.mjs owns the checkout pointer for every consumer:
  // env override for certification runs, the daily sibling default otherwise,
  // fail-fast when the resolved checkout is missing.
  projects: ['./tsconfig.json', resolve(harnessDir, 'tsconfig.base.json')],
})

const integrationSpecs = [
  // Integration specs (agent-team): they boot a real Host or Member runtime.
  'packages/agent-team/tests/activity-notice-recovery.spec.ts',
  'packages/agent-team/tests/activity-tool-recovery.spec.ts',
  'packages/agent-team/tests/agent-team-attention.spec.ts',
  'packages/agent-team/tests/agent-team-transfer.spec.ts',
  'packages/agent-team/tests/archived-reads.spec.ts',
  'packages/agent-team/tests/attachments.spec.ts',
  'packages/agent-team/tests/body-authored-mentions.spec.ts',
  'packages/agent-team/tests/change-scopes.spec.ts',
  'packages/agent-team/tests/dm-delivery-lane.spec.ts',
  'packages/agent-team/tests/harness-lifecycle.spec.ts',
  'packages/agent-team/tests/host-row-upgrade-regression.spec.ts',
  'packages/agent-team/tests/human-avatar-host.spec.ts',
  'packages/agent-team/tests/human-profile.spec.ts',
  'packages/agent-team/tests/legacy-session-transition.spec.ts',
  'packages/agent-team/tests/main-read-context.spec.ts',
  'packages/agent-team/tests/member-acceptance.spec.ts',
  'packages/agent-team/tests/member-archival.spec.ts',
  'packages/agent-team/tests/member-change-domains.spec.ts',
  'packages/agent-team/tests/member-cold-activation.spec.ts',
  'packages/agent-team/tests/member-execution-isolation.spec.ts',
  'packages/agent-team/tests/member-lifecycle-core.spec.ts',
  'packages/agent-team/tests/member-memory-dirs.spec.ts',
  'packages/agent-team/tests/member-memory-scaffold.spec.ts',
  'packages/agent-team/tests/member-model-adoption.spec.ts',
  'packages/agent-team/tests/member-model-legacy.spec.ts',
  'packages/agent-team/tests/member-model-route.spec.ts',
  'packages/agent-team/tests/member-presence-scope.spec.ts',
  'packages/agent-team/tests/member-reminder-delivery.spec.ts',
  'packages/agent-team/tests/member-reminder-host.spec.ts',
  'packages/agent-team/tests/member-reminder-timer.spec.ts',
  'packages/agent-team/tests/member-skills.spec.ts',
  'packages/agent-team/tests/member-time.spec.ts',
  'packages/agent-team/tests/member-wake-input.spec.ts',
  'packages/agent-team/tests/member-wake-safety.spec.ts',
  'packages/agent-team/tests/member-wake-swap.spec.ts',
  'packages/agent-team/tests/member-wake-windows.spec.ts',
  'packages/agent-team/tests/notification-attribution.spec.ts',
  'packages/agent-team/tests/notification-context.spec.ts',
  'packages/agent-team/tests/notification-recovery-context.spec.ts',
  'packages/agent-team/tests/notification-reminder-context.spec.ts',
  'packages/agent-team/tests/own-credential-superseded.spec.ts',
  'packages/agent-team/tests/performance-scenarios.spec.ts',
  'packages/agent-team/tests/post-commit-delivery.spec.ts',
  'packages/agent-team/tests/project-archival.spec.ts',
  'packages/agent-team/tests/project-owner-guidance.spec.ts',
  'packages/agent-team/tests/projection-indexes.spec.ts',
  'packages/agent-team/tests/release-snapshot.spec.ts',
  'packages/agent-team/tests/session-recycling.spec.ts',
  'packages/agent-team/tests/session-trace.spec.ts',
  'packages/agent-team/tests/storage-sqlite-compat.spec.ts',
  'packages/agent-team/tests/subscription-directory.spec.ts',
  'packages/agent-team/tests/subscription-host.spec.ts',
  'packages/agent-team/tests/subscription-retry.spec.ts',
  'packages/agent-team/tests/subscription-runs.spec.ts',
  'packages/agent-team/tests/surface-agreement.spec.ts',
  'packages/agent-team/tests/surface-exemption.spec.ts',
  'packages/agent-team/tests/surface-rejection-recovery.spec.ts',
  'packages/agent-team/tests/task-reminder-restart.spec.ts',
  'packages/agent-team/tests/task-transfer-v3.spec.ts',
  'packages/agent-team/tests/thread-read-context.spec.ts',
  'packages/agent-team/tests/thread-read-progress.spec.ts',
  'packages/agent-team/tests/thread-read-selection.spec.ts',
  'packages/agent-team/tests/update-operations.spec.ts',
  'packages/agent-team/tests/usage-report.spec.ts',
  'packages/agent-team/tests/webhook-entry.spec.ts',
  'packages/agent-team/tests/worker-anchors.spec.ts',
  'packages/agent-team/tests/worker-catalog-continuation.spec.ts',
  'packages/agent-team/tests/worker-composition.spec.ts',
  'packages/agent-team/tests/worker-steer.spec.ts',
  'packages/agent-team/tests/worker-stop-notice.spec.ts',
  // Integration specs (tool-agent-team): they boot a real Host runtime.
  'packages/tool-agent-team/tests/team-addressing.spec.ts',
  'packages/tool-agent-team/tests/team-view-directory.spec.ts',
  // Integration specs (client-agent-team): they assemble the heavy SlotTestRuntime bench.
  'packages/client-agent-team/tests/agent-row-open-failure.client.spec.tsx',
  'packages/client-agent-team/tests/human-profile-seats.client.spec.tsx',
  'packages/client-agent-team/tests/main-panel.client.spec.tsx',
  'packages/client-agent-team/tests/render-isolation.client.spec.tsx',
  'packages/client-agent-team/tests/team-edit-refresh-recovery.client.spec.tsx',
  'packages/client-agent-team/tests/team-human-attention.client.spec.tsx',
  'packages/client-agent-team/tests/team-inbox.client.spec.tsx',
  'packages/client-agent-team/tests/team-loading-surface.client.spec.tsx',
  'packages/client-agent-team/tests/team-main-stream.client.spec.tsx',
  'packages/client-agent-team/tests/team-mode-agents.client.spec.tsx',
  'packages/client-agent-team/tests/team-mode-conversation.client.spec.tsx',
  'packages/client-agent-team/tests/team-presence-scope.client.spec.tsx',
  'packages/client-agent-team/tests/team-project-board.client.spec.tsx',
  'packages/client-agent-team/tests/team-project-panel-switch.client.spec.tsx',
  'packages/client-agent-team/tests/team-project-panel.client.spec.tsx',
  'packages/client-agent-team/tests/team-send-retry.client.spec.tsx',
  'packages/client-agent-team/tests/team-shared-reads.client.spec.tsx',
  'packages/client-agent-team/tests/team-task-board-page.client.spec.tsx',
  'packages/client-agent-team/tests/team-worker-panel.client.spec.tsx',
  'packages/client-agent-team/tests/team-worker-thread.client.spec.tsx',
]

const longSpecs = [
  'packages/agent-team/tests/worker-inspect.spec.ts',
  'packages/agent-team/tests/storage-bench.spec.ts',
  'packages/agent-team/tests/member-tool-policy.spec.ts',
]

export default defineConfig({
  plugins: [pathsPlugin(), standardDecoratorPlugin()],
  resolve: {
    // Prefer .ts over stray .js build artifacts that linger in the harness
    // checkout's src trees; keeps this repo independent of their cleanup.
    extensions: ['.mts', '.ts', '.mjs', '.js', '.json'],
    // Harness sources live in a sibling workspace; rendered tests must still
    // share one React dispatcher with this repository's Testing Library.
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: resolve('node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve('node_modules/react/jsx-runtime.js') },
      { find: /^react-dom$/, replacement: resolve('node_modules/react-dom/index.js') },
      { find: /^react-dom\/(.*)$/, replacement: resolve('node_modules/react-dom/$1') },
      { find: /^@testing-library\/react$/, replacement: resolve('node_modules/@testing-library/react/dist/index.js') },
      { find: /^@testing-library\/dom$/, replacement: resolve('node_modules/@testing-library/dom/dist/index.js') },
      { find: /^use-sync-external-store\/(.*)$/, replacement: resolve('node_modules/use-sync-external-store/$1') },
    ],
  },
  test: {
    // Timeout policy lives here rather than in per-file `vi.setConfig` calls or
    // inline test/hook timeout arguments, so no file can quietly widen the budget.
    // Five mutually exclusive projects partition the suite by execution cost:
    // - unit (5s): pure functions, ledger specs, tool rendering, lightweight UI
    // - integration (60s): every spec that boots a real Host/Member runtime or the
    //   Client bench; the fixed list below is the classification, not a discovery scan
    // - worker-long (120s test / 30s hook): worker-inspect.spec.ts
    // - benchmark (900s): storage-bench.spec.ts (gated by DSH_BENCH_STORAGE=1)
    // - shared-host (30s test / 30s hook): member-tool-policy.spec.ts
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/tests/**/*.spec.ts', 'packages/*/tests/**/*.client.spec.tsx'],
          exclude: [...longSpecs, ...integrationSpecs],
          testTimeout: 5_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationSpecs,
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'worker-long',
          include: ['packages/agent-team/tests/worker-inspect.spec.ts'],
          testTimeout: 120_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'benchmark',
          include: ['packages/agent-team/tests/storage-bench.spec.ts'],
          testTimeout: 900_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'shared-host',
          include: ['packages/agent-team/tests/member-tool-policy.spec.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    // Every test file gets a throwaway DSH home so Agent Team boots can never
    // prune the developer's real Member memory directories.
    setupFiles: ['./scripts/isolate-dsh-home.setup.ts'],
    // Time rendering is zone-dependent by contract — a seat states the reader's
    // own clock, not the instant — so the suite needs one zone to mean anything.
    // Left to the runner, the same expectation reads as three different hours:
    // UTC in CI, UTC+8 on the machines this is maintained on. Pinning a zone
    // that is NOT UTC is the point: a formatter that reaches for `getUTCHours`
    // then renders a different time than the reader's clock and fails here,
    // which is exactly the bug the real literals below are meant to catch.
    env: { TZ: 'Asia/Shanghai' },
  },
})
