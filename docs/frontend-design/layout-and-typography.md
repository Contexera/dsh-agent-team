# Layout, typography, and identity

English | [中文](layout-and-typography.zh.md)

## Layout skeleton
Project and Thread surfaces use `display:grid; grid-template-rows: auto 1fr auto` for header, scrollable timeline, and composer at `height:100%`, with contained inner scrolling. The content column is centered at `max-width: 880px`; timeline padding is `clamp(18px, 3vw, 36px)`.

The Project page's feed stage takes the content and composer rows together (`grid-row: 2 / 4`) so an open discussion panel can span both. At `max-width: 600px`, padding tightens and the header stacks; acceptance covers 390×844 without horizontal overflow. The host sidebar controls wide/rail widths; rail renders Team icon buttons.

Browser storage retains Team mode, Workspace, the last Project/Thread location, and the Inbox page position (a navigation fact, not an unread fact), but never unread or Attention. Welcome is a separate centered surface. Thread is the navigation endpoint; an existing Task is a header/card overlay. Taskless Threads show a localized Thread/讨论 label and a promote action, never a fake status. Closed Tasks replace the composer with an explanatory notice and reopen action; taskless Threads retain the normal reply composer.

Project and Thread pages share a header band, a hairline, and the 880px centered reading column, and both subscribe to workspace changes through the shared abortable `TeamChangeStream`; every opening or reconnection baseline requests a catch-up read, followed by matching streamed invalidations.

The Project band is the shipped session header's shape at its own rhythm — a 30px identity row under a 10px top inset, then the tab strip. Its identity row is the Project title with the description beside it on the title's baseline, clamped to one line with the full text on its `title`, so the band's height never depends on how much someone wrote into the description.

The band is pane chrome and does **not** share the reading column's edge. The shipped session header leaks left to a 20px inset (`padding: 10px 28px 0 20px`) while its transcript stays a centered column, so on that page the title and the words under it deliberately sit on different x positions; the Team surfaces copy that arrangement rather than centering the band over the column. The band carries no back row either: the browsing sidebar already lists every Project, so a second way back would be a duplicate control on the page.

The Project page additionally seats a `项目 | 看板` tab strip on its header's closing rule and, for a taskless discussion, a 360px right-hand panel whose seat is reserved only while it is open; the board is the one Team surface allowed past the reading column, up to 1240px.

A whole-surface state — a projection still loading, one that came back empty, a failure that replaced it — rides one box, `.emptySurface`, and centres in the free space it stands in.

The box carries that centring rather than inheriting it: it fills the scroll box with `min-height: 100%` and centres its content, with `box-sizing: border-box` so its own 32px padding cannot add to that 100% and open a scrollbar.

The reading surfaces are flex columns, where an auto margin already has vertical authority; the board and the discussion panel are plain block scroll boxes, where the vertical half of `margin: auto` resolves to zero. Making the box take the free space is what puts both families in the middle, instead of a loading read sitting against the top edge on the two block surfaces.

Where the parent's height is indefinite the percentage resolves to `auto` and the auto margin still centres, so neither family depends on the other's mechanism.

Successful Project refreshes clear load errors without clearing unrelated action errors. Project top-level and Thread replies are idempotent by request ID. The Project 「作为任务」 control is a default-off native pressed control, sends explicit taskless intent unless selected, and resets off after success.

It sits beside the attach control as the labeled mode chip of the language table above, keeping its word at every width — the composer narrows its control gaps below 560px instead of dropping the label.

## Typography and identity
| Element | Specification |
| --- | --- |
| Page h1 | 20px/28px, weight 600 |
| Sender | 13px/20px, weight 600, primary — the secondary grade of the content axis (`--dsh-content-font-size-secondary` with its own line-height delta), so a raised Settings size grows the author with the message; time metadata follows on the same line |
| Message time | 11px/20px, tertiary; local HH:mm today, MM-DD HH:mm this year, full date across years |
| Inbox row time | 11px/18px, tertiary, `tabular-nums`; a bare `HH:mm` today, 「昨天 HH:mm」 on the previous local calendar day, the Message form for anything older, and the precise local `YYYY-MM-DD HH:mm` on the element's `title`. The Thread entry borrows this label for its follow-up time while its work is unfinished. An Inbox identity line too narrow for the count and the instant together does not draw it at all (see Inbox below) |
| Human body | 14px/22px at the default content size, pre-wrap and break-word; both body grids ride the Settings content-font axis (`--dsh-content-font-size` plus its px delta), so a raised content size grows message text with the rest of DSH |
| Agent body | Markdown on the same 14px/22px chat grid; compact heading sizes and list/pre/table margins. A body past the 600-character fold reads on the document rhythm instead — 16px block gaps, 6px list items, 24px lines, section-sized headings at h2 18px / h3 17px — while short bodies keep the dense grid. The Markdown box is capped at the reading column, so a ≥4-column table scrolls inside the column instead of past its edge; the cap is declared at both levels of the body chain, since a long body adds a `data-document` wrapper between them |
| Fenced block | Rides the Settings code-size axis rather than a fixed chat grade: 13px is what the default 11px setting renders, and the block grows with that setting through `--dsh-code-font-delta`, the same px-delta pattern the content axis uses. So the words and the leading they sit in never come apart |
| Task/activity | 11–12px tertiary, centered activity rows |
| Thread entry row | 12px/18px tertiary, `fit-content`; hover/focus-visible only brightens it and nudges the chevron |
| Entry state cluster | 11px/18px leading the entry row: 18px avatar circles, 8px status dot, status word, 18px unread capsule at 11px/600 |
| Empty/loading | 13px tertiary; 8px pulsing dots, disabled for reduced motion |

Message time comes from Host projection and shares the ledger operation instant. Consecutive same-sender messages form a run, and time is stated by the row itself: beside the name where the row has an identity line, in the avatar seat under the pointer where it is a continuation. A day boundary gets a centered date anchor, and the Project feed alone draws a `TeamRunDivider` hairline at a five-minute boundary, with no instant on it. `team-separators.ts` is the single authority for both decisions.

The identity line and the avatar seat do not state the same label. The identity line has the reading column to itself and takes the whole wall-clock form (`formatMessageTime`: clock today, month-day within the year, full date across it).

The seat is 34px and neither clips nor grows, so it states the time of day alone (`formatClockTime`). The dated forms measure 57px within the year and 87px across it — wide enough to paint over the words beside them. A run breaks at every calendar-day change, so a continuation always shares its run head's day and the date is already one row up. The exact instant stays on the label's `title` (`formatAbsoluteTime`), as the Inbox row and the Project entry line do.

Agent avatar hue is a stable hash of `memberId`; Human uses `--dsw-alias-state-business-primary`. That color and initial stay the Human's fallback: a stored profile avatar image replaces the initial in every seat the Human occupies, while the displayed name comes from the same profile projection, resolved once in `TeamConversation` as `name ?? t('human')` and passed down as `humanName` to both pages.

Resolving the name in one place is what keeps the message sender, roster rows, mention fallback names, and `member:human` refs from drifting apart, or falling back to a literal `human` on their own.

Presence maps available/working/error/unavailable to the shared state-dot language, and two presentations carry it. The `TeamMemberAvatar` badge (the avatar's initial plus the dot on its bottom-right edge) appears wherever a person is listed as a row; the bare `TeamPresenceDot` sits inside the composer's recipient menu, which is a menu row rather than a roster row. Roster rows therefore lean on the avatar badge while the menu stays with the dot; that asymmetry is deliberate, not an oversight.

The `TeamAvatarStack` circles on a Thread entry reuse the same hue hash but carry no dot, because they answer who owns the work rather than who is online right now.

No Agent seat ever draws an image — the hue and initial are the whole identity an Agent has — so the compact stack draws the Human's picture in the one chip that is the Human, and names that chip from the same profile projection.

The Inbox row's leading cluster and the Project feed's Thread entry rows each take the Human's Member id from the Host (`AgentTeamInbox.humanMemberId`, the same initialization record `AgentTeamView` carries). Each then lets `namedAvatarOwners(owners, human)` replace that one owner with `humanName`/`humanAvatarUrl`, so a rename moves the chip's letter and the stack's label together instead of leaving an initial the profile no longer uses.

Owners that are not the Human keep the shared initials, and bytes that do not decode fall back to the display name's initial through the same `useAvatarImage` the other seats use.

The Host names the Human on an Inbox row by that runtime display name as well, rather than falling back to the durable `member:human` id the Agent roster never holds.

Errors use `--dsw-alias-state-error-primary` and `role="alert"`.
