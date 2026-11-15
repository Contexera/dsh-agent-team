---
name: team-operations
description: The operating order for changing a Team — read, plan responsibility, confirm, write, report — with the nine manager tools, their partial-update and idempotency rules, failure and recovery handling, owner responsibility updates, Project archival, and the private-asset discipline. Read before establishing or adjusting responsibility, recovering a failed Member, archiving a Project, or continuing after a write that failed or returned an unknown result.
---

# Team operations

## Order of work

1. **Read.** `team_overview` first: Workspaces, Projects with their shared goal and owner responsibilities, Members with their participation and ownership, and the Worker switch. `truncated` means narrow or raise `limit`; an empty answer means an empty Team. `team_models` only when creating a Member or changing a route.
2. **Plan the least responsibility.** Reuse an existing Member before creating one; decide whether continuing judgment is needed at all; name the shared goal and each owner's responsibility. One-off work goes to an existing owner or a Worker.
3. **Confirm what is the Human's.** Creating a Member, granting ownership, archiving a Project, or changing in-flight work expands trust: ask with `ask_user_question` and show the plan. Reads, renames and typo fixes need no confirmation.
4. **Write in dependency order.** Members first and confirm activation, then the Project, then owner grants with responsibility. Every write takes a `requestId`; the same id and parameters answer the original receipt, and a changed parameter under a reused id is a collision.
5. **Report.** Refs, receipt, committed vs in effect, and the next step.

## The nine tools

| Tool | Use | Key rule |
| --- | --- | --- |
| `team_overview` | read the Team | bounded by `limit`; `truncated` means narrow; unknown ids refuse; a memberRef read adds only the private directory path |
| `team_models` | read routes | a failed provider is in `failures`, never an empty catalog; `memberPresets` is `team-member` |
| `member_create` | create one Member | handle, non-empty description, explicit route, Workspace; activation failure is still committed |
| `project_create` | create one Project | non-empty shared goal; only Members already active in that Workspace |
| `project_owner` | add / update / remove | `add` refuses an empty responsibility; `update` accepts one as `unspecified`; ≤2,000 characters; the grantee participates and is enabled or suspended |
| `project_update` | rename, restate, archive | `update` needs `name` or `description`; an empty name is refused, an empty goal clears it; `archive` takes refs alone |
| `member_update` | description, model, capabilities | partial; a blank description is refused; handle and preset are fixed; `capabilities` and `clearCapabilities` are exclusive |
| `member_state` | suspend, resume, archive, recover | `recover` is runtime-only, needs `workspaceId`, and writes no record |
| `member_workspace` | join, leave | a pure relation: the Session never moves; the creation Workspace cannot be left |

## Failure, retry and recovery

Three outcomes, never confused:

- **Not committed.** The refusal names its reason and wrote nothing. Fix the cause; use a new `requestId` only if the parameters changed.
- **Committed, not yet in effect.** Keep the receipt, ref and diagnostic; a Member whose activation or live apply failed is a committed fact, not a duplicate to recreate.
- **Unknown.** Read back with `team_overview`, or retry the same id and parameters. Never infer "not written" from an error.

No transaction spans steps: keep what succeeded and report its refs, continue only steps whose dependencies are met, and never delete a successful object as a rollback.

Recovery ladder: separate ledger state, live Agent state, model route and configuration; fix a route the catalog no longer offers with `member_update`, then `member_state recover` with the verifying Workspace; a `recover` that leaves the same diagnostic did not cure the cause, so fix the cause first and never loop recover. Report cause → changed configuration → recovery result → what still needs the Human.

[Failure classes and their next step](references/failure-recovery.md) lists the refusals and what each asks for.

## Responsibility updates and handoff

- `project_owner update` replaces the responsibility without withdrawing the grant, so the Member keeps its grant, its Main stream following and history; the new text is what `team_view`, the ownership context and `team_overview` read.
- `project_owner remove` ends the relation only: a Member that still participates keeps its Tasks, and open Tasks return to the Human only when ownership was its last participation.
- A handoff needs the shared goal, the responsibility, and a next context showing both plus the full owner list; the grant path carries it, so no DM or all-owner Thread is required. Report who answers for what and what the new owner should read first.

## Archival

- `project_update archive` releases active Claims, clears related Attention, stops and clears every subscription the Project owns, keeps the history, and returns open Tasks to the Human. A cleanup failure after the commit is a `cleanupWarning`; replaying the `requestId` retries it.
- `member_state archive` releases active Claims and clears Attention while private memory and the Session log stay on disk. No permanent removal exists; do not delete a Member's directory to simulate one.

## Models and capabilities

- Never name a route `team_models` did not list. A replacement route is checked only while the request is new, so a replay after the catalog moved still answers its original receipt.
- An omitted `capabilities` keeps the stored override; `clearCapabilities: true` restores the full surface. A configured allow-list is an intent, not proof of what is live: read `capabilityState` and `capabilityWarnings` from `team_overview`.
- `member_update` reports `effect`; a committed write whose apply failed is not an uncommitted rejection, and replaying the `requestId` retries the effect.

## Private assets

- Under `$DSH_HOME` touch only `agent-team/manager/` — your own `memory.md`, `notes/` and `skills/` — plus a Member's `memory.md`, `notes/` and `skills/` that `team_overview` confirmed by `memberRef`. Never the Host's sqlite files or Session logs.
- Organize a Member's private assets only when the Human asks for it now, only for that confirmed Member, and only within the request, following the Member's own memory and skill rules.
- Team state stays in the ledger and `team_overview`; keep `memory.md` a bounded index. Never use shell or file tools to bypass a tool's refusal.
