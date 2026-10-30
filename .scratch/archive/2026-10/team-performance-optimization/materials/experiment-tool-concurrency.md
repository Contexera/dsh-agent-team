# Team tool action-sensitive concurrency experiment

**Experiment date:** 2026-10-28

**Team commit:** `bf777c39ecc1ff912a3b473d85f575dd0758bdd5` (`bf777c3`)

**Harness commit:** `687f282e8625c6b8d11ff58211a90524be2e4317`

**Environment:** WSL2, Linux 6.6.87.2, Intel Core i7-14650HX, Node.js 24.15.0, Vitest 5.0.5

## Conclusion

Do not add `isConcurrencySafe` to these Team read actions for the current performance case.

The real Team Host does reduce the tool batch median by about 0.2–0.5 ms for four and eight calls, but the absolute gain is small and the p95 does not improve consistently. In the controlled workload, synchronous CPU work remains serial and gains nothing; only waiting that actually yields to the event loop can overlap. Today the candidate Host projections are synchronous, so the current implementation has little parallel resource to use.

Keep action-sensitive concurrency as a correctness-approved option for a future version that introduces genuinely asynchronous Host reads. Current priority should remain reducing synchronous projection work and repeated derivation.

## Scope check

At `bf777c3`, all seven registered Team tools resolve as `exclusive`: none declares `isConcurrencySafe`. The seven names are `team_inbox`, `team_thread`, `team_attention`, `team_message`, `team_dm`, `team_task`, and `team_view`.

The experiment covered only these candidate actions:

| Tool | Candidate action | Expected mode with temporary classifier |
|---|---|---|
| `team_attention` | `status` | parallel |
| `team_thread` | `history` | parallel |
| `team_thread` | `message` | parallel |
| `team_task` | `board` | parallel |
| `team_task` | `list` | parallel |
| `team_view` | current read | parallel |

The temporary classifier kept these actions exclusive: `team_inbox`; `team_thread read`; both mutating `team_attention` actions; all `team_message` actions; and `team_task claim`, `done`, `release`, `accept`, `close`, `reopen`, `transfer`, and `promote`.

The Harness tests confirmed that only exact `true` from `ToolRuntime.executionMode()` selects parallel execution. A missing classifier, a false result, an invalid call, or a thrown classifier selects exclusive execution. The scheduler also reclassifies later calls before starting them, so a tool registration change can create a barrier.

## Fixtures

Two fixtures were used.

### Controlled scheduler fixture

The first fixture loaded the actual Team tool definitions from `bf777c3`, including argument validation, Host calls, output validation, and rendering. It registered them in a real Harness `AgentLoop`, with real `ToolRuntime`, Session, Session projection, and model request handling. A fixed fake `AgentTeam` service supplied valid Thread, Task, Attention, Message, board, and directory data.

Three workloads separated scheduler behavior from Host cost:

| Workload | Added work per tool call | Purpose |
|---|---:|---|
| `none` | 0 ms | Actual Team tool body plus fake in-memory reads |
| `sync` | 10 ms busy CPU wait | Synchronous projection work that the JavaScript event loop cannot overlap |
| `async` | 20 ms timer wait | Yielding I/O to test the scheduler's actual overlap capability |

Each configuration used batches of 1, 4, and 8 calls. The six candidate actions rotate through a larger batch. Each cell had three warmup batches and 51 measured batches. The whole matrix ran three times.

### Real Host fixture

The second fixture used the actual `AgentTeam` Host over its memory storage backend and the real `team-member` preset activation path. It created a Project, Task Thread, Message, and Agent Member, then executed the candidate actions against that live Team state through the real AgentLoop.

This fixture added no artificial delay. Each cell had three warmup batches and 101 measured batches. The whole matrix ran twice. The temporary worktree required `npm run build` first because the preset loader imports compiled package entries rather than the source path alias.

## Commands

Run from a clean temporary worktree at `bf777c3`:

```text
npm run build
npx tsc -p packages/tool-agent-team/tsconfig.json --noEmit

DSH_EXPERIMENT_SAMPLES=51 npx vitest run \
  packages/tool-agent-team/tests/zz-tool-concurrency.experiment.spec.ts \
  --project suite

DSH_REAL_HOST_SAMPLES=101 npx vitest run \
  packages/tool-agent-team/tests/zz-tool-concurrency-realhost.experiment.spec.ts \
  --project suite
```

The controlled-scheduler command ran three times; the real-Host command ran twice. All runs passed. The temporary test files and worktree were removed after the results were recorded.

Harness contract checks run against the same Harness checkout:

```text
pnpm exec vitest run \
  packages/core/tools/tests/execution-mode.spec.ts \
  packages/core/agent-loop/tests/tool-calls.spec.ts
```

Result: 2 files and 34 tests passed. TypeScript checks for the temporary Team tool test fixture also passed.

## Controlled scheduler result

Values are milliseconds. Each cell shows the range across three independent 51-sample runs. `loop` covers the user turn from `followup()` until Agent idle; `tool` covers the first `tool/call` write to the last `tool/result` write.

| Workload | Calls | Exclusive loop p50 | Parallel loop p50 | Exclusive loop p95 | Parallel loop p95 | Tool p50 exclusive → parallel |
|---|---:|---:|---:|---:|---:|---:|
| none | 1 | 2.29–2.61 | 1.88–2.12 | 3.86–4.31 | 3.02–3.11 | 0.26–0.28 → 0.19–0.23 |
| none | 4 | 3.07–3.34 | 2.80–2.89 | 3.99–4.90 | 3.43–4.25 | 1.10–1.15 → 0.90–0.92 |
| none | 8 | 4.24–4.54 | 3.75–4.27 | 7.08–7.35 | 5.10–6.90 | 2.17–2.22 → 1.72–1.93 |
| sync CPU | 1 | 12.11–12.57 | 12.24–12.34 | 12.52–13.44 | 12.85–12.90 | 10.33–10.51 → 10.40–10.42 |
| sync CPU | 4 | 44.14–44.46 | 43.85–44.18 | 45.68–46.41 | 45.82–46.17 | 41.84–42.27 → 41.84–42.03 |
| sync CPU | 8 | 86.20–87.03 | 86.01–86.75 | 88.21–89.02 | 88.64–89.66 | 83.68–84.65 → 83.75–84.42 |
| async wait | 1 | 22.42–22.55 | 22.59–23.28 | 22.99–23.95 | 23.55–25.00 | 20.57–20.87 → 20.58–21.04 |
| async wait | 4 | 84.94–85.17 | 23.42–24.13 | 85.78–86.96 | 24.10–27.42 | 82.80–83.04 → 21.37–21.73 |
| async wait | 8 | 168.80–171.59 | 24.06–26.22 | 170.24–176.33 | 24.83–28.68 | 166.24–168.71 → 22.01–22.76 |

The `none` row shows a small reduction in absolute time, mostly from amortizing per-group scheduler work; it is below one millisecond per eight calls. The `sync` row shows no material improvement: 10 ms of uninterrupted CPU work per call remains approximately serial. The `async` row shows that the scheduler itself overlaps yielding work correctly.

## Real Team Host result

Values are milliseconds. Each cell shows the range across two independent 101-sample runs of the actual Host with no injected delay.

| Calls | Exclusive loop p50 | Parallel loop p50 | Exclusive loop p95 | Parallel loop p95 | Tool p50 exclusive → parallel | Tool p95 exclusive → parallel |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3.41–3.71 | 2.81–3.02 | 5.86–6.72 | 4.66–4.85 | 0.42–0.45 → 0.33–0.36 | 0.75–0.83 → 0.44–0.54 |
| 4 | 4.72–5.14 | 4.46–4.62 | 6.49–6.83 | 6.71–6.79 | 1.71–1.86 → 1.56–1.60 | 2.43–3.11 → 3.07–3.40 |
| 8 | 6.80–6.97 | 6.12–6.62 | 8.49–10.45 | 7.78–9.53 | 3.48–3.50 → 3.01–3.30 | 4.48–5.42 → 3.97–5.66 |

The one-call rows are a noise control because parallel and exclusive have no concurrency difference there. Their median difference of roughly 0.4–0.7 ms shows the setup and process variance floor.

At four calls, the parallel tool median decreases by 0.15–0.26 ms, but tool p95 is higher in both runs. At eight calls, the median decreases by 0.18–0.49 ms; p95 improves in one run and regresses in the other. This is not a stable end-to-end tail-latency improvement.

## Ordering result

Every run preserved these invariants:

- The assistant's calls were written to Session in model order.
- `tool/result` writes were in model order, regardless of dispatch settlement order.
- The next model request listed the current batch's tool results in model order.
- Exclusive batches wrote each call and result as a pair before starting the next call.
- Parallel yielding batches wrote all calls before their results in the representative eight-call sample.
- Parallel synchronous batches could interleave starts and ordered commits, for example `call1, call2, result1, call3, result2, ...`; call order and result order still remained model-ordered.

Representative eight-call order:

```text
exclusive: call:c1, result:c1, call:c2, result:c2, ... call:c8, result:c8
parallel (async): call:c1..call:c8, result:c1..result:c8
parallel (sync): call:c1, call:c2, result:c1, call:c3, result:c2, ...
```

The implementation reason is visible in the Harness scheduler: `tool/call` is appended when a call starts, while `appendToolResult()` commits only across contiguous slots in model order. Parallel dispatch can overlap, but result and additional-context commits remain ordered.

## Interpretation

Action-sensitive concurrency is technically possible without changing result order or the model's next-step view. The classifier combinations used in this experiment classified the six candidate actions as parallel and the excluded read/write actions as exclusive.

It is not yet a worthwhile Team performance change. The current candidate Host methods perform synchronous projection work. JavaScript cannot run that work in parallel inside one process. Parallel dispatch can pipeline asynchronous stages and remove a small amount of scheduler wait, but it cannot reduce the dominant CPU scan or rendering work.

The experiment therefore supports these priorities:

1. Reduce synchronous projection work and duplicate derivation first, including the notification read-set and repeated history/board scans identified in earlier research.
2. Keep mutation and read-with-side-effect tools exclusive. `team_inbox`, `team_thread read`, Attention changes, message writes, DMs, and Task mutations remain excluded.
3. Revisit pure-read concurrency only if Team reads start making real asynchronous calls or if production traces show a multi-call read batch whose tail is dominated by awaitable work.
4. If concurrency is adopted later for correctness or future-proofing, use the exact candidate set above and add scheduler-level ordering tests. The measured present-day performance benefit is too small to justify it as a standalone optimization.

## Limitations

- The controlled fixture used fixed valid Host data. It tested actual Team tool definitions and the real Harness loop, but not production projection size or SQLite work.
- The real Host fixture used the memory storage backend and small Team state. It did not test a large ledger, cold Session activation, browser rendering, or network/model latency.
- Measurements are same-process and JIT-warmed; sub-millisecond results have substantial scheduling noise. The one-call real-Host result was used as the empirical noise control.
- The 10 ms synchronous and 20 ms asynchronous delays are controlled sensitivity tests, not estimates of production Host cost.
- Only one Agent Session issues the batch. Separate Agents still serialize their Team writes through the shared operation queue.

## Raw result fingerprints

The complete controlled matrices were saved during the run as `/tmp/team-tool-concurrency-final-run1.json`, `/tmp/team-tool-concurrency-final-run2.json`, and `/tmp/team-tool-concurrency-final-typed.json`. SHA-256 values were:

```text
4bc82cc5a964e1a8e2ed22bb532e5ede883674bb53348d61c87d6d63d9208de2
f22b17efef59494265da20a0203a14a50febb0672f2ba97ff502afe5db98fff2
774ea96fbb3838bc2d4cc3d757d2877f4b61d6b238147216b20194e57ba6d4d9
```

The two final real-Host matrices had SHA-256 values:

```text
8d1fe3c39d680ca75bbac6714983a6185105406f242b5be7e7b33492c03afb16
4411875ffa9f5acf426da205712e47fe30307c69d0edf8d77a1c819ea2ac6d46
```

Raw files were temporary and were not added to the repository.
