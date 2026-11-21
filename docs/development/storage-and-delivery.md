# Ledger storage, notifications, and delivery

English | [中文](storage-and-delivery.zh.md)

## Team ledger storage routing
The Team Host owns a private SQLite backend and `DomainFacility` for `agent_team` and `agent_team_subscriptions`, using `$DSH_HOME/storages/agent_team.sqlite`. Unrelated domains retain the Host's default routes. This is deliberately not a `storage-domain` route override: changing that global row while toggling the bundle rebuilds unrelated storage consumers and can restart the Session controller twice, producing a duplicate file-upload resolver registration.

The subscription unit writes format v5 and reads v1–v4 without updating their stamp on open. The first actual subscription mutation upgrades its stamp in the same transaction; startup work can cause that write. The ledger unit has a separate stamp. Before upgrading, stop every Host that shares the database and back it up. After the subscription unit has advanced, an older build refuses it; rollback requires restoring that backup and loses writes made since it.

The backend is a vendored fork under our own package name (`@contexera/dsh-agent-team/sqlite-backend`, MIT, source `dsh-storage-sqlite` 0.2.2-rc.1, see `packages/agent-team/src/vendor/storage-sqlite/`): DSH Desktop generation installers strip `@deepseek-ai/*` copies and no shipped host closure provides the upstream package, so a loader row naming it blocks boot (GitHub issue #28).

The fork keeps the upstream `sqlite` backend name and config shape, so existing media open without migration; the upstream package stays a devDependency only as the byte-compatibility fixture.

Three checks pin this: `packages/agent-team/tests/storage-sqlite-compat.spec.ts` proves both read directions under the real ledger descriptor, `packages/agent-team/tests/shipping.spec.ts` pins every reachable runtime root inside the host closure, and `node scripts/verify-desktop-strip-boot.mjs` replays a real Loader boot against a stripped generation. Diff the fork against the upstream file on every DSH compat round.

On first use, routing creates a new SQLite database; an old `agent_team.json` is not read or migrated. Both preview commands mount the bundle in a temporary home, separate from the operator's database.

Run `DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts` to measure backend writes, not ledger validation. Startup still loads and replays the full ledger. For end-to-end ledger measurements, see [Team performance](team-performance.md).

## A ledger that does not replay
The Host replays and validates its durable ledger while it constructs it: a record whose sequence is not its position, a broken previous-operation link, a repeated operation or request id, or a first record that is not `team/initialized` throws there, naming the record. `agent-team ledger expected sequence 27968, found 27967` is a repeated sequence, not a gap.

If replay throws, the Host row fails to activate. Its companion `contexera-agent-team-invariant` waits for the `agentTeam` service, and the Harness loader warns about inactive entries. If replay succeeds and nothing has committed since, the companion reuses that result at mount.

After activation the companion coalesces commits into one replay after the response’s I/O turn. It logs a divergence and re-raises it on later commits until a replay comes back clean.

The tools report `Agent Team Host is unavailable` in that state, and in a normal startup window too: they inject only `tools` and resolve `agentTeam` on the call, while the Host applies once its required services are ready. Only the boot log separates the two — the tool error names neither.

## Multi-page notification regression
`npm run test:browser` includes four pages in the same BrowserContext (not four isolated connection pools), then a separate BrowserContext. It checks rendered Projects, cross-page messages, closing a page, leaving Team mode, and browser-originated member queries under a 3-second regression threshold. This is a small-fixture regression bound, not a production latency guarantee. The Inbox lane separately checks offline recovery without another commit. Screenshots remain under `artifacts/browser/`, including desktop and 390×844 multi-page views.

For a focused run: `npm run test:browser -- team-timeline-and-shell -t "four same-origin"`. Run the complete suite before accepting a transport change. These checks do not certify cross-page drafts, navigation storage, private unread synchronization, or hidden-page automatic reading; assess those separately.

## Delivery checklist
- No shipped DSH defaults were changed accidentally.
- Package README, manifest, exports, and visible behavior agree.
- Remote changes were regenerated; no artifacts were hand-edited.
- Client changes have real composition or browser evidence, not only component tests.
- Reports contain only checks that actually ran.
- `git diff --check <base>..HEAD` passes on the delivered range.
- Live preview, UI preview, and browser replay do not switch modes implicitly.
- No API keys, profile credentials, temporary overlays/tests, or browser artifacts are committed.
