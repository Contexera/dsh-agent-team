# Component contracts

English | [中文](components.zh.md)

## TeamMessage
Props include sender identity, body, optional time, mention handles, sender title, grouping, and children. Only adjacent same-sender Message rows group; Activity rows break runs. Grouped rows hide avatar/name while preserving grid alignment. The initial of the sender name (without `@`) is shown.

The identity seat draws a picture for exactly one author: the profile avatar lands on a row only while that row is the Human's own, so an Agent row keeps the shared hue and the sender initial whatever the surface passes down — one seat painting the reader's face for another author would name two people alike.

Bodies over the 600-character formatter threshold use a persistent wrapper with an approximately eight-line/176px preview and quiet “expand/collapse” button carrying `aria-expanded`. Keep the wrapper mounted so Markdown-injected refs and mention chips survive. Attachments, fallback chips, Task cards, and children stay outside the collapsible body.

That same wrapper carries `data-document`: the threshold that folds a body also calls it a document, so its Markdown reads on the document rhythm (Typography table above) while short messages keep the chat grid, and the preview stays eight lines of whatever the content-font axis sets.

## Message runs
A run groups consecutive same-sender Messages and its Thread entry row. Activity and unread boundaries break runs. An entry row in a grouped row gets a hairline; ordinary continuation does not. Runs have no hover box, fill, shadow, or permanent border—only two-pixel spacing. Five-minute dividers and day anchors carry time context.

## Mentions and Task refs
Mention chips are rendered only for handles in the Message's resolved mention list, matching the authored `@Handle` case-insensitively on Unicode word boundaries — a bare name without its `@` is prose and never chipifies, and code stays literal. A chip names the person as they are called today: the Human's pre-rename handle stays an alias the Host still delivers to, so a Message whose body wrote `@human` chips in place as the current profile name instead of landing in the trailing row under a name its body never used.

Human literal, Agent plain prose, and rich Markdown use their corresponding segmentation path; absent names become a trailing fallback row without duplication.

Known branded `task:*` refs are resolved in batches and rendered at their original position as clickable `Task #N` in Human, plain Agent, and rich Markdown text. Code fences, indented code, mixed inline code, and existing links stay literal. Normalize malformed double-colon or uppercase spellings before resolution. Resolved refs can navigate across Workspace, Channel, and Thread; failed refs remain plain text. Task numbers are home-Channel creation ordinals, while branded refs remain stable identity.

Known branded `thread:*` refs resolve the same way through `resolveThreadRefs` and render at their original position as clickable Thread chips titled with the cited Thread's opening line (`讨论 · …` in Chinese), so one taskless Thread no longer reads exactly like the next. A ref becomes a link only when the Host confirms it — abbreviated spellings included — and clicks navigate by the resolved full ref, so unresolvable text stays plain and never silently no-ops.

Known branded `channel:*` refs render at their original position as Channel chips naming the cited Channel (`频道 · …` under the Chinese locale, `Channel · …` under English); clicks hop to that Channel. Known branded `member:*` refs render as Member chips naming the cited Member (`成员 · @…` / `Member · @…`) — deliberately distinct from `@mention` chips, which notify, while a cited ref never does. Clicking an active Member's chip opens their session exactly the way the agent card does; suspended Members and the Human render as labelled but inert text.

Both resolve against the already-loaded Channel and member rosters with no new Host call, so a ref outside the loaded window stays plain text under the same rule unresolvable refs follow.

## Count capsule
`TeamCountBadge.tsx` over `countBadge.module.css .badge` is the one count capsule, and every count the Human reads wears it: the Channel feed's Thread entry and each Inbox queue row. One hand-written copy per surface — which is what there was before they were shared — is exactly what let the feed's copy sit on a different line box from the queue rows', with its digit a pixel away from theirs.

The sidebar's Inbox entry is deliberately not one of them: it states unread as a dot rather than a number (see Inbox (收件箱)), because what a reader scans the sidebar for is whether anything is waiting, while the quantity — which moves on every fact, and is what they ask for on purpose — belongs in the control's own name.

The rule is 18px tall and `min-width: 18px` with `box-sizing: border-box` (the platform ships no global border-box reset, so padding would otherwise inflate one digit into an oval), `border-radius: 999px` paired with `corner-shape: round`, `display: inline-flex` centred on both axes, 11px/600 with `font-variant-numeric: tabular-nums` so a two-digit count never moves the ink, `line-height: 18px` — the capsule's own height rather than whatever the surface inherits, because one surface inherits `normal` while another sets a height — and `flex: none`, so a squeezed Inbox row cannot shrink the circle.

Placement stays with the surface hanging the capsule through `className`, because the narrow rail pins it inside the 36px icon box.

Zero renders nothing: a count's absence is not a capsule reading zero. Past ninety-nine it reads `99+`. `tone` picks the ink and nothing else — the solid fill when the Thread names this reader, the same geometry drawn as a hairline in `--dsw-alias-border-l2` when it merely moved, the hairline paying for that 1px border out of its own padding (4px + 1px is the solid tone's 5px) so both tones keep one border box and one content box at every count — so one Thread never shifts its row when it is named again.

`label` decides how the count reaches assistive tech: with one, the capsule is a `role="img"` whose name and `title` carry it; without one, it is `aria-hidden`, because the control around it already says the number.

The digit's ink sits about half a pixel right of the box centre on every digit — a property of the glyph inside its own advance, not of the layout, so no declaration fixes it. What the rule owns is the 18px box one character keeps and one shared copy of it, which `scripts/audit-ui-parity.mjs` audits: a refactor that reintroduces a second copy fails the audit.

## Member rosters
`TeamMemberRow.tsx` is the single presentation of a person: `TeamMemberIdentity` (the presence-bearing `TeamMemberAvatar` plus the handle over its description) and an optional membership action. The Channel member-management dialog, the Channel editor's member section, and the footer's read-only Member roster all render it; the sidebar Agent list seats the same `TeamMemberIdentity` inside its own select button, so identity, tone, and truncation cannot drift between surfaces that show the same person.

The row is a three-track grid — 24px avatar, `minmax(0, 1fr)` copy, `auto` action — with the md tier of the shipped radius scale (12px), 8px/10px padding, a 40px minimum height, and `--dsw-alias-interactive-bg-hover` on hover. The handle is 12px/18px weight 500 primary; the description is 11px/16px tertiary and ellipsizes inside the copy track instead of pushing the grid. A read-only roster omits the action and the third track collapses, handing its width back to the description rather than reserving a hole.

The membership action is the row's only chrome — one `Button size="sm" variant="outline"` of at least 64×28 whose label changes (添加/移除, 更新中… while pending) while its shape does not — and the row's own failure line renders inside it as `role="alert"` under the copy track. Below 600px the action drops under the identity and aligns with the copy, because a squeezed dialog cannot afford a third column.

Membership law follows the Host: joining needs `availability === 'active'` (the Host refuses any other availability), while leaving needs only the membership fact, so an already-joined Member who is temporarily down keeps a working 移除. The sidebar Agent list is the exception on spelling: it names Members as the directory does (`builder`), while rosters address them the way the composer does (`@builder`).

## Team settings page
Settings carries the Team's one surface: the `settings.section` entry `team-settings` (「团队」), offered in ordinary mode only, because Team mode's sidebar takeover puts the settings panel out of reach. The shell draws the nav rail and the content column, so the section draws its own 18px/600 heading and then rows in the shipped settings language — 16px/0 padding over a hairline separator, a 14px/22px title above a 12px/18px tertiary description, 12px between controls — reusing the shipped `Button` and `Input` rather than restating them.

The page holds two writable groups that answer to two different documents, and it never renders one as the other: identity reads and writes through the Team Remote, while the judge's endpoint is one group of the Team Host row's settings section and writes through the settings provider. A form rendered wholesale over that namespace would put identity fields into the judge's group and address a flat `apiBase` at the wrong path.

Because the nav lists that entry among the Harness's own pages, a 13px tertiary intro under the heading names what owns the page and where a change applies, and that header renders in every state — including a failed read — so the page never leaves "whose Team is this?" open. The name row is a form: a 36×200px field whose primary Save button owns the submit, so Enter saves a dirty field and Tab reaches that button as the next stop.

The avatar row draws a 40px identity circle (`border-radius: 50%` with `corner-shape: round`) carrying the image or the initial, a 更换头像 button driving a visually hidden `input[type="file"] accept="image/*"` capped at 10MB, and 移除头像 only while a stored `avatarRef` exists.

Both avatar seats draw the picture only while those bytes decode — the Host accepts an avatar by its declared media type rather than by decoding it, so a phone photo in HEIC or a payload damaged on the way in is stored and handed back as a data URL that renders nothing — and `useAvatarImage` keys that answer by URL, so a seat shows the initial exactly as it does for a removed avatar and a new upload retries on its own. The footnote states the bundle version and links the repository; an update line appears only when the Host reports one.

`human-identity.ts` is the one reader of that profile: `TeamHumanIdentity` shares a single in-flight read between subscribers, reuses the avatar it already decoded while the reference is unchanged, keeps the last accepted value when a later read fails — only a never-loaded profile becomes unavailable, rendering as `role="alert"` with its own retry — and refreshes after every accepted write.

Writes reach the settings namespace through `remote.settings.update(namespace, patch, expectedRevision)` and `mutate(…, [{ op: 'unset', path: ['avatarRef'] }])`, resolved through an optional `ctx.inject(['remote.settings'])` binding: reading `ctx.remote.settings` without declaring it throws, and a hard activation dependency would take the whole Client down whenever the settings service is missing, so an absent service is reported as unavailable instead.

The section reports a rejected write's Host message in place rather than leaving a 「正在保存…」 label standing.

The Client's namespace constant is pinned by a test against the Host's own, so the two halves cannot drift silently.

At 390×844 the shipped panel keeps its 188px nav rail — it has no media query — which leaves the content column about 106px wide. The section therefore carries its own `@container (max-width: 420px)` rule that stacks each row's copy over its controls, drops the 48px right padding wide rows reserve for controls, lets the field and buttons take the full column, and gives the judge's answer its own line, flush with the row, its glyph leading the sentence; the browser acceptance asserts no horizontal overflow there and measures that glyph against the first line it leads.

## Environment check
Above the version footnote the page states one fact about the installation rather than about the Human: which DSH line this bundle runs against, and whether that line is inside the range the bundle declares. It is a second projection (`environment-check.ts`, `TeamEnvironmentCheck`), deliberately not a field of the identity store — it is read once, never written back, and the settings page is its only renderer.

It opens on the same hairline that separates the page's other rows. The verdict answers a question about this installation rather than about the endpoint above it, and without that rule it reads as part of the judge's own group.

Three verdicts, never a fourth, and never a guess. A fact the Host cannot establish is `undetermined`, which is a settled answer rather than a failed request: the block has no retry, and an unreachable Host renders nothing at all rather than borrowing that word.

The verdict order is the contract. An unreadable running version is `undetermined`; a running version that violates any declared `@deepseek-ai/dsh-*` peer is `out-of-range`, and a real violation is never downgraded to `undetermined` merely because the peer set then yields no single line to print; only when nothing is violated does the question become whether the declared range admits the version.

One range is stated, so every DSH peer must declare the same one: the prefix is `@deepseek-ai/dsh-` (`@deepseek-ai/cordis` shares the scope but is not on the DSH version line), and a drifted or empty set withholds the line rather than picking one peer to speak for the rest.

The `out-of-range` verdict is the only tier that takes a surface — `--dsw-alias-state-warn-tertiary` under `--dsw-alias-state-warn-label`, at the 12px radius of a row-sized surface — because it is the one state a reader may act on; the other two stay lines. Every tier states itself as text plus an icon, so the state survives a reader who cannot tell the colors apart.

The range is written in words, never as a bare semver range, because a range string is what a reader cannot check and a phrase is what they can. The certified combination (`Agent Team <bundle> × DSH <certified>`) prints only when both versions were derived: the installed manifest's own version, and the range's lower bound, which is what the repository gates pin as the certified baseline. A version that could not be read withholds the whole line rather than inviting a hand-written one onto the page.

Two versions a reader could reasonably confuse are therefore kept apart: the running DSH version is the environment, and the certified version is the declared line. They are the same string only while the installation sits on the baseline.

The block carries `data-environment` with its verdict, so an acceptance journey waits on a state rather than on prose.

## Judge endpoint group
The page's second group points jev at an endpoint: three controls — apiBase, model, and the write-only key — waiting behind a collapsed disclosure whose row is the whole control. The row carries the state and the chevron; the fields appear when it opens, and the opened body carries `role="group"` named by that title, because the page shows two saves and neither may be announced without context.

Collapsed is the default because the endpoint is set once and then left alone, while its state is worth seeing every time the page opens. The controls are absent from the DOM while it is closed rather than hidden in it: a disclosure that only hides its content stays reachable by Tab and by a screen reader, and the browser acceptance pins that absence — no `[data-team-judge]` body, no fields — rather than the styling that suggests it.

The state is that row rather than a line above the fields: `remote.agentTeam.contextJudge` answers whether jev is reachable, and the row states the Host's own answer as words plus a 14px glyph, carried on `data-context-judge` — `enabled`, `no-key`, `unavailable`. Only `unavailable` takes the warn colour, because a missing key is a step to take while an unreachable endpoint is something to fix. The row says nothing before the first read settles, and `detail` stays a Host diagnostic rather than user copy.

The gate's thresholds and the key's environment variable share that same row and are deliberately absent: they are row configuration the Team owns, and a deployment can still set them in its own patch layer. The Client reads only the `jev` group, through a projection adapter that flattens the section's `value`, `base`, and `user` layers and maps each control name onto the path it really lives at (`['jev','apiBase']`).

The form is the shipped settings stack — `SettingsFormModel` with `SettingsForm`, `SettingsValueField`, and `SettingsSecretField` — so drafts, override badges, reset, and the save behave as they do on the Harness's own settings pages. Every write goes through `ctx.configForms.get(namespace)`, which owns the revision fence and folds the Host's answer back into the mirror; a save that did not land keeps its drafts and says so, and a landed one re-reads the status.

The key is write-only: the Host redacts the literal, so the control starts blank on every load, a blank draft writes nothing — opening the page can never clear a stored key — and the configured badge comes from the describe mirror's `secrets` list, the only place that state is readable. Removing a literal is an explicit clear of its own, offered only while no draft is staged, because a write moves the document revision a staged save is fenced to.

The group is offered only while this deployment serves a settings document: the section is registered regardless, because identity is reachable without one, and an absent settings service simply leaves the group out. Inside a served document the group still answers for itself — a read-only document disables its controls and says so, and a namespace that is not served renders the form's own unavailable line instead of fields nothing would accept.

## Failure surfaces
A failed projection renders one of two shapes, and the choice is a claim about what is still on screen. When nothing was ever loaded, the failure replaces the whole surface as `errorState`: it rides the same free space as the loading and empty surfaces it stands in for (`margin: auto`, `padding: 32px 0`), keeps to the 880px reading column, takes the 12px/18px error scale in `--dsw-alias-state-error-primary`, and carries the Host's message plus one `重试` that re-issues the read — message and retry inside a single `role="alert"`.

When rows are still standing, the failure is the inline `error` line instead: `margin: 0` inside the content column, reading as the last line of the list it belongs to rather than re-centering a populated surface. Neither shape ever doubles as an empty state — an empty claim requires a successful projection that came back empty (`view !== undefined`, no error, nothing in it) — so a dropped connection cannot read as an empty workspace.

The rail speaks the same two shapes at rail scale. A Panel's own failure line is 11px/16px in `--dsw-alias-state-error-primary`, inset 12px so its text lands on the row labels it replaces (list inset 4px + row inset 8px) rather than on the Panel edge; a row's own failure (`rowAlert`) keeps that scale inside the row. Panel failures stay per Panel: each mounted Panel reports the drop it saw, so one outage shows the same message on the rail and, where the body's own read failed, on the page too.

A Panel's line carries no retry control; the rail heals from the change stream, which reports an outage once and wakes every listener when the transport answers again (see [`host-authority.md`](../architecture/host-authority.md)).

## Thread header band and the Claim panel
The Thread's header band carries the back row, the Task identity, the runtime-risk section, and the Claims section, and it closes with the one rule `.surfaceHeader` draws. The two sections inside it therefore separate by **space alone** — a section-level `border-top` would draw a second line around nothing, since the band's own rule already ends the group above.

Separator count is a measurable property here, not a matter of taste: shipped DSH draws them *between* groups (`PluginInventorySettingsTab.module.css`, `.group + .group { border-top: 0.5px solid … }`), so the per-section `1px solid var(--dsw-alias-border-l2)` was both off-convention and redundant. What stays: the band's `border-bottom` (a real structural boundary) and the unread boundary line in the timeline (a semantic one).

The band is height-budgeted rather than merely tidy — with two erroring Members it ran 426px of a 960px viewport and pushed the conversation below the fold, while sections that separate by space fit the same content in 360px.

A Claim row is **three grid tracks that are all occupied**: the presence dot, the identity-and-state group, and the direction. Identity and its state share the first line and the direction owns the second, so the handle is never a suffix adrift at a wide row's far end (at 880px the old single-line layout left the handle 158px past the direction it belonged to) and the state never floats at the row's right edge away from the Claim it qualifies.

The narrow breakpoint does not re-template the row: one `14px minmax(0, 1fr) auto` template holds at 1440 and at 390, so the two widths cannot drift apart, and the 14px dot column plus the list's 22px inset keep every dot on the same spine as the `Claims · N` title above them. The row's leading presence dot is the row's **only** liveness signal — an extra "available" badge beside the handle states one fact twice, which a reader notices before they can name it.

A `done` Claim carries `claimRowDone`, stepping its direction down to secondary so finished work stops competing with live work, without hiding the Claim.

The runtime-risk row is one line per erroring Member, and its leading token is the **localized name of the diagnostic's structured class** — `session-refused`, `session-unreadable`, `preset-composition`, `rollover`, `runtime`, `activation`, the policy axis `AgentTeamMemberDiagnostic.class` already carries and `restartOffered` already branches on.

That class answers the localizable question "what kind of problem is this", while the Host's `detail` is English by construction; the row therefore clamps the detail to its first sentence and keeps the full text on the row's `title`.

`AgentTeamClientMemberStatus` already carries the whole diagnostic to the browser, so this axis needs no Host protocol change. One sentence key per class keeps the visible line in the interface language instead of pasting a Host string into a localized surface, and a Member with no diagnostic resolves to the `runtime` wording rather than leaving a hole.

The opener under the Task or Thread identity is **one clamped line at every width and for every Thread kind**, with the full text on its `title`. A Task's title runs long and embeds unbreakable refs, and a discussion's opener is its own anchor message, repeated in full in the timeline directly below — so a second line in the band spends header height on text the reader can already see, and makes the band's height depend on how much someone happened to type.

One line keeps a long opener and a two-character one at the same band height (measured: 114px either way on a taskless Thread).
