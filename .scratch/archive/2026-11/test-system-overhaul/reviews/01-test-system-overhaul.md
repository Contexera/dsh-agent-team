# Review 01 — test-system-overhaul

**Conclusion:** Changes needed
**Work item:** test-system-overhaul
**Ticket:** Whole work item
**Compared:** Working tree at `57f762f9a6a38f95ac8f3db8849b2b698421d7f2`, including 144 changed tracked paths and untracked test helpers/bench files
**Commits:** None — the delivery is uncommitted
**Reviewed:** 2026-11-14

## Findings

### P1 — Remove the cross-project `/tmp` snapshot race from the lifecycle test

**Location:** `packages/agent-team/tests/harness-lifecycle.spec.ts:30`
**Evidence:** `npm test` ran 207 test files successfully but failed this assertion because another concurrent Vitest project created `dsh-agent-team-member-*` between `beforeRoots` and `afterRoots`. Running `npx vitest run --project integration packages/agent-team/tests/harness-lifecycle.spec.ts` passes.
**Impact:** The default required test command is red even though the harness cleanup itself succeeds. The test treats an unrelated concurrent harness directory as a leak.
**Basis:** Ticket 01 requires `npm test` to pass and the lifecycle test must prove cleanup without depending on unrelated tests.
**Suggested fix:** Give the test an ownership marker or an isolated parent it can inspect, or serialize only this test with the other tests that allocate the same prefix; do not compare a global prefix directory across concurrently running projects.

### P1 — Refresh the scratch evidence to describe the delivered working tree

**Location:** `.scratch/active/test-system-overhaul/materials/03-round2-ablation.md:4`
**Evidence:** The material says the `HEAD`/worktree contains only one additional lifecycle spec and records all gates as passed. The actual working tree has 150 changed/untracked entries, includes the Client bench and Tool host changes, and the current `npm test` fails as described above. The continuation README likewise reports the full suite as passed.
**Impact:** A reviewer or acceptance owner can approve the current delivery using evidence from a different fixed point. The round-two ablation list and its verification scope do not cover the full uncommitted delivery now under review.
**Basis:** `.scratch/AGENTS.md` requires evidence to come from actual execution and implementation review to pin the delivery range; Ticket 05 requires the ablation record to identify its baseline and verification scope.
**Suggested fix:** Re-pin the material to the actual delivery range, state which changes were included, rerun affected checks, and record the current failed/unverified gates instead of reporting the old pass state.

### P2 — Put every real Host/Client harness spec in the integration project

**Location:** `vitest.config.ts:123-145`
**Evidence:** The config claims that integration covers `realHarness`, `mountTeamMemberHost`, and heavy `SlotTestRuntime`, but the unit project still runs helper-backed files such as `packages/agent-team/tests/attachments.spec.ts`, `member-reminder-ledger.spec.ts`, `worker-thread.spec.ts`, and `packages/client-agent-team/tests/team-inbox.client.spec.tsx`. In total, 27 Host/Ledger helper specs and 11 Client `runtimeWithTeam()` specs are absent from `integrationSpecs`; `npx vitest run --project unit packages/agent-team/tests/attachments.spec.ts` reports the file under `unit`.
**Impact:** These tests use the same expensive/shared harnesses while receiving the 5-second unit budget. They also remain part of `test:unit`, so the advertised fast feedback lane and the timeout classification will drift as scenarios grow.
**Basis:** Ticket 04 D5 explicitly assigns `realHarness`, `mountTeamMemberHost`, and heavy `SlotTestRuntime` to the 60-second integration project; the project comment makes the same contract.
**Suggested fix:** Build the project membership from the complete fixed classification list and move all helper-backed Host/Ledger and Client bench specs into `integration`, leaving only genuinely pure tests in `unit`.

## Acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Ticket 01 lifecycle registration, environment restoration, validation guard, and failure cleanup | Partial | Targeted lifecycle tests pass in isolation; the full suite fails because the new lifecycle test is not isolated from concurrent harnesses. |
| Ticket 01 top-level temp-dir and E2E cleanup changes | Met by inspection | `process.once('exit')`, `closeScenario()` `try/finally`, and `scenarioTempDir()` changes are present. |
| Ticket 02 surface harness removal and shared Host/Ledger/Worker helpers | Partial | `surface-harness.ts` is deleted and shared helpers exist; 12 low-level `new Context()` specs remain and the requested exception accounting is not documented. |
| Ticket 02 domain handles and duplication reduction | Not verified | Typecheck passed, but the prescribed test-only `jscpd` command analyzed zero files because `.jscpd.json` ignores `**/tests/**`; no comparable before/after metric was produced. |
| Ticket 03 typed Tool host and modular Client bench | Met by inspection | `tool-test-host.ts` and `tests/bench/` exist; the migrated specs use the shared host/call helpers and the compatibility export remains. |
| Ticket 03 automatic Client cleanup for all bench users | Met by inspection | `createClientBench()` registers one idempotent `onTestFinished` cleanup covering React cleanup, runtime disposal, storage clearing, and slot-crash checking. |
| Ticket 04 five project partition and timeout governance | Partial | `vi.setConfig` has zero matches and unit/integration projects run, but real harness users are still classified as unit; the default full suite is red. |
| Ticket 05 baseline inventory and 15+ fault injections | Partial | The material records 16 experiments, but its pinned delivery description is stale relative to the current working tree and does not establish coverage of the current Client/Tool bench changes. |
| Ticket 06 E2E staging, worker helper, and CI gates | Partial | Staging and CI changes are present; `npm run test:browser` could only complete build, then stopped because `/usr/bin/google-chrome` is absent, so the 26 scenarios and screenshot evidence remain unverified. |

## Checks run

| Command or check | Result |
| --- | --- |
| `npm test` | Failed: 207 passed, 1 failed, 1 skipped; failure is `harness-lifecycle.spec.ts` temp-dir assertion. |
| `npx vitest run --project unit` | Passed: 138 files, 2034 tests. |
| `npx vitest run --project integration` | Passed: 68 files, 598 tests. |
| `npx vitest run --project integration packages/agent-team/tests/harness-lifecycle.spec.ts` | Passed: 7 tests. |
| `npm run typecheck` | Passed. |
| `npm run check:docs` | Passed. |
| `npm run check:artifact` | Passed: 458 artifact files and 133 relative imports resolved. |
| `node scripts/audit-ui-parity.mjs` | Passed with 0 errors and 2 existing warnings. |
| `pnpm dlx oxlint@1.76.0 --disable-typescript-plugin packages scripts` | Exit 0 with warnings, including unused imports in changed files. |
| `npm run test:browser` | Failed before browser scenarios: `/usr/bin/google-chrome` does not exist; the build completed first. |
| `rg -n 'vi\\.setConfig' packages` | Passed: 0 matches. |
| `git diff --check` | Passed. |

## Unverified scope and residual risk

- Browser E2E interaction, screenshot evidence, and Harness checkout residue could not be verified on this machine because Chrome is unavailable.
- The repository's configured `jscpd` ignores test directories, so the Ticket 02 before/after clone claim remains unverified.
- The lint script itself could not run because `corepack` is not on PATH; the equivalent `pnpm dlx oxlint` command exited 0 but emitted warnings.

## Review record

- Spec sources: `.scratch/active/test-system-overhaul/README.md`, `spec.md`, and `issues/01` through `issues/06`.
- Standards sources: `AGENTS.md`, `.scratch/AGENTS.md`, `docs/development/start-and-checks.md`, and the `review-agent`/`scratch-review` procedures.
- Uncommitted and untracked changes included: yes; the review covered the complete working-tree diff and the untracked test helpers/bench files. The review report itself was created after inspection.
