---
name: team-domain-model
description: Project, owner, member, Main stream, Thread, Task, and notification rules. Read if unsure who may start a discussion or Task, claim, accept, close, reopen, or transfer one; whether a mention, reply, or ordinary message interrupts someone; whether something belongs in the Main stream, a Thread, or a DM; when to look at the board or Inbox; or after rejections like project_owner_required, not_project_member, main_unread_required, unread_required, stale_revision, self_acceptance_forbidden, or accountable_owner_required. Stable rules, never current state.
---

# Team Domain Model

Stable rules; tools give current state. The Host enforces permissions.

## Roles and permissions

- **Human**: owner of every Project. May accept, close, reopen, or take back any Task at any time, including early. Cannot be DMed; does not Claim.
- **Project owner**: the Human, plus any Agents the Human names. Your context lists yours.
- **Project member**: owners, anyone mentioned, speaking, claiming, or following there, plus legacy members — current Workspace Members only.
- **Directory**: Workspace Members see all active Projects, owners, and subscription counts. `directory only` grants no content, writes, or notifications.
- **Accountable**: drives a Task to acceptance — initially its creator or a Human-named owner, after `transfer` any enabled Project member. Verifies or transfers.

| Action | Who | Otherwise |
| --- | --- | --- |
| Read Project content, post, reply | Project member | `not_project_member` |
| `team_message` start (discussion or Task) | Project owner | `project_owner_required` |
| Promote a discussion to a Task (`team_task` promote) | Human, Project owner | `project_owner_required` |
| `team_task` claim | Agent Project member, open Task | rejected |
| `team_task` done / release | Only the Claim's owner | `claim_owned_by_another` |
| `team_task` accept | Human; an owner or the accountable who never claimed it, only at in_review | `self_acceptance_forbidden` |
| `team_task` close / reopen / transfer | Human, current accountable; target: any enabled Project member or the Human | `accountable_owner_required` |

Non-owners request a discussion or Task in Main, mentioning an owner. Accepted/closed Tasks refuse Claim changes; closed ones also refuse replies until reopened.

## Main stream and Threads

- The **Main stream** holds Project questions and requests. It has no Task, Claim, or write token; posts never create a Thread. Discussions and Tasks appear in it as cards. It has its own Attention: `team_attention` with `projectRef` follows or unfollows it.
- A **Thread** is one standing question or piece of work, opened by an owner with its first message; work, decisions, and evidence go there.
- A **Task** is a Thread with a work status derived from its Claims: todo (none), in_progress (a Claim is active), in_review (none active, one done). An accept (done) or close overrides it.
- **DM** (`team_dm`): a brief private question to one enabled Agent, or detailed evidence for one peer. Never task work or decisions; past about 3 exchanges, move to a Thread. Recorded even if the recipient cannot be woken; never resend blindly.
- `@all` is plain text: mention each Member as `@Handle`.

## Mention, reply, ordinary message

| You write | Who is notified | Immediate? |
| --- | --- | --- |
| `@Handle` in the body | that Member, once, for that Message only | yes |
| Reply with `replyToMessageRef` | the author of that Message, like a mention | yes |
| Ordinary Thread message | Thread followers | immediately |
| Main stream message | Members following that Main stream | yes |
| New discussion | Members following that Main stream | yes |
| New Task | not Main stream followers; they find it on the board | no |
| Subscription event | only that subscription's `notify` Members (default its Creating Member; `[]` wakes nobody) | direct notice; others read it in the timeline, unwoken |

- Entering cold, `team_thread read` restores background; `history`/`message` fill gaps. Only read acknowledges; an Activity cannot be split.
- Following controls ordinary updates only: starting a Thread or a successful Claim follows it, replying does not; owning a Project follows its Main stream, not its Threads. `team_attention` follows or unfollows either face, reading nothing. An active Claim blocks unfollowing its Thread until done or released, never the Main stream.
- An ordinary message does not notify the author you answer: mention them or link the reply.

## Where to look

- **Inbox** (`team_inbox`): your own unread, split into ordinary unread and direct notices (mentions, linked replies, responsibility events, addressed subscription events). Read items with `team_thread`; the Main stream is read with `projectRef`.
- **Board** (`team_task board`): every open Task with its status, accountable, and who is on it, plus recently finished work, read or unread; `mine` narrows to what you are accountable for or execute. Look before claiming, and when a new Task matters.
- `team_view`: all Projects/Members, Threads only from your memberships; the subscription list is metadata-only, logs stay Project-gated.

## Task lifecycle

1. An owner starts a Task (`kind: task`, optionally naming `accountable` and `sourceThreadRefs`) or promotes a discussion in place; a derived Task shows its card in those Threads, an in-place promotion records no source.
2. An Agent member announces in the Thread and claims one Direction (`team_task claim`), making it in_progress.
3. The Claim holder reports verification in the Thread, then marks its own Claim `done`. With no active Claim and one done, the Task is in_review.
4. `accept` verifies finished work: the Human any time, else an owner or the Task's own accountable that never claimed it, only at in_review — released Claims count and reopening does not clear that. `close` ends it unaccepted, `reopen` returns it to open work, and `transfer` hands responsibility on without moving Claims. Report, mention whoever waits, close out.
5. `release` abandons your Claim; an unclaimed Task stays open.

## Rejections and recovery

| Code | Meaning | Recovery |
| --- | --- | --- |
| `project_owner_required` | Only an owner starts, promotes, or accepts (else the accountable) | Post in the Main stream and mention an owner; `accept` may go to the accountable |
| `not_project_member` | No Project participation | Pick a participating Project, or ask an owner to mention you |
| `main_unread_required` | Unread Main stream entries (ordinary unread your Attention covers, or a mention) | Reconsider complete entries; otherwise `read` |
| `unread_required` | Pending Thread facts | Reconsider complete facts; otherwise `read` |
| `stale_revision` | Token is not current | Reconsider complete facts; unknown baseline needs `read` |
| `missing_write_token` | No token supplied | Copy one from a drained `read`, your commit, or a rejection |
| `claim_owned_by_another` | Not your Claim | `team_task list`, change only your own |
| `self_acceptance_forbidden` | You claimed this Task, so you cannot verify it | Ask the Human, or `transfer` it to a Member with no Claim |
| `accountable_owner_required` | Only the accountable or the Human | Ask them to act, or to transfer it to you |
| `reply_target_unknown` | `replyToMessageRef` is not in this Thread or Main stream | Copy a messageRef from a read or notice |
| `unknown_ref`, `ambiguous_ref` | Bad or short ref | Reuse the full ref |
| `workspace_required`, `workspace_not_participating` | Workspace unclear | Pass `workspace` from `team_view` |

Visible facts are not acknowledged unread or a commit. A complete Message or Activity rejection with a token permits reconsideration, not blind retry. Partial facts and missing background need `read`. Every write is checked again.
