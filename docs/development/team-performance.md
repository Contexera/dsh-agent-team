# Team performance evaluation

English | [中文](team-performance.zh.md)

## Purpose

The Team performance suite measures the costs that a human or Member can observe across loading, tool calls, ledger reads, Session work, and collaboration. It is an evaluation tool, not a production code path, and it runs only when explicitly enabled.

The source of the scenarios is [`scripts/team-performance/`](../../scripts/team-performance/). The script index lists the entry points and their output formats in [`scripts/README.md`](../../scripts/README.md).

## Run the evaluation

### Baseline

Run the default 16 scenarios in one Node process:

```sh
DSH_BENCH_TEAM=1 npm run bench:team
```

The command writes a run directory under `artifacts/team-perf/runs/` containing `manifest.json`, measured `samples.jsonl`, and `summary.json`. The default configuration uses three measured samples and one warmup. Use `DSH_BENCH_SCENARIOS` to select scenarios and the matching variables such as `DSH_BENCH_THREADS`, `DSH_BENCH_FOLLOWERS`, `DSH_BENCH_MEMBERS`, and `DSH_BENCH_SESSION_EVENTS` to change workload size.

### Scale matrix

Run the default 15 cases in separate Node processes:

```sh
npm run bench:team:matrix
```

Set `DSH_BENCH_MATRIX_CASES` to a comma-separated list of `scenario:threads:followers`. The default collaboration cases cover the observed 1–4 follower range, the eight-Member queue boundary, a 20-Thread backlog, and one 32-follower stress case. The matrix routes the first size to Member or Session workloads when the scenario requires it. Each matrix directory contains a manifest, each child run, and an aggregated `results.json`.

In the fan-out fixture, `DSH_BENCH_FOLLOWERS` counts additional followers alongside one receiver, so a value of 32 yields 33 notification dispatches. Each raw sample records the expected and actual counts. The 8 case exercises the deferred path; mixed-batch ordering and shutdown are checked separately by the semantic probe.

### Real profile usage

Summarize an explicit read-only SQLite copy from a real profile:

```sh
npm run bench:team:usage -- /path/to/agent_team.sqlite --json
```

The report counts operations, Members, Thread Attention sizes, reply impact, and operations near the notification queue threshold. It reads raw operations instead of forcing the current ledger replay, so old `team/channel-*` records remain measurable.

`members.current` counts enabled and suspended Agent Members; archived and inactive Members remain only in `byState`. Enabled followers exclude the Human and non-enabled Agents; all followers include Human Attention rows. Lifecycle folding includes resume and removal snapshots.

Affected Member counts are estimates: they include stored Inbox recipients, Thread Attention after each operation, and the actor, but omit Main stream recipient derivation. The report prints counts only and never prints Message bodies or handles.

### Browser loading

Measure the assembled Web bundle and Team mode:

```sh
DSH_BENCH_BROWSER_SAMPLES=3 npm run bench:team:browser
```

Each sample uses a fresh temporary Web scaffold and Chromium. The runner records page load, Workspace connection, ordinary ready, Team mode ready, navigation timing, transfer bytes, console warnings, and page errors. It writes `manifest.json`, `samples.jsonl`, and `summary.json` under `artifacts/team-perf/browser/runs/`. Browser results must be read with p95 and p99 and with the individual samples because cold startup variance is material.

### Semantic probes

Check the ordered post-commit notification queue:

```sh
DSH_BENCH_TEAM=1 npm run bench:team:semantics
```

The probe checks failed delivery retry, per-Member ordering, Client invalidation before notification drain, shutdown cancellation, and disposal errors. A passing timing run does not replace these checks.

### Compare runs

Compare two baseline summaries or two matrix result files:

```sh
npm run bench:team:compare -- before/summary.json after/summary.json
npm run bench:team:compare -- --max-regression 20 before/summary.json after/summary.json
```

Host boot, Agent collaboration, and fan-out workloads carry `schema: 2` in each raw sample. Older runs measured different paths or unread loads and are not valid before/after inputs for these scenarios; rerun the same current evaluation script against both production versions.

The comparator reports shared p50, p95, and p99 rows and separately reports missing scenarios, missing metrics, and invalid measurements. With `--max-regression`, a metric with no measured percentiles fails the comparison; a zero-to-positive baseline change also fails instead of being treated as incomparable. A regression threshold is meaningful only when the workload, environment, and scenario schema match.

## What the scenarios measure

| Area | Scenarios | Main evidence |
| --- | --- | --- |
| Loading and activation | `bundle-size`, `host-boot`, `member-activation`, `member-activation-batch`, `member-resume` | bundle bytes, Host fixture boot, new and resumed Member activation, sequential versus concurrent activation |
| Tool paths | `tool-call`, `tool-read-sweep`, `thread-read-reply`, `tool-write`, `notification-retry` | tool total, Host handler time, result bytes, read/reply and failed-delivery recovery |
| Collaboration | `collaboration-fanout`, `collaboration-agent-turn` | durable commit, Ledger queue wait/service, fan-out dispatch, event-loop lag, notification drain, model request and idle stages |
| Session and storage | `session-fold`, `session-replay-jsonl`, `ledger-read-memory`, `ledger-replay-sqlite` | cursor and projection fold, JSONL write/read/bytes, bounded ledger reads, SQLite open/replay/validation |

The baseline uses real Team Host fixtures and deterministic model adapters where a model turn is needed. It does not claim to represent a production model provider or a live user's machine. The browser scenario is the assembled-path check; the Node scenarios explain the cost inside that path.

`collaboration-agent-turn` records notice queue/claim, model request, read/reply tool calls, durable receipts, and idle for cold and warm turns. It checks two committed replies, two reads, six receiver model requests, and correlated IDs. The warm trigger uses the sender's actual read result, not a fabricated revision.

`host-boot` measures a new Node process through empty Host readiness, then separately restores two persisted Members in that process. `ledger-replay-sqlite` supplies storage/open/replay/validation timing. The fan-out fixture follows every workload Thread and writes unread facts after following; assertions reject a nominal 20/100-Thread load with only one actually unread Thread.

## Current constraints

- [Host authority](../architecture/host-authority.md#lifecycle-and-notifications) defines notification reuse and ordered dispatch. Commit latency and notification drain measure different completion points; moving work after commit does not remove that work.
- The Agent-turn scenario drives real `team_thread read` and `team_message reply` calls through a deterministic adapter, checking committed replies and cold/warm stages. Host boot uses a fresh Node child; populated Host restoration is measured separately inside it. Neither includes production provider latency.
- JSONL `zstd` remains the production default. Uncompressed replay is faster in the measured fixture but uses substantially more disk space.
- Concurrent calls already improve the measured batch Member activation path. The result alone does not justify changing Host startup ordering without a separate startup-restoration experiment.
- Browser cold-start results have a long tail. Keep the sample records and compare distributions; do not turn one run into a hard acceptance threshold.
- Deferred dispatch can increase time until all notifications finish even when commit returns much earlier; Agent work can interleave with dispatch. Report both endpoints. This optimization reduces caller blocking, not total notification work.

## Change workflow

When changing a performance-sensitive path, run the narrowest scenario that can observe the change, then run the related scale cases and semantic probes. Compare the same scenario before and after the change. Inspect operation counts and result shape together with wall-clock values; a lower time with missing facts is a failed run. Run `npm test` and `npm run check:artifact` before treating the result as delivered.

Do not place secrets, real profiles, or temporary browser overlays in the repository. Timing runs and the scale matrix are opt-in. The test suite explicitly enables small scenario-contract fixtures to verify cold boot, real tool replies, and unread load; it does not impose timing thresholds.
