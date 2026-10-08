# Design principles and language

English | [中文](principles-and-language.zh.md)

## Design principles
1. Reuse Harness public primitives from `@deepseek-ai/dsh-client-ui-primitives`: `MarkdownText`, `Button`, `Pill`, `Modal`, `Tooltip`, `Input`, `StateDot`, icons, and the dismissal/max-height hooks. Team does not reimplement them; the composer textarea is the single-line `Input` exception, and `MessageText` is no longer part of the set — the shipped primitive was removed in 0.1.5, so `TeamMessage` renders plain bodies itself and delegates Markdown to `MarkdownText`.
2. Use only aliases actually defined by `@deepseek-ai/dsh-client-ui-theme`: `--dsw-alias-label-*`, border, background, interactive, state, shadow, and specific tokens. Team variables may only be derived values such as avatar hue. Undefined `var()` values silently fall back to `initial`, so never guess token names.
3. Prefer chat density over assistant-document density: body text is the 14px scale and Markdown spacing is tightened locally.
4. Use progressive disclosure: quiet borders and no fill by default; hover/focus elevate feedback; secondary information uses tertiary color.
5. Durable mutations are not optimistic. Preserve input on failure and render the next Host projection, using `mergeChannelView` rather than replacing the whole view.
6. Every custom composite control has roles, ARIA state, and a complete keyboard path.

## Design language alignment (DSH 0.1.7, rc.2 baseline)
The Team Client renders inside the shipped DSH shell, so it must speak the
base UI's design language. This section is the durable contract; the
repeatable mechanical audit is `node scripts/audit-ui-parity.mjs` (run it
after any visible-UI change and after every DSH upgrade — the shipped
reference tripwires fail when the harness checkout no longer defines the
primitives this parity relies on).

The target is the **0.1.7-rc.2** writing: it tokenized the focus ring, put the
radius scale on named tokens, and re-rounded several surfaces (the composer
card 22px → 28px, menu and result rows 8px → 12px and 16px, chips 6px → 8px).
See the two-checkout rule below for how one sheet serves both rc.1 and rc.2.

Re-verified on the **0.2.0-rc.1** line (the certified peer line; see
[dsh-release-compatibility.md](../dsh-release-compatibility.md)), and again on
**0.2.0-rc.2** at source level: the radius tiers and the focus-ring chain are
unchanged, the sheets this table mirrors are byte-identical, and the theme only
gains aliases. What 0.2 did move belongs to shipped surfaces this contract does
not mirror: overlays read the new frame insets, transcript shimmer moved to
`TextShimmer`, and the chat flow gap tightened to 6px — 12px after a response.
The Team timeline keeps its own rhythm: seat-style rows with reserved identity
space and Markdown bodies whose margins set the spacing, so a fixed transcript
gap has no equivalent.

| Dimension | Rule | Shipped reference |
| --- | --- | --- |
| Icon-only control | 28×28 circle, `border-radius: 999px`, `corner-shape: round`, transparent fill, hover `--dsw-alias-interactive-bg-hover-solid` (composer) / `--dsw-alias-interactive-bg-hover` (sidebar) | `InputBar.module.css .add`, `SidebarRoot.module.css .iconButton` |
| Primary round action (send/stop) | 34×34 circle, `--dsw-alias-button-info-fill`, static `#fff` glyph, hover info-hover, disabled `opacity .4` + `cursor: default`, `translateY(-2px)` seat compensation | `InputBar.module.css .primary` |
| List rows | The md tier of the shipped radius scale (12px); `aria-current="page"` leaf fill; hover `--dsw-alias-interactive-bg-hover`. The tier follows the row, not the surface it lands on: a row that carries a person or an entity — the sidebar's Channels and Agents, and the roster row shared by the members dialog, the Channel editor and the agent import — is a list row wherever it renders. | `SidebarRoot.module.css .panelRow` (12px since the 0.1.6 line, harness c6b81a75; `--dsw-radius-md` since 0.1.7-rc.2) |
| Queue/result row (two-line) | Full-width button, the lg tier (16px; 8px on an rc.1 checkout), 8px horizontal inset, one line per fact with its own ellipsis, hover `--dsw-alias-interactive-bg-hover`, inset focus ring. Typography grades the two lines: subject 14px/22px primary, provenance/meta 12px/18px tertiary with the significant segment (the Channel name) stepped up to secondary 600, and an inline `Task #N` as a chip. Which line carries which fact follows the surface's own information order. This is a *different* dimension from list rows: `.panelRow` moved onto the rail's 12px in the 0.1.6 line while `.searchResultRow` stayed at 8px — until 0.1.7-rc.2 took it to `--dsw-radius-lg`. | `ui-workspace/src/client/rows/Rows.module.css .searchResultRow` (8px inset, full-width button, hover fill, 14px title over 12px meta) |
| Capsules and circles | Every effectively uncapped radius — `border-radius: 50%`, `999px`, or a pill radius that equals half the box — pairs `corner-shape: round` in the same block. The platform curves all rounded surfaces along `superellipse(1.5)`, which deforms a circle into a squircle and squares capsule ends off; shipped pairs 100% of its full-round blocks and the audit fails an unpaired one. | `ui-theme/src/styles/corner-shape.css`; `Tag.module.css`, `StateDot.module.css`, `SidebarRoot.module.css .iconButton` |
| Count badge | One capsule for every count the Human reads, declared once in `countBadge.module.css .badge`: 18px with `min-width: 18px`, `border-radius: 999px` paired with `box-sizing: border-box` (one digit stays a circle instead of padding out to an oval), `--dsw-alias-state-business-primary` fill and `--dsw-alias-label-primary-foreground` text, hidden at zero, `99+` past it, and the number rides the control's accessible name (`aria-label`), never the visual badge alone. | `Tag.module.css` (read-only capsule language); `countBadge.module.css .badge` |
| Chips | The small tier of the shipped radius scale (8px; 6px on an rc.1 checkout — 0.1.7-rc.2 retired the 6px chip), `--dsw-alias-interactive-bg-hover` fill | `composer-editor.module.css .reference` (the inline reference; shipped keeps it transparent with a business-tinted hover) |
| Control gap | 12px between sibling controls inside a composer/sidebar toolbar group, narrowing to 8px in the composer below 560px | `InputBar.module.css .tools/.trailing`; the composer's own `@container (max-width: 560px)` |
| Keyboard focus | Ring in the shipped token form: `outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))` — one colour everywhere. The fallback carries that business colour, so an rc.1 checkout paints the same blue; on rc.2 the platform owns width, colour and the pointer suppression that blanks it for non-editable controls. Offsets stay per control (rows `-2px`). `outline: none` needs a ring-grade replacement in the same rule (outline, `box-shadow`, `border-color`, `text-decoration`). Exemption: `aria-activedescendant` listbox rows — focus stays on the text input, selection shows via `[aria-selected]`. | `SidebarRoot.module.css .panelRow:focus-visible` |
| Icon semantics | Glyphs carry meaning from the base UI: `+` = command menu, paperclip = attach, pencil = edit. Never repurpose a shipped glyph for a different action. 0.1.7 renamed the icon set — the size left the name and the weight entered it (`Icon*OutlineRegular`, `Icon*OutlineMedium`, `Icon*OutlineArtwork`), with the size passed through the `size` prop — and removed the shipped composer's own attach control, so the Team composer's paperclip is this repository's own convention. Weight is chosen per control rather than per size: the composer's leading controls take the `Medium` face at 14px (shipped's `+`), while the wider icon set stays `Regular` at 12–14px — so the Team composer's own attach and mode controls follow the composer. | `InputBar.tsx` (`+` opens the command menu via `aria-haspopup="listbox"`, `IconPlusOutlineMedium size={14}`) |
| Team artwork | Team draws its own: no shipped glyph means "Team", and the plugin list otherwise shows the default placeholder. The root manifest's `icon` field points at `assets/icon.svg` (a relative path inside the package, SVG/PNG/JPEG/WebP, ≤256 KiB, shipped through `files`) — the full-colour mark the plugin list renders — while the rail row carries a monochrome 16px mark of the same drawing in the shipped icon form (`viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1"`, geometry inside 2..14, `aria-hidden`), so it takes the row's own ink in either theme. | `assets/icon.svg`; `TeamPanelIcon.tsx` (rail row glyph); `package.json` (`icon`) |
| Mode control (composer) | A control that changes what the primary action *means* — as-task — is a **mode**, not an action: it keeps a visible word label at every width, shares the left group with the attach control, and reads as a 28px-high chip (8px radius, 13/20px weight 500, transparent fill, hover `--dsw-alias-interactive-bg-hover`, on-state `--dsw-alias-button-primary-fill` with `--dsw-alias-label-primary-foreground` under `aria-pressed`). Shipped deleted the labeled permission chip and its 460px label cut in 0.1.7, so the word is never hidden at any width: the composer narrows its control gaps below 560px instead. | `InputBar.module.css .row` (size container); mode chrome is `.select` (28px, 8px radius, 13/20 medium) |
| Floating surface | A translucent surface token (`rgba(…, α < 1)`) pairs a backdrop blur in the same rule, with the elevation stroke and shadow — the floating-card recipe: `background: var(--dsw-specific-menu)`, `backdrop-filter: var(--dsw-menu-backdrop-filter)`, `--dsw-elevation-stroke-color`, `box-shadow: var(--dsw-elevation-prominent)`. 0.1.7 made that token translucent *without renaming it*, so a popup painting it opaque goes unreadable while every existence check stays green; the audit's frosted-surface rule catches it. 0.1.7-rc.2 keeps the name as an alias of `--dsw-menu-surface-fill`, so the recipe is unchanged, and the surface is the lg tier over md-tier rows (`.list`, `.item`) — a hand-rolled popover speaks the `Menu` primitive's language. | `ui-primitives/Menu.module.css .list` |
| Card surface | A panel that holds content is stroked by the elevation hairline, not by a layout border: `border: 0` with `--dsw-elevation-stroke-color` set to the tier's neutral (l1 for menus, l2 for the composer card, one step apart) and the tier's shadow. A real 1px border in the dark-mode thin alias is half the intended alpha in dark mode and costs layout. | `InputBar.module.css .card` (`border: 0`, stroke l2, `--dsw-elevation-soft`); `Menu.module.css .list` (stroke l1, `--dsw-elevation-prominent`) |

**Two-checkout rule.** One sheet serves two checkouts: the rc.1 checkout this
repository builds against today, and the rc.2 baseline. A token that entered the
shipped theme in rc.2 is therefore written with the literal it replaced as its
fallback (`var(--dsw-radius-md, 8px)`, `var(--dsw-focus-ring-width, 2px)`): the
token carries the language forward, and the fallback keeps the older checkout
rendering what it renders today. The audit holds both ends — an undefined token
that is not on its forward-declared list is an error, and a forward-declared
token written without a fallback is an error too.

Three dimensions stay deliberately out of alignment. They are decisions, not
drift, and each is owned here so a future reader does not "fix" it:

- **Chip fill.** Shipped's `.reference` is an inline editor reference that stays transparent until hover; a Team chip must read as one token inside a 14px message body, so it keeps the shared hover fill as its own ground.
- **Composer card padding.** Shipped packs its card at 8px above and 4px below, but Team's card carries rows shipped's does not (the recipient notice and the attachment chips), so it keeps 10px above and 8px below. Its stroke, radius, fill, and shadow follow shipped exactly.
- **Neutral border width.** Shipped writes every neutral separator as `0.5px` (`--dsw-alias-border-l*`, 164 declarations), but Chromium rounds `border-width` up to a whole CSS pixel: a computed `0.5px` border reports and paints as `1px` at 1×, 1.25×, 2× and 3× device pixel ratios alike, which a pixel probe of the shipped declarations confirms. Team writes the value that actually renders — `1px` — so the pixels match shipped exactly and the source says what the eye sees. The real half-pixel mechanism is the `box-shadow` hairline the card-surface rule above uses.

Component-level verdicts are recorded per surface in
[components.md](components.md); the audit script reports mechanical drift,
these documents own the judgment.
