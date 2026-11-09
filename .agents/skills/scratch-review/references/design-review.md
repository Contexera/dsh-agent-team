# Design review

Review and refine a converged design before implementation. The output is a more coherent and verifiable version of the existing work item, not a separate review document.

## 1. Establish the facts and decision authority

Read the current `.scratch` rules, the work item's `README.md`, `spec.md`, all affected tickets, and the existing materials that support the chosen design. Use current source and tests for behavior, maintained documentation for repository standards, and the matching upstream source and documentation for external capabilities. Record the versions or commits used in the final response when they matter to a conclusion. If the work item has no design snapshot, or its core decisions are still open, report that the design has not converged and stop; do not write a spec from scratch.

Distinguish explicit Human decisions, rejected alternatives, derived design details, assumptions, and open questions. Do not silently reopen a settled product decision. New source evidence can expose a conflict with that decision; make the conflict concrete and leave the genuinely new choice to the Human.

For a substantial review, use a workflow or parallel subagents for independent tracks such as document consistency, architecture evidence, and failure or permission analysis. Workers and helpers can answer narrow source questions or trace one scenario. Give them exact documents, source locations, and versions; the lead reviewer verifies their evidence and makes all edits. A small review can proceed sequentially.

## 2. Review the design

Cover every selected behavior and open question in the spec. Findings need a concrete consequence and supporting document, source, test, or experiment; a preference for another design is not enough.

### Problem and decision closure

- Trace the chosen shape back to the original user problem and an end-to-end scenario.
- Check first-version scope, explicit non-goals, and whether an unresolved question could change the chosen shape or make a ticket unstartable.
- Identify superseded decisions that still influence later text, conflicting terminology, and places where the README, spec, and tickets describe different behavior.

### Architecture and evidence

- Check ownership and authority against current code: reuse existing operations and state, avoid parallel stores and rules, and preserve plugin, preset, Host, Client, and ordinary-session boundaries that apply.
- Verify that assumed public interfaces exist at the pinned versions and support the required lifecycle. Distinguish verified facts, reasoned assumptions, and unknowns.
- Treat an unknown as blocking only when its answer could change the design or make the next ticket impossible to start. Record lesser validation explicitly instead of disguising it as a settled fact.
- Challenge unnecessary entities, compatibility layers, duplicate mechanisms, and speculative flexibility with a simpler replacement that preserves the selected behavior.

### Behavior, interfaces, and risk

- Trace creation, update, recovery, replacement, restart, archival, and revocation where relevant. Define observable ordering for concurrent actions and the boundary between saved state and applied state.
- Trace partial failure, retry, idempotency, stale references, and recovery across a whole user workflow, not only one operation.
- Check caller-visible inputs, outputs, configuration scope, bounded results, refusal and error semantics, and whether the caller can recover.
- Check authorization at the enforcing layer, direct and indirect invocation, privilege expansion, confirmation requirements, audit identity, prompt injection, and old sessions or credentials. Separate hard guarantees from model behavior and accepted residual risk.
- Include user-visible empty, loading, missing, failure, keyboard, and responsive states when they are part of the design.

### Tickets and verification

- Map every selected behavior to a ticket and observable acceptance criterion; identify ticket text that silently narrows or changes the spec.
- Keep each ticket a complete, independently verifiable user path unless the work area documents an exception. Correct dependency edges and the ready frontier.
- Cover important failure and boundary cases, real integrations, and affected documentation. Distinguish deterministic tests from non-deterministic model behavior and human acceptance.
- Ensure the testing seams exercise the same public behavior as callers rather than implementation details.

## 3. Revise the existing materials

Write confirmed improvements directly into the existing `spec.md`, affected files under `issues/`, and the continuation `README.md`; correct an existing file under `materials/` when its evidence is wrong or incomplete. Do not create a review report, a parallel design summary, or a `reviews/` directory for this procedure.

Keep the spec focused on selected behavior, reasons, boundaries, and testing seams. Make tickets self-contained and their acceptance criteria observable. Update the README's status, last-checked date, current frontier, completion conditions, and formal-document exit when the revisions affect them. Adjust `ready` and `pending` only when blockers or unresolved design questions change whether work can start; leave implementation progress and acceptance checkboxes alone.

When a finding requires a genuine Human product decision, record the precise conflict and decision needed in the existing spec or README, keep affected tickets from appearing startable, and apply every other revision that already follows from confirmed decisions.

Archived work items are history. Do not rewrite them; provide design findings and suggested revisions in the conversation instead.

## 4. Verify completion

Reread the final design materials. Every confirmed finding must either be resolved in those materials or remain as an explicit Human decision with its affected scope. Every selected behavior must have a ticket and acceptance path, every ticket must agree with the spec, and the README must describe the resulting frontier. Check links and run applicable documentation checks when available; never claim a check passed without running it.

In the conversation, summarize the material design changes, the source or experiments checked, any checks run, and the remaining Human decisions. Do not allocate or link a review report.
