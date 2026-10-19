// UI parity audit: mechanical consistency checks between the Team Client's
// own CSS/TSX and the DSH 0.1.7 design language — the rc.2 baseline, re-verified
// on the 0.2.0-rc.1 and 0.2.0-rc.2 lines — documented in
// docs/frontend-design/principles-and-language.md §Design language alignment.
// This is the repeatable
// form of the manual audit that produced commit bb1ebba — run it after any
// visible-UI change and after every DSH upgrade:
//
//   node scripts/audit-ui-parity.mjs
//
// The script is intentionally a static text audit: it reads the Team Client
// sources and the harness checkout (through the shared harness-dir.mjs
// pointer), applies the documented language rules, and prints a report.
// Design judgment stays in docs; the script only reports mechanical drift.
// It must stay green on the checkout the peers are certified against
// (DSH_HARNESS_DIR points it at one): since the 0.2.0 peer move the shipped
// theme defines every --dsw-* token the Team Client references.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { harnessDir } from './harness-dir.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(root, 'packages/client-agent-team/src/client')
const shippedDir = join(harnessDir, 'packages/client')

const findings = []
const note = (severity, where, what) => findings.push({ severity, where, what })

// ---------------------------------------------------------------------------
// Language rules (keep in sync with
// docs/frontend-design/principles-and-language.md §Design language
// alignment — the document is the authority, this table is its executable
// mirror).
// ---------------------------------------------------------------------------

// The colour half of the focus ring. The platform sets `--dsw-focus-ring-color`
// to transparent for pointer input on non-editable controls, so a ring must read
// the variable and fall back to the one business colour — a literal colour would
// both ignore that suppression and stop tracking the theme. Both ring forms
// (outline below, and the box-shadow a control uses when an outline would
// collide with its own geometry — shipped `ModelSelect.module.css .trigger`)
// carry this same chain.
const RING_COLOR = 'var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))'

const LANGUAGE = {
  iconButtonDiameter: 28,
  sendButtonDiameter: 34,
  rowRadius: 8,
  chipRadius: 6,
  controlGap: 12,
  // 0.1.7-rc.2 tokenized the ring. The fallback names the colour and the standard
  // width. The language is this one string: a ring that reaches for another
  // colour, or nests a second fallback under the business token, is the drift
  // §2b catches — so the comparison is equality (whitespace normalized, so a
  // wrapped declaration still passes), not a prefix match.
  focusRing: `var(--dsw-focus-ring-width, 2px) solid ${RING_COLOR}`,
  // A focus ring must be visible: an `outline: none` with no paired visible
  // replacement (background, box-shadow, color, underline) is a violation.
  // listbox/aria-activedescendant option rows are exempt (focus stays on the
  // text input; the selected row is highlighted via aria-selected).
}

// Interactive classes that intentionally have no :focus-visible rule. Each
// entry must name the pattern that provides the visible selection feedback.
const FOCUS_EXEMPT = new Map([
  // Composer mention popup options: role="listbox" driven by
  // aria-activedescendant on the textarea — options never take keyboard
  // focus, the highlighted row is styled via [aria-selected='true'].
  ['mentionOption', 'aria-activedescendant listbox row (selection, not focus)'],
])

// ---------------------------------------------------------------------------
// 1. Focus visibility: every interactive class (cursor: pointer) needs a
//    focus-visible rule or a documented exemption.
// ---------------------------------------------------------------------------

function collectRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
    selector: match[1].trim(),
    body: match[2],
  }))
}

// Nested at-rule blocks (`@container`, `@media`) carry narrow-width values of
// their own — the composer's 560px branch narrows control gaps to 8px — so the
// flat rule scanner must not read them as the base rhythm. An at-rule that is
// never closed at column 0 would otherwise swallow the rest of the file in
// silence, so an unbalanced block is reported instead (once per file: several
// later sections run the same strip over the same sheet).
const unclosedAtRules = new Set()

function stripNestedAtRules(css, file) {
  const kept = []
  let depth = 0
  for (const line of css.split('\n')) {
    if (depth === 0) {
      if (/^@(container|media|supports)\b/.test(line)) { depth = 1; continue }
      kept.push(line)
      continue
    }
    if (line.startsWith('}')) depth = 0
  }
  if (depth !== 0 && !unclosedAtRules.has(file)) {
    unclosedAtRules.add(file)
    note('error', file, 'an unclosed @container/@media/@supports block hides every rule after it from the flat scan; close it at column 0')
  }
  return kept.join('\n')
}

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  const rules = collectRules(css)
  const interactive = new Set()
  for (const rule of rules) {
    if (/cursor:\s*pointer/.test(rule.body)) {
      for (const selector of rule.selector.split(',')) {
        const cls = selector.trim().match(/^\.([A-Za-z0-9_-]+)/)
        if (cls) interactive.add(cls[1])
      }
    }
  }
  const focused = new Set()
  for (const rule of rules) {
    if (/:focus-visible/.test(rule.selector)) {
      for (const match of rule.selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) focused.add(match[1])
    }
  }
  for (const cls of interactive) {
    if (!focused.has(cls) && !FOCUS_EXEMPT.has(cls)) {
      note('warn', `${file} .${cls}`, 'interactive class without any :focus-visible rule')
    } else if (!focused.has(cls) && FOCUS_EXEMPT.has(cls)) {
      note('info', `${file} .${cls}`, `exempt (${FOCUS_EXEMPT.get(cls)})`)
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Bare outline suppression: an outline removal must pair a ring-grade
//    replacement in the same rule body. Background/color/opacity alone is
//    hover feedback, not a focus indicator — shipped keeps the UA ring on
//    small controls rather than substituting a hover fill.
// ---------------------------------------------------------------------------

const RING_GRADE = [
  /outline\s*:\s*(?!\s*(?:none|0)\b)/,
  /box-shadow\s*:/,
  /border(?:-color)?\s*:\s*(?!\s*(?:none|0)\b)/,
  /text-decoration\s*:\s*(?!\s*none\b)/,
]

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  for (const rule of collectRules(css)) {
    if (!/:focus-visible/.test(rule.selector)) continue
    if (!/outline\s*:\s*(?:none|0)\b/.test(rule.body)) continue
    if (!RING_GRADE.some(pattern => pattern.test(rule.body))) {
      note('error', `${file} ${rule.selector}`, 'focus-visible suppresses the outline with only hover feedback; add a ring (outline, box-shadow, border-color, or text-decoration)')
    }
  }
}

// ---------------------------------------------------------------------------
// 2b. Focus ring form: every ring the Team Client paints takes the shipped
//     token form, so it inherits the platform's width and colour — including
//     the pointer-modality suppression, which works by setting the colour
//     variable (a literal colour would paint a ring over a mouse click that
//     shipped suppresses). Offsets stay per component, as shipped declares
//     them. Both forms are checked: the canonical `outline`, and the
//     `box-shadow: 0 0 0 2px …` ring a control uses when an outline would
//     collide with its own geometry — its colour must be the same chain, or the
//     ring silently becomes two different rings (`--dsw-alias-border-l3` was
//     one such drift). `outline: none` is section 2's business, not this one.
// ---------------------------------------------------------------------------

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  for (const rule of collectRules(css)) {
    if (!/:focus-visible/.test(rule.selector)) continue
    const outline = rule.body.match(/outline\s*:\s*([^;]+)/)?.[1]?.trim().replace(/\s+/g, ' ')
    if (outline !== undefined && !/^(?:none|0)$/.test(outline) && outline !== LANGUAGE.focusRing) {
      note('error', `${file} ${rule.selector}`, `focus ring is written as 'outline: ${outline}'; the language is the one form 'outline: ${LANGUAGE.focusRing}' so every ring follows the shipped width, the single business colour and the pointer suppression`)
    }
    // Elevation shadows (`0 4px 12px …`) on a focused element are not rings and
    // do not match the ring shape.
    const shadow = rule.body.match(/box-shadow\s*:\s*([^;]+)/)?.[1]?.trim().replace(/\s+/g, ' ')
    const ringColor = shadow?.match(/^0 0 0 [\d.]+px (.+)$/)?.[1]
    if (ringColor !== undefined && ringColor !== RING_COLOR) {
      note('error', `${file} ${rule.selector}`, `box-shadow focus ring paints '${ringColor}'; the ring is one colour in both forms — write 'box-shadow: 0 0 0 2px ${RING_COLOR}'`)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Hardcoded colors: the Team Client uses --dsw-alias-* tokens; hardcoded
//    hex/rgb values are allowed only in the documented exceptions (static
//    white on colored fills, avatar hue).
// ---------------------------------------------------------------------------

const colorExceptions = new Set([
  'composer.module.css', // .sendButton static #fff on info fill (matches shipped)
  'conversation.module.css', // message clamp mask gradients + run divider shadow
  'sidebar.module.css', // avatar text #fff on the hue fill
  'avatar-stack.module.css', // entry-stack avatar text #fff on the hue fill
])

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  if (colorExceptions.has(file)) continue
  const css = readFileSync(join(clientDir, file), 'utf8')
  for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
    note('warn', `${file}`, `hardcoded color '${match[0]}' (only --dsw-alias-* tokens or documented exceptions)`)
  }
}

// ---------------------------------------------------------------------------
// 4. Control rhythm: 12px between sibling controls inside a composer/sidebar
//    toolbar group (the shipped figma 75:8208 spacing).
// ---------------------------------------------------------------------------

for (const file of ['composer.module.css', 'sidebar.module.css']) {
  const css = stripNestedAtRules(readFileSync(join(clientDir, file), 'utf8'), file)
  for (const rule of collectRules(css)) {
    if (!/\.(toolbar|trailing|tools|modes|row)\b/.test(rule.selector)) continue
    const gap = rule.body.match(/gap\s*:\s*(\d+)px/)
    if (gap && Number(gap[1]) !== LANGUAGE.controlGap) {
      note('warn', `${file} ${rule.selector}`, `control gap ${gap[1]}px (language: ${LANGUAGE.controlGap}px)`)
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Icon semantics: the composer attach control must use the paperclip, not
//    the "+" (which in the base composer opens the command menu). Attach is a
//    Team convention: 0.1.7 removed the shipped composer's own attach control
//    (the file input is driven from the command menu), so the paperclip here
//    is justified by the glyph's meaning, not by a shipped control to copy.
// ---------------------------------------------------------------------------

const composer = readFileSync(join(clientDir, 'TeamComposer.tsx'), 'utf8')
const attachBlock = composer.match(/className=\{css\.attachButton\}[\s\S]{0,400}/)?.[0] ?? ''
if (/IconPlusOutline/.test(attachBlock)) {
  note('error', 'TeamComposer.tsx', 'attach button uses the "+" glyph; in the base composer "+" opens the command menu — attach keeps the paperclip')
}
if (!/IconPaperclipOutline/.test(attachBlock)) {
  note('error', 'TeamComposer.tsx', 'attach button does not use a paperclip icon (IconPaperclipOutline*, size through the `size` prop)')
}
if (!attachBlock.includes('Tooltip')) {
  note('warn', 'TeamComposer.tsx', 'attach button is not wrapped in a Tooltip (Team convention elsewhere)')
}

// ---------------------------------------------------------------------------
// 6. Shipped reference drift: whether the harness checkout still defines the
//    language primitives the Team parity relies on (a DSH upgrade may remove
//    or rename them — this is the upgrade tripwire).
// ---------------------------------------------------------------------------

const shippedInputBar = join(shippedDir, 'ui-conversation/src/client/skeleton/InputBar.tsx')
const shippedComposerCss = join(shippedDir, 'ui-conversation/src/client/skeleton/InputBar.module.css')
const shippedSidebarCss = join(shippedDir, 'ui-sidebar/src/client/SidebarRoot.module.css')
for (const [label, file, needles] of [
  // 0.1.7 renamed the icon set — the size left the name and the weight entered
  // it (`IconPlusOutlineMedium`, `size` prop) — and dropped the composer's own
  // attach control, so the paperclip no longer appears in the shipped composer.
  ['shipped composer icon language', shippedInputBar, ['IconPlusOutlineMedium', "t('input.commands')", 'aria-haspopup="listbox"']],
  // 0.1.7-rc.2 tokenized the ring: the sidebar row writes
  // `outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, …)`
  // where 0.1.7-rc.1 wrote the `--dsw-alias-label-primary` literal. Either
  // writing proves the reference is still the shipped row ring, so the daily
  // checkout (rc.1) and an rc.2 certification checkout both pass.
  ['shipped sidebar focus ring', shippedSidebarCss, ['panelRow:focus-visible', [
    'outline: 2px solid var(--dsw-alias-label-primary)',
    'outline: var(--dsw-focus-ring-width)',
  ]]],
  // The labeled permission chip (`PermissionSelect.module.css`) and its 460px
  // label cut were deleted in 0.1.7: mode chrome is the 8px `select`, and the
  // composer narrows its control gaps at 560px instead of hiding a label.
  ['shipped mode control', shippedComposerCss, ['@container (max-width: 560px)', '.select {', 'max-width: 220px;', 'gap: 8px;']],
]) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    note('error', label, `shipped reference file missing: ${file} — the harness checkout moved; re-verify the language baseline`)
    continue
  }
  for (const needle of needles) {
    // A needle may be a list of alternatives: the writing moved between DSH
    // releases and either form still proves the same reference.
    const alternatives = Array.isArray(needle) ? needle : [needle]
    if (!alternatives.some(candidate => text.includes(candidate))) {
      note('warn', label, `shipped reference no longer contains ${alternatives.map(a => `'${a}'`).join(' or ')} — a DSH upgrade may have changed the language; re-verify docs`)
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Shipped primitive existence: every named import the Team Client takes
//    from @deepseek-ai/dsh-client-ui-primitives must still be exported by the
//    harness checkout. This is the upgrade tripwire for primitive removals —
//    MessageText disappeared in 0.1.5 while the docs still cited it.
// ---------------------------------------------------------------------------

function collectExportedNames(file, seen = new Set()) {
  const names = new Set()
  if (seen.has(file)) return names
  seen.add(file)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return names
  }
  for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  for (const match of text.matchAll(/export\s+(?:const|function|class|type|interface|enum)\s+(\w+)/g)) {
    names.add(match[1])
  }
  for (const match of text.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)) {
    for (const name of collectExportedNames(resolve(dirname(file), match[1]), seen)) names.add(name)
  }
  return names
}

const primitivesBarrel = join(shippedDir, 'ui-primitives/src/index.ts')
const shippedPrimitives = collectExportedNames(primitivesBarrel)
if (shippedPrimitives.size === 0) {
  note('error', 'shipped primitives', `cannot read exported names from ${primitivesBarrel} — re-verify the parity baseline`)
} else {
  const seen = new Set()
  for (const file of readdirSync(clientDir).filter(name => name.endsWith('.tsx'))) {
    const src = readFileSync(join(clientDir, file), 'utf8')
    for (const match of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'@deepseek-ai\/dsh-client-ui-primitives'/g)) {
      for (const entry of match[1].split(',')) {
        const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim()
        if (!name || name === 'default' || seen.has(`${file}:${name}`)) continue
        seen.add(`${file}:${name}`)
        if (!shippedPrimitives.has(name)) {
          note('error', file, `imports '${name}' from dsh-client-ui-primitives, which the harness checkout no longer exports — a DSH upgrade removed or renamed it`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Geometry language: the canonical controls keep the shipped dimensions —
//    icon-only controls 28×28, the primary round action 34×34 with its -2px
//    seat compensation, and one radius per surface role: list rows 12px, a menu
//    surface 16px over its own 8px rows, dense two-line result rows and compact
//    controls 8px, chips 6px. A refactor or a DSH upgrade must not silently
//    move them.
//    Line width is part of the same language: shipped declares its 164 neutral
//    separators as `0.5px`, but Chromium rounds `border-width` up to a whole CSS
//    pixel, so a computed 0.5px border reports and paints as 1px at device
//    pixel ratios 1, 1.25 and 2 alike (probed against the shipped declarations
//    in Chrome 138). The Team Client therefore writes the value that reaches
//    the glass — `1px` — and the scan below keeps a fractional border width
//    from coming back as a misleading "thinner" line. A genuine half pixel is
//    the elevation box-shadow hairline the card-surface rule uses, which is why
//    only border declarations are scanned.
// ---------------------------------------------------------------------------

const GEOMETRY = [
  ['composer.module.css', '.attachButton', [['height', '28px'], ['width', '28px'], ['border-radius', '999px']], 'icon-only control is 28×28, radius 999px'],
  ['composer.module.css', '.card', [['border-radius', 'var(--dsw-radius-panel, 22px)']], 'the composer card is the panel tier of the shipped scale: 0.1.7-rc.2 re-rounded the shipped composer card from 22px to `--dsw-radius-panel`, and the 22px fallback keeps the rc.1 checkout rendering what it renders today'],
  ['composer.module.css', '.asTaskPill', [['height', '28px'], ['border-radius', 'var(--dsw-radius-sm, 8px)']], 'the mode chip keeps the shipped mode-chrome radius — the small tier, unchanged by 0.1.7-rc.2'],
  ['composer.module.css', '.sendButton', [['height', '34px'], ['width', '34px'], ['border-radius', '999px'], ['transform', 'translateY(-2px)']], 'primary round action is 34×34 with the -2px seat compensation'],
  ['sidebar.module.css', '.workspaceBrowser', [['padding', '0 var(--dsh-sidebar-inline-padding, 12px) 8px 0']], 'the browsing column stands on the shipped browser\'s own content box: shipped declares the same trailing 12px inset and no leading one, because the sidebar column already carries the leading inset. Matching it is what puts this column\'s rows on the shipped rows\' left edge instead of 4px inside it'],
  ['sidebar.module.css', '.error', [['padding', '4px 8px 6px']], 'a Panel\'s failure line lands its text on the row labels, so it takes the row\'s own 8px leading inset and nothing else — the list between them carries no padding of its own. The browser test measures this line\'s inset against the label it sits under, because the two are only in step while both are stated here'],
  ['sidebar.module.css', '.channelRow', [['border-radius', 'var(--dsw-radius-md, 12px)']], 'list row radius is the md tier; the shipped rail put .panelRow on its .newSession bar\'s 12px in the 0.1.6 line (harness c6b81a75, 2026-09-15), and 0.1.7-rc.2 kept that tier while moving it onto `--dsw-radius-md`'],
  ['sidebar.module.css', '.agentRow', [['border-radius', 'var(--dsw-radius-md, 12px)']], 'list row radius is the md tier, the same tier as .channelRow above'],
  ['sidebar.module.css', '.workspaceTrigger', [['border-radius', 'var(--dsw-radius-md, 12px)'], ['min-height', '34px'], ['border', '1px solid var(--dsw-alias-border-l2)']], 'the Workspace selector keeps the sidebar row geometry: the md tier, 34px line, and its neutral separator written as 1px because that is what shipped\'s 0.5px declaration actually renders as'],
  ['sidebar.module.css', '.inboxCard', [['border-radius', 'var(--dsw-radius-md, 12px)'], ['height', '34px']], 'the Inbox entry is a sidebar row: the md tier, 34px height'],
  ['sidebar.module.css', '.leaveCard', [['height', '38px'], ['border-radius', 'var(--dsw-radius-md, 12px)'], ['box-sizing', 'border-box'], ['background', 'var(--dsw-alias-button-elevated-fill)'], ['border', '1px solid var(--dsw-alias-border-l3)'], ['padding', '8px 12px'], ['margin', '0 2px 12px']], 'the mode\'s exit takes over the shipped New Session bar: the same 38px elevated slab, the same 8px/12px inset and a centred label in the same vertical slot, its l3 separator written as 1px because that is what shipped\'s 0.5px declaration actually renders as. It also stands on the shipped bar\'s own box — 14px to 266px in the 280px sidebar, measured equal in one render by the e2e parity block. The 2px horizontal margin is the shipped bar\'s own, and it must stay stated: shipped declares no width, so the slab is a stretched flex item that the margin pulls in, while a `width: 100%` here would add to the margin and push the slab 4px past the column. The browsing region keeps its own 12px trailing inset so this row and the rows below it share one right edge'],
  ['sidebar.module.css', '.leaveCardGlyph', [['position', 'absolute'], ['right', 'calc(100% + 6px)']], 'the exit centres its label, not the group: the chevron hangs off the label\'s leading edge out of flow, because centring the group depends on the air inside each glyph\'s box, which differs between CJK and Latin glyphs and across platform font stacks — a compensation measured on one stack walks the ink off the middle on another'],
  ['sidebar.module.css', '.iconButton', [['height', '28px'], ['width', '28px'], ['border-radius', 'var(--dsw-radius-sm, 8px)'], ['flex', 'none']], 'the section header\'s action is the shipped header action: a 28px square on the small tier, not the round 24px control it used to be, and `flex: none` keeps a long section label from squeezing it. Its focus ring is inset (`outline-offset: -2px` on the focus-visible rule) because this header does not clip its own overflow the way the shipped one does, so an outset ring would add 2px to a line the row grid already measures'],
  ['sidebar.module.css', '.sectionHeader', [['height', '28px'], ['margin', '2px 0 0'], ['padding', '0 0 0 4px'], ['gap', '4px']], 'the header is its tallest control and nothing more — a 28px action beside a 14/20 label — not the shipped 36px toolbar, which is sized for a search field and an action cluster. Its only vertical margin is the 2px step above it, the shipped list\'s own within-group step, so a header sits nearer the rows it names than the block before it; the list below carries the other step. It takes no negative right margin: inside the scroll container that overhang would be clipped and would cut the action button, and the container\'s reserved bar gutter already lands this header\'s right edge on the rows\' edge'],
  ['sidebar.module.css', '.sectionToggle', [['font-size', '14px'], ['line-height', '20px'], ['padding', '0']], 'the disclosure label reads at the shipped section label\'s own grade, so a header is one size in either mode'],
  ['sidebar.module.css', '.channelRow', [['min-height', '32px']], 'a channel row is the shipped list row\'s own 32px, the height the other mode\'s session rows and this column\'s section headers share'],
  ['sidebar.module.css', '.channelSelect', [['min-height', '32px'], ['padding', '0 4px 0 8px']], 'the row\'s hit target fills it; the 8px leading inset is what seats the label, and the 4px trailing one keeps a long name off the fill\'s edge'],
  ['sidebar.module.css', '.agentRow', [['min-height', '42px']], 'a Member row is taller than a channel row because it carries two lines; 42px is the 34px avatar plus its 4px seats, which a Member with no description also measures, so both cases keep one rhythm instead of the row collapsing to a single line'],
  ['sidebar.module.css', '.agentSelect', [['min-height', '42px'], ['padding', '4px 4px 4px 8px']], 'the row\'s hit target fills it; the vertical inset is what seats the 34px avatar inside the 42px floor and lets a described Member\'s 37px copy box reach 45px'],
  ['sidebar.module.css', '.agentAvatar', [['height', '34px'], ['width', '34px'], ['flex', '0 0 34px']], 'the identity circle is the conversation timeline\'s own identity seat (34px), near as tall as the two-line copy block beside it (a 20px title over a 17px meta line), so a Member reads at one size in both surfaces — and it is the one avatar geometry every roster surface shares'],
  ['sidebar.module.css', '.channelName', [['font-size', '14px'], ['line-height', '20px']], 'a channel name is a row title, so it reads at the shipped title grade rather than the 13px it carried'],
  ['sidebar.module.css', '.textButton', [['border-radius', 'var(--dsw-radius-sm, 8px)'], ['color', 'var(--dsw-alias-link)'], ['font-size', '13px'], ['line-height', '20px'], ['padding', '0']], 'the shipped empty-state action is a line of link-coloured text, not a button chrome of its own: no padding, no fill, and the empty-state grade. A hover fill would hug the glyphs instead of reading as a row the way the list rows\' fills do, so its hover is colour only'],
  ['sidebar.module.css', '.workspaceSection', [['overflow-x', 'hidden'], ['overflow-y', 'auto'], ['scrollbar-gutter', 'stable'], ['gap', '4px']], 'one scroll container carries both sections and only the vertical axis moves: the headers\' 4px overhang is a box rather than content, and left scrollable it becomes a horizontal gutter that shifts the whole column. The bar\'s space is reserved rather than conditional, as the shipped list reserves it, so a growing list does not move the rows sideways when the bar appears. The 4px step is the shipped list\'s step between groups and is the only space between two sections — the lists add none of their own, which is what made two sections read as far apart'],
  ['sidebar.module.css', '.agentSelect .agentCopy', [['display', 'flex'], ['flex-direction', 'column']], 'the sidebar\'s own copy hook must stay scoped to its row: TeamMemberIdentity puts the shared .copy class and this hook on the same element, so at equal specificity the later source order wins and the dialog\'s density silently overrides the sidebar\'s. The scoping is what keeps a Member row at the sidebar grade — and it must stay scoped on all three rules below, since the same-element override would otherwise reset every one of them'],
  ['sidebar.module.css', '.agentSelect .agentCopy strong', [['font-size', '14px'], ['line-height', '20px']], 'a Member\'s handle is a row title and reads at the shipped title grade, which the same-element override above would otherwise reset to the dialog\'s 12px'],
  ['sidebar.module.css', '.agentSelect .agentCopy small', [['font-size', '12px'], ['line-height', '17px']], 'a Member\'s description is the shipped two-line row\'s meta grade, 12px over 17px, which the same-element override above would otherwise reset to the dialog\'s 11px'],
  ['member-row.module.css', '.row', [['border-radius', 'var(--dsw-radius-md, 12px)']], 'the shared roster row is a list row wherever it renders: the md tier, the rail/settings row tier'],
  ['composer.module.css', '.mentionMenu', [['border-radius', 'var(--dsw-radius-lg, 16px)']], 'the mention popover is the shipped menu surface: the lg tier, so it matches the Menu primitive this app already renders elsewhere'],
  ['composer.module.css', '.mentionOption', [['border-radius', 'var(--dsw-radius-md, 8px)']], 'a row inside a menu surface carries the shipped .item radius — 0.1.7-rc.2 moved that row up to the md tier (12px), and the 8px fallback keeps the rc.1 checkout on its own value'],
  ['countBadge.module.css', '.badge', [['height', '18px'], ['min-width', '18px'], ['border-radius', '999px'], ['box-sizing', 'border-box'], ['line-height', '18px'], ['flex', 'none']], 'every count is one 18px capsule in one place; border-box keeps one digit a circle instead of a padded oval, the line box is the capsule\'s own height so a surface inheriting `normal` cannot move the digit, and `flex: none` keeps a squeezed row from shrinking it'],
  ['inbox.module.css', '.row', [['border-radius', 'var(--dsw-radius-lg, 8px)']], 'the Inbox queue row is the two-line result-row dimension, not the list-row one: it follows shipped .searchResultRow, which 0.1.7-rc.2 moved from 8px to the lg tier'],
  ['inbox.module.css', '.rowTask', [['border-radius', 'var(--dsw-radius-sm, 6px)']], 'the Task marker on a queue row is the chip tier; 0.1.7-rc.2 retired the 6px chip (the shipped crumb, reference and retry all moved to the small tier)'],
  ['composer.module.css', '.fileChip', [['border-radius', 'var(--dsw-radius-sm, 6px)']], 'chip radius is the small tier; the 6px fallback is what the rc.1 checkout renders'],
  ['conversation.module.css', '.attachmentChip', [['border-radius', 'var(--dsw-radius-sm, 6px)']], 'chip radius is the small tier; the 6px fallback is what the rc.1 checkout renders'],
  ['conversation.module.css', '.mention', [['border-radius', 'var(--dsw-radius-sm, 6px)']], 'inline mention chip radius follows the shipped editor `.reference` chip, which moved to the small tier in 0.1.7-rc.2'],
  ['conversation.module.css', '.messageText', [['font-size', 'var(--dsh-content-font-size, 14px)'], ['line-height', 'calc(22px + var(--dsh-content-font-delta, 0px))']], 'literal body rides the content-font axis on the 14/22 chat grid'],
  ['conversation.module.css', '.messageClamp', [['max-height', 'calc(176px + 8 * var(--dsh-content-font-delta, 0px))']], 'the fold preview stays eight lines of the body grid at any content size'],
  ['conversation.module.css', '.messageBody .messageMarkdown', [['font-size', 'var(--dsh-content-font-size, 14px)'], ['line-height', 'calc(22px + var(--dsh-content-font-delta, 0px))'], ['max-width', '100%']], 'markdown body rides the content-font axis on the 14/22 chat grid, and it is capped at the reading column: this column lays its children out shrink-to-fit, so without the cap the box widens to whatever wide block it holds (a ≥4-column Markdown table, a long `pre`) and paints past the column edge instead of scrolling inside it. It is the unwrapped half of a two-rule pair — a long body gains a `[data-document]` wrapper between this box and `.messageBody`, which `findRuleBody` can only see by its own selector'],
  ['conversation.module.css', '.messageBody > [data-document]', [['max-width', '100%']], 'the wrapped half of the same pair: a body long enough to fold is wrapped in `[data-document]`, so this wrapper is what actually sits under the reading column and must carry the cap itself. A `max-width` resolves against the containing box, so a cap on the Markdown box inside cannot constrain a wrapper that was already sized to the wide block it holds — and dropping this rule while keeping the one above leaves a clamped body painting past the column edge'],
  ['conversation.module.css', '.nameRow strong', [['font-size', 'var(--dsh-content-font-size-secondary, 13px)'], ['line-height', 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))']], 'the sender line is the secondary grade of the content axis (13px over 20px at the default content size), so a raised Settings size grows the author with the body; shipped puts a label next to content on this same grade and pins only its smallest time grade'],
  ['conversation.module.css', '.messageBody [data-document] .messageMarkdown', [['line-height', 'calc(24px + var(--dsh-content-font-delta, 0px))']], 'a folded long body reads on the 24px document grid'],
  ['conversation.module.css', '.messageBody [data-document] .messageMarkdown p', [['margin', '16px 0']], 'document block gap'],
  ['conversation.module.css', '.messageBody [data-document] .messageMarkdown li + li', [['margin-top', '6px']], 'document list-item gap'],
  ['conversation.module.css', '.messageBody [data-document] .messageMarkdown :where(h1, h2, h3, h4, h5, h6)', [['margin', '24px 0 8px']], 'document section-heading margins'],
  ['conversation.module.css', '.messageBody .messageMarkdown pre', [['font-size', 'calc(13px + var(--dsh-code-font-delta, 0px))']], 'a fenced block rides the Settings code-size axis on the same px-delta pattern as the content axis: 0.2.1-rc.2 rewrote the primitive\'s `--dsw-font-markdown-code-block` onto `--dsh-code-font-delta`, so a literal 13px here would hold the words still while the leading around them moved with the setting'],
]

// A rule preceded by a comment keeps that comment inside the captured
// selector text, so comparisons and reports start after the last comment.
function bareSelector(rule) {
  return rule.selector.replace(/^[\s\S]*\*\//, '').trim()
}

/** {@link bareSelector} with runs of whitespace collapsed onto one line. */
function collapsedSelector(rule) {
  return bareSelector(rule).replace(/\s+/g, ' ').trim()
}

function findRuleBody(file, selector) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  for (const rule of collectRules(css)) {
    if (bareSelector(rule) === selector) return rule.body
  }
  return undefined
}

for (const [file, selector, expected, what] of GEOMETRY) {
  const body = findRuleBody(file, selector)
  if (body === undefined) {
    note('error', `${file} ${selector}`, `canonical control is gone (${what})`)
    continue
  }
  for (const [property, value] of expected) {
    const declared = body.match(new RegExp(`${property}\\s*:\\s*([^;]+)`))?.[1]?.trim()
    if (declared === undefined) {
      note('error', `${file} ${selector}`, `no ${property} declared (${what})`)
    } else if (declared !== value) {
      note('error', `${file} ${selector}`, `${property} is '${declared}', expected '${value}' (${what})`)
    }
  }
}

// The same rule, applied to every sheet rather than the canonical controls:
// a fractional border width promises a thinner line than the platform can
// paint. Fractional shadow offsets and radii are legitimate and not scanned.
for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = stripNestedAtRules(readFileSync(join(clientDir, file), 'utf8'), file)
  for (const rule of collectRules(css)) {
    const selector = collapsedSelector(rule)
    for (const declaration of rule.body.matchAll(/(?:^|;)\s*border(?:-(?:top|right|bottom|left))?(?:-width)?\s*:\s*([^;]+)/g)) {
      const fraction = declaration[1].match(/\d*\.\d+px/)
      if (fraction) {
        note('error', `${file} ${selector}`, `border width '${fraction[0]}' does not render: Chromium rounds border-width up to 1px, so declare 1px — or use the elevation box-shadow hairline for a real half pixel`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Token existence: every --dsw-* token the Team Client references must be
//    defined by the shipped client source. A renamed/removed token falls back
//    silently, so the audit fails loudly instead — typos included.
// ---------------------------------------------------------------------------

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(path, out)
    else if (/\.(css|ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

function collectShippedTokens() {
  const tokens = new Map()
  for (const file of walkFiles(join(shippedDir, 'ui-theme/src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(--dsw-[\w-]+):\s*([^;]+)/g)) {
      const [, name, value] = match
      if (!tokens.has(name)) tokens.set(name, new Set())
      tokens.get(name).add(value.trim())
    }
  }
  return tokens
}

const shippedTokens = collectShippedTokens()
if (shippedTokens.size === 0) {
  note('error', 'shipped theme', 'cannot read --dsw-* token definitions from the harness checkout — re-verify the parity baseline')
} else {
  const teamRefs = new Map()
  for (const file of readdirSync(clientDir).filter(name => /\.(css|tsx|ts)$/.test(name))) {
    const text = readFileSync(join(clientDir, file), 'utf8')
    for (const match of text.matchAll(/var\(--dsw-[\w-]+/g)) {
      const token = match[0].slice(4)
      if (!teamRefs.has(token)) teamRefs.set(token, new Set())
      teamRefs.get(token).add(file)
    }
  }
  for (const [token, files] of teamRefs) {
    if (!shippedTokens.has(token)) {
      note('error', [...files].sort().join(', '), `references '${token}' which the shipped theme does not define — a typo, or a DSH upgrade renamed it`)
    }
  }
}

// ---------------------------------------------------------------------------
// 10. Mode control language: as-task is a mode (it changes what Send means),
//     not an action, so it keeps a visible word label at every width.
//     Reducing a mode to a bare glyph loses its state to a picture nobody
//     agreed on, and a hover tooltip is not a label on touch. DSH 0.1.7 deleted
//     the labeled permission chip and with it the 460px label cut: the base
//     composer now keeps every mode's word and narrows its control gaps to 8px
//     below 560px, which is the branch this check requires instead.
// ---------------------------------------------------------------------------

const MODE_NARROW_WIDTH = 560
const composerCss = readFileSync(join(clientDir, 'composer.module.css'), 'utf8')
const asTaskPill = composer.match(/css\.asTaskPill[\s\S]{0,600}?<\/button>/)?.[0] ?? ''
if (asTaskPill === '') {
  note('error', 'TeamComposer.tsx', 'the as-task mode control is not rendered as css.asTaskPill — a mode is not an icon action')
} else {
  if (!/aria-pressed=\{asTask === true\}/.test(asTaskPill)) {
    note('error', 'TeamComposer.tsx', 'the as-task mode pill declares no aria-pressed state')
  }
  if (!/css\.asTaskLabel/.test(asTaskPill) || !/t\('asTask'\)/.test(asTaskPill)) {
    note('error', 'TeamComposer.tsx', "the as-task mode pill lost its visible word label (css.asTaskLabel + t('asTask'))")
  }
}

const labelRule = collectRules(composerCss).find(rule => bareSelector(rule) === '.asTaskLabel')
if (labelRule === undefined) {
  note('error', 'composer.module.css .asTaskLabel', 'the mode label class is gone; a mode keeps a visible word')
} else if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(labelRule.body)) {
  note('error', 'composer.module.css .asTaskLabel', 'the mode label is hidden; a mode keeps its word at every width')
}
if (/\.asTaskLabel[^{}]*\{[^{}]*?(?:display\s*:\s*none|visibility\s*:\s*hidden)/.test(composerCss)) {
  note('error', 'composer.module.css', 'a rule still hides the mode label; 0.1.7 keeps every mode word and narrows the control gaps instead')
}

const narrowBranch = composerCss.match(/@container\s*\(max-width:\s*(\d+)px\)\s*\{[\s\S]*?gap\s*:\s*8px/)
if (narrowBranch === null) {
  note('error', 'composer.module.css', 'no narrow-container branch narrowing the control gaps to 8px (the shipped composer does this below 560px)')
} else if (Number(narrowBranch[1]) !== MODE_NARROW_WIDTH) {
  note('warn', 'composer.module.css', `control gaps narrow at ${narrowBranch[1]}px (shipped: ${MODE_NARROW_WIDTH}px)`)
}

// ---------------------------------------------------------------------------
// 11. Corner-shape pairing: the shipped platform curves every rounded surface
//     along superellipse(1.5) (ui-theme/src/styles/corner-shape.css), which
//     deforms a circle into a squircle and squares off capsule ends. Every
//     effectively uncapped radius — 50%, 100%, 999px, a pill radius — must
//     therefore pair `corner-shape: round` in the same block. Shipped keeps
//     100% coverage of this pairing; a new full-round control that forgets it is
//     the drift this rule catches. The scan is textual: it reads the three
//     uncapped radius forms, but a pill radius that only exceeds its box at one
//     rendered size (say `border-radius: 12px` on a 24px row) is invisible here
//     and belongs in GEOMETRY instead.
// ---------------------------------------------------------------------------

const FULL_ROUND = /border-radius:\s*(?:50%|100%|999px)\s*;/
for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  for (const rule of collectRules(css)) {
    if (!FULL_ROUND.test(rule.body)) continue
    if (!/corner-shape:\s*round/.test(rule.body)) {
      const bare = collapsedSelector(rule).slice(0, 60)
      note('error', `${file} ${bare}`, 'full-round radius without `corner-shape: round`; the platform superellipse squares capsule ends off')
    }
  }
}

// ---------------------------------------------------------------------------
// 12. Frosted surfaces: a token whose whole purpose is a floating surface must
//     pair its translucency with the menu backdrop blur
//     (`ui-primitives Menu.module.css`: `--dsw-specific-menu` +
//     `--dsw-menu-backdrop-filter` + the elevation stroke and shadow).
//     DSH 0.1.7 turned `--dsw-specific-menu` from an opaque layer token into
//     `rgba(…, 0.5)`, which silently made an opaque popup unreadable while
//     every existence check stayed green — a value change, not a rename.
//     Only surface tokens are checked: interaction fills, skeletons and
//     dividers are translucent by design and shipped leaves them unblurred.
// ---------------------------------------------------------------------------

const SURFACE_TOKENS = new Set([
  '--dsw-specific-menu',
  '--dsw-specific-input-major',
  '--dsw-specific-input-minor',
  '--dsw-specific-panel',
  '--dsw-specific-selector',
])

function resolveTokenValue(value, depth = 0) {
  const reference = value.match(/^var\((--dsw-[\w-]+)\)$/)
  if (reference === null || depth > 8) return value
  const values = shippedTokens.get(reference[1])
  if (values === undefined || values.size !== 1) return value
  return resolveTokenValue([...values][0], depth + 1)
}

function isTranslucentToken(token) {
  const values = shippedTokens.get(token)
  if (values === undefined) return false
  let seen = false
  for (const raw of values) {
    if (!/^rgba\([^)]*,\s*0?\.\d+\)$/.test(resolveTokenValue(raw))) return false
    seen = true
  }
  return seen
}

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  for (const rule of collectRules(stripNestedAtRules(css, file))) {
    const bare = bareSelector(rule)
    const surface = rule.body.match(/background(?:-color)?\s*:\s*var\((--dsw-[\w-]+)/)
    if (surface === null || !SURFACE_TOKENS.has(surface[1]) || !isTranslucentToken(surface[1])) continue
    if (/backdrop-filter\s*:/.test(rule.body)) continue
    note('error', `${file} ${bare}`, `paints the translucent surface token '${surface[1]}' without a backdrop blur; shipped pairs a frosted surface with var(--dsw-menu-backdrop-filter)`)
  }
}

// ---------------------------------------------------------------------------
// 13. Popup roles: a trigger that opens the shared Menu renders `role="menu"`
//     with `role="menuitem"` rows — the primitive owns that markup — so a
//     trigger announcing `aria-haspopup="listbox"` promises the reader a popup
//     they will never get, and a screen reader voices the wrong control class.
//     Every `aria-haspopup` in the Team Client opens either that Menu or a
//     dialog; the composer's mention picker is a genuine listbox, but it is
//     driven from the textarea through `aria-activedescendant` and carries no
//     haspopup attribute at all, so it is not in this rule's path.
// ---------------------------------------------------------------------------

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.tsx'))) {
  const source = readFileSync(join(clientDir, file), 'utf8')
  for (const match of source.matchAll(/aria-haspopup="listbox"/g)) {
    const line = source.slice(0, match.index).split('\n').length
    note('error', `${file}:${line}`, 'aria-haspopup="listbox" on a trigger whose popup is the shared Menu (role="menu", menuitem rows); declare aria-haspopup="menu"')
  }
}

// ---------------------------------------------------------------------------
// 14. Container queries: a `@container` block restyles descendants of the box
//     that declares `container-type` — an element never answers a query about
//     itself. A rule whose target is that container class is therefore dead CSS
//     that reads exactly like a working narrow-width branch, and it silently
//     keeps the wide layout at every width. Shipped declares its container on
//     the composer row and queries the group inside it; this check keeps the
//     same shape.
// ---------------------------------------------------------------------------

for (const file of readdirSync(clientDir).filter(name => name.endsWith('.module.css'))) {
  const css = readFileSync(join(clientDir, file), 'utf8')
  const containers = new Set()
  for (const rule of collectRules(css)) {
    if (!/container-type\s*:/.test(rule.body)) continue
    for (const match of rule.selector.matchAll(/\.([\w-]+)/g)) containers.add(match[1])
  }
  if (containers.size === 0) continue
  const lines = css.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^@container\b/.test(lines[index])) continue
    for (let inner = index + 1; inner < lines.length && !lines[inner].startsWith('}'); inner += 1) {
      const selector = lines[inner].match(/^\s*([^{}]*?)\s*\{/)
      if (selector === null) continue
      for (const match of selector[1].matchAll(/\.([\w-]+)/g)) {
        if (!containers.has(match[1])) continue
        note('error', `${file} ${selector[1].trim()}`, 'restyles the container element itself inside its own @container block; a query only answers for descendants, so this branch never applies')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const bySeverity = { error: [], warn: [], info: [] }
for (const finding of findings) bySeverity[finding.severity].push(finding)
const print = (list) => list.forEach(f => console.log(`  [${f.severity}] ${f.where}: ${f.what}`))

console.log('UI parity audit — Team Client vs DSH 0.1.7 design language')
console.log(`harness checkout: ${harnessDir}`)
console.log('')
console.log(`errors (${bySeverity.error.length}):`)
print(bySeverity.error)
console.log('')
console.log(`warnings (${bySeverity.warn.length}):`)
print(bySeverity.warn)
console.log('')
console.log(`info (${bySeverity.info.length}):`)
print(bySeverity.info)
console.log('')
if (bySeverity.error.length === 0) console.log('No mechanical language violations. Design judgment still lives in docs/frontend-design/principles-and-language.md.')
process.exit(bySeverity.error.length === 0 ? 0 : 1)
