# Refresh, copy, accessibility, and evolution

English | [中文](refresh-copy-accessibility.zh.md)

## Data refresh semantics
Project refreshes deduplicate by `messageRef`, merge new and loaded history through `mergeProjectView`, retain the older cursor, and combine `hasMore`. The fresh window is authoritative for every Message it covers — a change wake must move that row's live Task state, newest instant, and unread along with the new facts — while older Messages loaded earlier are kept instead of discarded. A refresh also reads the Workspace Inbox slice and rebuilds the Thread→unread map from it; a failed read clears that map.

Thread passive changes merge into current facts; the durable read pointer advances automatically on open and on every arrival (a bounded read's remainder drains through the serial continuation loop), and `newFactsCount` only drives the pure jump hint. `loadOlder` has concurrency protection.

Once an Agent or Project edit commits, the dialog closes. Until the list refresh succeeds, a failed read reports that the edit is already saved and offers to refresh the list. The Project and Member list results can succeed independently, and a superseded read cannot change the list or its error.

The Inbox badge refreshes from exactly two sources: a durable read this Client completed itself, and a shared change wake. A Host-side read advances only the reader's private watermark and wakes nobody — `team/thread-read` carries an empty change scope by design, because no projection another participant can see moves.

That lag is notification-only. An Inbox page reads fresh on open and a Thread reads when it mounts, so either face shows the Host's current picture. Do not poll the badge, and do not broadcast the read wake: every participant's projection would refetch for nothing. The seam for a future fix is one wake scoped to the reading actor, and it stays unbuilt until multi-window reading becomes a real need.

## Copy and localization
All visible copy comes from structurally matching zh/en locale keys, whose types derive from zh. Parameter conventions are `{count}`, `{ids}`, `{kind}`, `{number}`, `{actor}`, `{direction}`, and `{message}`. Error copy follows the Host: a refusal with a known remedy renders through locale-key copy (`staleRevision` for a Thread that moved, `extraToolsConflict` for a settings revision conflict).

Every other failure keeps the Host's own message verbatim: the localized layer is the frame naming the failed action (`restartFailed`, `archiveProjectFailed`) where the surface does not already name it, because the raw text is the only diagnostic for an unknown refusal and `isUncertainRemoteFailure` treats a dropped carrier and an ordinary Host exception alike.

## Accessibility baseline
Section headers, expand/collapse buttons, menus, listbox/options, the 「作为任务」 control, and the Project page's `主对话 | 看板 | 订阅` tab strip use native keyboard behavior and complete ARIA state. The tab strip is one tab stop for the group with Left/Right/Home/End moving selection and focus together, each tab naming its panel through `aria-controls`/`aria-labelledby`.

Every icon button has an accessible label; decoration is hidden. A Thread entry's door is one native button whose label carries both the Thread and its unread count; the capsule drawn beside it is `aria-hidden`, and the owner stack is a single labeled `role="img"` that stays outside the button so its name survives. Timeline uses a dedicated message-timeline label.

The Agent and Project edit dialogs focus the name on entry and return focus to the originating row on close. Opening an owner responsibility edit focuses its textarea, and closing it — cancel or a committed save — returns focus to that row's Edit control.

A successful manager-gate retry focuses the shipped composer after its Session resolves, unless the reader has already left. The gate's own failure is the surface failure the rest of this Client draws — one line, the message first and its retry at the row's end — and its retry re-runs the same resolution. A failed **New conversation** restores the enabled action and reports through an auto-dismissing Toast rather than a persistent inline alert.

Unread and run dividers have `role="separator"`; visible UI changes require desktop 1440×960, 390×844, and keyboard browser checks.

## Verification and evolution

For prose-only changes, start with `npm run check:docs`; add `npm run check:e2e-docs` when changing browser lane documentation. For UI work, use the [lane catalog](../development/e2e-lanes.md) for targeted feedback. A targeted lane does not replace full browser acceptance.

Visible UI, Client bundle, slot, or Remote activation changes require:

```sh
npm run typecheck && npm test && npm run lint && npm run build && npm run test:browser
```

Thread-first changes additionally cover default taskless sends, default-off keyboard toggle, promotion Host reread, taskless gating, desktop, and 390×844. Routine screenshots stay in ignored `artifacts/browser/`; only a few acceptance images with a README belong in the archive. Behavior changes update this document in the same change; historical rationale belongs in `.scratch/archive/`.

A CSS-module class the TSX names but the module does not define resolves to `undefined` and renders the element unstyled — silently, with no build, type, or test failure. When a rule's presence decides layout, verify the assembled bundle (a computed style, an offset, or the screenshot) rather than the TSX, and read a state that depends on it as an assertion, not as a comment.
