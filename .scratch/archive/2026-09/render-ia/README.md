# Team tools render information architecture

**Status:** Both implementation tickets complete (2026-09-08); cumulative delivery `440624f` reviewed by Reeve with verdict 不通过 — six blockers. Tars's focused follow-up commit `d9611e56` addressed them and landed; archived without a recorded final delta re-review or Cole's simplification pass.
**Last checked:** 2026-09-08.

## Current frontier

- Tars is landing the focused follow-up for Reeve's six blockers: (1) the token story unified to its two legal surfaces across descriptions, READMEs, validation errors, the preset workflow clause, and tests; (2) claim mutations/rejections restore the real structured `status`/`claims` via the post-mutation list (render still shows the affected Claim only); (3) `member_not_following.revision` passthrough restored plus an execute-level regression assertion; (4) `team-thread-render.spec.ts` deduped onto the shared render-text helper; (5) bilingual docs' Active-Claims row wording matches the rendered template; (6) raw trace artifacts (`analyze-trace.mjs`, `trace-analysis.json`, `inspect-oversized.mjs`) deleted — they persisted raw chat bodies; durable conclusions live in `materials/cole-trace-audit.md`.

- Tars completed `issues/01-discover-and-read-current-thread.md` and `issues/02-mutate-and-align-model-contract.md`: address-book `team_view` (Threads sole catalog, newest-first, bounded subject, inline Task standing, Thread-only cursor), inbox header/two-counts/truncation conclusions, five-action `team_thread` renders with the A/B/C orientation discriminator and zero-unread-only next-write token, message/claim outcome-first renders (committed verbs, affected-Claim-first, shared rejection formatter with no numeric revision), `baseRevision` parameter descriptions, preset workflow normalization, package READMEs, bilingual collaboration docs, and CHANGELOG `[Unreleased]`.
- Verification on the final state: `npm run build` clean; `npm test` 435 passed / 1 skipped (includes the 79-test lifecycle suite and generate:typert, with no diff in generated artifacts); `npm run typecheck` clean; `npm run lint` clean (0 warnings, 0 errors).
- One deliberate deviation flagged for review: the inbox truncated-empty state renders `Inbox — N unread update(s) on Threads beyond this bounded list — call again with a larger limit.` instead of the header-only shape in `materials/expected-results.md` — more informative at zero extra cost.
- Next: Reeve's unified technical review of the cumulative change, then Cole's final simplification pass. The formal-document exit (archive under `.scratch/archive/2026-09/`) happens only after that review accepts the work.

## Verified starting point

- All five model-facing Team tool renders live in `packages/tool-agent-team/src/index.ts`; their structured results are richer than what the model sees, because the rendered text is the model-facing result channel.
- `team_view` currently combines three different discovery questions—where work lives, which Threads exist, and whom to contact—into one flat result.
- The current no-argument `team_view` is not one coherent snapshot: Thread rows come from the earliest selected top-level anchors, while the separate Task rows come from the complete current Task projection. The same taskful Thread is indexed twice with different selection semantics.
- Every `team_view` call also repeats the visible roster with full Member descriptions. Thread rows expose no anchor text or other subject, so a ref/status-only row does not explain what the work is about.
- Real traces show `team_thread` is the dominant collaboration read path. `team_message` and `team_claim` regularly return normal concurrency rejections (`unread_required`, `stale_revision`), so rejection results are primary interface paths rather than exceptional copy.
- One exact Reeve trace demonstrates the current `team_view` shape; Cole's extracted trace report gives broader cross-Member call and rejection samples. Do not use result size as the design criterion: the issue is whether information is coherent, non-duplicative, and sufficient for the next correct action.

## Completion conditions

- [x] State the primary caller intent and legal next actions for every action of `team_view`, `team_inbox`, `team_thread`, `team_message`, and `team_claim`.
- [x] Build a failure-mode catalogue from real traces: missing/incorrect refs, stale or unread-gated writes, ambiguous success, repeated state, temporal mixing, and misleading empty/continuation states.
- [x] Compare at least two substantially different interface designs, including their ordering, invariants, error modes, and migration implications.
- [x] Record one explicit decision table: default facts, action-specific facts, facts available through a deeper read, and facts that must never be omitted from the action that needs them.
- [x] Obtain Human agreement on the design before implementation starts.
- [x] Turn the chosen design into self-contained vertical implementation tickets with discriminating model-visible tests.
- [x] Validate the implemented behavior against representative traces and the full affected contract suite.

## Formal-document exit

When implementation is accepted, move durable behavior into the bilingual `docs/team-collaboration.*` and `packages/tool-agent-team/README*` contracts, update `CHANGELOG.md` for the model-visible behavior change, delete transient analysis with no provenance value, and archive this work item under `.scratch/archive/2026-09/`.

## Delivery and research map

- [`spec.md`](spec.md) — Human-approved implementation contract.
- [`issues/01-discover-and-read-current-thread.md`](issues/01-discover-and-read-current-thread.md) — first vertical ticket: directory, Inbox, and action-specific Thread reads.
- [`issues/02-mutate-and-align-model-contract.md`](issues/02-mutate-and-align-model-contract.md) — second vertical ticket: mutation outcomes and complete prompt/document alignment.
- [`materials/recommended-design.md`](materials/recommended-design.md) — supporting rationale and earlier review contract, now superseded by `spec.md` for implementation.
- [`materials/expected-results.md`](materials/expected-results.md) — approved focused before/after examples, including the first-principles revision-exposure answer.
- [`materials/reeve-first-principles.md`](materials/reeve-first-principles.md) — Reeve's independent intent and failure-mode audit plus candidate interface families.
- [`materials/cole-trace-audit.md`](materials/cole-trace-audit.md) — Cole's independent simplification/repetition audit and trace-backed challenges.
- [`materials/interface-options.md`](materials/interface-options.md) — earlier explicit-scope versus progressive alternatives; retained as comparison evidence, with its recommendation superseded.
- Raw trace artifacts (`analyze-trace.mjs`, `trace-analysis.json`, `inspect-oversized.mjs`) were deleted per the review data-hygiene blocker: they persisted raw chat bodies from real session logs, against the `.scratch` transient-artifact rule. The durable aggregates survive in `materials/cole-trace-audit.md`.
