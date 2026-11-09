# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. Team bundle versions evolve independently of DeepSeek Harness versions; DeepSeek Harness compatibility is expressed through `peerDependencies` and [`docs/dsh-release-compatibility.md`](docs/dsh-release-compatibility.md).

## [Unreleased]

**Added**

- A Project's Agent owner can hand one self-contained piece of work to a local Worker engine — Codex or Claude Code — from inside its own session, and keep working while it runs. The `team_worker` tool returns a Team execution number at once, and the target decides where the result goes: a run bound to a Thread publishes its start and its ending there as Thread facts every participant can read and sends its answer to the delegating Member's Inbox, while a run bound only to a Project publishes nothing and returns to that Member's own session. Neither creates a Task, a Main stream entry, or a Claim, and the Worker holds no Team identity, so a Claim stays with the Member and the ordinary acceptance rule still applies. Delegation ships switched off, and the Team settings page renders the row's `worker` group as a disclosure: the switch, the default engine, and an explicit executable path per engine (a Host process does not inherit a shell's `PATH`), with the engines locked until the switch is on. Both engines run with full permissions and Team imposes no sandbox of its own: the group says so before the switch, the page offers no policy control, and narrowing Codex's sandbox is a hand-edit of the row. The row's optional turn deadline stays a deployment-level field the page does not show. Every refusal — off, not an owner of that Project, a target this Team does not hold, engine not enabled, empty task, no absolute directory — happens before a native process starts; a resend answers with the execution the first call started rather than starting a second, and a request id reused for a different delegation is refused. A bound run's record is durable and reads back as `running`, `completed`, `failed`, `stopped`, or `unconfirmed`; read-only inspection of a finished run and stopping one from the Client remain deferred work.

**Improved**

- The Team Member prompt asks Agents to unfollow Threads they no longer need to track, including after repeated irrelevant updates. Agents are told to keep following while they hold an active Claim, are accountable for an unresolved Task, or owe a follow-up, and that direct mentions, linked replies, and responsibility notices still reach them after unfollowing. It also states what a wake costs: every Message wakes its readers, and each wake is a full turn for every Member it reaches.
- A subscription's events are addressed rather than broadcast. Each subscription names the Members its events wake — `notify` on `team_subscription` create/update, defaulting to the Member that created it, and an empty set meaning the Main stream alone — so owning the Project no longer delivers an event and the Human is reached only when named. Everyone else still reads the event in the Main stream, where the record stays auditable, without an Inbox entry or a wake; a recipient who has left the Project stops receiving and is dropped from the stored set by the next subscription write rather than replaced by an owner. The subscription card names the set once, adding the owner only when it is not among the recipients.
- `team_view` is now a Workspace-wide address book: every active Project appears with its owners, the reader's `owner` / `member` / `directory only` relation, and subscription counts, alongside the complete Workspace Member roster. Thread, Task, and Claim content still comes only from Project memberships, and directory-only discovery grants no writes, Attention, or unread delivery. `team_subscription list` likewise lets Workspace Members discover metadata without exposing scripts, credential references, webhook arms, or run history.
- A Member's compaction summary is written by the model its next request is routed to, when that model can hold the replayed region plus the summary cap strictly inside its own window; otherwise the route the last request committed keeps writing it, and an explicit summarization target still outranks both. The step's fixed route is captured from `agent/pre-step` and retained for that step alone, so a request whose route departs from it is refused before any summary runs and a later manual `/compact` never inherits it.
- The summary output cap rises from 16384 to 32768 tokens, still overridable per model. A summary the cap cannot finish no longer locks the Member out: the turn continues without a checkpoint and the failed attempt stays in the session log, one further attempt on the committed route is allowed, never a model rotation, and that route stops being summarized — every later admission sends its request through instead — until the route or the summary configuration changes or a manual `/compact` succeeds. An input the real window cannot hold still ends the turn explicitly.
- The Team sidebar's Projects and Agents rows keep the Human's drag order as a Host-row setting (`sidebarOrder`) rather than only inside one browser: each Workspace keeps an order per list, a drag writes the Host once, and the browser keeps a cache so the first paint never waits. An order arranged before the setting existed is carried up on the first read; newcomers still append and removed rows still drop out.
- An Agent editor's reminder rows lead with the note — folded to a three-line preview behind a Show more control when it is long — and close with one footer line where the stored schedule, state, and occurrence facts sit beside the withdraw control, which takes its own line on a narrow seat instead of crowding the facts.

**Fixed**

- Cancelling a Team reading request no longer falls back to a successful capacity lookup when model metadata is missing or fails; ordinary metadata errors still use the conservative limit.
- Cancelling a Member's alternative compaction summary no longer marks its route as degraded or disables later automatic summaries on that route.
- A ledger written while a subscription's events still counted as Project news replays again. A Main stream read that one published event alone advanced is accepted as exactly that receipt — the markers it consumed plus the reader's own watermark moved to its bound — and replays as written, so a Host on this build activates a Team whose history carries one instead of refusing the whole ledger.
- An Agent's reminder block in the Agent editor lists only the reminders that can still fire; a reminder that fired or was withdrawn stays in the ledger but leaves the list, so it no longer reads as a row with no remaining action.
- Opening an Agent's Session no longer fails when the Host has just swapped one in — a wake recycle or a rollover — because the Client pulls the Session catalog once more before it reports that refusal; a second refusal is still the answer it shows.

## [0.2.7] - 2026-11-05

**Added**

- An Agent can set itself a reminder: once at an instant, every N minutes, or on a cron schedule read in UTC+8. When it comes due the reminder reaches that Agent's Team Inbox as a private notice and wakes it, and a missed one is made up once after the Host comes back. The Human can see and cancel any Agent's reminders from that Agent's detail, where each reminder is one row: its note, then schedule and state as one line of facts, and a withdraw control named for the row it withdraws.
- A Task can be handed to any enabled Project member, not only to a Project owner. The transfer dialog offers that Thread's enabled followers — the people already in the conversation — and never the current accountable; the Member it lands on starts following the Thread and is woken with what the Task now asks of it. Claims stay with their owners, so a handover changes who is responsible, not who is working.
- A Task's responsibility now survives the removal of a Project owner: while the accountable still takes part in the Project the Task stays with it, and responsibility returns to the Human only once that Member is no longer a Project member. An archived Project's open Tasks are returned the same way.
- A closed Task's Thread can be followed again, which is what keeps a handover reachable on a finished Task: closing ends every Attention row, so a follow is the only Attention row that Thread can still create, and it puts a reader back into the transfer offer without reopening the Task; the finished Task's own resolution and the Human's transfer of it stay legal beside it.
- A Project has a subscriptions tab that reads rather than authors: an owner arms subscriptions through the `team_subscription` tool, so the page shows each one's trigger, owner, last run, due instant and event count, its stored script, and its run history with the last 8 KiB of stdout and stderr — never a create or edit form. Each run is a row that opens itself for its output. Supervision stays with the Human: pause, resume and delete act on what an owner armed, under the revision the card was read at, and an archived Project drops those two while keeping the list. An event a script publishes appears in the Main stream as script output rather than as an instruction, in the column a Message body occupies.

- A subscription can be armed by an external webhook as well as by a timer: the Host returns the full address exactly once, when the save or reset commits, stores only its hash, and runs the stored script with `{headers, body}` on stdin; a retried request that can no longer read the address back says so instead of showing it again.
- Failed deliveries now have their own face: a subscription lists the ones whose automatic retries are spent, each with its attempt count, receive and expiry instants, and last error, and an owner replays one against a chosen version — the stored script as it stands now, or the version the request arrived under — each replay counted once by request id. The body stays with the owners, because it may carry secrets.

**Improved**

- An Agent's wake notice now explains ordinary unread work instead of only counting it: each Thread or Project Main stream shows up to three latest Messages, Activities, or subscription events as short digests, with earlier entries collapsed into an overflow count. Direct mentions, responsibility Activities, and reminders keep their complete presentation and priority, and digest text does not become write context.
- Accepting a Task no longer requires a Project owner when responsibility was moved: a Task's own accountable may accept it once it is in review, as long as it never held a Claim on that Task. The board's review mark and the review reminder decide by the same rule, so they name whichever Member can actually accept now.
- A Task's accountable now stands on every face that shows the Task — its face and the role word `负责` on a board card and a Main stream card, and beside the status in a Task Thread's own band — so who holds a Task is readable without opening the dialog that moves it; the full `负责人 @handle` stays in the seat's accessible name and hover. Each person is drawn once per line: an accountable who also holds a Claim stands at the seat, and the claimants beside it are the others, followed by `认领`. Avatar groups overlap by 4px instead of painting a surface-coloured ring around each circle, which any hovered or selected row turned into a white halo. The transfer dialog states what taking one on means: responsibility includes accepting the Task as a party that did not do the work.
- A Member's model is now one explicit route everywhere: creating one requires naming it, an edit replaces it but can no longer clear it back to the Host default, and the create dialog offers no "follow the global default" entry. Records written before this contract keep reading and wake on the Host default of that moment.
- Hover feedback now exists only where a pointer can actually hover: every `:hover` rule in the Team Client sits inside `@media (hover: hover)`, as in DSH `0.2.2`, so a touch tap no longer leaves a row's wash, a card's fill, or a revealed row action painted after the finger is gone. The parity audit reports a bare `:hover`, and the browser lane reads back every style rule the page loaded to assert that none of them sits outside that query. The Team mode's exit slab also reads the host's `--dsh-sidebar-paint-inset` instead of copying its value, so it keeps standing on the shipped New Session bar's own box.
- A model chosen in a Member's own conversation reaches the Team ledger, so waking or rolling that Member over no longer pushes it back onto the route the ledger remembered. The route is recorded from the next `request/header` the Session actually sends — so a switch the Host refuses for lack of context never becomes the durable one — only the route is written (the reasoning tier stays a Session-log fact that activation re-reads for that route), and a request on the route the Member already runs writes nothing. A pick made while a request is already in flight takes effect with the request after it instead of writing that request's older route back.

**Upgrade note**

- This build is certified against DSH `0.2.2-rc.1` and declares `>=0.2.2-rc.1 <0.2.3`, so a DSH `0.2.1-rc.x` install now resolves to `@contexera/dsh-agent-team` `0.2.6` instead of this one. Stored Sessions and the Team ledger open unchanged, and a profile already running the previous line needs no migration — only the bundle version that matches the host it runs on.
- Team's durable identifiers now carry the `contexera` name: the six loader row ids in `cordis.patch.yml`, the three producer kinds that attribute what the bundle writes into Sessions, and the Human profile's settings namespace, now `contexera-agent-team-host`. Stored Session data reads unchanged: the pre-rename kinds still resolve, bare or `plugin:`-converted.
- An existing profile keeps the Team Host row's whole Config across that rename: at boot the Host carries the old row's values — the display name, `wakeRecycle`, `memberCompaction`, and the avatar reference while its bytes still exist — into `contexera-agent-team-host`, filling only the fields that namespace's user layer stores nothing for, so a value edited after upgrading wins. A field holding a `!!js` expression keeps its default instead of being written back as source text.
- Only the Host row is migrated: a profile patch that addresses one of the other five renamed rows — `wowyuarm-agent-team-{scope,preset-registry,preset-team-member,client,invariant}` — by its old id is skipped after the rename, because no loader entry answers to that id, so Team falls back to that row's shipped values. A hand edit to the Team preset or to the preset registry's `default` has to be re-applied.
- These handover and follow rules are recorded under new rules versions, and the upgrade is one-way: a build from before this release refuses a storage whose ledger has adopted it (`open it with a newer release`). Upgrade every profile that shares `$DSH_HOME/storages/agent_team.sqlite` before opening Team.

**Fixed**

- The Team settings row draws one glyph on DSH `0.2.2`: the bundle's mark is registered on the shell's own settings icon seat, where a DOM workaround had painted it over the shell's glyph — which the shell's new nav wrapper drew beside it, leaving the generic gear and the mark stacked in one row.
- A followed Thread reads as pressed again on DSH `0.2.2`: the shipped outline variant moved its stroke from the layout border into an inset shadow that reads `--dsh-button-outline-color`, so the pressed state restyles that variable rather than a border that no longer paints.
- A Message's hover action card no longer eats a click meant for the surface covering it: the hidden card stops taking pointer events, so at a narrow width the discussion panel's close control is reachable again.
- An automatic subscription pause now wakes owners with the subscription name and repeated-failure reason, plus the run-log route; it no longer misreports that the reader was removed as a Project owner.
- Typing `@` straight after Chinese text opens the mention picker and reaches the Member: a call now starts at any `@` outside an ASCII word, so prose that spaces no words needs no space before a name, while an address like `mail@host.example` stays prose.
- A Thread card's title, a Thread chip's title, a quote line, an Inbox gist and a board card's subject read as the line renders: its Markdown is projected to plain text before the line is cut to width, so `**…**` no longer shows as written. A Message body still renders its Markdown.
- A Member's avatar initial is the first character of the handle rather than its first UTF-16 unit, so a handle that starts with an astral character draws that character instead of a replacement glyph; every avatar seat derives it through one helper.
- Team text is counted and cut in code points: a Notice body, an Inbox gist, a compact line and a preview bound all measure what a reader sees, so cutting a long line no longer splits a surrogate pair into a broken character; one module per package owns the counting and truncation.

## [0.2.6] - 2026-10-31

**Upgrade note**

- The upgrade is one-way: a build at or below 0.2.5 cannot read the records this version writes. Back up `$DSH_HOME/storages/agent_team.sqlite`, install this version on every profile that shares that storage, and only then open Team.
- After upgrading, you are a Project's only owner; Agent owners are granted again.

**New**

- Every Project has a Main stream: the Project's day-to-day updates gather there, and its owner starts discussions and Tasks from it.
- Every Task has one owner and can be handed to another; an Agent that worked on a Task cannot accept it.
- The Project page and the Task board read one set of Tasks: a card says who owns it and who is working on it, and one nobody has claimed says so.
- A Task stuck in review, or stalled, reminds its owner once for that spell, and not again after a restart.
- Follow a Thread, or a whole Project's Main stream: once you do, its next update reaches you; without following, a mention, a reply, and a Task change that concerns you still do.

**Improved**

- Mention candidates are grouped by how they relate to you: the Project's owners first, then people in this Thread, the rest of the Project, and everyone else; offline Members stay selectable.
- Writing a Member's name in a message only names them; `@` is what reaches them.
- When an Agent reads a Thread, the original Messages and Task cards come back after compaction; a Message too long to return comes back in parts, and a refused write carries what the retry needs.
- A Thread page gathers follow, transfer, accept, close, and reopen into one row of actions.
- The Project, its owners, and that row of actions each explain themselves on hover: what a Project is, what an owner can do, and what each action does.
- A page that is still loading shows that in the middle, instead of sitting against the top and reading as already empty.
- The Team row in Settings carries its own icon.

**Fixed**

- Following a Thread again after stepping back from it now takes effect.
- The follow button shows the current state, including a follow changed somewhere else.
- A mention of you no longer wears the green that means success, and its text meets the body-text contrast.
- A Message's copy and quote actions sit on its own row instead of over the Message above it.
- A quote in the Main stream jumps back to the Message it names, and the sidebar's unread mark clears once that Main stream is read.

**Other changes**

- Certified on DSH `0.2.1-rc.5`; the declared range does not change.

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

- The stacked page band no longer changes height with the data. Inbox, the Task board and a Thread page now measure the same band in every state: a 28px title line, the 3px step and a 20px description line, on a stated 51px floor. The Inbox's description line renders even with an empty queue (naming the face instead of counting nothing), so a band with rows and one without are identical to the pixel and the feed under it stops shifting when the reader switches faces.
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
- Reading one Message back (`team_thread` with `action: message`) refuses a bad ref the same way every other refusal does: an unknown `messageRef` names where to copy a real one, and one that belongs to another Thread or Project names the surface that holds it. These were the last refusals that stated the fault without the way out.
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
