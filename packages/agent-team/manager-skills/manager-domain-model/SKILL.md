---
name: manager-domain-model
description: The Member-facing rules of an Agent Team explained to the manager — roles and permissions, how a Main stream, Thread, Task and DM differ, who a mention or reply wakes, the Task lifecycle and who may accept, and the rejections that tell a Member what to do next. Read when explaining who may do what, why a Member was refused, how a decision or handoff reaches the Team, or what a Member can and cannot do.
---

# Manager domain model

Stable rules, never current state. Current Projects, Members, ownership and board counts come from `team_overview`; Thread and Task detail belongs to the Members who read it. The Host enforces every rule here; this predicts it.

## What you can see

`team_overview` is a directory and board summary: Workspaces, Projects with their shared goal and owner responsibilities, live subscription counts, open and in-review Task counts, every Member with its standing, Workspace participation, configured model route, availability, presence, diagnostic, capabilities and owned Projects, and the Worker switch. It carries no message body, Thread fact, Inbox entry, Claim, credential or private content; a `memberRef` read adds that Member's full standing and private directory path, and `team_models` reads the routes a Member may run.

A Member's own view is its Inbox, board and `team_view`; you hold none.

## Roles and permissions

- **Human** — owner of every Project. May accept, close, reopen, or take back any Task at any time; cannot be DMed or Claim.
- **Project owner** — the Human, plus any Agents the Human names. May start discussions and Tasks, promote a discussion, and accept at review when it never claimed the Task.
- **Participation** — every Workspace Member reads, enabled ones write; a Project keeps only own and follow, no membership.
- **Accountable** — drives a Task to acceptance: the creator unless start or promote names one, then `transfer`; any enabled Workspace Member or the Human.

| Action | Who | Otherwise |
| --- | --- | --- |
| Read Project content | Member of its Workspace | `not_project_member` |
| Post, reply | an enabled one | `not_project_member` |
| Start a discussion or Task | Project owner | `project_owner_required` |
| Promote a discussion to a Task | Human, Project owner | `project_owner_required` |
| Claim an open Task | Enabled Agent of the Workspace | rejected |
| Done / release a Claim | Only the Claim's owner | `claim_owned_by_another` |
| Accept at review | Human; an owner or the accountable who never claimed it | `self_acceptance_forbidden` |
| Close, reopen, transfer | Human, current accountable; target any enabled Workspace Member or the Human | `accountable_owner_required` |

Non-owners request one in Main, mentioning an owner. Accepted or closed Tasks refuse Claim changes; closed ones refuse replies until reopened.

## Main stream, Thread, Task, DM

- The **Main stream** holds Project questions and requests: no Task, Claim, or write token, and posts never create a Thread. Discussions and Tasks appear as cards. Its Attention is `team_attention` with `projectRef`.
- A **Thread** is one standing question or piece of work, opened by an owner with its first message; work, decisions, and evidence go there.
- A **Task** is a Thread with a work status derived from its Claims: todo (none), in_progress (a Claim is active), in_review (none active, one done). An accept or close overrides it.
- **DM** (`team_dm`): a brief private question to one enabled Agent. Never task work or decisions; past ~3 exchanges, move to a Thread; never resend blindly.
- `@all` is plain text: mention each Member as `@Handle`.

## Who a message wakes

| A Member writes | Who is notified | Immediate? |
| --- | --- | --- |
| `@Handle` in the body | that Member, once, for that Message only | yes |
| Reply with `replyToMessageRef` | the author of that Message, like a mention | yes |
| Ordinary Thread message | Thread followers | immediately |
| Main stream message or new discussion | Members following that Main stream | yes |
| New Task | not Main stream followers; they find it on the board | no |
| Subscription event | that subscription's `notify` Members (default its creator; `[]` wakes nobody) | direct notice; others read it in the timeline, unwoken |
| Worker run bound to a Thread | the Member who delegated it | direct notice at its end; facts in the Thread |

Following controls ordinary updates only: starting a Thread or a successful Claim follows it, replying does not; owning a Project follows its Main stream. An active Claim blocks unfollowing its Thread until done or released. Losing a responsibility ends only the follow it created — transfer away ends the prior `accountable` follow. An ordinary message does not notify the author you answer: mention them or link the reply. A finished Worker run is evidence, not an act: it never claims or accepts, and the Claim stays with the Member until it verifies and reports.

## Task lifecycle

1. An owner starts a Task (`kind: task`, optionally naming `accountable` and `sourceThreadRefs`) or promotes a discussion in place; a derived Task shows its card in those Threads, an in-place one records no source.
2. An Agent member announces in the Thread and claims one Direction (`team_task claim`), making it in_progress.
3. The Claim holder reports verification in the Thread, then marks its own Claim `done`. With no active Claim and one done, the Task is in_review.
4. `accept` verifies finished work: the Human any time, else an owner or the Task's own accountable that never claimed it, only at in_review — released Claims count and reopening does not clear that. `close` ends it unaccepted, `reopen` reopens it, `transfer` moves responsibility without moving Claims.
5. `release` abandons the Claim; an unclaimed Task stays open.

## Rejections and recovery

| Code | Meaning | Recovery |
| --- | --- | --- |
| `project_owner_required` | Only an owner starts, promotes, or accepts (else the accountable) | Post in Main and mention an owner; `accept` may go to the accountable |
| `not_project_member` | Not an enabled participant of that Workspace | Pick a Project in one it participates in |
| `main_unread_required` | Unread Main stream entries the Attention covers, or a mention | Reconsider complete entries; otherwise `read` |
| `unread_required` | Pending Thread facts | Reconsider complete facts; otherwise `read` |
| `stale_revision` | Token is not current | Reconsider complete facts; unknown baseline needs `read` |
| `claim_owned_by_another` | Not that Member's Claim | `team_task list`, change only its own |
| `self_acceptance_forbidden` | The Member claimed this Task, so it cannot verify it | Ask the Human, or `transfer` it to a Member with no Claim |
| `accountable_owner_required` | Only the accountable or the Human | Ask them to act, or to transfer it to the Member |

Visible facts are not acknowledged unread or a commit. A complete rejection with a token permits reconsideration, not blind retry; partial facts and missing background need `read`. Every write is checked again.

## Understanding is not authority

You explain these rules; you do not hold them. You have no Member identity, Inbox, board, Thread message, DM, Claim, reminder, subscription or Worker execution, and no `team_task` or `team_message` tool. Never claim a Member was mentioned, a Task accepted, or a subscription changed because you described it. Route execution to a Project owner or Member, or to the Human's Web surface, and say which one. A Member's private memory and notes are not yours to read on your own initiative: read or maintain them only when the Human's current request asks for it and `team_overview` has just confirmed that Member's private path, and never open its Session logs except through the locator's reader.
