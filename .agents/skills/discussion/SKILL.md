---
name: discussion
description: Open a structured multi-round discussion that converges - research, explore options, decide together - and persist it as a .scratch work item ending in spec.md and information-ready tickets. For topics too big or contested for a one-shot chat answer.
disable-model-invocation: true
---

# Discussion

A conductor for converging work: a topic that needs multiple rounds — research, exploring alternatives, decisions — and deserves persistence as a `.scratch/active/<work>/` work item instead of chat that evaporates at compaction.

The discussion is the interview. Its durable output is a current `spec.md`, the evidence needed to understand it, and, once the shape is agreed, `issues/` tickets. The repository's `.scratch/AGENTS.md` owns artifact structure, ticket contracts, readiness, delegation, and lifecycle; this skill owns the converging conversation and its handoffs. `DESIGN.md` is a legacy snapshot name, not a second output.

## 1. Gate

Discussion-worthy means: multiple rounds needed, real decisions to make, and the outcome will be built or referenced later. A question with a one-pass answer gets answered, not a work item.

## 2. Open the work item

Follow `.scratch/AGENTS.md`: `active/<work>/` with its continuation README and a `materials/` directory. Name the default acceptance owner. Work in the conversation; persist what matters as it crystallizes, not at the end.

If the repository has no `.scratch` work area, offer to run ax-init first. Without one, keep the discussion in-conversation and say that nothing is being persisted.

## 3. Research

Pull in facts with the `research` skill — primary sources, each claim cited, findings saved into `materials/`. Facts are the agent's job: never ask the user for something that can be looked up.

## 4. Discuss and preserve evidence

Run the questioning with the `grilling` discipline: map the topic as a design tree, work it in frontier rounds, numbered questions each carrying a recommended answer; one round, then wait. Settled answers reshape the tree and unlock the next frontier. The questioning is done when the frontier is empty — nothing left silently assumed.

Keep decision-relevant raw excerpts, worked examples, counterexamples, rejected alternatives, and their provenance in `materials/` as the discussion moves. Mark whether each material is current evidence or history. Do not wait for the final summary to rescue meaning from a long transcript.

## 5. Converge

Synthesize — do not transcript, and do not discard the evidence behind the synthesis. `spec.md` holds the problem in the user's terms, the chosen shape, current decisions with their reasons and source links, explicit boundaries and non-goals, agreed verification seams, and open questions. Move superseded choices out of the current contract or label them as history.

The README routes to the spec and materials and tracks the frontier; it does not become a decision log that a worker must reconstruct. Stable paths, symbols, and decision-dense fragments may be retained with provenance and verification instructions under the repository's scratch rules.

Done means every remaining open question is either non-blocking and explicitly deferred, or prevents the affected tickets from becoming ready.

## 6. Ticket and establish readiness

When the shape is agreed, propose the breakdown — title, blocked-by, and what each ticket delivers — and settle granularity with the user before writing ticket files.

Follow the repository's generic ticket contract. For each ticket:

- Name one independently reviewable outcome and the evidence suited to its deliverable type.
- Point to exact required/binding sections and separate background reading. Do not assign the whole history or compress away examples that define an abstract requirement.
- State boundaries, settled decisions that must not be reopened, acceptance, and evidence to return.
- Leave tickets with unfinished blockers or missing decisions, access, references, or verification as `pending`, with the gap recorded.

Before marking a ticket `ready`, check both dependency and information readiness. For substantial, ambiguous, or high-impact tickets, recommend `/scratch-review <work-item>` for design review and use a fresh-context rehearsal: the fresh agent restates outcome, boundaries, required reading, and verification without implementing. A settled-product question means the ticket is not ready.

## 7. Deliver, review, and close

Update the README's status, last-checked date, frontier, completion conditions, and maintained-document exit as work moves.

Dispatch each ready ticket with the repository root, work-item README, its named reading packet, applicable repository rules/checks, and writable scope. For code, use `tdd` at the seams already confirmed in the spec; other deliverables use their agreed verification. Workers return changes, observed check results, unverified scope, deviations, and questions rather than claiming Human acceptance.

After a coherent ticket set or the work item has been delivered, offer `/scratch-review <work-item>` for implementation review; use an earlier per-ticket review only when its stated risk gate requires one. Resolve confirmed findings, then collect any required Human acceptance under `validation/`.

Closing follows `.scratch/AGENTS.md`: the acceptance owner completes the tickets, durable conclusions graduate into maintained documents, the archive index is updated, and the work item archives. Do not rewrite older archives to match the new workflow.
