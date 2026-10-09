# Timeline, composer, and entry rows

English | [中文](thread-and-composer.zh.md)

## Timeline scrolling
When the reader is within 48px of the bottom, follow new content; away from the bottom, do not disturb. Every arrival while a Thread is open is acknowledged durably right away, whether or not the reader is pinned — a scrolled-away reader gets only the pure “↓ N new update(s)” jump hint, which scrolls to the tail without any read semantics and clears when the reader returns to the bottom.

Opening a Thread scrolls to the latest fact, and a bounded read with a remaining unread count continues automatically: a serial drain loop issues fresh-requestId reads until the remainder is zero (50-round cap surfaces an error). Compensate `scrollTop` by the `scrollHeight` delta when prepending history. Rendering keys change with facts; a current length plus last fact key is used.

Older facts are paged by the timeline's own 「加载更早消息」 action, so the first paint's history read is what decides whether it is offered: a read that was refused or rejected leaves the action standing, paging back from the oldest fact on screen under its own error surface, rather than stranding older facts behind a control that never appears.

## Composer and mentions
The textarea grows to 336px, autofocuses without moving the timeline, sends on Enter, and inserts a newline on Shift+Enter. IME composition suppresses send. During submit it stays focused and read-only; buttons do not steal focus. Confirmation for an unfollowed recipient preserves draft and focus for the second Enter.

The mention popup is an upward `role="listbox"` associated through `aria-controls`, `aria-activedescendant`, and `aria-expanded`; arrows cycle, Tab/Enter accept, Escape closes, and outside dismissal/max height use public hooks. The highlighted row is kept inside the scrollable popup (`scrollIntoView` with `block: 'nearest'`), so long rosters never hide the keyboard selection.

The popup paints the shared translucent menu surface, so it takes the shipped frosted recipe instead of an opaque fill: the menu token under `--dsw-menu-backdrop-filter`, with the elevation stroke and prominent shadow. DSH 0.1.7 made that token translucent without renaming it, so an opaque popup over the conversation stopped reading while every existence check stayed green. The composer card follows the same 0.1.7 surface language: no layout border, an l2 elevation hairline, and the soft elevation tier.

On Thread surfaces the popup loads the current follower set through the Human-only `threadObservations` read (first paint round plus every thread-scope wake) and ranks followers above the remaining roster-order candidates, because a follower mention delivers directly while a non-follower needs the two-send invitation; Channel surfaces keep plain roster order. Accepted text places the caret precisely; deleting mention text shrinks recipients.

A quiet recipient notice shows who will be notified: the picked recipients unioned with the `@Handle` names typed into the body (`mentionedMemberIds`, matched on the Host's own case-insensitive word boundaries), with `@all` listing the menu's expansion. That derived set is display-only and never travels as explicit recipients, where a name outside the Channel would be a rejected target instead of the prose the Host reads. Drafts and recipients are stored per Channel/Thread in the bounded `TeamDraftStore`; successful sends clear them and failures preserve them.

The 「作为任务」 intent is not persisted and resets off after success. The mode chip keeps its word label at every width and narrows the toolbar gap below 560px rather than hiding the word.

Taskless Thread promotion is Human-only, durable, and non-optimistic. On success reread Thread and supplemental Channel/Member projections; on unread/stale fence errors preserve Host error and reread relevant facts.

## Thread/Task entry rows
Every top-level Channel Message has one Thread entry, drawn as a single quiet row under its body that both states and opens the Thread. It never treats Task as a navigation level, and no state of an entry ever lives on the identity line: a continuation row in a run has no identity of its own, so a cluster parked there would float alone at a line's far end, and any placement that far right costs the reader a trip across the column for the value they came for.

The state instead leads the entry row, at the same left edge as the body above it and on one x for every entry in the feed — the same leading position shipped DSH rows give their state (a `SkillRow`'s collapsed leading slot, the `JobListAction` trigger's dot before its count).

A taskful entry leads with, in order, the avatar stack of the Task's live Claim owners, the 8px `TeamStateDot` for `taskStatusDot(status)`, and the localized status word — `in_progress`→ongoing, `in_review`→warning, and `done`→done on the shared `StateDot`, while `todo` renders its hollow ring and `closed` a quiet tertiary dot, so all five statuses keep one shape language.

Claims are Host facts rather than decoration: only an `in_progress` or `in_review` Task has owners, a `released` Claim is no longer work, owners are deduped in Claim order, and a done or closed Task keeps no stack because the state word already tells that history. A taskless entry invents no status dot.

`TeamAvatarStack` draws overlapping 18px circles in the shared Member hue, capped at three plus a `+N` chip; a 2px ring separates neighbours by cutting the faces out of the surface the stack is laid on (values and layering: the Inbox entry note below, where both kinds of row sit on the page fill); the circles are presentational, so the stack is one `role="img"` whose label names the whole roster (`claimers`).

What the entry is follows the state on the same line: 12px/18px tertiary and `fit-content`, with no box of its own — hover and `:focus-visible` only brighten it to primary and nudge the chevron 2px (120ms, off under reduced motion), under a 2px business-colored focus ring. That text is `Task #N` for a taskful entry, and for a taskless one the localized Thread label once the Thread has follow-up activity, or `replyAction` while the entry Message is still the newest fact.

Follow-up activity appends `· 最近活动 <HH:mm>`, the same recency label an Inbox row wears — today is a bare clock time and only the first day that is not today is named (「昨天 HH:mm」) — because the Host's `lastActivityAt` differing from the entry Message's own `occurredAt` is exactly "the work moved after this Message", and the control's `title` carries the precise local instant.

Only unfinished work prints it, and a `done` or `closed` Task prints its number alone: the status word beside the door already says nothing is moving, so the instant there would only repeat the moment it resolved on every finished row, while the precise instant stays on the control's `title`, one hover away. A taskless Thread never resolves, so a discussion keeps printing the recency that is the whole of its state line — it wears no status word, dot, or owner stack. The Message count is retired — the quantity a reader acts on here is unread, not how much text exists.

A 390 column wraps the door text under the state rather than pushing the row past the reading column.

The unread capsule counts what needs *this* reader and is the only cluster member a taskless discussion can carry. It comes from the Workspace Inbox slice the Channel's own refresh already needs, read as the Host's whole unread slice, because that three-class judgement — activity on Threads I follow, mentions of me, and changes to my Tasks and Claims — is the authority; the Client joins it to the feed by `threadRef` and never re-derives unread from `item.mentions`.

It is the shared count capsule (see Count capsule), so it cannot drift from the sidebar entry or an Inbox row: zero unread is the absence of a badge rather than a zero, and past 99 it reads `99+`. A failed unread read drops the badges instead of showing counts the reader can no longer trust, and reports through the same inline failure line as the other reads.

The row follows card type and count in its label: `openTask`/`openThread` when the entry is read, `openTaskUnread`/`openThreadUnread` when it carries a count. The capsule itself is `aria-hidden`, so the count reaches assistive tech through that door control's label — which is also what pairs the number with the Thread it belongs to. The state cluster stays outside the control, because a labeled button prunes its descendants from the accessibility tree and would silence the owner stack's own name.

### Status pills and overlays
Thread status rides the public `Pill` on the same row as the `Task #N` chip; channel member and online meta share one `.headerMeta` inline row (`memberCount` + `onlineCount`, error/unavailable excluded from online). Claims collapse behind the public `DisclosureRow` (`expandOnRowClick`, titled `Claims · N`), keyboard closure owned by the primitive, claim rows indented to the title text. Every overlay goes through the public `Modal`: focus moves into the content on open and returns to the trigger on close (the `queueMicrotask` deferred-focus pattern).
