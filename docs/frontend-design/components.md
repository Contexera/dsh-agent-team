# Component contracts

English | [中文](components.zh.md)

## TeamMessage
Props include sender identity, body, optional time, mention handles, sender title, grouping, and children. Only adjacent same-sender Message rows group; Activity rows break runs. Grouped rows hide avatar/name while preserving grid alignment. The initial of the sender name (without `@`) is shown.

The identity seat draws a picture for exactly one author. The profile avatar lands on a row only while that row is the Human's own, so an Agent row keeps the shared hue and the sender initial whatever the surface passes down — one seat painting the reader's face for another author would name two people alike.

Row actions hang off the Message they act on: its own top-right corner, revealed under the pointer or the caret. The card carries copy, the quote action, and — when the body itself names the reader — the `Mentioned you` notice. The card belongs to the row rather than to one action. A surface that withholds quoting (`rowActions` without `onReply`) keeps copy and the notice and drops only the quote button, while a surface that passes neither offers no card at all.

It floats, anchored to its own row rather than to a rise measured upwards out of that row. A card pinned above the row edge sits in the band the row above owns, so a Message that opens a run showed its actions over the empty gutter — or the words — of the Message before it, which reads as somebody else's card.

Anchored at the row's own top edge, the card hangs beside the author line, so the room between its lower edge and the first words is the row's top padding plus that author line minus the card's own height — 3px at the default content size, and it keeps clear as the content font axis grows. A continuation row has no author line to hang beside, so its card rises over its run's own previous line — the words those actions belong to — and still clears the first line it acts on.

Its action sits inside the card rather than filling it: a 24px control inset 2px on every side. At the card's own 28px height and 8px radius the hover fill painted from edge to edge, so the pointer state read as the card being cut open instead of one control lighting up — the shipped IconActions are 28px squares with their own padding, never flush with the surface that holds them.

The two surfaces that read a Thread both offer the card: its page, and the discussion panel beside the Project feed. They render the same rows, and a reader who turned to the panel would otherwise leave it to quote the Message in front of them. The row itself stays flat, so one hovered Message gains a layer instead of the whole timeline gaining texture.

A Message that answers another leads its body with the resolved quote (`data-quote-line`): the parent's author and one ellipsised line of its opening text, both resolved by the Host from the ledger rather than read out of the body. The quote therefore cannot disagree with what it points at, and still fills in when the parent sits outside the loaded history. The whole block jumps to the original wherever the surface can reach it — the Thread page, the Thread panel and the Main stream alike, since the target sits in the same timeline.

That pulse is the only layer the Main stream's rows take: under the pointer they stay inert, because a feed row is an entry row and does not borrow the Thread's reading-seat hover language. Only where the original is unreachable is the block inert text; a Message that is not a reply renders none.

Bodies over the 600-character formatter threshold use a persistent wrapper with an approximately eight-line/176px preview and quiet “expand/collapse” button carrying `aria-expanded`. Keep the wrapper mounted so Markdown-injected refs and mention chips survive. Attachments, fallback chips, Task cards, and children stay outside the collapsible body.

That same wrapper carries `data-document`: the threshold that folds a body also calls it a document, so its Markdown reads on the document rhythm (Typography table above) while short messages keep the chat grid, and the preview stays eight lines of whatever the content-font axis sets.

## Message runs
A run groups consecutive same-sender Messages and its Thread entry row. Activity and unread boundaries break runs. An entry row in a grouped row gets a hairline; ordinary continuation does not. Runs have no hover box, fill, shadow, or permanent border—only two-pixel spacing. Time is stated by the row that owns it, never by a line: a row with an identity line states its instant beside the name, a continuation row in the avatar seat under the pointer or keyboard focus.

The seat states the time of day only — it is 34px and does not clip, while a dated label is 57px within the year and 87px across it. The date therefore stays with the identity line that opened the run and the day separator above it, and the exact instant rides the label's `title`. A day boundary gets its anchor, and the Project feed alone draws a five-minute `TeamRunDivider` hairline, carrying no instant.

## Mentions and Task refs
Mention chips are rendered only for handles in the Message's resolved mention list, matching the authored `@Handle` case-insensitively on Unicode word boundaries — a bare name without its `@` is prose and never chipifies, and code stays literal. A chip names the person as they are called today. The Human's pre-rename handle stays an alias the Host still delivers to, so a Message whose body wrote `@human` chips in place as the current profile name instead of landing in the trailing row under a name its body never used.

Human literal, Agent plain prose, and rich Markdown use their corresponding segmentation path; absent names become a trailing fallback row without duplication.

Every mention chip renders alike, the reader's own handle included: recognising yourself is the row's job, not the chip's, so a chip carries no second treatment and `[data-mention-human]` is gone. The row states it instead, through `data-mentions-me` and the `Mentioned you` notice on the action card, and that scan follows the identity rather than the spelling, so a body written before the reader's rename still counts. Chip ink mixes the business alias toward `label-primary`, which holds it over the 4.5:1 body-text floor in both themes.

The trailing fallback row never repeats the reader's own name — that would print a bare `@me` under a body that already chips it in place — nor an author the quote line above it already names, since that line states the delivery itself. A quote that no longer resolves names nobody, so there the chip is the only place the delivery still shows.

Known branded `task:*` refs are resolved in batches and rendered at their original position as clickable `Task #N` in Human, plain Agent, and rich Markdown text. Code fences, indented code, mixed inline code, and existing links stay literal. Normalize malformed double-colon or uppercase spellings before resolution. Resolved refs can navigate across Workspace, Project, and Thread; failed refs remain plain text. Task numbers are home-Project creation ordinals, while branded refs remain stable identity.

Known branded `thread:*` refs resolve the same way through `resolveThreadRefs` and render at their original position as clickable Thread chips titled with the cited Thread's opening line (`讨论 · …` in Chinese), so one taskless Thread no longer reads exactly like the next. A ref becomes a link only when the Host confirms it — abbreviated spellings included — and clicks navigate by the resolved full ref, so unresolvable text stays plain and never silently no-ops.

Known branded `project:*` refs render as Project chips naming the cited Project (`项目 · …` under the Chinese locale, `Project · …` under English); clicks hop to that Project. Known branded `member:*` refs render as Member chips naming the cited Member (`成员 · @…` / `Member · @…`) — deliberately distinct from `@mention` chips, which notify, while a cited ref never does. Clicking an active Member's chip opens their session exactly the way the agent card does; suspended Members and the Human render as inert labelled text.

Both resolve against the already-loaded Project and member rosters with no new Host call, so a ref outside the loaded window stays plain text under the same rule unresolvable refs follow.

## Count capsule
`TeamCountBadge.tsx` over `countBadge.module.css .badge` is the one count capsule, and every count the Human reads wears it: the Project feed's Thread entry, each Inbox queue row, and a Task card on the Project board. One hand-written copy per surface — which is what there was before they were shared — is exactly what let the feed's copy sit on a different line box from the queue rows', with its digit a pixel away from theirs.

The sidebar's Inbox entry is deliberately not one of them: it states unread as a dot rather than a number (see Inbox (收件箱)). What a reader scans the sidebar for is whether anything is waiting, while the quantity — which moves on every fact, and is what they ask for on purpose — belongs in the control's own name.

The rule is 18px tall and `min-width: 18px` with `box-sizing: border-box` (the platform ships no global border-box reset, so padding would otherwise inflate one digit into an oval). It pairs `border-radius: 999px` with `corner-shape: round`, is `display: inline-flex` centred on both axes, and sets 11px/600 with `font-variant-numeric: tabular-nums` so a two-digit count never moves the ink.

Its `line-height: 18px` is the capsule's own height rather than whatever the surface inherits, because one surface inherits `normal` while another sets a height, and `flex: none` keeps a squeezed Inbox row from shrinking the circle.

Placement stays with the surface hanging the capsule through `className`, because the narrow rail pins it inside the 36px icon box.

Zero renders nothing: a count's absence is not a capsule reading zero. Past ninety-nine it reads `99+`. `tone` picks the ink and nothing else — the solid fill when the Thread names this reader, the same geometry drawn as a hairline in `--dsw-alias-border-l2` when it merely moved. The hairline pays for that 1px border out of its own padding (4px + 1px is the solid tone's 5px) so both tones keep one border box and one content box at every count, so one Thread never shifts its row when it is named again.

`label` decides how the count reaches assistive tech: with one, the capsule is a `role="img"` whose name and `title` carry it; without one, it is `aria-hidden`, because the control around it already says the number.

The digit's ink sits about half a pixel right of the box centre on every digit — a property of the glyph inside its own advance, not of the layout, so no declaration fixes it. What the rule owns is the 18px box one character keeps and one shared copy of it, which `scripts/audit-ui-parity.mjs` audits: a refactor that reintroduces a second copy fails the audit.

## Member rosters
`TeamMemberRow.tsx` is the single presentation of a person: `TeamMemberIdentity` (the presence-bearing `TeamMemberAvatar` plus the handle over its description) and an optional action. The cross-Workspace import roster renders the row, and the sidebar Agent list seats the same `TeamMemberIdentity` inside its own select button, so identity, tone, and truncation cannot drift between surfaces that show the same person.

The row is a grid — 34px avatar, `minmax(0, 1fr)` copy, and an `auto` action track — with the md tier of the shipped radius scale (12px), 8px/10px padding, a 50px minimum height, and `--dsw-alias-interactive-bg-hover` on hover. The handle is 12px/18px weight 500 primary; the description is 11px/16px tertiary and ellipsizes inside the copy track instead of pushing the grid. The action track is declared only when an action is rendered, so a row without one hands that width back to the description rather than reserving a hole.

The membership action is the row's only chrome — one `Button size="sm" variant="outline"` of at least 64×28 whose label changes (添加/移除, 更新中… while pending) while its shape does not — and the row's own failure line renders inside it as `role="alert"` under the copy track. Below 600px the action drops under the identity and aligns with the copy, because a squeezed dialog cannot afford a third column.

Membership law follows the Host: joining needs `availability === 'active'` (the Host refuses any other availability), while leaving needs only the membership fact, so an already-joined Member who is temporarily down keeps a working 移除. The sidebar Agent list is the exception on spelling: it names Members as the directory does (`builder`), while rosters address them the way the composer does (`@builder`).

## Team settings page
Settings carries the Team's one surface: the `settings.section` entry `team-settings` (「团队」), offered in ordinary mode only, because Team mode's sidebar takeover puts the settings panel out of reach. The shell draws the nav rail and the content column, so the section draws its own 18px/600 heading and then rows in the shipped settings language — 16px/0 padding over a hairline separator, a 14px/22px title above a 12px/18px tertiary description, 12px between controls. It reuses the shipped `Button` and `Input` rather than restating them.

The nav glyph is shell-owned too: `navIcon(id)` draws a fixed mark per section id and falls back to the generic gear for an unknown one, and `settings.section` carries no icon option.

So the Team row takes the bundle's mark through a contained DOM workaround: the row is tagged inside the shell's portalled dialog and the mark is painted over the shell glyph with a mask. It is not a supported extension point, so one observer watches only the dialog's open/close and releases every tag and style on dispose — drop it once the Harness exposes an icon on `settings.section`.

The page writes two things. Identity — the display name and the avatar — goes through the Team Remote, which owns the profile entry the Client would otherwise have to name. The compaction threshold is the Team Host row's own settings group, read and written through the shared configuration form (`configForms.get(<row id>)`), so the page names one `memberCompaction.tokens` child path rather than restating the whole group.

The group sits between the identity rows and the environment check, under its own 13px/600 heading — the shipped settings card's group label — opening on the page's hairline. Its field and its save are the shipped `SettingsForm` and `SettingsValueField`: the threshold is typed as a capacity (`256K`, `1M`, or a plain count), and a draft the field cannot read (`2GB`) keeps its text and blocks the save.

A blank field stages an `unset` so the group re-inherits the composition layer and its 256000 default. Only that one child path is written, so the sibling `enabled` switch the page never shows survives every save.

Because the nav lists that entry among the Harness's own pages, a 13px tertiary intro under the heading names what owns the page and where a change applies. That header renders in every state — including a failed read — so the page never leaves "whose Team is this?" open. The name row is a form: a 36×200px field whose primary Save button owns the submit, so Enter saves a dirty field and Tab reaches that button as the next stop.

The avatar row draws a 40px identity circle (`border-radius: 50%` with `corner-shape: round`) carrying the image or the initial, a 更换头像 button driving a visually hidden `input[type="file"] accept="image/*"` capped at 10MB, and 移除头像 only while a stored `avatarRef` exists.

Both avatar seats draw the picture only while those bytes decode. The Host accepts an avatar by its declared media type rather than by decoding it, so a phone photo in HEIC or a payload damaged on the way in is stored and handed back as a data URL that renders nothing. `useAvatarImage` keys that answer by URL, so a seat shows the initial exactly as it does for a removed avatar and a new upload retries on its own. The footnote states the bundle version and links the repository; an update line appears only when the Host reports one.

`human-identity.ts` is the one reader of that profile. `TeamHumanIdentity` shares a single in-flight read between subscribers, reuses the avatar it already decoded while the reference is unchanged, keeps the last accepted value when a later read fails, and refreshes after every accepted write. Only a never-loaded profile becomes unavailable, rendering as `role="alert"` with its own retry.

Its writes go through the Team Remote's own `setHumanProfile` and avatar calls, which own the profile entry: the Client never writes the settings document for the identity fields, so it never has to name them.

`team-config.ts` is the one reader and writer of the threshold. The shared settings form addresses a namespace's top-level fields only, while the threshold lives inside the row's `memberCompaction` group, so a small `SettingsFormScope` adapter flattens that group for the form and maps its edits back onto child paths.

`TeamConfigController` wraps that adapter in a `SettingsFormModel` and publishes the one snapshot the page renders.

The Client injects `configForms` — a shipped service every settings consumer uses — and constructs the controller once per Client. If the service is absent the group is not rendered at all, and the controller is disposed with the rest of the navigation services.

A rejected write never leaves a 「正在保存…」 label standing. The identity rows report the Host's message in place under their own controls; the configuration group is the shipped form, so a save the deployment refused leaves its draft staged and states the shared "the deployment did not accept these values" line beside the save.

The Client's namespace constant is pinned by a test against the Host's own, so the two halves cannot drift silently.

At 390×844 the shipped panel keeps its 188px nav rail — it has no media query — which leaves the content column about 106px wide. The section therefore carries its own `@container (max-width: 420px)` rule that stacks each row's copy over its controls, drops the 48px right padding wide rows reserve for controls, and lets the field and buttons take the full column. The browser acceptance asserts no horizontal overflow there.

No horizontal-overflow probe catches the failure this group is prone to at that width: the shipped field lays its label and its 「已覆盖」 badge on one line, and in a ~106px column the label's own box collapses to zero width and paints one character per line. The field wrapper is therefore its own query container; under 200px the shipped field's row wraps so the badge sits beneath the label.

The selectors anchor on the shipped markup's shape rather than a class the field does not offer, so a shape change leaves the shipped layout in place. The acceptance measures the label's rendered box: a zero-width or wrapped label fails it, not only overflow.

## Environment check
Above the version footnote the page states one fact about the installation rather than about the Human: which DSH line this bundle runs against, and whether that line is inside the range the bundle declares. It is a second projection (`environment-check.ts`, `TeamEnvironmentCheck`), deliberately not a field of the identity store — it is read once, never written back, and the settings page is its only renderer.

It opens on the same hairline that separates the page's other rows. The verdict answers a question about this installation rather than about the Human above it, and without that rule the block reads as part of the identity row.

Three verdicts, never a fourth, and never a guess. A fact the Host cannot establish is `undetermined`, which is a settled answer rather than a failed request: the block has no retry, and an unreachable Host renders nothing at all rather than borrowing that word.

The verdict order is the contract. An unreadable running version is `undetermined`. A running version that violates any declared `@deepseek-ai/dsh-*` peer is `out-of-range`, and a real violation is never downgraded to `undetermined` merely because the peer set then yields no single line to print. Only when nothing is violated does the question become whether the declared range admits the version.

One range is stated, so every DSH peer must declare the same one. The prefix is `@deepseek-ai/dsh-` (`@deepseek-ai/cordis` shares the scope but is not on the DSH version line), and a drifted or empty set withholds the line rather than picking one peer to speak for the rest.

The `out-of-range` verdict is the only tier that takes a surface — `--dsw-alias-state-warn-tertiary` under `--dsw-alias-state-warn-label`, at the 12px radius of a row-sized surface — because it is the one state a reader may act on; the other two stay lines. Every tier states itself as text plus an icon, so the state survives a reader who cannot tell the colors apart.

The range is written in words, never as a bare semver range, because a range string is what a reader cannot check and a phrase is what they can. The certified combination (`Agent Team <bundle> × DSH <certified>`) prints only when both versions were derived: the installed manifest's own version, and the range's lower bound, which is what the repository gates pin as the certified baseline. A version that could not be read withholds the whole line rather than inviting a hand-written one onto the page.

Two versions a reader could reasonably confuse are therefore kept apart: the running DSH version is the environment, and the certified version is the declared line. They are the same string only while the installation sits on the baseline.

The block carries `data-environment` with its verdict, so an acceptance journey waits on a state rather than on prose.

## Project page and discussion panel
The Project page reads one timeline two ways. A tab strip under the header switches between them: `项目` is the feed, `看板` is a four-column board of the Task-status projection. The board is a second **reading**, not a second surface — a Task's state, owners, and title cannot disagree between the two views.

The board reads the Host's `taskBoard` projection — the same rows the Agent `team_task board` tool reads — not the feed's loaded window. One source means the board never merges the timeline's Messages to fill its columns, open Tasks are complete without paging, and the finished column opens on the newest few per Project the Host bounds and expands to the rest on request. The feed stays the only paged surface.

Columns are `待处理` / `进行中` / `待验收` / `已完成`, the five Task statuses folded so `done` and `closed` share the resolved column. Resolved cards dim rather than hide — the board's job is to keep moving work loudest while leaving finished work findable.

The finished column offers `展开全部已完成` under its head only while the Host reports it cut the column — the board value's `finishedTruncated` — and the control retires once the column shows everything, and at the deepest page the Host accepts, rather than standing there with nothing to do. A full column is not a cut one, so the control never appears on a page that merely happens to be full. An empty column states its own `0` in the head and draws no placeholder row, because a placeholder inside a column the count has already closed says the same thing twice.

A card splits the two people roles by their count. The accountable owner stays text — the reader as `你负责`, resolved from the board value's `humanMemberId` — because one named person has to be read. Executors are the avatar stack under a `执行者` caption, since they are 0–N read at a glance; an open Task nobody has claimed says `待认领`, and a resolved card drops the executor slot rather than claiming nobody is on it.

A `待你验收` badge rides the cards the reader may accept.

A Task started from the composer switches the Project to the board, and the keyboard focus lands on that Task's own new card rather than the `看板` tab. The composer unmounts with the switch, so focus has to move somewhere; the card the reader just created is that place, and Enter on it opens the Task. A pointer-driven send focuses the card without a visible ring, and the landing takes the same `:focus-visible` ring every board card draws — the tab is not rung.

The same card family serves the one cross-Workspace board (`TeamTaskBoardPage`, reached from the sidebar's 任务看板 entry — see [sidebar-browser.md](sidebar-browser.md)): three open-status columns over every visible Workspace, each card prefixed with its Project name. It answers to the same empty rule — the empty message stands alone, no column heads beside it — and carries no unread badges, which stay per-Thread facts on the Project face.

The first tab is `主对话`, the Project's Main stream (`TeamMainStream`), read from `mainStreamHistory` newest page first, older pages through `beforeSequence`. The second tab is the Task board; there is no version-1 feed.

A Thread card is the feed's one large target: the page ground at rest behind a hairline and the md radius, inset 10px/12px like the composer card. Its pointer answer is the surface itself — the interactive fill the Inbox row takes — not a border that only lightens, which left the fill untouched and made the one reacting edge fainter under the pointer.

The Main stream holds three entry kinds in ledger order: Main messages (the same `TeamMessage` row, with hover quote and copy), owner-added/owner-removed activity rows, and Thread cards.

A card is one button that shows the Thread's current state, never one row per transition. A discussion card names its first line, reply count and participant count; a Task card shows its number, status and, until it resolves, its live Claim owners or `待认领`. A discussion card opens the Thread side panel; a Task card opens the Task's Thread page.

Both faces draw that card with the same component, and the discussion panel draws the Tasks its discussion spawned with it too: the status, the live Claim owners and the reply count must not depend on which of the three is open. A derived card sits at the sequence of the fact that created its Task, never collected at the end of the timeline, and clicking it opens that Task's Thread page.

Where a discussion opens is a navigation fact, not a panel's private state: `discussionRef` rides the persisted Team location beside `projectRef`, so a reload reopens the same Project with the same discussion beside it. A Task Thread covers the whole page but does not erase that Project face: entering a Task from its own Project keeps the panel state underneath, and Back restores it; Inbox, board, another Task page, promotion and a sibling-Project Task replace it the way they replace any other location.

While the tab is mounted, a standing with unread entries or markers is acknowledged through `readMainStream`. An entry that arrives unread states the arrival with a thin accent in a reserved gutter, and releases it three seconds later on its own clock — the gutter stays reserved, so nothing shifts when it goes. The mark is information, not furniture: keeping it until the reader leaves the page turned a per-visit state into a permanent one, which is what the Human reported.

Durable unread stays where it can be acted on — the sidebar's count and the card's own accessible name — because a mark that expires cannot be the only statement of it.

The board is the one Client surface allowed past the 880px reading column, up to 1240px: four status columns are a scanning surface, and narrowing them to the reading measure would cost every column its card width.

The columns are equal (`flex: 1` with `min-width: 0`), so a longer title in one column cannot buy it more room than its neighbours, and they sit on `--dsw-alias-bg-module-platform` — the shipped recessed fill a grouped module uses — so the cards' own base fill reads as raised against them.

A board card answers the pointer on its own surface too, with the interactive fill the Thread card and the Inbox rows take. Lightening only the border was the defect here as well, and worse on this ground: the fill never moved, so a fainter edge was the whole feedback. A discussion's derived Task card takes the same answer, so a Task is one card language wherever it appears.

The tab strip is a composite control: `role="tablist"` with two `role="tab"` buttons, one tab stop for the group (`tabIndex` -1 on the unselected tab), each tab naming the panel it controls through `aria-controls`/`aria-labelledby`, and Left/Right/Home/End moving selection **and** focus together.

It takes the shipped session page's own tab language — 13px/16px weight 500, a 36px gap, and a 2px underline in `--dsw-alias-state-business-primary`. The underline rides a pseudo-element and reaches 1px past the tab's box, so it ends flush with the header's closing rule and the two read as one edge — the shipped strip's own arrangement. The inactive tab is tertiary and the selected one is business blue rather than ink, because `--dsw-alias-brand-primary` resolves to neutral black in this token sheet; shipped states the same reason on its own strip.

A taskless Thread opens beside the feed in a right-hand panel rather than replacing the page. The panel is a discussion's whole face: its head names it and offers promotion plus a close, its body reads the facts with the same day separators and runs as any timeline, and its foot is the ordinary composer at the same `thread:<threadRef>` draft key, so a half-written reply survives the trip between the panel and the Thread page. A Task's entry still walks into the Thread page, which is where acceptance lives.

The panel is the surface's own child, not the feed's: it spans the band above the feed as well as the feed itself, as one column from the top of the page to the bottom. That is what lets its head share the band's identity row — the same 10px top inset and 30px row as `# name` and its description — instead of starting under the tab strip.

It is also why the head carries no closing rule of its own: the band's rule already ends that row, and a second line beside it would draw a boundary where nothing is bounded. For the same reason the panel's composer stands on the feed composer's line with no rule above it.

The panel's seat is reserved only while it is open, and only beside the feed. An always-on reservation would spend a band of the reading surface on nothing for the whole life of the page and charge every line of the feed for it; the price of releasing it is a single re-wrap at the moment the reader opens or closes the panel, when their attention has moved to the panel anyway.

Opening the panel is a decision about where to read, so its width is the reader's: the panel takes the larger share of the stage on open — 52% of it, clamped to 420–960px — and a seam between the two surfaces drags that share either way.

Both surfaces read one variable, so the feed gives up exactly what the panel takes and the panel can never paint over it, and a drag repaints without re-rendering either side. The seat persists per browser and re-clamps to whatever surface it reopens on, so a width chosen on a wide window never overflows a narrow one. The band gives up the same width while the panel is open, so a long description ellipsizes beside the seam instead of running underneath it.

The seam is a real separator control with a keyboard path — the arrow keys nudge it, Shift for a coarse step — because a pointer-only affordance would leave those readers with the seat they cannot change. The panel and the feed share the surface's full height: the head sits in the band's identity row, and both composers stand on the same foot line.

Below the shared 600px breakpoint the panel covers the feed whole instead of standing beside one too narrow to read: the two take the surface's single column and the feed's rows, so the panel paints over the feed while the band above stays visible and keeps its own width. Placing either of them out of that column would open a second implicit column and squeeze the feed to a sliver rather than covering it.

Promotion from the panel is the same Human-only durable mutation the Thread page runs, and it ends the panel's job: on success the panel closes as the reader walks into the new Task's Thread page.

An Inbox row enters a discussion by the rule its full page follows: the panel opens on the first unread Message naming the Human, centred and briefly marked, with the boundary above it; without one it opens at the newest. The Inbox names a Thread, never a Message, so the panel derives the position from the Inbox origin. An ordinary Main stream opening keeps the newest-first seat. A read committed in the panel clears its feed row's unread capsule at once, not on the next Inbox read. A Task opened from an Inbox row returns to its Project, not the Inbox.

## Whole-surface loading state
Every surface that has nothing to show yet — the Inbox, the global Task board, both Thread seats, the Project feed and the Project board tab — renders the same box: `.emptySurface` holding a `.loadingState` line whose pulse mark (`.loadingMark`, `aria-hidden`) precedes the words.

The box centres in the free space by taking it (`min-height: 100%`, `box-sizing: border-box`) rather than relying on the container being a flex column. That is what puts the two block scroll boxes — the board and the discussion panel — on the same axis as the reading surfaces; the mechanism is stated in [`layout-and-typography.md`](layout-and-typography.md).

The line says what is loading and always uses the 「正在加载…」 verb family: `正在加载收件箱…`, `正在加载看板…`, `正在加载主对话…`, `正在加载 Thread…`. Each surface owns its own key. A feed that borrows another surface's sentence tells the reader the wrong thing is loading, which is how the Main stream once loaded under the Projects sentence.

A loading frame is never drawn in the empty state's clothes. The status classes are separate — `loadingState` for a read in flight, `emptyState` for a projection that came back empty — because the two are different claims about the surface, and a board that renders its loading frame as an empty one reads as 「already empty」 rather than 「still reading」.

A whole-surface failure stands on this same box, carrying `min-height: 100%` beside `margin: auto`, so one surface never shows its loading state in the middle and its failure against the top edge.

## Failure surfaces
A failed projection renders one of two shapes, and the choice is a claim about what is still on screen. When nothing was ever loaded, the failure replaces the whole surface as `errorState`: it rides the same free space as the loading and empty surfaces it stands in for (`margin: auto`, `padding: 32px 0`), keeps to the 880px reading column, and takes the 12px/18px error scale in `--dsw-alias-state-error-primary`. It carries the Host's message plus one `重试` that re-issues the read — message and retry inside a single `role="alert"`.

When rows are still standing, the failure is the inline `error` line instead: `margin: 0` inside the content column, reading as the last line of the list it belongs to rather than re-centering a populated surface. Neither shape ever doubles as an empty state — an empty claim requires a successful projection that came back empty (`view !== undefined`, no error, nothing in it) — so a dropped connection cannot read as an empty workspace.

The rail speaks the same two shapes at rail scale. A Panel's own failure line is 11px/16px in `--dsw-alias-state-error-primary`, inset 12px so its text lands on the row labels it replaces (list inset 4px + row inset 8px) rather than on the Panel edge; a row's own failure (`rowAlert`) keeps that scale inside the row. Panel failures stay per Panel: each mounted Panel reports the drop it saw, so one outage shows the same message on the rail and, where the body's own read failed, on the page too.

A Panel's line carries no retry control; the rail heals from the change stream, which reports an outage once and wakes every listener when the transport answers again (see [`host-authority.md`](../architecture/host-authority.md)).

## Thread header band
The Thread's header band carries the back row, the Task identity, and the runtime-risk section, and it closes with the one rule `.surfaceHeader` draws. A section inside it therefore separates by **space alone** — a section-level `border-top` would draw a second line around nothing, since the band's own rule already ends the group above.

Separator count is a measurable property here, not a matter of taste: shipped DSH draws them *between* groups (`PluginInventorySettingsTab.module.css`, `.group + .group { border-top: 0.5px solid … }`), so the per-section `1px solid var(--dsw-alias-border-l2)` was both off-convention and redundant. What stays: the band's `border-bottom` (a real structural boundary) and the unread boundary line in the timeline (a semantic one).

The band is height-budgeted rather than merely tidy — with two erroring Members it ran 426px of a 960px viewport and pushed the conversation below the fold, while sections that separate by space fit the same content in 360px.

The one separator the band does draw is the `1px solid var(--dsw-alias-border-l2)` rule *between* its two action groups, which is the same between-groups convention applied to the action band: following a Thread and moving its responsibility are what a reader does with it, accepting and closing are what resolves it. The rule states that hierarchy in place of whitespace. Four sibling action containers spread by `justify-content: space-between` used to read as four isolated buttons hundreds of pixels apart.

Uniformity across that band is a set of equations, and the e2e measures them in one render instead of reviewing the row by eye: one height (28px, the shipped `sm` box), one radius (`--dsw-radius-sm`), one inline inset (10px), one outlined stroke, one 6px step between the controls. Width is deliberately absent — a label's length is content, not chrome — and so is any control whose presence depends on the Task, because which of them may stand together is the Host's answer rather than a styling fact.

The visible verbs shorten to `关注` / `取消关注` / `转交` so four controls share one line, while the accessible name keeps the full phrase (`关注此 Thread`, `转交负责人`): the band states the object once and each control states its action, so the shorter word never drops what the action applies to.

Shortening the visible word must not shorten the announcement. While a write runs, the accessible name takes the long pending phrase (`正在更新关注状态…`, `正在转交负责人…`) instead of staying at the idle one, because the shortened visible word is not what a screen reader reads: a name frozen at the idle phrase would announce an action as though nothing were happening. The pending phrase is a standing rather than a rename — the settled control announces its idle phrase again.

A followed Thread reads as pressed. The shipped `Button` paints nothing for `aria-pressed`, so "followed" and "not followed" used to differ by a stroke alone. The on-state takes the shipped selected vocabulary — the ghost-active fill under a same-family stroke, as `Pill` and `ClockPicker` already do — rather than a second solid fill, because acceptance is the one primary this band carries and a second filled block would flatten the hierarchy the band exists to state. The attribute stays part of the selector, so the state rests on the button's own semantics.

That band's feedback line is a third failure shape beside `errorState` and `error`: one 12px/18px line per refusing control, under the band and inside its padding. The whole-surface shape centres itself in the free space it replaces, so borrowing it here would push the timeline down by its 32px padding instead of stating what went wrong where the control is. Each control keeps its own line, so two failed writes never collapse into one message the reader has to attribute.

A committed transfer states its result in the same slot at the same grade, in the secondary ink: the Host's activity row records it in the feed, but a long Thread scrolls that row away from the control just used. The receipt is derived from the projection, so a later move retires it rather than leaving a line claiming the Task is somewhere it no longer is.

The band names the Task and states what is wrong with it; it does not carry the Task's work queue. A Claim reaches the reader as the fact that recorded it — the activity line in the timeline — and as the owners drawn on a feed entry row, and the early-accept dialog still lists the open Claims it will complete, because that list is what the acceptance is decided on. No surface lists Claims on demand, so the band stays identity plus a real problem.

The runtime-risk row is one line per erroring Member, and its leading token is the **localized name of the diagnostic's structured class** — `session-refused`, `session-unreadable`, `preset-composition`, `rollover`, `runtime`, `activation`, the policy axis `AgentTeamMemberDiagnostic.class` already carries and `restartOffered` already branches on.

That class answers the localizable question "what kind of problem is this", while the Host's `detail` is English by construction; the row therefore clamps the detail to its first sentence and keeps the full text on the row's `title`.

`AgentTeamClientMemberStatus` already carries the whole diagnostic to the browser, so this axis needs no Host protocol change. One sentence key per class keeps the visible line in the interface language instead of pasting a Host string into a localized surface, and a Member with no diagnostic resolves to the `runtime` wording rather than leaving a hole.

The opener under the Task or Thread identity is **one clamped line at every width and for every Thread kind**, with the full text on its `title`. A Task's title runs long and embeds unbreakable refs, and a discussion's opener is its own anchor message, repeated in full in the timeline directly below. A second line in the band would therefore spend header height on text the reader can already see, and make the band's height depend on how much someone happened to type.

One line keeps a long opener and a two-character one at the same band height (measured: 114px either way on a taskless Thread).

A stacked band — Inbox, the Task board, a Thread page — states its own height: a 28px title line, the 3px step and a 20px description line, a 51px floor. Its description line renders in every state: the counts while there is a queue, a sentence naming the face while there is not. A band with data and one without therefore measure the same to the pixel.

The Project page is the other shape — description on the title's baseline, tab strip below — and keeps its own 10px top inset and 30px identity row, the shipped session header's rhythm.
