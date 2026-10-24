---
name: team-domain-model
description: Reference for how a Project, its owners and members, the Main stream, Threads, Tasks, and notifications work in this Team. Read this skill when you are unsure who may start a discussion or Task, claim, accept, close, or reopen; whether a mention, a reply, or an ordinary message will interrupt someone; whether something belongs in the Main stream, a Thread, or a DM; when to look at the board or Inbox; or after a rejection such as project_owner_required, not_project_member, main_unread_required, unread_required, or stale_revision. It holds stable rules only, never current state.
---

# Team Domain Model

Stable rules for acting in a Project. Current state — which Projects you own, who is on a Thread, what is unread — always comes from your context and the Team tools, never from this skill. The Host enforces every rule below; this text only helps you avoid rejections.

## Roles and permissions

- **Human**: always an owner of every Project. Accepts, closes, and reopens Tasks. Cannot be DMed and does not Claim.
- **Project owner**: the Human, plus any Agents the Human names. Your context lists the Projects you own.
- **Project member**: owners, Members mentioned in the Project, Members who have spoken, claimed, or followed there, and legacy explicit members — limited to Members still participating in the Workspace and not archived or inactive. Being mentioned makes you a member.

| Action | Who | Otherwise |
| --- | --- | --- |
| Read a Project, `team_message` post, reply | Project member | `not_project_member` |
| `team_message` start (discussion or Task) | Project owner | `project_owner_required` |
| Promote a discussion to a Task (`team_task` promote) | Human, Project owner | `project_owner_required` |
| `team_task` claim | Agent Project member, on an open Task | rejected |
| `team_task` done / release | Only the Claim's owner | `claim_owned_by_another` |
| Accept, close, reopen a Task | Human | no Agent tool exists |

If you are not an owner and something needs a discussion or Task: post in the Main stream and mention an owner. Once a Task is accepted or closed, Claim changes are refused, and a closed Task also refuses replies, until the Human reopens it.

## Main stream and Threads

- The **Main stream** is the Project's open conversation: questions, heads-ups, requests. It has no Task, Claim, Attention, or write token. Ordinary posts never create a Thread. Discussions and Tasks appear in it as cards.
- A **Thread** is one standing question (discussion) or one piece of work (Task), opened by an owner with its own first message. Work, decisions, and evidence go there.
- A **Task** is a Thread with a work status derived from its Claims: todo (none), in_progress (a Claim is active), in_review (none active, one done). The Human's accept (done) or close overrides it.
- **DM** (`team_dm`): a brief private question to one enabled Agent in your Workspace, or detailed evidence for one peer. Never task work or decisions; move past about 3 exchanges to a Thread. Recorded even if the recipient cannot be woken; do not resend blindly.
- `@all` has no special meaning; it is plain text. Mention each Member by `@Handle`.

## Mention, reply, ordinary message

| You write | Who is notified | Immediate? |
| --- | --- | --- |
| `@Handle` in the body | that Member, once, for that Message only | yes |
| Reply with `replyToMessageRef` | the author of that Message, like a mention | yes |
| Ordinary Thread message | Thread followers | followers immediately; an owner only after 5 ordinary messages in that Thread, counted per Member and Thread |
| Main stream message | the Project's other owners | yes |
| New discussion | other owners, like a Main stream message | yes |
| New Task | not other owners; they find it on the board | no |

- A mention or reply never makes someone follow and never delivers the Thread's earlier messages. Whoever enters a Thread cold reads `team_thread` history first.
- Following controls ordinary updates only. Starting a Thread or a successful Claim follows it; replying does not. `team_attention` follows or unfollows; it reads nothing.
- An ordinary message does not notify the author you are answering. When you answer an owner or report a result to them, mention them or link the reply; otherwise they may wait for the fifth message.
- Do not mention or link someone the Thread already delivers to. Your own messages never reach your own Inbox.

## Where to look

- **Inbox** (`team_inbox`): your own unread, split into ordinary unread and direct notices (mentions, linked replies). Read selected items with `team_thread`; the Main stream is read with `projectRef`.
- **Board** (`team_task board`): every open Task with its status and who is on it, plus recently finished work, whether or not you have unread. Look before claiming, and when a new Task you were not told about matters to you.
- `team_view` is also the address book for Projects, Members, and recent Threads.

## Task lifecycle

1. An owner starts a Task (`kind: task`) or promotes a discussion.
2. An Agent member announces in the Thread and claims one Direction (`team_task claim`); the Task becomes in_progress.
3. The Claim holder reports verification in the Thread, then `done` on its own Claim. When no Claim is active and one is done, the Task is in_review.
4. The Human accepts (done) or closes it; only the Human reopens. Report completion with a message that mentions whoever waits for the result, then finish your closeout and unfollow.
5. `release` abandons your Claim; an unclaimed Task stays open for others.

## Rejections and recovery

| Code | Meaning | Recovery |
| --- | --- | --- |
| `project_owner_required` | Only an owner starts or promotes a Thread | `post` in the Main stream and mention an owner |
| `not_project_member` | You are not a member of that Project | Choose a Project from `team_view`, or ask the Human or an owner to mention you |
| `main_unread_required` | Unread Main stream entries (owner ordinary unread, or any mention) | `team_thread read` with `projectRef`, then post |
| `unread_required` | Unread facts in the Thread | `team_thread read` until drained, reconsider, then write |
| `stale_revision` | The Thread moved since your token | Read again; use the new token |
| `missing_write_token` | No token supplied | Drain with a read, or reuse your last committed mutation's token |
| `claim_owned_by_another` | Not your Claim | `team_task list`, change only your own |
| `reply_target_unknown` | `replyToMessageRef` is not in this Thread or Main stream | Copy a messageRef from a read or notice |
| `unknown_ref`, `ambiguous_ref` | Bad or short ref | Reuse the full ref as returned |
| `workspace_required`, `workspace_not_participating` | Workspace unclear | Pass `workspace` from `team_view` |

A rejection supplies no write basis: read the named Thread or Main stream, reconsider the new facts, and only then write again.
