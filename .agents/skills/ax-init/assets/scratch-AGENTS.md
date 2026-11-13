# .scratch Work Rules

This subtree holds cross-session work items: design snapshots, research, delegable tickets, prototypes, reviews, and acceptance evidence. It is not an implementation or API authority — current behavior is defined by source and tests, and maintenance rules by the repository's maintained documentation. This file governs how to work here.

While a codebase does not yet exist, `.scratch/active/` is the primary authority for in-progress design. As source lands, code and tests take precedence over these notes.

## Work-item structure

Each `active/<work>/` has a short `README.md` as its continuation entry. It covers at least status, last-checked date, current frontier (who is doing what and what is blocked), completion conditions, and the maintained-document exit. It may add useful navigation, but it is not a decision history that workers must reconstruct.

```
active/<work>/
├── README.md      # continuation entry and default acceptance owner
├── spec.md        # current confirmed decisions — written when discussion converges
├── issues/        # delegable tickets, one file per ticket
│   ├── 01-<slug>.md
│   └── 02-<slug>.md
├── materials/     # research, raw evidence, examples, and rejected alternatives worth rereading
├── reviews/       # implementation review records; design review edits materials in place
└── validation/    # required Human or named acceptance evidence
```

Use `spec.md` for new work. Read `DESIGN.md` as the same kind of snapshot in older work items; do not rename archives merely to normalize them.

## Information and authority

- The spec states current decisions, reasons, boundaries, open questions, and verification seams. Move superseded choices into clearly labeled materials instead of leaving them as implicit instructions.
- Materials preserve decision-relevant raw excerpts, worked examples, counterexamples, research, and prototypes with their provenance. Synthesis does not authorize deleting evidence that gives a decision its meaning.
- For planned work, the spec and references explicitly named as binding by a ticket govern intent. Background material explains those decisions without silently expanding scope. Current source and tests still govern existing behavior.
- Classify every ticket reference as required/binding or background. Select the relevant sections rather than assigning the whole work-item history.
- When documents conflict or an unresolved decision changes the outcome, stop and report instead of choosing an interpretation silently.

## Ticket contract

Number `issues/NN-<slug>.md` from `01` in dependency order. Use this common skeleton for every deliverable type; omit a background line when there is none:

```markdown
# NN — title

**What to deliver:** the independently reviewable outcome this ticket delivers
**Blocked by:** ticket numbers, or "None — no ticket blockers"
**Status:** pending | ready | in-progress | review | complete
**Required context:** the work-item README and binding spec, material, and interface references
**Background:** optional evidence that informs but does not expand scope
**Boundaries:** included, excluded, and settled decisions that must not be reopened

- [ ] observable acceptance criterion 1
- [ ] observable acceptance criterion 2

**Evidence to return:** changes, checks and observed results, unverified scope, and deviations
```

- **One outcome:** a ticket is one dispatch and review unit. Split independent outcomes or incompatible verification setups; do not split implementation into schema/API/UI layers that cannot demonstrate anything alone.
- **Implementation slices:** code normally delivers a narrow end-to-end path through the affected layers. Research, review, content, and other work deliver a bounded answer or artifact with evidence suited to that work.
- **Closed reading set:** a fresh agent can start from the ticket and named references without discovering product decisions from the whole history. Stable paths and symbols are allowed with a baseline or an instruction to verify them. Decision-dense fragments may be inlined with their source; avoid brittle line-number-only references.
- **Observable acceptance:** each criterion states an outcome and a way to evaluate it. Use tests, cited sources, rendered artifacts, scenario evidence, or Human judgment as appropriate; one checkbox does not hide several independent outcomes.
- **Wide-refactor exception:** a repository-wide mechanical change may use expand–contract batches rather than an artificial end-to-end slice.

## Readiness and status

`ready` requires both dependency readiness and information readiness:

1. Every blocking ticket is complete.
2. The outcome and boundaries are clear, required decisions are settled, required reading and access are available, and acceptance can be evaluated with the named evidence.

Every ready ticket passes that checklist. For a ticket whose ambiguity, scope, or impact makes misunderstanding costly, a fresh-context agent first restates the outcome, boundaries, required reading, and verification without implementing. A question that exposes unsettled product intent returns the ticket to `pending`. Record the missing information or blocker instead of using `ready` as a draft state.

Status meanings:

- `pending`: a dependency or information gate remains.
- `ready`: both gates pass and work can start now.
- `in-progress`: execution is underway.
- `review`: execution has been delivered, but a stated review or acceptance gate remains.
- `complete`: every stated gate is satisfied. Do not encode waiting states in free-text suffixes.

## Delegation and evidence

The dispatcher gives a stateless worker the repository root, ticket, work-item README, named references, applicable repository rules and checks, and writable scope. The worker implements the selected contract rather than reopening settled decisions. It stops when documents conflict, necessary access or interfaces are absent, or progress requires a new Human decision.

The worker returns actual changes, commands and observed results, unverified scope, deviations, and questions requiring review. Verification claims must come from actual execution or inspection. A worker does not claim Human acceptance.

Keep verification proportional to the change: use the narrowest existing check that exercises the risk. Documentation-only edits normally need a diff review and the applicable existing documentation/link check, not new fixtures, criterion matrices, or cold-start rehearsals. Add those only when the changed behavior itself warrants them, and review a coherent delivered set instead of creating per-ticket ceremony by default.

The work-item README names the default acceptance owner. A ticket adds any independent-review or Human-acceptance gate it needs. Review a coherent delivered ticket set or work item by default; use an earlier per-ticket gate only when its risk or sequencing requires one. Implementation review compares a pinned delivery range with the ticket, spec, correctness requirements, and repository standards. Required Human or named acceptance evidence belongs in `validation/`; review records belong in `reviews/`. The acceptance owner marks `complete` only after all stated gates are satisfied. After a batched review, the lead returns any ticket with an unmet in-scope gate to `in-progress`; a defect in the delivered contract does not require a replacement ticket. Delivery logs and later amendments do not overwrite the original ticket contract; record them separately.

## Lifecycle

- **Closing a work item:** complete or explicitly cancel unfinished tickets → satisfy required review and acceptance gates → move durable conclusions to their maintained owners → update `.scratch/README.md`'s archive index → remove only transient material without provenance value → move into `archive/YYYY-MM/`.
- **Archive is history:** archived states and terminology represent their time and never override current implementation. Do not rewrite archives to match new code or new Meta rules.
- **Transient artifacts:** logs, debug output, and downloads go in `local/` or the repository's ignored artifact location, never into active or archive. Keep only curated evidence with provenance value in the work record.

## Version control

- `active/` and `local/` stay ignored by default. An explicitly requested review snapshot may be force-added, but it remains working material rather than a durable authority.
- Clean and archive a closed work record before committing it. Normally amend the archive move into the commit that delivers the work so the record lands with the change it explains.
- Links from maintained documents target maintained files or curated archives, not unstable active paths.

## Local conventions

Repository-specific additions live in this section. `ax-init` preserves this section during an upgrade and reports its differences from the generic core rather than silently overwriting them.

## Directory index

See [README.md](README.md).
