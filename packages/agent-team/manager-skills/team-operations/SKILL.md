---
name: team-operations
description: The operating order for changing a Team — read, plan, confirm, write, report — with the nine manager tools, their partial-update and idempotency rules, failure and recovery handling, event-loop routing, owner responsibility updates, Project archival, and the private-asset discipline. Read before establishing or adjusting responsibility, recovering a failed Member, archiving a Project, or continuing after a write that failed or returned an unknown result.
---

# Team operations

## Order of work

1. **Read.** `team_overview` first: Workspaces, Projects with their shared goal and owner responsibilities, Members with their participation and ownership, and the Worker switch. `truncated` means narrow or raise `limit`; empty means an empty Team. `team_models` only for a new Member or route.
2. **Plan the least responsibility.** Reuse an existing Member before creating one; decide whether continuing judgment is needed at all; name the shared goal and each owner's responsibility. One-off work goes to an existing owner or a Worker.
3. **Confirm what is the Human's — once.** Creating a Member, granting ownership, archiving a Project, or changing in-flight work expands trust: ask with `ask_user_question` and show the plan. Reads, renames and typo fixes need no confirmation, and neither does what the current request already authorizes explicitly; ask again only when the request is silent on that exact act or a new fact changes what it authorizes.
4. **Write in dependency order.** Members first and confirm activation, then the Project, then owner grants with responsibility. Every write takes a `requestId`; the same id and parameters answer the original receipt, a changed parameter under a reused id is a collision.
5. **Report.** Refs, receipt, committed vs in effect, and the next step.

## The nine tools

| Tool | Use | Key rule |
| --- | --- | --- |
| `team_overview` | read the Team | `limit` 1–100; `truncated` means narrow; a capability warning means the stored name is ignored at runtime |
| `team_models` | read routes | a failed provider is `failures`, not an empty catalog |
| `member_create` | create one Member | activation failure is still committed |
| `project_create` | create one Project | only active Members join |
| `project_owner` | add / update / remove | `add` needs responsibility; `update` accepts `unspecified`; ≤2,000 |
| `project_update` | rename, restate, archive | empty name refused; empty goal clears |
| `member_update` | description, model, capabilities | partial; handle and preset fixed; capabilities exclusive |
| `member_state` | suspend, resume, archive, recover | `recover` is runtime-only, needs `workspaceId` |
| `member_workspace` | join, leave | the Session never moves; creation Workspace cannot be left |

## Failure, retry and recovery

Three outcomes, never confused: **not committed** — the refusal names its reason and wrote nothing; fix the cause, and use a new `requestId` only if the parameters changed. **Committed, not yet in effect** — keep the receipt, ref and diagnostic; a failed activation or live apply is a committed fact, not a duplicate. **Unknown** — read back with `team_overview`, or retry the same id and parameters; never infer "not written" from an error.

Recovery ladder: separate ledger state, live Agent state, model route and configuration; fix a route the catalog no longer offers with `member_update`, then `member_state recover` with the verifying Workspace. A `recover` that leaves the same diagnostic did not cure the cause: fix the cause first, never loop recover. Keep what succeeded, continue only steps whose dependencies are met, and never delete a successful object.

[Failure classes and their next step](references/failure-recovery.md) lists the refusals and what each asks for.

## Event loops and routing

A Team keeps moving through loops, not your Session: a subscription discovers external change, a reminder wakes a Member's later judgment, and messages carry responsibility, evidence and exceptions. Design the loop with the owner — source, recipient, response, verification and escalation boundary — and do not poll status or convene discussion for show. `notify` decides who a subscription event wakes, not every owner.

You cannot create or operate those surfaces: no `team_subscription`, `team_reminder`, `team_message` or `team_dm`, and no Worker. Route the write to a Project owner or Member, or to the Human's Web surface, and say which one; never bypass a missing tool with shell. The same rule covers a Task, a Claim and an acceptance.

## Responsibility updates and handoff

- `project_owner update` replaces the responsibility without withdrawing the grant, so the Member keeps its grant, Main stream following and history; the new text is what `team_view`, the ownership context and `team_overview` read.
- `project_owner remove` ends the relation only: a Member that still participates keeps its Tasks, and open Tasks return to the Human only when ownership was its last participation.

## Archival

- `project_update archive` releases active Claims, clears related Attention, stops and clears every subscription the Project owns, keeps the history, and returns open Tasks to the Human. A cleanup failure after the commit is a cleanup warning; replaying the `requestId` retries it.
- `member_state archive` releases active Claims and clears Attention while private memory and the Session log stay on disk. No permanent removal exists; do not delete a Member's directory to simulate one.

## Models and capabilities

- Never name a route `team_models` did not list; a replay after the catalog moved still answers its original receipt.
- `member_update` is partial: an omitted `capabilities` keeps the stored override, `clearCapabilities` restores the full surface, and `effect` reports how far the stored configuration reached the live runtime. An allow-list is intent, not proof of what is live.

## Private assets

- Under `$DSH_HOME` touch only `agent-team/manager/`, the Workspace rules files you curate, and a Member's `memory.md`, `notes/` and `skills/` that `team_overview` confirmed by `memberRef`. Never the Host's sqlite files; Session logs only through the locator's reader.
- Organize a Member's private assets only when the Human asks now, only for that confirmed Member, and only within the request, following the Member's own memory and skill rules.
- Team state stays in the ledger and `team_overview`; keep `memory.md` a bounded index. Never bypass a tool's refusal with shell or files.
- Bundled guide skills are read-only and win over a same-name private skill in `manager/skills/`.
