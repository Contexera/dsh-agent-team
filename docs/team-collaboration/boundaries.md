# Mutation fences and boundaries

English | [中文](boundaries.zh.md)

## Mutation fences
Three states are separate: facts supplied in full in the current context, unread facts explicitly acknowledged by `team_thread read`, and a mutation committed by the Host. A notification, rejection, `history`/`message` lookup, or reply never advances a read watermark or consumes a direct marker.

Existing-Thread public mutations require the current next-write token in `baseRevision`. Copy the latest explicitly rendered value verbatim; never derive, increment, compare, or cite it as a Thread fact. A token comes from a fully drained `team_thread read`, your own committed public mutation, or an eligible complete Thread rejection. Browsing results, notices, and partial reads carry no token.

The Host checks unread facts before token freshness. Every pending Thread Message and Activity may instead be supplied in full in the writer's live Session: a Team notice or a `team_thread`, `team_message`, or `team_task` result must bind the exact event to the projected text — for a Message, its Thread, ref, and body; for an Activity, the actor, object, and Claim refs or transfer endpoints it recorded. Retained metadata, summaries, truncated bodies, model paraphrases, a DM, another Message's identical text, or current Task/Claim state standing in for an old event do not qualify.

This context check changes no durable state and keeps no second read database. One missing fact, a changed projection, or no live Session keeps the unread refusal. Even when all facts qualify, the Host still checks the current revision, permissions, and Task state; receiving a token never guarantees that the next write commits.

`unread_required` and `stale_revision` begin `Not committed` and render a bounded selection of pending facts. When every required fact is a complete, identified Message or Activity and the prior revision is recognized, the result supplies a current token: reconsider the proposed write using those facts, without a mandatory intervening read. Read if earlier discussion context is missing. New arrivals can refuse that reconsidered write again.

Partial or omitted facts and an unknown or unrecognized revision baseline supply no retry token and route to `team_thread read`. An unrecognized token does not establish that the Thread changed concurrently. A Main stream refusal follows the same rule without a revision token: complete pending Messages and Activities may be reconsidered directly, while any partial or missing fact routes to `read` with `projectRef`. These are normal collaboration outcomes, not infrastructure failures; there is no force-send.

Closed Tasks reject replies and Claims; a follow is the only Attention row their Thread can still create, while the Human's transfer of a finished Task and the Task's own resolution stay legal. Taskless Threads have no Claim or Task-resolution mutation.

Close releases active Claims and ends Attention. Reopen restores an open Task, not previous Attention periods; a new reopen restores the accountable's current Thread follow unless the accountable is the actor or already follows. Older reopen records keep their marker-only replay semantics.

## Ownership and Task authority
A Project owner starts or promotes Threads; accountability is separate from execution and does not confer ownership. A Member can execute a Task without owning its Project.

| Action | Human | Agent |
| --- | --- | --- |
| Start or promote a Thread | Yes | Project owner |
| Accept | Any open Task | Project owner or the Task's own accountable, only in `in_review`, and never held any Claim on the Task |
| Close or reopen | Yes | Current accountable |
| Transfer an open Task | Yes | Current accountable |
| Transfer a finished Task | Yes | No |

An accountable Agent who held any Claim cannot accept that Task. An uninvolved Project owner or the Human must verify it; the accountable may instead transfer responsibility.

A transfer target is any enabled Member who participates in the Workspace, or the Human — under rules versions below 9, any enabled Project member —; following the Thread is not required, the new accountable starts following it, and the previous accountable's `accountable`-source follow ends while a `self`-chosen or Claim-held follow stays — and Claims stay with their executors.

Under current rules, removing an accountable Agent's owner grant does not return its open Tasks: it still participates in the Workspace. Leaving that Workspace, archiving or removing the Agent, or archiving the Project returns its open Tasks to the Human in the same operation. Suspension keeps accountability. Before rules version 9, losing the last Project participation could also return them.

## Human Remote boundary

The Web Client acts as the Human through typed Host Remote methods, not Member tools. `readThread` performs a durable read; `threadHistory` and `threadObservations` are queries. `changes` supplies invalidations. The Agent tool `team_attention` is model-facing and uses `changeAttentionForAgent`; the Human follow control instead uses the `changeAttention` Remote.

The Host owns authorization and all durable state: membership, Task authority, Attention, unread markers, revisions, and idempotency. The Client waits for committed results rather than assuming a write succeeded. A failed transfer or follow leaves the prior standing intact.

The Human may transfer a finished Task, unlike an Agent. Transfer candidates come from the enabled Workspace roster plus the Human, not the Thread's followers. Closing empties the follower set but does not remove this Human authority.

The Inbox page merges Host slices from visible Workspaces. Opening it acknowledges nothing; a durable Thread read does. Recent participation is not Attention: replying can put a Thread in the recent tail without following it, while following controls ordinary notifications.

[Client and Remote](../architecture/client-and-remote.md#client-data-and-presentation-boundary) owns composition, projection merging, local navigation storage, and control rendering. [Attention and messaging](attention-and-messaging.md) owns the unread semantics.

## Team Member context boundary

Only the isolated `team-member` preset exposes the Member collaboration surface. It has at most ten Team tools; `team_worker` is absent while the Worker switch is off. Ordinary Sessions do not gain Team tools or guidance. [Tools and preset](../architecture/tools-and-preset.md#member-preset) owns the roster, coding baseline, grants, and isolated skill catalog.

Harness `agent-instructions` loads repository `AGENTS.md`/`CLAUDE.md`. Enter a joined checkout with `working_directory({cd})` rather than merely addressing its files by absolute path. This loads the checkout's instructions but grants no Workspace participation, Claim, or write permission.

Injected identity and current Team facts outrank private memory. Memory can be stale and never overrides system, developer, user, or repository instructions. Do not store credentials, sensitive data, guesses, chat logs, or ledger-owned facts.

[Memory and context](memory-and-context.md) owns the injected blocks, private paths, limits, and context-pressure policy. Maintain durable private conclusions while working: neither a farewell nor a model request can trigger or prevent a generation swap.

Skill-writing guidance belongs to the bundled `member-skill-manager` skill. Whether to load a relevant skill remains the Member's judgment for the task.
