---
name: scratch-review
description: Review and refine a converged .scratch design, or review its implementation and save an evidence-based report.
disable-model-invocation: true
---

# scratch-review

Review a work item at the stage the user asks about. Design review improves the existing design materials; implementation review examines a fixed code range and leaves a report. Both verify findings against evidence rather than preferences.

## 1. Resolve the target

Accept a work-item directory or one of its `issues/NN-<slug>.md` files, optionally with a base ref for implementation review:

```text
/scratch-review .scratch/active/<work>
/scratch-review .scratch/active/<work>/issues/02-<slug>.md --base main
```

Read the target's `README.md`, its design snapshot (`spec.md`, or `DESIGN.md` in older archives), and the selected ticket. For a work-item review, read all in-scope tickets and their status. Also read the work area's rules and the repository guidance applicable to the requested stage. Do not infer requirements from a branch name.

If the repository has no `.scratch` work area, or the user supplied only a diff or ref, perform the requested review in the conversation. Do not initialize `.scratch` or manufacture a work item just to store output.

## 2. Choose the procedure

The user's explicit request takes precedence over the work item's status. Otherwise, use the actual design and code state rather than relying on a status label alone.

- **Converged design before implementation:** follow [references/design-review.md](references/design-review.md). Review the chosen shape, evidence, risks, ticket information readiness, and verification, then write confirmed improvements back into the existing design materials. Do not create a review report. If the design has not converged, report that state and stop rather than inventing a spec.
- **Implementation or delivery:** follow [references/implementation-review.md](references/implementation-review.md). Review a coherent delivered set by default, check it against its spec and repository standards, run relevant checks, and save a report in the work item. Implementation review does not mark Human acceptance or close tickets.

If the user asks for both, refine the design first, then review the implementation against the revised spec. An ambiguous stage that would materially change the output requires a clarifying question.

Neither procedure modifies production code, checks off acceptance criteria, marks implementation work complete, or closes the work item.

## 3. Delegate deliberately

Use subagents, a workflow, or worker/helper delegation when independent investigation or review axes would benefit from parallel work. Give each worker a bounded assignment, the exact target and source locations, and a requirement to return evidence rather than general impressions. Keep workers read-only.

The lead reviewer verifies candidate findings, reconciles the results, and performs all permitted edits or writes the single report. Work sequentially when delegation is unavailable or the target is small; do not paste unverified worker reports together.
