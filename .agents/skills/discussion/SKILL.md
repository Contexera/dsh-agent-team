---
name: discussion
description: Open a structured multi-round discussion that converges - research, explore options, decide together - and persist it as a .scratch work item ending in DESIGN.md and tracer-bullet tickets. For topics too big or contested for a one-shot chat answer.
disable-model-invocation: true
---

# Discussion

A conductor for converging work: a topic that needs multiple rounds — research, exploring alternatives, decisions — and deserves persistence as a `.scratch/active/<work>/` work item instead of chat that evaporates at compaction.

The flow internalizes to-spec and to-tickets for the local `.scratch` world: the discussion is the interview; its durable output is the work item's `DESIGN.md` and, once the shape is agreed, its `issues/` tickets — all under the repo's own `.scratch/AGENTS.md` rules, which own the structures and stay the single source for them.

## 1. Gate

Discussion-worthy means: multiple rounds needed, real decisions to make, and the outcome will be built or referenced later. A question with a one-pass answer gets answered, not a work item.

## 2. Open the work item

Follow `.scratch/AGENTS.md`: `active/<work>/` with the five-item `README.md` (status, last-checked date, current frontier, completion conditions, formal-doc exit) and a `materials/` directory. Work in the conversation; persist what matters as it crystallizes, not at the end.

If the repository has no `.scratch` work area, offer to run ax-init first. Without one, keep the discussion in-conversation and say that nothing is being persisted.

## 3. Research

Pull in facts with the `research` skill — primary sources, each claim cited, findings saved into `materials/`. Facts are the agent's job: never ask the user for something that can be looked up.

## 4. Discuss in rounds

Run the questioning with the `grilling` discipline: map the topic as a design tree, work it in frontier rounds, numbered questions each carrying a recommended answer; one round, then wait. Settled answers reshape the tree and unlock the next frontier. The questioning is done when the frontier is empty — nothing left silently assumed.

## 5. Converge

Synthesize — do not transcript. `DESIGN.md` holds: the problem in the user's terms, the chosen shape, key decisions with their reasons, the agreed testing seams, and open questions. No file paths or code snippets (they go stale); the exception is decision-dense fragments (state machines, type shapes) inlined with their source noted.

## 6. Ticket

When the shape is agreed, break the work into tracer-bullet tickets per `.scratch/AGENTS.md` (vertical slices, blocking edges, frontier; wide refactors as expand–contract). Present the breakdown — title, blocked-by, what it delivers — and settle granularity with the user before writing any ticket file.

## 7. Keep the entry alive

Update the README's five items as the frontier moves; set last-checked at the start of each session that touches the item. Implementation proceeds per ticket (tdd at the agreed seams).

Before closing a work item with code changes, offer `/scratch-review <work-item>` to review the implementation against its design and tickets and save the report under `reviews/`. Resolve confirmed findings first; human acceptance evidence belongs separately under `validation/`. Closing follows the `.scratch/AGENTS.md` lifecycle — durable conclusions graduate into maintained docs, the item archives.

## 8. Cost and attention management

Manage token consumption and team noise through active attention control:

- **Proactive Unfollowing**: Unfollow the thread when your contribution is finished or the topic evolves outside your area of expertise. This stops redundant message delivery and prevents unnecessary awakening costs.
- **Token Awareness**: At task boundaries or when context usage feels high, check token usage via `context_status` (or `context_timeline`). Monitor usage against the handoff budget and hard limit.
- **Context Maintenance**: Use `context_compact` to summarize history in place or `context_rollover` to hand off to a fresh generation when nearing the handoff budget or after completing a major milestone (like a `DESIGN.md`).
- **Stay Slim**: Prefer unfollowing a thread over remaining an idle follower. Direct summons (@-mentions) and responsibility signals (assignments, reviews) will still reach you even when you are not following regular updates.
