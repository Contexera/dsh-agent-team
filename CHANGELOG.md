# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. Team bundle versions evolve independently of DeepSeek Harness versions; DeepSeek Harness compatibility is expressed through `peerDependencies` and [`docs/dsh-release-compatibility.md`](docs/dsh-release-compatibility.md).

## [Unreleased]

**Upgrade note**

- Rules version 2 is now the default and the `DSH_AGENT_TEAM_PREVIEW_RULES` preview switch is gone: this build adopts version 2 on every ledger it opens and no longer writes the version 1 kinds it replaced (`team/message-sent`; they replay inside version 1 segments only). A build at or below 0.2.5 refuses a ledger this build has opened, so install this release on every profile that shares `$DSH_HOME/storages/` before opening the Team anywhere, and back up `agent_team.sqlite` first. Upgraded Projects initially have only the Human owner, so reassign any Agent owners after upgrading. A ledger written by the unreleased 06/07 dev builds of this train still opens: their Task starts without a creation activity and their Claim transitions without responsibility markers replay exactly as those builds wrote them.

**New**

- Tasks carry one accountable owner. An Agent Project owner creating a Task becomes accountable by default; the Human may name any owner. Accountability transfers explicitly to another owner or the Human; when an owner is withdrawn, archived, removed, or leaves a Workspace, every open Task it was accountable for returns to the Human in the same operation with a public transfer activity.
- Acceptance is separated from execution: an Agent may accept a Task only once it is `in_review` and only if it never held any Claim on it, released ones included; the Human keeps early acceptance. Close, reopen, and transfer belong to the Human and the current accountable owner.
- Responsibility events reach the Inbox as direct facts regardless of Attention: being made accountable, entering review, a Task left unowned, reopen, and needs-your-acceptance when the accountable owner executed the work.
- A Task may record its originating discussion (`sourceThreadRefs`, immutable, same Project); sourced Tasks leave the Main stream and appear as read-only cards inside the discussions they came from. The board adds the `accountable` relation and flags Tasks awaiting an owner's acceptance.
- `team_task` gains `accept`, `close`, `reopen`, and `transfer`; `team_message.start` accepts an accountable owner and source discussions for Tasks. The persona and the `team-domain-model` skill state the accountable/verifier split.
- Notices are delivered by role. A Project owner's Main stream posts, new discussions, mentions, replies, and ownership events wake immediately; an owner's or Task owner's ordinary Thread updates accumulate per Member per Thread and summarize once at five. The sender's own messages never enter the sender's Inbox.
- Every visible Project carries one Main stream unread row in the Inbox, shared by the Human and Agents; `team_inbox` and the Human's inbox count agree.
- The task board: a `taskBoard` Host projection and Remote method lists every visible Project's open Tasks plus the last five finished per Project, and names the reader its `humanMemberId`. The Web Client reads this projection in both places — the Project board tab and the cross-Workspace Task board page the sidebar's 任务看板 entry opens (its own checklist glyph, a narrow-rail button, cards that say 「你负责」, and an empty state that stands alone without column heads). `team_claim` is merged into `team_task` (`board`, `list`, `claim`, `done`, `release`, `promote`); `team_view` no longer returns active task threads.
- The team-member persona is rewritten for project ownership and ships the `team-domain-model` core skill.
- Event-evaluated Task reminders cover review backlog and stalled work. They are private durable direct notifications, deduplicated by condition episode across restarts, immediate for Agents, and consumed only by reading the Task Thread. The Host uses no timer; an entirely silent Team does not wake itself at a threshold. The first deployment can raise one reminder for each already-eligible historical episode on its next Team event.
- Agent `team_thread` renders a discussion's derived Task cards with current status and accountable owner. Human boards name the accountable owner, flag work awaiting the reader's acceptance, and disclose a suspended accountable owner.

**Changed**

- The Client drops its version 1 paths: the old Project feed, `@all` expansion, and the invitation confirmation flow are gone. The Project page is the Main stream plus the board, and a Thread starts through the owner-only 讨论/任务 control.
- Exactly one sidebar row carries `aria-current="page"`: a global face (Inbox, Task board) no longer leaves the marker on the Workspace selector beneath it, and the auto-select no longer pulls the seat back to a Workspace overview while a global face stands.

## [0.2.5] - 2026-10-24

**Upgrade note**

- Channel is now Project. New ledger records use `project:` refs, `projectRef` / `project` / `projectRefs` fields, and `team/project-*` kinds; records written before keep their bytes and still read. Compatibility is one-way: a build older than this release cannot open a ledger this release has written to, because it knows neither the `project:` ref spelling nor the `team/project-*` kinds and rejects the whole table at open. There is no interim release that reads both spellings, so install this release on every profile that shares `$DSH_HOME/storages/` at the same time, and treat downgrading below it as unavailable.
- The generation swap records a new operation kind, `team/member-session-recycled`, in the durable ledger. An older build reading a ledger that contains one rejects the whole table at open, so downgrading below this release with a ledger that already recorded a swap leaves the Team unavailable until the release is restored. The domain version stays at 1: an additive kind never changes what a stored record means, which is the only thing the number is allowed to move for.

**New**

- A Project has owners once the ledger adopts rules version 2, which is still a preview: only `DSH_AGENT_TEAM_PREVIEW_RULES=1` adopts it, and the next release makes it the default. The Human owns every Project without being recorded, and grants or withdraws Agent owners from the Project dialog among Agents that participate in the Workspace and are enabled or suspended. Leaving the Workspace, archival, or removal ends an ownership; suspension does not. Writes are non-optimistic and a Host error stays in the section's alert.

**Changed**

- Channel is renamed to Project on every surface: the Client (项目 in Chinese), the Remote (`createProject`, `updateProject`, `archiveProject`), tool parameters and output (`projectRef`), change scopes (`kind: 'project'`), and the `start_requires_project` rejection. `channel:` refs still resolve wherever a ref is accepted — a tool argument or a ref cited in a Message body — so Agents and older Messages that cite them keep working. Drafts, sidebar order, and the last open page saved in the browser carry over.
- Every Member starts restricted to its preset tools plus `working_directory`; a capability allow-list can only narrow that set. Later plugin tools are removed from request schemas and denied direct or nested execution. Same-name replacements reject requests and execution.
- When other official or custom plugins are enabled, Team mode filters their undeclared tools but does not filter their injected prompts. Current public Harness APIs do not provide complete per-Member prompt isolation: required contexts can be restored after assembly. Those prompts remain visible without blocking conversation; full plugin compatibility is not certified.
- A Member no longer manages its own context. The four context tools (`context_rollover`, `context_checkpoint`, `context_status`, `context_compact`) are gone, and so is the acceptance advice that used to ride a Thread read. The preset delegates in-place reduction to the Harness's `BasicCompactionEngine` through a thin Team admission adapter; the compaction transaction and summary template stay upstream's. A generation swap is a Host decision: `team-context-management.ts` records `team/member-session-recycled` as the Host actor and activates a fresh Session parented at the one it replaces.
- An acceptance that concludes a Member's own work now leaves a boundary behind. The Host appends one `<system-reminder>` telling the Member to move durable conclusions into its `memory.md` index and the notes it names, and at or above 128000 measured tokens it also compacts the generation once the Agent settles. A follower who owns nothing on the Task sees the same accept as unread and is left alone, the reminder never promises a compaction the preset cannot run, and one turn spends at most one boundary however many accepted Tasks it reads.
- A Member's proactive input trigger is `floor(min(memberCompaction.tokens, window × 0.8, window − 16384))`, with an absolute default of 256000. A 272K model therefore triggers at 217600 without pre-reserving its maximum output. Pending input is counted; tool-result pruning precedes forced upstream reduction with no proportional retained tail. Summary output has its own 16384 cap. Normal output is limited to remaining window space and the original allowance, with temporary limits recomputed rather than persisted as future intent. An insufficient reduction ends the turn explicitly. A window under 20480 tokens cannot hold both fixed reserves, so the policy declines and that route keeps only the Agent's own limits. Disabling `memberCompaction` restores upstream pressure handling; overflow recovery and ordinary Sessions are unchanged.
- The Team settings page configures the in-place compaction threshold under 「上下文」: one capacity field (`256K`, `1M`, or a plain count) that writes `memberCompaction.tokens` through the shared configuration form. A blank field clears the override so the group returns to its 256000 default, and only that child path is written — the sibling `enabled` switch and the rest of the Host row keep the values they had.
- A cold Member generation is replaced automatically before a wake reaches it. The Host swaps a generation that has been idle for more than an hour and measures more than 128000 context tokens, whether the wake is a notification, a DM, or an activation at startup or resume; every fact the decision cannot establish answers resume, and a generation still holding unprocessed ordinary input keeps its continuity. Three volatile Host-row fields under `wakeRecycle` set it — `enabled`, `idleMs`, `minContextTokens` — and the Team settings page gives them no form.
- A swap no longer strands the input it was racing. A queued ordinary message defers the swap before it starts; past that, the commit runs inside `agent.runMaintenance`, so a message arriving mid-swap waits in the durable inbox instead of reaching the generation being retired, and the retiring generation rejects later steps without spending a model request. Original inbox insertions remain available for replay even after a claim. The commit records `inputFromSeq`, the retired log's offset, when it retires a live generation, and the successor replays only that log's input at and after the boundary, deduplicated by Message id against what it already holds. Nothing is copied through process memory and no handoff envelope returns; a legacy transition without `inputFromSeq` keeps its old started-generation skip.
- A swapped-in generation is told nothing about the swap. Its first model-facing context is the ordinary per-step injection — identity, `memory.md`, the Workspace list — plus the message that woke it; the handoff envelope, the generation announcement and the crash-time `Context handoff:` steer are all gone, because a successor that is told it received a handoff performs a handoff instead of reading its memory.
- A Member works in the directory the work is in. Its Session, Team participation, Claims, and write permissions stay bound to the Workspace it was created in, but its working directory moves: `working_directory` enters a Workspace the Member has joined and leaves it again, so relative paths, searches, new shells, `run_code`, and that checkout's `AGENTS.md` all resolve where the work actually is. The multi-Workspace guidance now says so instead of telling Members to reach across checkouts by absolute path, which silently skipped the other checkout's instructions.
- A Member's tool allow-list no longer removes `working_directory`. The restriction narrows capability; it does not confine a Member to its creation checkout, so the Host unions the tool over the configured list the way it already unions the Team tools.
- The bundle declares `engines.dsh` beside its DSH peers. DSH decides a plugin's compatibility from that field alone when it is present, so an install on an uncertified Harness now reports one unmet requirement instead of listing every peer package.
- A stale-revision rejection now says how the writer's token related to the Thread instead of carrying a lone `tokenUnrecognized` flag: `staleTokenKind` is `unrecognized` for a token this Thread's revisions skipped over, `unknown` for one older than its first fact, and absent for a plain insertion race. The model-facing refusal is unchanged in words, but a caller that read the boolean must read the new field.
- The Inbox and feed rows name Claim owners as `liveClaimOwners` rather than `claimOwners`, so the field matches the rule that produces it: owners of live Claims only, empty once the Task is resolved.
- A discussion panel's width is the reader's. Opening one gives it the larger share of the surface (52% of it, clamped to 420–960px) instead of a fixed 360px column, and a seam between the panel and the feed drags that share either way with arrow keys as well as the pointer. Both surfaces read one variable, so the feed gives up exactly what the panel takes, the band above gives up the same width so a long Project description ellipsizes beside the seam rather than running under it, and the seat is remembered per browser and re-clamped to whatever surface it reopens on. The panel is the surface's own child rather than the feed's, so it spans the band and the feed as one column: its head now shares the band's identity row — the same 10px inset and 30px row as the Project title — instead of starting under the tab strip, and its foot composer stands on the feed composer's line. The two rules that used to close those two rows are gone; the band's own rule already ends the row they framed. Below 600px the panel covers the feed in the surface's single column, so the band above keeps its width and its identity row stays whole.
- The discussion panel's Messages carry the row actions the Thread page gives them. Hovering a row opens the same card — copy, and a quote that fills the panel's own composer with the Message as the reply's parent — and a row that answers another leads with its quote line, which scrolls to the original inside the panel instead of walking the reader to another page. The panel was the one surface rendering Thread rows without the reading language, so quoting from it was impossible without leaving it. The first row of any scroll box took its card's rise as headroom: the rule that was meant to pay for it named a row as the box's own child, which a run wrapper never is, so the first row's card was clipped by the scroll edge on both surfaces.

**Removed**

- `clearMemberContext` is gone from the Remote surface, and with it the last way for a Human caller to start a Member from a fresh context. Ledgers that recorded `team/member-session-renewed` or `team/member-session-rolled-over` still replay.
- The bundle no longer depends on `@contexera/dsh-context-continuity` or `@contexera/dsh-jev`. The Team's context projection and generation coordinator are its own; `scripts/continuity-dir.mjs`, the engine exports (`./compaction-engine`), the copy steps in `generate-typert.mjs`, and the `DSH_CONTEXT_CONTINUITY_DIR` resolution are gone with them. A profile that still states the old `gate`/`jev` fields in the Host row keeps working — the schema is non-strict, so the unknown keys pass through — but nothing reads them, and a `jev.apiKey` left in a real profile stays in plain text until it is deleted by hand.
- The Team settings page drops its `jev` endpoint group: the apiBase/model/key controls, the reachability line, and the 14 locale keys behind them. The page is identity, the compaction threshold, the environment check, and the version footnote.
- A Task's Thread band states the Task rather than listing its work queue: the `Claims · N` disclosure is gone with its row layout, its empty line and its three state words. A Claim still reaches a reader as the fact that recorded it — the activity line in the timeline — and as the owners drawn on a feed entry row, and the early-accept dialog still lists the open Claims it will complete, because that list is what the acceptance is decided on. What went is the surface that listed Claims on demand.
- `AgentTeamHumanProfileResult.updateAvailable` is gone. `latestVersion` carries the fact on its own: present exactly when a newer release is known, absent while the check has not observed one — or is disabled, offline, or failed. A caller that treated `updateAvailable: false` as "up to date" was reading four different states as one.

**Fixed**

- A Main stream Thread card answers the pointer on its own surface: the interactive fill the Inbox row takes. It used to lighten only its border, which left the feed's one large target visually inert and made the single reacting edge fainter under the pointer.
- The message action card's buttons sit inside the card instead of filling it: a 24px control inset 2px on every side, on the 4px tier. At the card's own height and radius the hover fill painted from edge to edge, so the pointer state read as the card being cut open or pressed rather than one control lighting up.
- A quote in the Main stream jumps to the Message it names again. The row already accepted a jump handler — the Thread seat wired it and the Main stream did not, so a quote there rendered as inert text while the maintained documents promise every reachable surface is a jump. It now centres the original and pulses it, and the pulse is the only layer those rows take: under the pointer they stay inert, because a feed row is an entry row rather than the Thread's reading seat.
- The sidebar's browsing list now closes on the shipped session tree's bottom fade: a 24px gradient from transparent to the sidebar fill, inert to the pointer, with the last row clearing it by the shipped list's own 16px inset. The list previously ended at a hard clip, so the seam to the Settings/More row below read as a break instead of the list continuing under it.
- A fenced code block in a message body follows the code-size setting again. DSH 0.2.1-rc.2 moved the Markdown code-block size onto `--dsh-code-font-delta` while its leading stayed on that same delta, so the Team Client's own fixed 13px held the words still while the lines around them grew with the setting: at 16px the block rendered 13px words on a 24px line. It now renders 13px at the default setting and moves with the setting on the same px-delta pattern the content axis uses.

## [0.2.4] - 2026-10-17

**Changed**

- The Channel page reads one timeline as either a feed or a board. A the `Channel | Board` tab strip under the header switches between them, speaking the shipped session page's tab language. The board sorts the same projection into four Task-status columns — `To do`, `In progress`, `In review`, `Done` — and reads only the window the feed has already loaded, so opening the tab is not an unbounded read and the feed's own `Load older messages` is how it reaches older work. It is the one Team surface allowed past the 880px reading column, up to 1240px, because four status columns are a scanning surface. Resolved cards dim rather than hide; an empty column states its own `0` in the head instead of drawing a placeholder row.
- A taskless discussion opens beside the Channel feed instead of on a page of its own. A taskless Thread's entry row opens a right-hand panel that names the discussion, reads its facts with the usual day separators and runs, answers in the ordinary composer at the same draft key, and offers `Convert to Task` — which, on success, closes the panel as the reader walks into the new Task's Thread page. A read committed in the panel clears its feed row's unread capsule immediately. A Task's entry still walks into the Thread page, where Claims and acceptance live. The panel's 360px seat is reserved only while it is open: an always-on reservation would spend a sixth of a 1440px viewport on an empty band and charge every line of the feed for it. Below 600px the panel covers the stage whole.
- The Channel page's header is the shipped session header's shape: one identity row carrying the Channel title with its description beside it on the title's baseline, clamped to one line with the full text on its `title`, and the `Channel | Board` strip on the band's own closing rule. The band is pane chrome rather than a centered column — the shipped session header leaks left to a 20px inset while its transcript stays centered, so the title and the words under it deliberately sit on different x positions, and the Team surfaces copy that arrangement. The band's member and online counts are gone, and so is its back-to-Channels row — the browsing sidebar already lists every Channel and marks the selected one, so a page-level way back was a second control for one destination. The description no longer gets a line of its own, so the band is the same height however much someone wrote into it.
- A resolved Task's feed entry row slims to a footnote: `Task #N · <status word> · <MM-DD>`, the day it landed, instead of printing follow-up recency on every finished row. The owner stack and status dot stand down with it — the board owns scanning resolved work — while the unread capsule stays, because a resolved Thread can still be answered and the precise instant stays on the control's `title`.
- Team mode's way back to the conversation takes over the shipped New Session bar's slot instead of sitting in the sidebar's footer: it is the first row of the browsing region, directly under the shell's brand row and above the Inbox card, and the narrow rail's first icon. The mode hides that bar, so one bar stands in that position in either mode and only its label changes — the same 38px elevated slab and l3 hairline, reading `Chat` with the glyph pointing back, on the shipped bar's own box: it measures 14px to 266px in the 280px sidebar, the same box the shipped bar occupies, and the browser test measures both in one render and requires them equal — the group's ink is nudged 2.5px back because the chevron's mark sits off-centre inside its box, so a row centred by box alone reads as off-centre. The browsing column beneath it stands on the shipped browser's own content box, so its section headers and rows share the shipped rows' left edge, and it scrolls one way only: the vertical axis, with the bar's space reserved rather than conditional so a growing list never shifts the rows sideways. The brand row itself cannot carry the control — that row is the shipped New Session button on non-macOS and a window-drag surface on macOS, and its mark is `aria-hidden`, so it offers neither a place for a second control nor an accessible name. The members entry and its read-only roster dialog are retired, because the Agent panel already lists every Member with its actions. The footer's settings seat is left to the shipped Settings row, which now keeps it in both modes; the Team's own settings page registers on `settings.section` and stays reachable.
- A Message's avatar is 34px instead of 28px, and the author line is levelled with it: the face drops 5px from the name row's top edge so its top meets the author name's capitals, and the name and its time share one baseline — the arrangement Raft gives its own Message row, whose avatars are also level with their author lines. The seat is `--team-identity-seat`, the one place the face's size is stated, so the continuation row's in-seat time and the hairlines that hug the text column follow it with no second edit; it is declared on the shared conversation surface, so the Channel feed — which renders the same rows — follows it too.
- Attention and direct messages now have their own tools instead of sharing one with reading and replying. `team_attention` answers only "am I following this Thread" with three parameters no read action needs, and `team_dm` addresses a person with a `memberRef` and a `body` and nothing else. `team_thread` reads and `team_message` writes Threads, so neither carries a branch for the other's job. Sessions recorded before the split still fold correctly: a `follow` logged under `team_thread` is decoded to the same boundary it always was, while no new call can carry that name.
- A rejected write now answers with the facts that gated it instead of only a count: `unread_required` renders the unread batch and `stale_revision` renders what changed since your token, both in the same shape a `team_thread read` returns them, and both hand back the current revision to retry with. The retry commits without a second read, so a rejection no longer costs a round-trip of its own.
- A write no longer needs a read when the unread work is already in front of the model: a direct mention and a DM arrive carrying the Message body, so when every unread Message is on your surface in full, the write goes through without a `team_thread read` first. Reading still advances the same durable state and stays the only thing that does; the exemption records nothing, and an ordinary notice — which carries a count and not the body — still requires the read.
- Every Team rejection now names the next action and the value that action takes — a missing `threadRef` says where to copy one, an unknown Claim ref says which command lists your own, an attachment path says what shape it must have. The words come from one registry instead of each call site writing its own, and a test refuses a route sentence written outside it, so a new rejection cannot reach you with a fault you have no way out of.
- Taking part in a Channel now means having taken part in one of its Threads: reading, speaking, claiming, or following. A Member named into a Thread sees the Channel from then on, and a Member who never visits a Channel of its Workspace still does not.
- Naming a Member with `@Handle` resolves across the whole Workspace's participants, not only the Channel's enrolled roster, and `@all` expands to the Channel's participants rather than its enrolled roster.
- Manual Channel member management is retired: the join and remove entry points are gone from the Remote surface and the Client, and the Channel editor carries no member rows. Old ledgers that still carry explicit membership keep loading and replaying unchanged.
- The mention picker ranks every Workspace participant by how directly a pick reaches them — this Thread's followers, then Members taking part in the Channel through another Thread, then the rest. A name outside the conversation being written into also drops a weight, though the row stays pickable because the ledger addresses all of them. Weight is the row's whole distinction: no row states a consequence, and a pick the Host stops to confirm is announced by the composer's status line after the send.

**Fixed**

- A wide Markdown table scrolls inside the Message column instead of painting over the page beside it. The column lays its children out shrink-to-fit, so a ≥4-column table — which the primitive holds at its natural width so its own wrapper can scroll it — had sized that wrapper to the table itself, and the overflow landed on the page outside the column's right edge. The cap is declared at both levels of the body chain, because a body long enough to fold gains a `data-document` wrapper between the column and the Markdown box, and a `max-width` only resolves against the box that contains it.

## [0.2.3] - 2026-10-11

**New**

- A reply can be linked to the Message it answers: the composer quotes one line of the original, resolved by the Host, and answering a Member delivers to them the way naming them does, while answering your own Message notifies nobody.
- A Message that names you says so where its actions are, with a `Mentioned you` badge that lights only for Messages that really name you, and your own handle reads as yours inside a Message body.
- The notice that a reply mentions you now says what it answers: the author, the first line of the original, and the full ref you hand back.
- Read one Message back whole: `team_thread message` returns the verbatim body by ref, which is how you answer one specific Message without re-reading the Thread.
- Members stop queueing behind each other: a long wait on one Member no longer holds up another's pause, removal, or configuration edit.
- Member configuration edits report their effect: whether the accepted row was applied now, already in force, or saved for the next activation — and a failed apply leaves a routable diagnostic instead of silently skipping.
- A Team wake canceled before the Member can start its turn is now visible instead of silent.

**Improved**

- Team moves into the sidebar's panel rail beside Plugins, and the plugin list shows Team's own artwork instead of the default placeholder.
- Reading the same data on one surface costs one request, a late response never overwrites a fresher result, and a reconnect still fetches what is current.
- A read that fails keeps the last number it had and says so, so the Inbox badge and the Channel's unread count no longer drop to empty or zero.
- A Message states its own time: rows that already carry an identity line state the instant beside the name, the time stays inside the avatar seat, and reading a Thread on a later day no longer paints a dated label across it.
- The Inbox says when the unread queue continues past the rows it shows, instead of letting a full page read as all of it.

**Fixed**

- Starting a Member from a new context no longer names the caller in the Session id, and a Thread whose history read fails keeps its action for loading older messages — that same action is the retry.
- Creating or editing a Member with a model provider the Host has no adapter for is rejected on the spot, naming the provider, instead of producing a Member whose first turn fails.
- Opening a Member's Session from its sidebar row now says so when it fails, instead of doing nothing while the row still marks itself as current.
- A new Member's private-memory index starts as a bare structural skeleton rather than prose that has to be replaced afterwards.
- Quoting your own Message promises nobody a delivery, and a Message's time, mention badge, and quote delivery are stated the way the reader meets them.

**Other changes**

- The bundled context-continuity engine moves to `0.4.0`, and Team asks the engine's one anchor rule instead of restating it.
- `sendMessage` stops creating a Task unless it is asked for one: `asTask: true` is now required to hang a Task off it.
- `updateMember` becomes a partial update: a field left out keeps its value, and clearing a `model` or `capabilities` override takes an explicit `null`.

**Compatibility**

- The certified baseline is unchanged: DSH `>=0.2.0-rc.2 <0.2.1`.
- The two call-contract changes above (`asTask`, and `updateMember`'s explicit `null`) are breaking for direct Remote callers.

## [0.2.2] - 2026-10-08

- The Inbox says where each Task stands: a row whose Thread carries a Task prints that Task's status beside its number, in the same state dot and word the Channel feed and the Thread header already use, so a Thread waiting for your acceptance no longer reads like one that is finished — while a Thread that is only a discussion stays exactly as it was.
- Team tool calls that miss an argument now say which ref is missing, where to copy one from, and that a retry is the way out, instead of reporting only the parameter name.
- The repository and the package move to Contexera together: `Contexera/dsh-agent-team` on GitHub, `@contexera/dsh-agent-team` on npm. The old name `@wowyuarm/dsh-agent-team` stays at 0.2.1 and is deprecated in favour of the new one; Team's durable identifiers — row ids, the settings section, the stored context kinds — do not change, so an existing profile swaps the plugin's name rather than its data.
- The bundled context-continuity engine moves to `@contexera/dsh-context-continuity` in the same pass, with no code change.

## [0.2.1] - 2026-10-06

- Context housekeeping moves to the engine's own two tools: `context_status` shows a Member how much of its context is used and how much is left, `context_compact` shortens it in place while keeping recent work verbatim, and the summary a Member writes itself is the one that gets used instead of a template written for it.
- When a Member is woken after a long quiet stretch, the deployment's own model first judges whether the work is still related: input judged unrelated is held back and replaced with a fresh-context instruction. A key is the switch for that gate — a Team Host row that states one (or names an environment variable holding one) turns it on, and a row without one leaves it off.
- The gate's three numbers live in that same row: how long counts as a long gap (`gate.idleMs`), how large counts as large (`gate.tokens`), and how long one judgement may take (`gate.judgeTimeoutMs`). An edit applies to the next judgement, with no restart.
- Settings is one page: your display name and avatar, one place for the model endpoint's address, model and key (a key is write-only), and whether it answers right now.
- Members are more autonomous: they decide by default and report when done instead of asking you to confirm a plan, and the calls left to you are the irreversible, the expensive and the ones only you can make.
- At a raised content size the sender's name grows with the message while the body keeps its layout.
- When a Member reviews where its context stands, adjacent rows that differ only by an anchor number fold into one line, which reads much shorter.
- Fixed a message that failed to send being impossible to answer, and attachments uploading twice when a request is retried.
- Fixed an interrupted Member context update being abandoned halfway: it finishes on the next start, and the same step is not done twice.
- Fixed the plugins page taking the center column in Team mode: Channels, the Inbox and Threads open there again.
- Certified against DSH `0.2.0-rc.2`: all 43 `@deepseek-ai/dsh-*` peers move together, so a host still on `0.2.0-rc.1` is outside the supported range.
- The session-local todo tool and the Team's own context timeline tool are gone, and the bundled context-continuity engine moves to `0.3.0`.

## [0.2.0] - 2026-09-29

- `team_view` lists the Task Threads in flight: every in-progress or in-review Task in your Channels, with the members already on it and the latest activity, independent of your own unread queue.
- Settings says whether the DSH you are running is one this bundle supports: it states the running version and the supported range in words, and reports a version it cannot read as not determined rather than unsupported.
- Interface details follow DSH 0.1.7-rc.2: focus rings use DSH's own ring tokens with one ring colour everywhere, and radii move onto DSH's own scale.
- Certified against DSH `0.2.0-rc.1`: every `@deepseek-ai/dsh-*` peer moves together to `>=0.2.0-rc.1 <0.2.1`, and the context-continuity engine floor moves to `^0.1.6`.

## [0.1.15] - 2026-09-24

- Upgrades carry your profile across: the name and avatar saved under the old settings section land in the Team Host row on the first boot after upgrading, and anything you re-entered yourself wins.
- Long messages read as documents: a body past the fold takes a roomier rhythm of paragraph, list and line spacing, short chat keeps its dense grid, and message text follows the content-size setting.
- The Team Client takes DSH 0.1.7's surface language: sidebar rows, the Workspace selector and member rows share one radius tier, the composer card wears DSH's own hairline and elevation, a narrow composer narrows its gaps instead of dropping the as-task word, and the Inbox row's clock yields when the line cannot hold it.
- Fixed the `@mention` menu being hard to read: DSH 0.1.7 made the shared menu surface translucent, and the suggestion list now frosts what is behind it instead of letting the conversation bleed through the names.
- Fixed the settings footnote naming the wrong version: 0.1.14 shipped a hard-coded previous version, so the footnote reported the old release and the update check offered the release you already had.
- The sidebar's Plugins panel entry stands down while Team mode stands and returns when you leave; ordinary conversations keep it.
- Fixed a fresh install of 0.1.14 losing context handoff silently on the previous DSH line: this release declares the engine's current line and matches its data shapes.
- Certified against DSH `0.1.7-rc.1`: every `@deepseek-ai/dsh-*` peer moves together to `>=0.1.7-rc.1 <0.1.8`, so upgrade DSH together with this release. The `@deepseek-ai/dsh-agent-presets` peer left with the package it named.
- Durable messages carry their own producer's kind as DSH's session format requires, history written by earlier lines still reads back, and the startup pass that rewrote those sources is gone.

## [0.1.14] - 2026-09-22

- Context continuity runs on `@wowyuarm/dsh-context-continuity`, the extracted context-continuity engine: rollover, checkpoints, the projection fold, and the timeline all read through that published package. Timeline rows carry a short `anchor` id, and only a restorable row ever prints a ref `context_rollover` accepts.
- Settings gains a `My profile` section: set the display name Agents mention and an avatar, which then leads your own Inbox rows, avatar stacks, and message seats — bad image bytes fall back to your initial, and `@human` survives any rename.
- The Settings footnote checks for a newer release in the background and names it once observed (12-hour cache, silent on failure, `DSH_AGENT_TEAM_UPDATE_CHECK=0` to opt out).
- Member memory carries a 16 KiB budget with usage shown on every injection (`X.X KiB / 16 KiB`); the over-budget warning states exact bytes, and a bundled `member-memory-manager` skill holds the upkeep rule.
- The sidebar leads with one keyboard-operable workspace selector on a single line; Thread, Channel, and Member references render as titled clickable chips; a finished Task row reads `Task #N` without its last-activity time.
- The Task Thread header separates its sections by space instead of a second rule, reads Claims in two lines with finished ones stepped back, and states each runtime risk as one localized line with the full diagnostic on hover.
- Agent model pickers open from a warmed shared catalog — a slow Host read delays a refresh instead of hanging, and a failed read offers a retry instead of endless loading.

## [0.1.13] - 2026-09-17

- Fixed market-installed DSH Desktop clients failing to start: the SQLite storage backend now ships inside this bundle instead of depending on a package no published host provides. Existing media open without migration.
- Agent Members can now work across Workspaces: joining a Member into another Workspace is explicit, and the five Team tools take an optional Workspace selector. The Inbox merges every participation, and the Human member panel gains import and withdraw controls.
- Mention chips render only where delivery reaches: a name needs its authored `@` to chip.
- The Inbox leads with rows that mention you, ahead of merely newer ones.
- Team pages stay responsive when several are open at once, and reconnected pages catch up without a new commit. A Host and a Client half from different bundle versions no longer work together — restart the Host after updating.
- Fixed archived Channels leaking their Threads into the Inbox: archival ends participation as well as notification.

## [0.1.12] - 2026-09-16

- Reworked Inbox around unread and recent activity: the unread queue leads with counts, and threads you keep returning to get their own list.
- Mention members with `@handle` or `@all` right in the message body, with suggestions and a will-notify line as you type.
- Connection loss renders as an inline state with retry in place, and surfaces wake up on recovery.
- Interface details aligned with DeepSeek Harness conventions.
- Fixed long threads silently dropping facts a bounded read left behind.
- Fixed member private-data migration and removal to stay within the current DSH home.
- Other changes: progress nudges are gone; member context is fully managed by members and the Host pressure policy.

## [0.1.11] - 2026-09-14

- The Human Team gains a `Mentions of me` Inbox that gathers unread mentions from every Workspace into one list.

- A member whose stored Session cannot be read can be repaired by restarting it, and an unavailable member reports why.

- Thread messages are conclusion-first, mentioning the Human only when you must know or decide.

- Opening a Thread, waking a long-lived member and startup are faster, and stored data is smaller.

- Team interface details are aligned with DeepSeek Harness's own conventions.

- Fixed surfaces not showing a change that landed while you were away.

- Fixed `team_view` reporting a wrong revision for a Task whose Thread is outside the page.

- The `@deepseek-ai/dsh-*` peers declare exactly the certified DSH line, `>=0.1.5-rc.1 <0.1.6`; a newer `0.1.x` reports a peer conflict.

## [0.1.10] - 2026-09-11

- The certified baseline moves to DSH `0.1.5-rc.1`, and `0.1.5-rc.2` is certified on the same peers with no manifest change; the peer range is now `>=0.1.5-rc.1 <0.2.0`. Seven upstream source breaks are adapted to, including the agent setup signature, the keyed `main` slot, the Session persistence handle API, and the `dsh-persona` config key rename. Published 0.1.9 cannot install on this line, because `>=0.1.2-rc.1 <0.2.0` admits prereleases only on its own base tuple; DSH `0.1.2-rc.1`–`0.1.4` fall outside the new range, so upgrade `@deepseek-ai/dsh` together with this release.

- Member Sessions record rollover handoffs and checkpoint continuations as named snapshot sections instead of package-specific source kinds, so what this version writes stays readable through a later format migration.

- Member Sessions that the current format migration refuses, or whose retired log is corrupt, no longer block startup or leave a Member `unavailable`: a refused artifact is admitted into the shipped shape with one current-format sibling published beside it, leaving the original byte-identical, while genuine read failures stay fail-closed.

- Fixed Channel archival and Channel member removal on a Channel holding a taskless Thread, which wrote an incomplete inbox cleanup and made the next start fail; records written by 0.1.7–0.1.9 with that legacy cleanup are repaired in memory on load.

- Members gain `web_fetch` through the `team-member` preset, and the `web_search` guidance now recommends fetching a specific result.

- Members now have time awareness: every agent-facing surface carries absolute instants in the fixed Team coordination zone UTC+8 with an explicit offset, and a `member-time-context` clock row gives the first step of an eligible turn one durable snapshot with the current instant, the elapsed time since the preceding model-visible event, and the ordering-authority note.

- The five model-facing Team tools render as one decision interface: `team_view` is an address book, `team_inbox` states unread and direct counts, and `team_thread` renders its five actions separately.

- The write basis is an opaque next-write token rendered only on a fully drained `team_thread read` and on your own committed public mutation; committed results name their action, claim mutations render the affected Claim first, and `team_claim list` shows only active Claims.

- A Member activation failure caused by two physical copies of `@deepseek-ai/dsh-scope` now states its fix instead of the bare `selected preset is not team-enabled`.

## [0.1.9] - 2026-09-07

- Members manage their own context: `context_rollover` ends the current context and continues as the same Member in a new one, `context_checkpoint` records a restorable anchor before a risky operation, and `context_timeline` inspects the context lineage (checkpoint, first-arrival, and Task claim boundaries labeled by their semantics) and picks an anchor to return to.
- Member context no longer needs watching: near the budget a Member receives one notice suggesting `context_rollover`; at the hard limit the Host compacts before the next request, so a task is not interrupted by context exhaustion.
- Context switches survive restarts and crashes: pending switches replay safely and a crash rebuilds the handoff from the last recorded state.
- `team_view` now lists top-level Threads (with revision and message count), so Members can discover discussions they were not mentioned in.
- Windows support: attachment file names and member memory directories are sanitized per Windows rules (illegal characters, reserved device names, trailing dots and spaces), legacy memory directories migrate automatically, and legacy colon-spelled memory directories merge into the canonical path on activation, with conflicting content archived under a `.colon-twin` suffix.
- Team tool results carry more complete decision information: thread/inbox lines show channel, status, unread/direct counts, and revision; Claims show status, owner, and direction.
- Fixed an intermittent session-retirement race during member activation that could fail startup.
- Fixed the underlying session not rebinding after leaving an embedded member view, which could cross replies.
- Fixed early-accept notifications carrying an empty finished-claim clause.
- Fixed a poisoned rollover pending that could not recover; recovery now retries and prevalidates the checkpointRef.
- The manual "start from a fresh context" action is removed; Member context management is fully delegated to Members and the Host pressure policy.
- CI gains Linux and Windows (Git Bash) lanes, and build/dev scripts are adapted for Windows environments.

## [0.1.8] - 2026-09-05

- Members that run 20 tool calls (then 40, 60…) without posting to a Thread receive a reminder in the current turn, listing the Tasks they hold a Claim on and the Threads they follow, asking for a brief note on what is confirmed, what remains, and any blocker. A reminder the member has not read yet is revoked once the member commits a message.
- A member following a still-`todo` Task it has never claimed receives one `team_claim` reminder after 5 tool calls (once per Thread per Session), suggesting it state its direction in the Thread first. Both reminders are advisory, write nothing to the ledger, and never wake an idle member.
- Team tools and the Web Client accept abbreviated refs: `task:0f0ad7` and any 6+ unambiguous hex prefix resolve to the matching Task / Thread / Member / Channel / Claim. Ambiguous prefixes are rejected with the candidate full refs, prefixes shorter than 6 hex characters are not accepted, and a Task ref renders as a link only after the Host confirms it — unresolved text stays plain.
- On Thread surfaces the mention candidate list ranks the current Thread's followers above the remaining roster, because mentioning a follower delivers directly while a non-follower needs the Human's two-step invitation.
- Member sessions now use the same shipped composer as ordinary sessions: the Team's own hint strip and its `/compact` and `@member` entry points are removed. Member context still compacts automatically past the threshold, and members still get the pre-compaction hint to persist key conclusions first.
- Member guidance separates the two channels: Team messages go to the ledger (visible to the team, revisitable), while a session reply goes straight to the Human who reads the output. It also states that a member's private memory/notes/skills are readable only by that member — restate the content inside the message instead of pointing at a note path.
- Task chips, thread pills, and member avatars share one status-dot component, so the same state renders at the same size and color everywhere.
- The mention candidate list keeps the keyboard selection inside the visible area when the roster needs scrolling.
- The new-update jump hint at the bottom of a Thread disappears once the reader scrolls to the newest message.

## [0.1.7] - 2026-09-04

- Fixes startup failure with current DSH. 0.1.6 combined with the current `@deepseek-ai/dsh` (latest is now 0.1.2-rc.1) installs cleanly — via npm directly or via `dsh plugin add` — but the host then fails to start, because the old peer range still resolves to the 0.1.1-rc.2 generation while DSH itself runs rc.1. This release fixes the combination and moves the certified baseline to DSH `0.1.2-rc.1`. Breaking for older DSH: this is a hard cut — the bundle no longer runs on 0.1.1-rc.2; users still on rc.2 must upgrade `@deepseek-ai/dsh` together with this release.
- Four previously missing peer declarations added (`dsh-api-session-controller`, `dsh-api-workspace-controller`, `dsh-client-ui-renderer`, `dsh-skill`). Two of them appear in the published type declarations, so consumers depending on Team types were relying on `@deepseek-ai/dsh` to pull them in transitively; they are now declared explicitly.
- Member sessions now use the full shipped composer. The restricted Team-only input box is gone: `/` and `@` menus, attachments, and the model picker come from the standard DSH input bar, with a slim Team hint strip above it (vocabulary hint + member turn errors, one quiet line on every viewport).
- Typing `/compact` as a full line now works in member sessions — it routes to the Team compact transaction whether picked from the menu or typed outright; `@member` still inserts structured references.
- Members and Channels can be archived — a reversible third state between suspend and remove. Archiving disposes the live session (member) while keeping private memory and logs on disk, releases the Member's active Claims with public activities, and hides archived entities from every Team surface; direct reads of archived threads return an explicit archived error.
- Member departure cleanup fixed: a departing member's Attention and markers now clear on every thread it followed, taskless ones included (was taskful only).
- README gains a Core-ideas section and a star nudge; docs updated to match the new member-session input surface and the rc.1 baseline.

## [0.1.6] - 2026-09-02

- Member runtime phase one: durable per-member capabilities schema, per-member tool policy, and member-private skills through per-member providers.
- Members can own their private space: the bundled member-skill-manager meta skill guides creating, installing, and maintaining private skills beside member roots.
- Member-to-member direct messages ship with focused context, recipient-handle error reporting, and correct reader-perspective context direction.
- Threads read their updates automatically without manual controls, and the client drops channel-level member editing in favor of the member-focused flow.
- The README now acknowledges Raft as the design inspiration for the collaboration shape.

## [0.1.5] - 2026-08-31

- Member sessions can start from a new context in place: renewing a session keeps the Agent identity, and error members get the same fresh-start path.
- Branded thread references navigate like Task references, and Human mentions render correctly in rich Markdown bodies.
- The team composer accepts pasted files as attachments, expands `@all` to all eligible members, and the member composer accepts mention candidates with Tab.
- Sidebar section collapse state persists per browser, and unclaimed `todo` Tasks can be accepted directly by the Human.
- Before automatic compaction, Members receive one advisory hint to persist their own key conclusions; writing remains the Agent's own call.
- Docs are now bilingual (English default path plus `.zh.md`), the Chinese README carries the full badge row, and builds allow esbuild scripts under pnpm 11.

## [0.1.4] - 2026-08-30

- Thread-first collaboration: start ordinary Threads without a Task, then promote a Thread to a Task when work is ready; structured promotion activity and optional Task overlays keep both paths durable.
- Add long-message expansion and clearer Thread/Channel conversation layouts, including stable reference chips and persisted workspace navigation.
- Add a Human restart action for unavailable Agent members and report the resulting runtime status in the Agent row.
- Keep composer task-mode state visible, preserve Thread header controls after replies, and improve Task reference and mention rendering.
- Refresh the bilingual README previews with current Team mode and Task Thread screenshots; archive completed diagnostics and maintenance records.

## [0.1.3] - 2026-08-29

- Member sessions now support direct Human editing and messaging, including session controls and a dedicated embedded composer.
- Accepted Tasks coordinate bounded automatic Member compaction when scoped token usage exceeds the threshold, without adding compaction facts to the Team ledger.
- Member recovery stops after three consecutive errors, and compaction state heals across preset reloads.
- Harden attachment payload sanitization, normalize legacy Team timestamps, and simplify Host and Client dispatch/rendering paths.
- Add stable Task reference formatting and inline mention rendering, plus the Awesome DSH Plugin listing badge in both README languages.
- Build cleanup, duplication checks, shipping specs, and browser test surfaces now better match the published bundle layout.

## [0.1.2] - 2026-08-27

- Human Thread replies now accept local file attachments; attachment chips, reference rendering, and draft previews are unified across message paths.
- Task references in Human and Agent prose resolve to Task numbers and navigate across Channels; Agent Markdown renders those references inline.
- Human members can accept a Task early while its open Claims finish their work.
- Channels and Agent members can be reordered per browser, with the chosen order restored after reload.
- Preserve member Sessions and pinned reasoning effort through model updates; fixes cover empty optional Team fields and cold-start records.
- Refresh the README Team mode capture to show the current collaboration UI.

## [0.1.1] - 2026-08-26

- Composer attachments: upload local files with cached bytes and thumbnail display, a larger zoom preview, and `team_message` delivery through the host attachment cache.
- Member recovery: resume or restart error-stopped members from the row menu, with automatic scheduled recovery that stands down after repeated failures.
- Restart member sessions in place, with distinct resume/restart row menu icons.
- Pin per-member reasoning effort together with the model selection.
- Simplified Agent and Channel creation: descriptions and initial Channels are optional, and both forms share the unified multi-select picker.
- Time dividers between wide same-sender message runs, and Team mode restores your last location after reload.
- Visual fixes: composer attach button alignment, suppressed stacked row fills while an Agent card menu is open, theme tokens limited to those the DSH theme defines, and a leveled divider hairline.

## [0.1.0] - 2026-08-24

First published release of the bundle.

- Durable single-host Agent Team: Workspaces, Channels, Messages, Tasks, Threads, Claims, and managed Agent membership, backed by an append-only operation ledger.
- Web Client for Human control: Team mode entry, refresh recovery, and exit; Channel and Agent management; Thread attention; Task review.
- Isolated `team-member` preset with five model-facing tools: `team_inbox`, `team_thread`, `team_message`, `team_claim`, and `team_view`.
- Pull-based collaboration protocol: Agent Inbox admission is durable and does not claim that the model has processed an update.
- Team ledger storage routed to SQLite via the public composition patch; other domains keep the JSON default route.
- Certified against DeepSeek Harness `0.1.1-rc.2`.
