# Timeline, composer, and entry rows

English | [中文](thread-and-composer.zh.md)

## Timeline scrolling
When the reader is within 48px of the bottom, follow new content; away from the bottom, do not disturb. Every arrival while a Thread is open is acknowledged durably right away, whether or not the reader is pinned. A scrolled-away reader gets only the pure “↓ N new update(s)” jump hint, which scrolls to the tail without any read semantics and clears when the reader returns to the bottom.

Opening a Thread scrolls to the latest fact, and a bounded read with a remaining unread count continues automatically: a serial drain loop issues fresh-requestId reads until the remainder is zero (50-round cap surfaces an error). Compensate `scrollTop` by the `scrollHeight` delta when prepending history. Rendering keys change with facts; a current length plus last fact key is used.

Older facts are paged by the timeline's own 「加载更早消息」 action, so the first paint's history read is what decides whether it is offered. A read that was refused or rejected leaves the action standing, paging back from the oldest fact on screen under its own error surface, rather than stranding older facts behind a control that never appears.

## The Message row's identity line

A Message leads with its author: the avatar seat and, beside it, the author name and the time. The seat is `--team-identity-seat` (34px) and is the single place the face's size is stated — the initial avatar and the uploaded-image avatar both take their width and height from it, the continuation row's time centres inside it, and the two hairlines that hug the text column are inset past it, so changing the face needs no second edit. It is declared on the shared conversation surface rather than the Thread page, because the Project feed renders the same Message rows.

The face is levelled with the author line by a 5px drop from the name row's top edge, not by the author line growing to the face's height. An inline box carries font half-leading above its glyphs, so at the default 13px/20px the author line's capitals begin 5.5px below its box top, and 5px puts the face level with them. Raft levels its avatar with its own author line too, but its `mt-0.5` measures 2px only because that line is `leading-none` at 14px/14px, whose capitals already start 2px down. Copying that constant floats our face above its name.

The name and its time share one baseline, as in Raft's `items-baseline` row. The e2e journey asserts the face's rendered size and its drop at each end of the published content axis: the face is chrome, so the axis moves the words beside it and never the face.

A continuation row has no identity line; its time rides in the avatar seat as described under [Timeline scrolling](#timeline-scrolling).

## Composer and mentions
The textarea grows to 336px, autofocuses without moving the timeline, sends on Enter, and inserts a newline on Shift+Enter. IME composition suppresses send. During submit it stays focused and read-only; buttons do not steal focus. Confirmation for an unfollowed recipient preserves draft and focus for the second Enter.

The mention popup is an upward `role="listbox"` associated through `aria-controls`, `aria-activedescendant`, and `aria-expanded`; arrows cycle, Tab/Enter accept, Escape closes, and outside dismissal/max height use public hooks. The highlighted row is kept inside the scrollable popup (`scrollIntoView` with `block: 'nearest'`), so long rosters never hide the keyboard selection.

The popup paints the shared translucent menu surface, so it takes the shipped frosted recipe instead of an opaque fill: the menu token under `--dsw-menu-backdrop-filter`, with the elevation stroke and prominent shadow. DSH 0.1.7 made that token translucent without renaming it, so an opaque popup over the conversation stopped reading while every existence check stayed green. The composer card follows the same 0.1.7 surface language: no layout border, an l2 elevation hairline, and the soft elevation tier.

On Thread surfaces the popup loads the current follower set through the Human-only `threadObservations` read (first paint round plus every thread-scope wake). The popup offers every Workspace participant, matching the Host's own candidate rule, and ranks them by how directly a pick reaches the Member: this Thread's followers, then Members taking part in the Project through another Thread, then the rest of the Workspace.

Every tier stays pickable — the ledger addresses all of them, so the ranking is a hint rather than a filter. `@all` alone keeps the narrower Project scope, because that is what the Host expands it to. Accepted text places the caret precisely; deleting mention text shrinks recipients.

A row carries its weight on `data-mention-inside`: whether the Member is inside the conversation being written into. False means they are not, and the name drops to the secondary label alias while the row keeps its own contrast. Weight is the whole of the row's distinction — the row names the Member and says nothing about what the pick will do.

The two surfaces disagree about the same tier. On a Thread the boundary is following that Thread, so a Member taking part in the Project through another Thread is outside it; a Project send counts any Project participant as inside. Stating the consequence per row added nothing on either surface: on a Thread it marked exactly the rows the weight already marks, and a Project send has no confirmation step while every recipient joins the Thread it creates — a fact true of every row, so writing it per row is noise where it appears and a false difference where it does not.

Nothing is hidden by that silence. A pick the Host stops to confirm is announced by the status line the composer shows after the send (`mentionConfirmation`), so the row states who is in the conversation and the confirmation states what the send did. Colour alone carries the row's distinction, which is why it must survive the width change: below 600px the description is dropped and the weight stays.

A quiet recipient notice shows who will be notified: the picked recipients unioned with the `@Handle` names typed into the body (`mentionedMemberIds`, matched on the Host's own case-insensitive word boundaries), with `@all` listing the menu's expansion. That derived set is display-only and never travels as explicit recipients, where a name outside the Project would be a rejected target instead of the prose the Host reads. Drafts and recipients are stored per Project/Thread in the bounded `TeamDraftStore`; successful sends clear them and failures preserve them.

The 「作为任务」 intent is not persisted and resets off after success. The mode chip keeps its word label at every width and narrows the toolbar gap below 560px rather than hiding the word.

The reader's own handle is the one mention chip they must find without reading, so it is the one chip that leaves the business family: `[data-mention-human]` paints it in the success alias, because the error and warn families mean a failure and a caution. A body that wrote the reader's older handle still marks that chip — the mark follows the identity, not the spelling.

At `view.rulesVersion >= 2` the Project composer posts to the Main stream and its tool slot holds `讨论/任务` instead of the as-task pill. The toggle is a pressed button; once on, it reveals a native `作为任务` checkbox.

Off sends `postMainMessage`, with `replyToMessageRef` when a Main message is quoted. On sends `startThread` as a discussion, or as a Task when the box is checked; a committed Task moves the page to the `看板` tab with focus on it. Quoting turns the toggle off and turning it on drops the quote, since a new Thread has no quote target.

When the Host answers `main_unread_required` the draft stays, the stream is refreshed and read, and a status line asks the Human to look and send again; the retry is a new operation.

Replies never ask for confirmation at version 2, and neither the Main stream nor Thread composers offer `@all` or expand it into recipients; a typed `@all` is plain text.

## Quoting a Message
A Thread Message can be answered by picking the Message it answers. The affordance is unconditional: the reply action, the stored quote lines, and the composer banner are one feature the Host serves in full, so no surface asks whether quoting is available.

Choosing a Message states the target where the reader is already looking. The row holds the flat interactive layer the pointer gave it, so the choice survives the pointer leaving. The composer carries a banner naming the parent and its first line, with a cancel beside it, and cancelling clears both. The banner sits inside the composer card above the input, so target and draft read as one act. It does not restate the delivery: the quoted author joins the same “will notify” row as any other recipient, because a quote delivers like a mention and one delivery reads once.

One author never joins that row. The Host delivers to neither the Human — who reads the Thread directly and holds no session to deliver to — nor a Message's own author. A quoted Human, and with them the reader quoting themselves, therefore leaves the recipient set before delivery ever happens. That row states what will happen rather than what was picked, so it stays silent instead of naming the reader back at themselves as the one who hears about it.

The send carries the parent's ref, so the Host records the link and delivers to the parent's author; a successful send clears the target, and so does switching Threads, so a stale quote can never ride along with the next Enter.

In the timeline the link leads the Message it belongs to, in the Markdown reference form the reader already knows: one muted line behind a 2px rule, naming the author and the parent's first line, the whole of it a jump to the original. It is a handle on the original rather than a copy — a long parent is never pasted twice, and the quote cannot disagree with the Message it points at. The composer's banner is the same object in the same language, which is what lets the two read as one statement.

Taskless Thread promotion is Human-only, durable, and non-optimistic. On success reread Thread and supplemental Project/Member projections; on unread/stale fence errors preserve Host error and reread relevant facts.

## Thread/Task entry rows
Every top-level Project Message has one Thread entry, drawn as a single quiet row under its body that both states and opens the Thread. It never treats Task as a navigation level, and no state of an entry ever lives on the identity line. A continuation row in a run has no identity of its own, so a cluster parked there would float alone at a line's far end. Any placement that far right costs the reader a trip across the column for the value they came for.

The state instead leads the entry row, at the same left edge as the body above it and on one x for every entry in the feed. That is the same leading position shipped DSH rows give their state (a `SkillRow`'s collapsed leading slot, the `JobListAction` trigger's dot before its count).

Where the row opens depends on what is behind it. A Taskful entry walks into the Thread page, which carries acceptance and the whole history; a taskless discussion opens in the Project page's own side panel, so the reader keeps the feed beside them and reads its head on the band's identity row (see [the Project page](components.md#project-page-and-discussion-panel)).

An unfinished taskful entry leads with, in order, the avatar stack of the Task's live Claim owners, the 8px `TeamStateDot` for `taskStatusDot(status)`, and the localized status word. The word maps `in_progress`→ongoing, `in_review`→warning, and `done`→done on the shared `StateDot`, while `todo` renders its hollow ring and `closed` a quiet tertiary dot, so all five statuses keep one shape language.

Claims are Host facts rather than decoration: only an `in_progress` or `in_review` Task has owners, a `released` Claim is no longer work, and owners are deduped in Claim order. A done or closed Task keeps no stack because the state word already tells that history. A taskless entry invents no status dot.

A resolved Task drops the whole cluster and leads with the unread capsule alone — the board owns scanning resolved work, and an owner stack on finished work answers a question nobody is asking.

`TeamAvatarStack` draws overlapping 18px circles in the shared Member hue, capped at three plus a `+N` chip. A 2px ring separates neighbours by cutting the faces out of the surface the stack is laid on (values and layering: the Inbox entry note below, where both kinds of row sit on the page fill). The circles are presentational, so the stack is one `role="img"` whose label names the whole roster (`claimers`).

What the entry is follows the state on the same line: 12px/18px tertiary and `fit-content`, with no box of its own. Hover and `:focus-visible` only brighten it to primary and nudge the chevron 2px (120ms, off under reduced motion), under a 2px business-colored focus ring. That text is `Task #N` for a taskful entry, and for a taskless one the localized Thread label once the Thread has follow-up activity, or `replyAction` while the entry Message is still the newest fact.

An unfinished entry appends `· 最近活动 <HH:mm>`, the same recency label an Inbox row wears — today is a bare clock time and only the first day that is not today is named (「昨天 HH:mm」). The Host's `lastActivityAt` differing from the entry Message's own `occurredAt` is exactly "the work moved after this Message", and the control's `title` carries the precise local instant.

A `done` or `closed` Task replaces that recency with a footnote: `Task #N · <status word> · <MM-DD>`, the day it landed in the same date-only form the Inbox's older rows use, and the full date across years.

The recency clause there would only repeat the moment it resolved on every finished row; the precise instant stays on the control's `title`, one hover away. A taskless Thread never resolves, so a discussion keeps printing the recency that is the whole of its state line, and wears no status word, dot, or owner stack. The Message count is retired — the quantity a reader acts on here is unread, not how much text exists.

A 390 column wraps the door text under the state rather than pushing the row past the reading column.

The unread capsule counts what needs *this* reader and is the only cluster member a taskless discussion can carry. It comes from the Workspace Inbox slice the Project's own refresh already needs, read as the Host's whole unread slice, because that three-class judgement — activity on Threads I follow, mentions of me, and changes to my Tasks and Claims — is the authority. The Client joins it to the feed by `threadRef` and never re-derives unread from `item.mentions`.

It is the shared count capsule (see Count capsule), so it cannot drift from the sidebar entry or an Inbox row: zero unread is the absence of a badge rather than a zero, and past 99 it reads `99+`. A failed unread read drops the badges instead of showing counts the reader can no longer trust, and reports through the same inline failure line as the other reads.

The row follows card type and count in its label: `openTask`/`openThread` when the entry is read, `openTaskUnread`/`openThreadUnread` when it carries a count. The capsule itself is `aria-hidden`, so the count reaches assistive tech through that door control's label — which is also what pairs the number with the Thread it belongs to. The state cluster stays outside the control, because a labeled button prunes its descendants from the accessibility tree and would silence the owner stack's own name.

### Status pills and overlays
Thread status rides the public `Pill` on the same row as the `Task #N` chip. Every overlay goes through the public `Modal`: focus moves into the content on open and returns to the trigger on close (the `queueMicrotask` deferred-focus pattern).
