# Ledger storage, notifications, and delivery

English | [中文](storage-and-delivery.zh.md)

## Team ledger storage routing
The `agent_team` domain is routed to SQLite through the public composition in `cordis.patch.yml`, using `$DSH_HOME/storages/agent_team.sqlite`; other domains retain the JSON default. The override must be a top-level row, not an insert item.

The backend is a vendored fork under our own package name (`@contexera/dsh-agent-team/sqlite-backend`, MIT, source `dsh-storage-sqlite` 0.1.5-rc.2, see `packages/agent-team/src/vendor/storage-sqlite/`): DSH Desktop generation installers strip `@deepseek-ai/*` copies and no shipped host closure provides the upstream package, so a loader row naming it blocks boot (GitHub issue #28). The fork keeps the upstream `sqlite` backend name and config shape, so existing media open without migration; the upstream package stays a devDependency only as the byte-compatibility fixture.

Three checks pin this: `packages/agent-team/tests/storage-sqlite-compat.spec.ts` proves both read directions under the real ledger descriptor, `packages/agent-team/tests/shipping.spec.ts` pins every reachable runtime root inside the host closure, and `node scripts/verify-desktop-strip-boot.mjs` replays a real Loader boot against a stripped generation. Diff the fork against the upstream file on every DSH compat round. Routing creates a new empty SQLite medium; an old `agent_team.json` is not read or migrated. `preview` and `preview:ui` use a minimal JSON overlay.

The storage benchmark measures only backend writes, not ledger validation, over deterministic operation documents near the observed 3.4 KB average:

```sh
DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts
```

JSON's whole-file rewrite cost grows with history — about 2.7× from 1k to 10k operations — while SQLite stays near the per-statement fsync floor. The startup path remains full `loadAll()` plus full replay, and the checkpoint/log direction is in [the storage architecture archive](../../.scratch/archive/2026-08/agent-team-storage-architecture/).

## Multi-page notification regression
`npm run test:browser` includes four pages in the same BrowserContext (not four isolated connection pools), then a separate BrowserContext. It checks rendered Channels, cross-page messages, closing a page, leaving Team mode, and browser-originated member queries under a 3-second regression threshold. This is a small-fixture regression bound, not a production latency guarantee. The complete journey also checks recovery without a new commit after intentional network loss. Screenshots remain under `artifacts/browser/`, including desktop and 390×844 multi-page views.

For a focused run: `npm run test:browser -- -t "four same-origin"`. Run the complete suite before accepting a transport change. These checks do not certify cross-page drafts, navigation storage, private unread synchronization, or hidden-page automatic reading; assess those separately.

## Delivery checklist
- No shipped DSH defaults were changed accidentally.
- Package README, manifest, exports, and visible behavior agree.
- Remote changes were regenerated; no artifacts were hand-edited.
- Client changes have real composition or browser evidence, not only component tests.
- Reports contain only checks that actually ran.
- `git diff --check <base>..HEAD` passes on the delivered range.
- Live preview, UI preview, and browser replay do not switch modes implicitly.
- No API keys, profile credentials, temporary overlays/tests, or browser artifacts are committed.
