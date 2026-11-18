# 01 — Give the manager scoped Session evidence and better judgment support

**What to deliver:** One installed-manager path from a known Member to bounded canonical Session evidence, with aligned persona/skills and open, evidence-driven management examples.
**Blocked by:** None — no ticket blockers
**Status:** complete
**Required context:** `../README.md`, `../spec.md`; root `AGENTS.md`, `docs/README.md`, applicable `docs/AGENTS.md`; current manager persona in `cordis.patch.yml`; all five manager skills and their references; `scripts/session-trace.ts` and its test; manager overview Host/tool/type code and read/render tests; package shipping contract.
**Background:** Source discussion `thread:4434d3fd-8ae1-4a41-b282-3238e8c210e8`; previous accepted manager context work does not authorize Session inspection until the Human's current expansion. Baseline `161aeb1`; verify current HEAD and shared tree before edits.
**Boundaries:** Follow spec. Do not alter the current Team, add manager Team tools or collaboration writes, modify Harness, read Host SQLite, publish, or restart the live GUI. Do not blindly ship the old development locator. Announce any necessary scope conflict before implementation.

- [x] The installed manager receives authoritative, unambiguous Session evidence locators for the Member it selects, and has a runnable, bounded canonical reader without repository-only assumptions.
- [x] The reader performs no writes, does not scan unrelated Sessions, and reports incomplete/missing evidence honestly; actual-format fixtures and read-only snapshots demonstrate the selected contract.
- [x] Prompt, all affected skills/references, tools and maintained documentation agree on Session reading, privacy, history versus authority, and absent collaboration permissions.
- [x] Judgment guidance supports multiple justified organizational outcomes and avoids repeated confirmation of explicit current authorization; concrete examples do not contradict the main guide.
- [x] Relevant checks, installed-artifact execution and any required assembled browser checks pass; limits of real-model behavioral verification are stated.

**Evidence to return:** pinned commit range, concise implementation/locator decision, actual checks/results, any remaining limitations, and exact changed paths. Stage only owned paths. Do not commit `.scratch/active/`; Reeve archives after independent acceptance.

## Round 2 — corrections for the first review

Review: [01-independent-review.md](../reviews/01-independent-review.md), findings returned at sequence 31074. All four production/documentation groups are addressed in `464a731`; independent packed-artifact behavior is green. The remaining test-quality follow-up is closed by `1458cb3`: its nine oversized escaped events genuinely discriminate the original multi-event failure. Reeve accepted Task #161 after the final 43-test focused run.

1. **The answer is the printed JSON.** `window` now measures the text it prints — wrapper included — and reports that size as `budget.outputCharacters`; the pre-escape count that under-reported by more than a factor of two is gone. A cut event carries `dataSegment` (`offset`, `nextOffset`, `totalCharacters`, `remaining`) and `--offset` continues it until `remaining` is 0, so the whole event is reachable through the script and the manager never opens the log to finish reading one. `index` obeys the same cap by dropping rows from the oldest end and naming how many are missing. Tests cover backslashes and quotes, multi-byte text, several events at once, and reassembly of the segments into the original JSON.
2. **Failures are classified, not caught and swallowed.** Mount, stat, open, read and close share one path: a missing or unusable storage root answers `kind: missing`/`io` with exit 2, and the fiber is disposed on every exit. A `--log` that no longer names this Session's artifact is refused with exit 1 and `kind: mismatch` **before any event body is returned**, and the refusal tells the caller to re-read `team_overview`. Neither failure is ever answered as an empty log.
3. **The prompt no longer contradicts itself.** The skill stops sending the manager to `team_task board` (it holds no such tool) and points at the overview summary and the Member rows instead; the Session log is described as a record of model inputs and tool activity, not as the only record; the locator is stated to cover that one Session id, so an older generation is not silently implied. The handoff reference applies the once-rule to its own `ask_user_question` sentence and forbids inventing a Member for a single acceptance rather than forbidding continuing quality responsibility.
4. **The tool count is nine everywhere.** `packages/agent-team/README{,.zh}.md` now says nine manager tools, two reads and seven writes, and the tool package README no longer claims a `memberRef` read adds only the private directory path.

Budget: the script is not prompt text. `check:core-skills` counts `.md` only and reports the shipped script in its summary line; the corrections cost no authorization or responsibility qualifier.

## Round 3 — the budget test must exercise the defect

Reeve's second review closed the reader behaviour but found the regression test non-discriminating: the case titled "nine long messages" ran against a fixture with one long message and eight small events, so it could not reproduce the multi-event double-escape overflow.

`1458cb3` replaces it with a dedicated fixture (`session:long-messages`): nine assistant messages, each `C:\path\"quoted"\n ` repeated 200 times plus multi-byte text, in one turn of nine steps (29 events). The window `--seq 14 --before 12 --after 12` spans seq 2–26, so nine long events compete for the budget at once.

Measured against the pre-fix reader on that fixture: it printed **51,560** characters while reporting `usedCharacters` 28,304, kept 23 events and returned `dataPreview` with no continuation. The corrected reader prints **31,946**, reports `outputCharacters` 31,946, keeps 9, omits 16, keeps the target and returns four segments. Three assertions in the test fail on the old code — printed size, reported size equals printed size, and more than one segment — so the case discriminates rather than passing by luck.
