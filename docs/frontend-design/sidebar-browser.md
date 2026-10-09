# Sidebar browser

English | [中文](sidebar-browser.zh.md)

The Workspace is one selector line, not a list. Channels and Agents below it belong to exactly one Workspace; collapsing it into a single trigger makes the sidebar read as "you are in X, and here is X's content" and returns the rows a low-frequency switch was holding.

Nothing is hidden by that collapse — Workspace rows carry no unread mark of their own, and cross-Workspace unread is summarized by the Inbox entry, which stays above the selector: that entry's total sums every visible Workspace, so it is the one destination the selector does not scope, and it must not read as one of the rows under the line that names a single Workspace. When there is no Workspace to state — an empty roster, or a selection the roster no longer carries — the browser says so in the selector's own seat instead of rendering a dead field.

The trigger is the bordered single-choice field shape the creation forms already use (`.workspaceTrigger`, 12px radius, 34px line, `aria-haspopup="menu"` plus `aria-expanded`), so the line that says where the reader is does not read as the first entry of the Channels list; it carries the selected folder tint permanently because it is always showing a selection, states the selection as its own text with the full path on `title`, and opens the public `Menu` with the current Workspace checked.

The control's accessible name states both what the field is and which Workspace it shows (`工作区，Alpha`), because that value is invisible to a reader who cannot see the field.

That menu is the only way to switch Workspaces, so it takes focus on open: a portaled list is placed a frame after it mounts, so the selector focuses the opened row once that list is on screen, and keeps `autoFocus` on the primitive for what the primitive owns — arrow-key movement between rows, which indexes from the focused row, and Escape's return to the trigger.

The trigger takes `aria-current="page"` while the Workspace overview is the page on screen, exactly as the old selected row did, and takes the shared hover fill for it: the field's own layer is its resting background, so the fill is what marks the page.

Persistent Channels/Agents sections use native button headers with `aria-expanded`, default expanded. Collapse state is a per-browser preference, not a Team fact: both panels are keyed per workspace, and `sidebar-sections.ts` persists them to one localStorage key (`dsh.agent-team.sidebar-sections`) with a read-through cache and an in-memory fallback when storage is unavailable — the Workspace selector is a field rather than a section, so it keeps no preference of its own. Rows remain quiet: Channels keep `#`; Agent rows use avatars and presence.

Only the active leaf row has `aria-current="page"`. The embedded Member Session is the one overlay that can stand over a Team face the reader is still on — an Inbox page, or a Channel or Thread they opened the Agent from — and it takes the marker for its own Agent card: the face underneath keeps its place without the marker, and takes it back when the overlay closes (the Inbox entry included, which is otherwise the marked row while its page stands).

Row ellipsis menus use public `Menu`, are visible on hover/focus/menu-open, and pin the row background while open.

Channel and Agent editors use public Remote mutations and Host projections rather than optimistic inline edits. Agent model selection uses the public menu and Host model directory; changing an active model preserves Member and Session identity. Selecting an Agent opens its embedded Session without leaving Team mode; explicit Team navigation closes that overlay.

When a Member rolls over to a fresh context through `context_rollover`, the Agents panel observes the old→new Session binding and follows exactly once — only when the embedded page equals the observed old live Session id — and never redirects an archive view; the manual clear-context row action is retired. The narrow rail's three icon buttons read top-down Inbox (`IconQueueOutline14` at 16px) → Channels (`IconListPenOutline16`) → Agents (`IconAgentPresetOutline16`); none reuse the checklist (Task) or member icons.

The Inbox icon is a destination: clicking it opens the Inbox page and expands the sidebar; the Channels/Agents icons expand the sidebar and focus their section header. Agent creation carries no Channel page and the Agent editor carries no membership section: Channel membership is managed from the Channel side (create-dialog initial members, Channel editor member rows, and the member-management dialog); a Channel-less Member stays reachable through its DM view.

The create dialog is also the one import entry: a single disclosure button toggles between creating a new Member and bringing an existing one in from another Workspace. The import view reuses the shared `TeamMemberRow` roster and offers only Members that exist globally and do not yet participate here (suspended Members included — joining does not depend on availability); confirming routes the durable `joinWorkspace` and the row appears through the workspace refetch, with retry reusing the exact failed request.

The row's destructive action splits by context — on a non-creation Workspace it withdraws that participation only (with its own confirm copy stating what stays), while on the creation Workspace it archives the whole Member, naming the other Workspaces it will disappear from. There is deliberately no per-Workspace badge on Agent rows: participation is visible through presence in each Workspace's list, not through labels. Members appear in every participated Workspace's list through the Host's participation projection — no Client-side filtering on top.

The dialog body keeps one block rhythm — the mode switch is its first block, a 16px step above the content it switches — while the roster inside it keeps the shared 2px row density and states its caption and its loading/empty lines at the dialog's own 12/18 caption scale, so bringing a Member in does not draw the same list at a second density or its notice at title size.

The embedded Member Session input surface is the shipped composer itself, unmodified: the Team registers no member-session composer surface at all — no shadow, no trigger sources, no dock strip. The keyboard contract, command and reference menus, and attachments are exactly the ordinary session's.

Team is one of the shell's global panels rather than a seat beside them: its row is the rail's own (`sidebar.panellist`, order 20, one row under the Plugins entry, at that row's height, carrying the Team's own 16px monochrome mark), selecting it is what enters the mode, and the selected row wears the shell's own `aria-current="page"` and fill — the panel-level marker above the leaf markers described above.

Team mode stands the rail down with the shipped New Session button: both address the profile rather than the Team, and the Team row is not needed once the reader stands on the page it names, so the whole rail hides while `html[data-agent-team-mode='team']` stands and returns the moment the mode is left. The rule keys off the mode attribute and the shipped `panelList` class substring, because SlotCore cannot withdraw another plugin's list row and the entry's label is localized; the browser test pins the transition from both sides.

The mode's foot takes the settings seat (`sidebar.settings`, a single seat, priority -100): while the mode stands, the shipped Settings row is replaced by two full-width rows — 「对话 / Conversations」 (`data-team-action="leave"`) above 「成员 / Members」. That seat is bottom-anchored, so the second row keeps the y the Settings row had and the exit row stands directly above it; on the narrow rail both are 36px circles.

## Inbox (收件箱)
The Inbox entry is one card on the wide rail above the Workspace selector — its total sums the unread of every visible Workspace, so it is the one destination that outlives the scope the selector names, and it leads the sidebar instead of standing inside that scope — and the rail's first icon on the narrow rail, where no selector exists to lead.

Both mark unread the same way — a dot on the icon's top-left corner, standing for the sum of each visible Workspace's whole-unread Inbox total with mentions counted inside it rather than alone, and rendering nothing at zero: no unread is the absence of the mark, not an empty dot.

The dot is 8px of `--dsw-alias-state-business-primary` — the solid ink the queue gives a Thread that named this reader, so one colour still means "this needs you" wherever it appears — ringed by 2px of whatever surface carries it — `--team-mark-ring`, which every surface that fills hands the fill it is actually on (the card on hover and as the current page, the rail button on hover, focus, and as the current page).

That fill is translucent, so the ring paints two layers — the fill over that surface's own opaque fill — because the wash alone would darken an already-darkened surface a second time and read as a halo instead of a ring.

The avatar stack keeps the same rule (`avatar-stack.module.css`), and each side names its own surface: the sidebar dot cuts out of `--dsw-specific-sidebar-fill`, the fill the Agent badge cuts itself out of, while the chips on Inbox page rows and Channel feed entry rows sit on the page fill `--dsw-alias-bg-base`; handing over no fill leaves both layers the same colour, which draws nothing extra — so it reads as a mark laid over the icon's strokes instead of one blending into them, on a filled card as much as on a plain one.

It hangs off the icon's own wrapper (`.inboxMark`: `position: relative`, `flex: 0 0 16px`) at `-2px` on both axes, which is what puts the same dot on the same corner of the same glyph whether that icon sits in the 34px card or in the 36px rail button; on the narrow rail the mark thus stays inside the control box that the rail region clips its overflow to.

The number lives in the control's accessible name on both rails (`收件箱，6 条未读`) and the rail's hover hint — one hover away, never printed in the sidebar.

While the Inbox page stands, the card/icon carries `aria-current="page"` — and the rail icon wears the card's own current-page fill, because the icon-only rail has no label and the fill is the only thing that can say where the reader is.

`TeamConversation` renders a fourth face: Thread | Channel | Inbox | welcome. Selecting Inbox clears the Channel/Thread faces; selecting a Workspace, Channel, or Thread clears the Inbox. From an Inbox row, Back lands on that row's Channel — the Inbox is never pushed onto the back path; re-enter it through the card or the rail icon.

### Page frame and header

The page rides the shared conversation seat — the same header band, 880px centered reading column, `clamp(18px, 3vw, 36px)` gutters, and stable scrollbar gutter Channel and Thread use. Its header carries the page h1 plus one count line built as segments rather than a sentence: the Thread count, the whole-unread total the page is about in primary 600 ink while its neighbours stay secondary, and the mention total only while the queue actually holds one.

Spacing alone separates the segments, so a squeezed seat can wrap this line without dragging punctuation to the front of a line — and each segment names its own unit.

### The two slices and the merge order

It merges one Inbox call per visible Workspace into one list in the Host's own order — mentions first, then newest, the Thread ref breaking ties — because the merge must keep the Host's truncation order rather than invent a second one: a row that survived the cut on mentions must not sink below a merely newer row after the merge (a Workspace slice arrives in that same order).

The page renders the Host's two slices: 「需要我」, the unread queue the header totals above describe, and 「最近活跃」, the Threads this reader has written a Message in — newest activity first, at most five across every Workspace, never one the queue already holds — drawn by the same row component with its count capsule absent — zero is the absence of a badge rather than a badge reading zero, and such a row keeps the leading cluster every counted row opens on.

It never acknowledges anything: opening the page is not a read; only a durable Thread read clears its marker and the badge (see [Thread Attention and Inbox](../team-collaboration/)).

### Row anatomy

Each row is one full-width 8px-radius queue row in the shipped two-line result-row shape — 8px inset, shared `--dsw-alias-interactive-bg-hover` fill, inset focus ring — laid out as a grid whose first track belongs to whoever is on the Thread and is exactly as wide as the cluster it draws, plus the line's 8px gap.

A leading cluster hangs there on every row — counted or not, which is the point, because a track reserved for a count is empty on every Thread with nothing waiting.

It centres on the identity line it leads rather than sharing that line's baseline, because the chip that is the Human's picture has none to share: a browser reads a replaced box as resting on its bottom edge, so baseline alignment dropped the identity line 4px and made that row 4px taller while an initial-led row stayed put (the shipped two-line row centres its own marker on its heading line the same way, `.searchResultHeading`).

Everything the row says opens on the column after it, so the identity line, the gist under it, and the section heading above it share one left edge (34px from the row's edge) on every row that draws a single face — which is what the section heading is inset to. A stack widens its own row by 12px per extra face instead of every other row reserving the width of the widest stack. The row has three left edges where it had two: the count and the gist at 8px, the provenance at 34px, and the section heading a third.

### Information order

The row carries the Human-fixed information order.

(0) Every row opens with who is on it — the Task's live Claim owners where it has any, drawn as the shared 18px Member stack in the Channel feed's own words (`claimers`) and by its own rule (the Thread entry row above states it: unreleased Claims of a Task still in progress or review, in Claim order, deduped), and the actor behind the row's own instant (`newestActor`) where no Claim is live, because that is all anybody knows about such a Thread.

The Host resolves both, so the row needs no Member roster of its own, and the same Thread draws the same cluster in either section.

(1) The identity line — the Channel in 13px/20 primary 600, preceded by `workspace / ` only while the rows on screen span more than one Workspace, and followed by `Task #N` as the same hairline chip when taskful, then by where that Task stands.

A row states the standing where the number already is, and it is the Task's own status rather than the Thread's: the 8px state dot and the 11px status word four pixels apart, which is the pairing the shipped pill uses for the Thread header's own status. It rides the same clamped run, so a squeezed seat shortens the standing with the Channel name and the number instead of the standing cutting its own hole in the line, and a Thread that is only a discussion draws neither chip nor standing.

The line stays one run with its separator as a text node of its own, because splitting it into styled runs costs the spaces in the control's accessible name, and it clamps to one line with an ellipsis: a squeezed seat shortens the provenance instead of folding one row into three lines, while `overflow: hidden` stops a Channel name wider than the whole seat from pushing a scrollbar into the shared timeline.

The identity is what a queue reader scans for, so it carries the row's ink; while the gist held the heaviest ink and the identity the lightest, ten rows read as ten paragraphs rather than ten entries.

(2) The count closes that identity line, one line-gap left of the instant — the shared count capsule (see Count capsule), filled when the Thread named this reader and drawn as a hairline in `--dsw-alias-border-l2` when it merely moved, so one grammar carries both kinds of unread the queue now mixes and only the ink separates them, and a Thread never shifts its row when it is named again.

The count reads `99+` past ninety-nine, and the mention split inside it reaches assistive tech and hover through the capsule's own label — the row's visible text stays the Thread rather than a second count.

(3) The gist under it — the Thread's opening line capped at 120 characters straight from the Host's `previewText`, 13px/20 secondary on the identity's own column, one line.

(4) The newest instant closing the identity line behind the count — the Inbox row time of the Typography table — with the precise local `YYYY-MM-DD HH:mm` on the element's `title`.

That line is its own size container: the count capsule's 18px floor, its 8px gap, and this instant's 28px together need 62px — 70px once the count reaches two digits — and below that width the instant is not drawn at all, because a queue row that cannot hold both keeps the count and its own edge instead of hanging the instant past it; the row keeps its two-line shape, and the Thread states the exact instant.

### Section counts and row activation

Each section heading carries its own slice's count — the queue's, and the tail's as the five it was capped to — inset to that same 34px column. Clicking a row selects the row's Workspace and opens its Thread.

### States and subscriptions

The empty state speaks the shared empty-state language — the same 13px `strong` title and 12px hint pair Channel and Thread use — reading 「收件箱是空的」 with the hint 「你参与的 Thread 有新活动、或有人提到你时，会出现在这里」; loading, error, and retry reuse the shared conversation classes, and a failed background refresh keeps the rows and reports through `role="alert"` in `--dsw-alias-state-error-primary`.

While the page is open it subscribes once without a change scope and refetches the list on every wake; closed, the fetches stop.

A capped queue says so where the list ends: when the Host reports unread Threads beyond the page it returned, the section closes with 「未读 Thread 多于本页显示的上限；读完上面的之后，其余的会继续出现在这里」, so a full page never reads as the whole queue. A failed read keeps the last verdict alongside the rows it kept.

The badge subscribes the same way for its totals and re-pulls only totals (`limit: 1`), never lists. The badge additionally refreshes from every completed durable Thread read: the Host's changes stream deliberately never wakes on reads (a read changes no shared projection), but the read consumes this reader's unread facts, markers included.
