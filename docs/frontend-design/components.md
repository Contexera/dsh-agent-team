# Component contracts

English | [中文](components.zh.md)

## TeamMessage
Props include sender identity, body, optional time, mention handles, sender title, grouping, and children. Only adjacent same-sender Message rows group; Activity rows break runs. Grouped rows hide avatar/name while preserving grid alignment. The initial of the sender name (without `@`) is shown.

The identity seat draws a picture for exactly one author. The profile avatar lands on a row only while that row is the Human's own, so an Agent row keeps the shared hue and the sender initial whatever the surface passes down — one seat painting the reader's face for another author would name two people alike.

Row actions float beside the Message in a card rather than living on it: copy, the quote action, and — when the body itself names the reader — the `Mentioned you` notice. The card belongs to the row rather than to one action. A surface that withholds quoting (`rowActions` without `onReply`) keeps copy and the notice and drops only the quote button, while a surface that passes neither offers no card at all, which is what the Channel feed does.

The two surfaces that read a Thread both offer the card: its page, and the discussion panel beside the Channel feed. They render the same rows, and a reader who turned to the panel would otherwise leave it to quote the Message in front of them. The row itself stays flat, so one hovered Message gains a layer instead of the whole timeline gaining texture.

A Message that answers another leads its body with the resolved quote (`data-quote-line`): the parent's author and one ellipsised line of its opening text, both resolved by the Host from the ledger rather than read out of the body. The quote therefore cannot disagree with what it points at, and still fills in when the parent sits outside the loaded history. The whole block jumps to the original wherever the surface can reach it and is inert text otherwise; a Message that is not a reply renders none.

Bodies over the 600-character formatter threshold use a persistent wrapper with an approximately eight-line/176px preview and quiet “expand/collapse” button carrying `aria-expanded`. Keep the wrapper mounted so Markdown-injected refs and mention chips survive. Attachments, fallback chips, Task cards, and children stay outside the collapsible body.

That same wrapper carries `data-document`: the threshold that folds a body also calls it a document, so its Markdown reads on the document rhythm (Typography table above) while short messages keep the chat grid, and the preview stays eight lines of whatever the content-font axis sets.

## Message runs
A run groups consecutive same-sender Messages and its Thread entry row. Activity and unread boundaries break runs. An entry row in a grouped row gets a hairline; ordinary continuation does not. Runs have no hover box, fill, shadow, or permanent border—only two-pixel spacing. Time is stated by the row that owns it, never by a line: a row with an identity line states its instant beside the name, a continuation row in the avatar seat under the pointer or keyboard focus.

The seat states the time of day only — it is 34px and does not clip, while a dated label is 57px within the year and 87px across it. The date therefore stays with the identity line that opened the run and the day separator above it, and the exact instant rides the label's `title`. A day boundary gets its anchor, and the Channel feed alone draws a five-minute `TeamRunDivider` hairline, carrying no instant.

## Mentions and Task refs
Mention chips are rendered only for handles in the Message's resolved mention list, matching the authored `@Handle` case-insensitively on Unicode word boundaries — a bare name without its `@` is prose and never chipifies, and code stays literal. A chip names the person as they are called today. The Human's pre-rename handle stays an alias the Host still delivers to, so a Message whose body wrote `@human` chips in place as the current profile name instead of landing in the trailing row under a name its body never used.

Human literal, Agent plain prose, and rich Markdown use their corresponding segmentation path; absent names become a trailing fallback row without duplication.

The reader's own handle is the one chip that leaves the business family: `[data-mention-human]` paints it in the success alias, because the error and warn families mean a failure and a caution while every other chip stays business. The trailing fallback row never repeats the reader's own name — that would print a bare `@me` under a body that already chips it in place — nor an author the quote line above it already names, since that line states the delivery itself. A quote that no longer resolves names nobody, so there the chip is the only place the delivery still shows.

Known branded `task:*` refs are resolved in batches and rendered at their original position as clickable `Task #N` in Human, plain Agent, and rich Markdown text. Code fences, indented code, mixed inline code, and existing links stay literal. Normalize malformed double-colon or uppercase spellings before resolution. Resolved refs can navigate across Workspace, Channel, and Thread; failed refs remain plain text. Task numbers are home-Channel creation ordinals, while branded refs remain stable identity.

Known branded `thread:*` refs resolve the same way through `resolveThreadRefs` and render at their original position as clickable Thread chips titled with the cited Thread's opening line (`讨论 · …` in Chinese), so one taskless Thread no longer reads exactly like the next. A ref becomes a link only when the Host confirms it — abbreviated spellings included — and clicks navigate by the resolved full ref, so unresolvable text stays plain and never silently no-ops.

Known branded `channel:*` refs render at their original position as Channel chips naming the cited Channel (`频道 · …` under the Chinese locale, `Channel · …` under English); clicks hop to that Channel. Known branded `member:*` refs render as Member chips naming the cited Member (`成员 · @…` / `Member · @…`) — deliberately distinct from `@mention` chips, which notify, while a cited ref never does. Clicking an active Member's chip opens their session exactly the way the agent card does; suspended Members and the Human render as labelled but inert text.

Both resolve against the already-loaded Channel and member rosters with no new Host call, so a ref outside the loaded window stays plain text under the same rule unresolvable refs follow.

## Count capsule
`TeamCountBadge.tsx` over `countBadge.module.css .badge` is the one count capsule, and every count the Human reads wears it: the Channel feed's Thread entry, each Inbox queue row, and a Task card on the Channel board. One hand-written copy per surface — which is what there was before they were shared — is exactly what let the feed's copy sit on a different line box from the queue rows', with its digit a pixel away from theirs.

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

The page holds two writable groups that answer to two different documents, and it never renders one as the other. Identity reads and writes through the Team Remote, while the judge's endpoint is one group of the Team Host row's settings section and writes through the settings provider. A form rendered wholesale over that namespace would put identity fields into the judge's group and address a flat `apiBase` at the wrong path.

Because the nav lists that entry among the Harness's own pages, a 13px tertiary intro under the heading names what owns the page and where a change applies. That header renders in every state — including a failed read — so the page never leaves "whose Team is this?" open. The name row is a form: a 36×200px field whose primary Save button owns the submit, so Enter saves a dirty field and Tab reaches that button as the next stop.

The avatar row draws a 40px identity circle (`border-radius: 50%` with `corner-shape: round`) carrying the image or the initial, a 更换头像 button driving a visually hidden `input[type="file"] accept="image/*"` capped at 10MB, and 移除头像 only while a stored `avatarRef` exists.

Both avatar seats draw the picture only while those bytes decode. The Host accepts an avatar by its declared media type rather than by decoding it, so a phone photo in HEIC or a payload damaged on the way in is stored and handed back as a data URL that renders nothing. `useAvatarImage` keys that answer by URL, so a seat shows the initial exactly as it does for a removed avatar and a new upload retries on its own. The footnote states the bundle version and links the repository; an update line appears only when the Host reports one.

`human-identity.ts` is the one reader of that profile. `TeamHumanIdentity` shares a single in-flight read between subscribers, reuses the avatar it already decoded while the reference is unchanged, keeps the last accepted value when a later read fails, and refreshes after every accepted write. Only a never-loaded profile becomes unavailable, rendering as `role="alert"` with its own retry.

Writes reach the settings namespace through `remote.settings.update(namespace, patch, expectedRevision)` and `mutate(…, [{ op: 'unset', path: ['avatarRef'] }])`, resolved through an optional `ctx.inject(['remote.settings'])` binding: reading `ctx.remote.settings` without declaring it throws, and a hard activation dependency would take the whole Client down whenever the settings service is missing, so an absent service is reported as unavailable instead.

The section reports a rejected write's Host message in place rather than leaving a 「正在保存…」 label standing.

The Client's namespace constant is pinned by a test against the Host's own, so the two halves cannot drift silently.

At 390×844 the shipped panel keeps its 188px nav rail — it has no media query — which leaves the content column about 106px wide. The section therefore carries its own `@container (max-width: 420px)` rule that stacks each row's copy over its controls, drops the 48px right padding wide rows reserve for controls, lets the field and buttons take the full column, and gives the judge's answer its own line, flush with the row, its glyph leading the sentence. The browser acceptance asserts no horizontal overflow there and measures that glyph against the first line it leads.

## Environment check
Above the version footnote the page states one fact about the installation rather than about the Human: which DSH line this bundle runs against, and whether that line is inside the range the bundle declares. It is a second projection (`environment-check.ts`, `TeamEnvironmentCheck`), deliberately not a field of the identity store — it is read once, never written back, and the settings page is its only renderer.

It opens on the same hairline that separates the page's other rows. The verdict answers a question about this installation rather than about the endpoint above it, and without that rule it reads as part of the judge's own group.

Three verdicts, never a fourth, and never a guess. A fact the Host cannot establish is `undetermined`, which is a settled answer rather than a failed request: the block has no retry, and an unreachable Host renders nothing at all rather than borrowing that word.

The verdict order is the contract. An unreadable running version is `undetermined`. A running version that violates any declared `@deepseek-ai/dsh-*` peer is `out-of-range`, and a real violation is never downgraded to `undetermined` merely because the peer set then yields no single line to print. Only when nothing is violated does the question become whether the declared range admits the version.

One range is stated, so every DSH peer must declare the same one. The prefix is `@deepseek-ai/dsh-` (`@deepseek-ai/cordis` shares the scope but is not on the DSH version line), and a drifted or empty set withholds the line rather than picking one peer to speak for the rest.

The `out-of-range` verdict is the only tier that takes a surface — `--dsw-alias-state-warn-tertiary` under `--dsw-alias-state-warn-label`, at the 12px radius of a row-sized surface — because it is the one state a reader may act on; the other two stay lines. Every tier states itself as text plus an icon, so the state survives a reader who cannot tell the colors apart.

The range is written in words, never as a bare semver range, because a range string is what a reader cannot check and a phrase is what they can. The certified combination (`Agent Team <bundle> × DSH <certified>`) prints only when both versions were derived: the installed manifest's own version, and the range's lower bound, which is what the repository gates pin as the certified baseline. A version that could not be read withholds the whole line rather than inviting a hand-written one onto the page.

Two versions a reader could reasonably confuse are therefore kept apart: the running DSH version is the environment, and the certified version is the declared line. They are the same string only while the installation sits on the baseline.

The block carries `data-environment` with its verdict, so an acceptance journey waits on a state rather than on prose.

## Judge endpoint group
The page's second group points jev at an endpoint: three controls — apiBase, model, and the write-only key — waiting behind a collapsed disclosure whose row is the whole control. The row carries the state and the chevron; the fields appear when it opens, and the opened body carries `role="group"` named by that title, because the page shows two saves and neither may be announced without context.

Collapsed is the default because the endpoint is set once and then left alone, while its state is worth seeing every time the page opens. The controls are absent from the DOM while it is closed rather than hidden in it. A disclosure that only hides its content stays reachable by Tab and by a screen reader, so the browser acceptance pins that absence — no `[data-team-judge]` body, no fields — rather than the styling that suggests it.

The state is that row rather than a line above the fields: `remote.agentTeam.contextJudge` answers whether jev is reachable, and the row states the Host's own answer as words plus a 14px glyph, carried on `data-context-judge` — `enabled`, `no-key`, `unavailable`. Only `unavailable` takes the warn colour, because a missing key is a step to take while an unreachable endpoint is something to fix. The row says nothing before the first read settles, and `detail` stays a Host diagnostic rather than user copy.

The gate's thresholds and the key's environment variable share that same row and are deliberately absent: they are row configuration the Team owns, and a deployment can still set them in its own patch layer. The Client reads only the `jev` group, through a projection adapter that flattens the section's `value`, `base`, and `user` layers and maps each control name onto the path it really lives at (`['jev','apiBase']`).

The form is the shipped settings stack — `SettingsFormModel` with `SettingsForm`, `SettingsValueField`, and `SettingsSecretField` — so drafts, override badges, reset, and the save behave as they do on the Harness's own settings pages. Every write goes through `ctx.configForms.get(namespace)`, which owns the revision fence and folds the Host's answer back into the mirror; a save that did not land keeps its drafts and says so, and a landed one re-reads the status.

The key is write-only: the Host redacts the literal, so the control starts blank on every load, and a blank draft writes nothing — opening the page can never clear a stored key. The configured badge comes from the describe mirror's `secrets` list, the only place that state is readable. Removing a literal is an explicit clear of its own, offered only while no draft is staged, because a write moves the document revision a staged save is fenced to.

The group is offered only while this deployment serves a settings document: the section is registered regardless, because identity is reachable without one, and an absent settings service simply leaves the group out. Inside a served document the group still answers for itself — a read-only document disables its controls and says so, and a namespace that is not served renders the form's own unavailable line instead of fields nothing would accept.

The form reaches the page through an observable seat rather than as a value. A slot entry's injected props are computed once and cached for that entry's lifetime, so a settings service answering after the first render would otherwise leave the group off the page until a reload. Filling the seat after render is what the page's own test pins.

## Channel page and discussion panel
The Channel page reads one timeline two ways. A tab strip under the header switches between them: `频道` is the feed, `看板` is a four-column board of the Task-status projection. The board is a second **reading**, not a second surface — it re-sorts the same projection, so a Task's state, owners, and title cannot disagree between the two views, and neither view fetches anything the other has not.

The board reads the window the feed has already loaded, not the Channel's whole history. A board that paged the Channel until `hasMore` was false would merge every top-level Message into the timeline, defeating the feed's own pagination to fill four columns, and it would make opening a tab an unbounded read.

The feed's `加载更早消息` is how the board gets older work: one affordance, one page size, and the two views always describe the same set of facts.

Columns are `待处理` / `进行中` / `待验收` / `已完成`, the five Task statuses folded so `done` and `closed` share the resolved column. Resolved cards dim rather than hide — the board's job is to keep moving work loudest while leaving finished work findable. A column with nothing in it states its own `0` in the head; it draws no placeholder row, because a placeholder inside a column the count has already closed says the same thing twice.

The board is the one Client surface allowed past the 880px reading column, up to 1240px: four status columns are a scanning surface, and narrowing them to the reading measure would cost every column its card width.

The columns are equal (`flex: 1` with `min-width: 0`), so a longer title in one column cannot buy it more room than its neighbours, and they sit on `--dsw-alias-bg-module-platform` — the shipped recessed fill a grouped module uses — so the cards' own base fill reads as raised against them.

The tab strip is a composite control: `role="tablist"` with two `role="tab"` buttons, one tab stop for the group (`tabIndex` -1 on the unselected tab), each tab naming the panel it controls through `aria-controls`/`aria-labelledby`, and Left/Right/Home/End moving selection **and** focus together.

It takes the shipped session page's own tab language — 13px/16px weight 500, a 36px gap, and a 2px underline in `--dsw-alias-state-business-primary`. The underline rides a pseudo-element and reaches 1px past the tab's box, so it ends flush with the header's closing rule and the two read as one edge — the shipped strip's own arrangement. The inactive tab is tertiary and the selected one is business blue rather than ink, because `--dsw-alias-brand-primary` resolves to neutral black in this token sheet; shipped states the same reason on its own strip.

A taskless Thread opens beside the feed in a right-hand panel rather than replacing the page. The panel is a discussion's whole face: its head names it and offers promotion plus a close, its body reads the facts with the same day separators and runs as any timeline, and its foot is the ordinary composer at the same `thread:<threadRef>` draft key, so a half-written reply survives the trip between the panel and the Thread page. A Task's entry still walks into the Thread page, which is where Claims and acceptance live.

The panel is the surface's own child, not the feed's: it spans the band above the feed as well as the feed itself, as one column from the top of the page to the bottom. That is what lets its head share the band's identity row — the same 10px top inset and 30px row as `# name` and its description — instead of starting under the tab strip.

It is also why the head carries no closing rule of its own: the band's rule already ends that row, and a second line beside it would draw a boundary where nothing is bounded. For the same reason the panel's composer stands on the feed composer's line with no rule above it.

The panel's seat is reserved only while it is open, and only beside the feed. An always-on reservation would spend a band of the reading surface on nothing for the whole life of the page and charge every line of the feed for it; the price of releasing it is a single re-wrap at the moment the reader opens or closes the panel, when their attention has moved to the panel anyway.

Opening the panel is a decision about where to read, so its width is the reader's: the panel takes the larger share of the stage on open — 52% of it, clamped to 420–960px — and a seam between the two surfaces drags that share either way.

Both surfaces read one variable, so the feed gives up exactly what the panel takes and the panel can never paint over it, and a drag repaints without re-rendering either side. The seat persists per browser and re-clamps to whatever surface it reopens on, so a width chosen on a wide window never overflows a narrow one. The band gives up the same width while the panel is open, so a long description ellipsizes beside the seam instead of running underneath it.

The seam is a real separator control with a keyboard path — the arrow keys nudge it, Shift for a coarse step — because a pointer-only affordance would leave those readers with the seat they cannot change. The panel and the feed share the surface's full height: the head sits in the band's identity row, and both composers stand on the same foot line.

Below the shared 600px breakpoint the panel covers the feed whole instead of standing beside one too narrow to read: the two take the surface's single column and the feed's rows, so the panel paints over the feed while the band above stays visible and keeps its own width. Placing either of them out of that column would open a second implicit column and squeeze the feed to a sliver rather than covering it.

Promotion from the panel is the same Human-only durable mutation the Thread page runs, and it ends the panel's job: on success the panel closes as the reader walks into the new Task's Thread page. A read committed in the panel clears its feed row's unread capsule immediately rather than waiting for the next Inbox read to land.

## Failure surfaces
A failed projection renders one of two shapes, and the choice is a claim about what is still on screen. When nothing was ever loaded, the failure replaces the whole surface as `errorState`: it rides the same free space as the loading and empty surfaces it stands in for (`margin: auto`, `padding: 32px 0`), keeps to the 880px reading column, and takes the 12px/18px error scale in `--dsw-alias-state-error-primary`. It carries the Host's message plus one `重试` that re-issues the read — message and retry inside a single `role="alert"`.

When rows are still standing, the failure is the inline `error` line instead: `margin: 0` inside the content column, reading as the last line of the list it belongs to rather than re-centering a populated surface. Neither shape ever doubles as an empty state — an empty claim requires a successful projection that came back empty (`view !== undefined`, no error, nothing in it) — so a dropped connection cannot read as an empty workspace.

The rail speaks the same two shapes at rail scale. A Panel's own failure line is 11px/16px in `--dsw-alias-state-error-primary`, inset 12px so its text lands on the row labels it replaces (list inset 4px + row inset 8px) rather than on the Panel edge; a row's own failure (`rowAlert`) keeps that scale inside the row. Panel failures stay per Panel: each mounted Panel reports the drop it saw, so one outage shows the same message on the rail and, where the body's own read failed, on the page too.

A Panel's line carries no retry control; the rail heals from the change stream, which reports an outage once and wakes every listener when the transport answers again (see [`host-authority.md`](../architecture/host-authority.md)).

## Thread header band and the Claim panel
The Thread's header band carries the back row, the Task identity, the runtime-risk section, and the Claims section, and it closes with the one rule `.surfaceHeader` draws. The two sections inside it therefore separate by **space alone** — a section-level `border-top` would draw a second line around nothing, since the band's own rule already ends the group above.

Separator count is a measurable property here, not a matter of taste: shipped DSH draws them *between* groups (`PluginInventorySettingsTab.module.css`, `.group + .group { border-top: 0.5px solid … }`), so the per-section `1px solid var(--dsw-alias-border-l2)` was both off-convention and redundant. What stays: the band's `border-bottom` (a real structural boundary) and the unread boundary line in the timeline (a semantic one).

The band is height-budgeted rather than merely tidy — with two erroring Members it ran 426px of a 960px viewport and pushed the conversation below the fold, while sections that separate by space fit the same content in 360px.

A Claim row is **three grid tracks that are all occupied**: the presence dot, the identity-and-state group, and the direction. Identity and its state share the first line and the direction owns the second. The handle is therefore never a suffix adrift at a wide row's far end (at 880px the old single-line layout left the handle 158px past the direction it belonged to), and the state never floats at the row's right edge away from the Claim it qualifies.

The narrow breakpoint does not re-template the row: one `14px minmax(0, 1fr) auto` template holds at 1440 and at 390, so the two widths cannot drift apart, and the 14px dot column plus the list's 22px inset keep every dot on the same spine as the `Claims · N` title above them. The row's leading presence dot is the row's **only** liveness signal — an extra "available" badge beside the handle states one fact twice, which a reader notices before they can name it.

A `done` Claim carries `claimRowDone`, stepping its direction down to secondary so finished work stops competing with live work, without hiding the Claim.

The runtime-risk row is one line per erroring Member, and its leading token is the **localized name of the diagnostic's structured class** — `session-refused`, `session-unreadable`, `preset-composition`, `rollover`, `runtime`, `activation`, the policy axis `AgentTeamMemberDiagnostic.class` already carries and `restartOffered` already branches on.

That class answers the localizable question "what kind of problem is this", while the Host's `detail` is English by construction; the row therefore clamps the detail to its first sentence and keeps the full text on the row's `title`.

`AgentTeamClientMemberStatus` already carries the whole diagnostic to the browser, so this axis needs no Host protocol change. One sentence key per class keeps the visible line in the interface language instead of pasting a Host string into a localized surface, and a Member with no diagnostic resolves to the `runtime` wording rather than leaving a hole.

The opener under the Task or Thread identity is **one clamped line at every width and for every Thread kind**, with the full text on its `title`. A Task's title runs long and embeds unbreakable refs, and a discussion's opener is its own anchor message, repeated in full in the timeline directly below. A second line in the band would therefore spend header height on text the reader can already see, and make the band's height depend on how much someone happened to type.

One line keeps a long opener and a two-character one at the same band height (measured: 114px either way on a taskless Thread).
