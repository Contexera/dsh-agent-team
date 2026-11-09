# Implementation review

Review a change through the work item that explains why it exists. Check the implementation against its spec, correctness, repository standards, and unnecessary complexity; leave a report that a later session can act on.

This procedure is read-only except for its new review report. Do not modify implementation code, design materials, ticket status, acceptance checkboxes, or the work-item continuation README.

## 1. Pin the code range

The review must name the exact code it examined. Use the work item's acceptance criteria as the spec and its design snapshot for intent and boundaries. If the selected scope has neither a ticket nor explicit acceptance criteria, report the spec gap instead of inventing requirements.

- With a base ref, verify the ref, use `git diff <ref>...HEAD`, and record `git log <ref>..HEAD --oneline`. Also inspect uncommitted changes and untracked files separately.
- Without a base ref, review the working tree, including untracked files. If it is clean, ask which fixed point to compare against; do not silently choose a branch or commit.
- For a single ticket, use the tickets, commit list, and design to exclude unrelated changes. Record anything that could not be separated.
- Read the complete relevant diff and enough surrounding source to verify behavior. An empty or unresolvable range means an incomplete review, not a pass.

## 2. Review three axes

Run these as independent read-only sub-agent reviews in parallel or as an explicit workflow when the harness supports it; otherwise perform them sequentially. Workers and helpers can inspect one behavior, check one standard, or run a focused verification. Give each reviewer the exact range, relevant spec, and source locations. The lead reviewer aggregates and verifies their candidates rather than pasting their reports together.

### Spec

For every acceptance criterion, determine whether it is implemented, partial, missing, or not verifiable here. Report behavior outside the requested scope and requirements that appear implemented but behave incorrectly. Cite the ticket or design passage supporting each finding.

### Correctness

Trace concrete inputs and states through the changed code. Look for behavioral regressions, boundary and error-handling mistakes, security problems, and missing tests for important behavior. Report a failure scenario, not a vague concern. Run relevant existing checks to confirm or reject candidates.

### Standards and simplicity

Read the repository's documented standards that apply to the change. Cite the rule behind a standards finding; the repository overrides general style preferences. Skip what tooling already enforces.

Also look for code that can be removed without losing required behavior: hand-written standard-library functionality, unnecessary dependencies, unused flexibility, speculative abstractions, and avoidable duplication. State what replaces it, including "nothing" for dead code. Do not treat line count as a quality metric or suggest removing meaningful tests.

## 3. Verify

Run the repository's relevant existing tests and checks against real inputs where practical. Add targeted edge cases when needed, without modifying the implementation. Never claim a check passed without running it. Distinguish observed behavior from code inspection, and human-only acceptance from automated verification.

A failed check is not automatically a defect in this change: establish whether it predates the range before attributing it. Record unrelated failures as limitations.

## 4. Save the report

From the skill directory (the parent of `references/`), allocate the report with:

```bash
python3 scripts/start_review.py <work-item-or-ticket>
```

The script resolves a ticket to its work item and creates a new empty report under `reviews/`, numbered monotonically: `01-<scope>.md`, then `02-<scope>-recheck.md`, and so on. It refuses targets outside a `.scratch` work item and never overwrites an existing report.

Fill that new file using [assets/review-template.md](../assets/review-template.md). Use the repository's documentation language. Write only this report; never rewrite an earlier review to make history look clean.

The conclusion is one of:

- **Pass** — no confirmed finding requires a change. This does not erase listed unverified scope or residual risk.
- **Changes needed** — at least one confirmed finding requires a change.
- **Incomplete** — the spec, code range, or evidence needed for a meaningful review was unavailable.

Order findings by severity. Each finding needs a location, concrete impact or failure scenario, supporting spec or standard where applicable, verification evidence, and the smallest appropriate fix. Do not create tickets, apply fixes, mark acceptance complete, or close the work item unless the user asks afterward.

In the conversation, give the conclusion, material findings, checks actually run, and a link to the saved report.
