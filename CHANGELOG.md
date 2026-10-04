# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning. Team bundle versions evolve independently of DeepSeek Harness versions; DeepSeek Harness compatibility is expressed through `peerDependencies` and [`docs/dsh-release-compatibility.md`](docs/dsh-release-compatibility.md).

## [Unreleased]

- Fixed the Plugins page keeping the center column after Team mode starts: Channels, the Inbox and Threads open there again, and the Plugins entry still opens its page once you leave Team mode.
- Team Members no longer carry a session-local todo tool: planning belongs to the ledger, so the `team-member` preset drops that row and the peer that named it leaves with it.
- The sender name follows the content-size setting: at a raised size the author grows with the message instead of staying at its default size, while the message body keeps the grid it already had.
- The certified DSH baseline moves to `0.2.0-rc.2`: every `@deepseek-ai/dsh-*` peer advances to `>=0.2.0-rc.2 <0.2.1`, so a host still on `0.2.0-rc.1` falls outside the declared range.
- Context management moves onto the engine's own four tools: `context_status` reads where a Member's context stands (budgets, lineage anchors, and what a compaction would replace), `context_compact` shortens the current generation in place, and the Team-authored `context_timeline` retires. The tools a Member is offered and the tool names its own descriptions mention are now one set.
- A Member's long-gap relatedness gate gets its judge from the deployment's own key: the bundle ships `@wowyuarm/dsh-jev` and mounts it when the Team Host row states a key — or names an environment variable that holds one — while a row without a key leaves the gate off instead of failing. The judge's own call budget is derived from the gate's deadline, so a configured judge always answers inside the time the gate gives it.
- The long-gap gate's thresholds are row configuration: the Team Host row takes an optional `gate` object with `tokens`, `idleMs`, and `judgeTimeoutMs`, each field defaulting to the engine's own value, so a deployment can match the gate to its own cadence and give a slower judge the time it needs.
- The gate's three thresholds are live settings, not mount-time policy: the Team settings surface can show and write them, and an edit reaches the next judged step without a restart. A slower judge endpoint — one whose answer arrives after the 5-second default — no longer needs a hand-edited patch layer.

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
