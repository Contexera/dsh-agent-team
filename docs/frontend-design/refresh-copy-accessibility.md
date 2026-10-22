# Refresh, copy, accessibility, and evolution

English | [中文](refresh-copy-accessibility.zh.md)

## Data refresh semantics
Project refreshes deduplicate by `messageRef`, merge new and loaded history through `mergeProjectView`, retain the older cursor, and combine `hasMore`. The fresh window is authoritative for every Message it covers — a change wake must move that row's live Task state, newest instant, and unread along with the new facts — while older Messages loaded earlier are kept instead of discarded. A refresh also reads the Workspace Inbox slice and rebuilds the Thread→unread map from it; a failed read clears that map.

Thread passive changes merge into current facts; the durable read pointer advances automatically on open and on every arrival (a bounded read's remainder drains through the serial continuation loop), and `newFactsCount` only drives the pure jump hint. `loadOlder` has concurrency protection.

## Copy and localization
All visible copy comes from structurally matching zh/en locale keys, whose types derive from zh. Parameter conventions are `{count}`, `{ids}`, `{kind}`, `{number}`, `{actor}`, and `{direction}`. Error copy follows the Host: a refusal with a known remedy renders through locale-key copy (`staleRevision`, `memberNotFollowing`), while a failure the Client cannot word better — a dropped transport, for instance — shows the Host's own message verbatim.

> TODO: decide whether a raw transport message should be replaced by localized copy or stay exactly as the Host worded it; today the surfaces show it verbatim.

## Accessibility baseline
Section headers, expand/collapse buttons, menus, listbox/options, the 「作为任务」 control, and the Project page's `项目 | 看板` tab strip use native keyboard behavior and complete ARIA state. The tab strip is one tab stop for the group with Left/Right/Home/End moving selection and focus together, each tab naming its panel through `aria-controls`/`aria-labelledby`.

Every icon button has an accessible label; decoration is hidden. A Thread entry's door is one native button whose label carries both the Thread and its unread count; the capsule drawn beside it is `aria-hidden`, and the owner stack is a single labeled `role="img"` that stays outside the button so its name survives. Timeline uses a dedicated message-timeline label.

Unread and run dividers have `role="separator"`; visible UI changes require desktop 1440×960, 390×844, and keyboard browser checks.

## Verification and evolution
Visible UI, Client bundle, slot, or Remote activation changes require:

```sh
npm run typecheck && npm test && npm run lint && npm run build && npm run test:browser
```

Thread-first changes additionally cover default taskless sends, default-off keyboard toggle, promotion Host reread, taskless gating, desktop, and 390×844. Routine screenshots stay in ignored `artifacts/browser/`; only a few acceptance images with a README belong in the archive. Behavior changes update this document in the same change; historical rationale belongs in `.scratch/archive/`.

A CSS-module class the TSX names but the module does not define resolves to `undefined` and renders the element unstyled — silently, with no build, type, or test failure. When a rule's presence decides layout, verify the assembled bundle (a computed style, an offset, or the screenshot) rather than the TSX, and read a state that depends on it as an assertion, not as a comment.
