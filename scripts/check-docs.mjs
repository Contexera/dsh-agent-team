// Mechanical gate for the maintained documentation set.
//
// docs/AGENTS.md states the rules this file decides: maintained documents ship
// as bilingual pairs with a working switcher, every relative link resolves, and
// the index in docs/README.md and docs/README.zh.md names exactly the documents
// that exist. Humans forget those rules silently; this script is the part that
// cannot be forgotten.
//
// It covers every bilingual page that ships: the maintained documents under
// docs/, the four README pairs (repository root and one per package), and the
// root contributing pair. The set comparison stays docs-only, because those two
// READMEs are the only indexes.
//
// Two judgments go past "the target exists": a `#fragment` must name a real
// heading of its target document, and no rendered block of a maintained
// document may outgrow the ceiling recorded for it below. A link whose fragment
// survived a rename while its path did not is the failure mode that motivates
// the first; a paragraph that keeps absorbing facts is the one behind the
// second.
//
// A third judgment compares the two halves of a pair to each other: they carry
// the same outline — the same headings at the same levels, in the same order —
// because a translation rewords a heading but never adds, drops, or re-levels
// one. Lists and tables are deliberately out of scope: the two languages
// legitimately render one rule set as bullets in one half and as a table or
// prose in the other, so gating presentation would fail correct documents and
// train everyone to work around the gate. What it catches is the drifted
// outline a translation quietly leaves behind.
//
// It deliberately runs standalone — no Harness checkout, no Vitest config — so a
// documentation edit can be checked in a second: `npm run check:docs`, which is
// also part of `npm test`. `--root <dir>` points the same checks at another tree
// (used to exercise the failure paths against throwaway copies), and
// `--budgets` prints the per-file longest-block table instead of deciding.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// AGENTS.md files are single-language by rule (docs/AGENTS.md), so they are not
// part of the pairing check; everything else under docs/ is a maintained doc.
const SINGLE_LANGUAGE = new Set(['AGENTS.md'])
// The entry-point index describes where a reader should start: it lists neither
// itself nor the routing rules it points at.
const NOT_INDEXED = new Set(['AGENTS.md', 'README.md'])
// Each language's index links to its own side of the pair.
const INDEXES = [
  { name: 'README.md', heading: '## Documentation entry points' },
  { name: 'README.zh.md', heading: '## 文档入口' },
]
const SWITCHER_LINES = 6

// A switcher contract is the exact shape of the first lines, with `{source}` and
// `{pair}` standing for the two file names. The shapes genuinely differ — the
// repository README says "简体中文" and also links its own English page — so each
// page set states its own instead of being normalized into one wording.
const DOCS_SWITCHER = {
  english: 'English | [中文]({pair})',
  chinese: '[English]({source}) | 中文',
}

// `docs` enumerates: every Markdown file there is a maintained document unless
// it is single-language. A named set lists its pages instead, so an unrelated
// future Markdown file inside a package directory — or at the repository root —
// is not silently promoted into the pairing rule.
const PAGE_SETS = [
  { directory: 'docs', switcher: DOCS_SWITCHER, enumerate: true, skip: SINGLE_LANGUAGE },
  { directory: '.', pages: ['README.md', 'CONTRIBUTING.md'], switcher: {
    english: '[English]({source}) | [简体中文]({pair})',
    chinese: '[English]({source}) | 简体中文',
  } },
  { directory: 'packages/agent-team', pages: ['README.md'], switcher: DOCS_SWITCHER },
  { directory: 'packages/tool-agent-team', pages: ['README.md'], switcher: DOCS_SWITCHER },
  { directory: 'packages/client-agent-team', pages: ['README.md'], switcher: DOCS_SWITCHER },
]

// The longest rendered block each maintained document may contain, measured in
// characters on the block's own source text: the longest paragraph, single list
// item, single table cell, single heading, or single line of a fenced code
// sample. A whole paragraph is one block even when it is soft-wrapped over
// several source lines, and one list item or one table cell is a block of its
// own — a blank-line-delimited "block" would call a list or a table one wall.
//
// The English and Chinese halves of a pair each get their own number: the same
// content costs Chinese roughly half the characters, so one shared ceiling
// would either never fire on the Chinese side or fire on every English edit.
//
// A ceiling is the value measured when it was recorded. It ratchets down as a
// document is condensed and is raised only deliberately, in a commit that says
// why — the same discipline as the persona budget in the shipping contract.
// Every maintained document needs a row, so a new document declares its own
// ceiling instead of inheriting an unbounded default.
const BLOCK_CHARACTER_CEILINGS = {
  'architecture/README.md': [342, 174],
  'architecture/client-and-remote.md': [602, 586],
  'architecture/host-authority.md': [597, 541],
  'architecture/package-ownership.md': [552, 339],
  'architecture/tools-and-preset.md': [616, 540],
  'architecture/workspace-session-storage.md': [576, 584],
  'development/README.md': [105, 64],
  'development/environments-and-install.md': [597, 569],
  'development/generated-and-seams.md': [515, 362],
  'development/start-and-checks.md': [595, 415],
  'development/storage-and-delivery.md': [585, 583],
  'domain-model.md': [593, 580],
  'dsh-release-compatibility.md': [475, 235],
  'frontend-design/README.md': [367, 189],
  'frontend-design/components.md': [603, 523],
  'frontend-design/layout-and-typography.md': [556, 452],
  'frontend-design/principles-and-language.md': [775, 557],
  'frontend-design/refresh-copy-accessibility.md': [510, 310],
  'frontend-design/sidebar-browser.md': [556, 366],
  'frontend-design/thread-and-composer.md': [573, 589],
  'harness-navigation.md': [425, 322],
  'release-runbook.md': [547, 244],
  'team-collaboration/README.md': [259, 161],
  'team-collaboration/attention-and-messaging.md': [598, 585],
  'team-collaboration/boundaries.md': [642, 578],
  'team-collaboration/memory-and-context.md': [581, 573],
  'team-collaboration/model-and-time.md': [530, 598],
  'team-collaboration/tools.md': [573, 564],
}

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const root = rootFlag === -1 ? repositoryRoot : resolve(args[rootFlag + 1] ?? '.')
const docsDirectory = join(root, 'docs')
const budgetsOnly = args.includes('--budgets')

const failures = []
const fail = (file, message) => failures.push(`${relative(root, file).replaceAll('\\', '/')}: ${message}`)

function markdownFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(path))
    else if (entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g

// Relative targets only: external URLs and other schemes are out of scope for a
// repository-local resolution check. A target's fragment is kept apart from its
// path — an empty path means a same-file anchor such as `#budgets`.
function linkTargets(text) {
  const targets = []
  for (const match of text.matchAll(linkPattern)) {
    const raw = match[1].trim().replace(/^<|>$/g, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    const hash = raw.indexOf('#')
    const path = (hash === -1 ? raw : raw.slice(0, hash)).split('?', 1)[0]
    targets.push({ path, fragment: hash === -1 ? null : raw.slice(hash + 1) })
  }
  return targets
}

const relativeTargets = text => linkTargets(text).map(target => target.path).filter(Boolean)

// docs/README.zh.md links to the Chinese side of each pair; both indexes are
// compared on the English document name they name.
function documentName(target) {
  const path = target.replace(/^\.\//, '')
  return path.endsWith('.zh.md') ? `${path.slice(0, -'.zh.md'.length)}.md` : path
}

function sectionLines(text, heading) {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const start = lines.indexOf(heading)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
}

// GitHub's heading slug: lowercase, then keep only letters, numbers,
// underscores, spaces, and hyphens; spaces become hyphens. Everything else —
// backticks, colons, parentheses, emoji — disappears. A heading's inline
// Markdown is already rendered by the time GitHub slugs it, so link and image
// targets go first and their label or alt text is what remains.
const githubSlug = heading =>
  heading.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replaceAll(' ', '-')

const renderedHeading = line =>
  line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()

// Every fragment a document exposes: each heading's slug — repeated headings
// take GitHub's `-1`, `-2`, … suffixes — plus every explicit `<a id="…">` in
// HTML flow. Fenced code is skipped on purpose: a `# comment` inside a shell
// sample is not a heading, and a commented-out anchor registers nothing.
function documentAnchors(text) {
  const anchors = new Set()
  const occurrences = new Map()
  const html = []
  let fence = null
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) {
      fence = fence === null ? marker[1][0] : null
      continue
    }
    if (fence !== null) continue
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const base = githubSlug(renderedHeading(heading[1]))
      let slug = base
      let bump = occurrences.get(base) ?? 0
      while (anchors.has(slug)) {
        bump += 1
        slug = `${base}-${bump}`
      }
      occurrences.set(base, bump)
      anchors.add(slug)
      continue
    }
    html.push(line)
  }
  for (const match of html.join('\n').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<a id="([^"]+)"/g)) {
    anchors.add(match[1])
  }
  return anchors
}

// The outline a document declares: each heading's level and rendered text, in
// source order. Fenced code is skipped for the same reason as above — a
// `# comment` inside a shell sample is not a heading — so a shell block that
// gains a comment cannot tip a pair out of alignment.
function documentHeadings(text) {
  const headings = []
  let fence = null
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) {
      fence = fence === null ? marker[1][0] : null
      continue
    }
    if (fence !== null) continue
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) headings.push({ level: heading[1].length, text: renderedHeading(heading[2]) })
  }
  return headings
}

// The rendered blocks of a document, in source order. Soft-wrapped lines join
// the paragraph they belong to; one list item, one table cell, one heading, and
// one line of a fenced code sample are each a block of their own. Blank lines
// end a paragraph. A code line counts even though it is not prose: a code line
// cannot wrap, and leaving fences out would make "wrap it in a fence" the
// cheapest way past the ceiling.
function renderedBlocks(text) {
  const blocks = []
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  let fence = null
  let open = null
  const flush = () => {
    if (open !== null && open.text.trim() !== '') blocks.push(open)
    open = null
  }
  const start = (kind, value, line) => {
    flush()
    open = { kind, text: value.trim(), line }
  }
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd()
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker) {
      flush()
      fence = fence === null ? marker[1][0] : null
      continue
    }
    if (fence !== null) {
      if (line.trim() !== '') start('code', line, index + 1)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = /^ {0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      start('heading', heading[1], index + 1)
      continue
    }
    if (/^\s*\|/.test(line)) {
      flush()
      for (const cell of line.trim().replace(/^\||\|$/g, '').split('|')) {
        const value = cell.trim()
        if (value !== '' && !/^-{2,}$/.test(value)) blocks.push({ kind: 'cell', text: value, line: index + 1 })
      }
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      start('item', item[1], index + 1)
      continue
    }
    // A plain line continues the paragraph or list item above it; Markdown
    // joins them, so the ceiling must measure them joined.
    if (open !== null && (open.kind === 'para' || open.kind === 'item')) open.text += ` ${line.trim()}`
    else start('para', line, index + 1)
  }
  flush()
  return blocks
}

function longestBlock(text) {
  let longest = { length: 0, kind: '-', line: 0 }
  for (const block of renderedBlocks(text)) {
    if (block.text.length > longest.length) {
      longest = { length: block.text.length, kind: block.kind, line: block.line }
    }
  }
  return longest
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const fillSwitcher = (template, source, pair) =>
  template.replaceAll('{source}', source).replaceAll('{pair}', pair)

// The same template with each placeholder widened to any link: a switcher that
// points somewhere else is still recognized as a switcher, so the failure names
// the wrong target instead of claiming the line is missing.
const switcherDetectors = new Map()
function switcherDetector(template) {
  let detector = switcherDetectors.get(template)
  if (detector === undefined) {
    const widened = escapeRegExp(template)
      .replaceAll('\\{source\\}', '([^)]+)')
      .replaceAll('\\{pair\\}', '([^)]+)')
    detector = new RegExp(`^${widened}$`)
    switcherDetectors.set(template, detector)
  }
  return detector
}

function checkSwitcher(file, template, names) {
  const expected = fillSwitcher(template, names.source, names.pair)
  const detector = switcherDetector(template)
  const head = readFileSync(file, 'utf8').replaceAll('\r\n', '\n').split('\n').slice(0, SWITCHER_LINES)
  const line = head.find(candidate => detector.test(candidate))
  if (line === undefined) fail(file, `missing the switcher line (expected "${expected}")`)
  else if (line !== expected) fail(file, `switcher does not name its pair: ${line} (expected "${expected}")`)
}

if (!existsSync(docsDirectory) || !statSync(docsDirectory).isDirectory()) {
  console.error(`Documentation check failed: no docs directory at ${docsDirectory}`)
  process.exit(1)
}

// 1. Bilingual pairing and switcher integrity, in every page set.
const linkFiles = new Set()
let pagePairs = 0
let pairOutlines = 0
for (const set of PAGE_SETS) {
  const directory = join(root, set.directory)
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    fail(directory, 'document set directory is missing')
    continue
  }
  const prefix = set.directory === '.' ? '' : `${set.directory}/`
  const names = set.enumerate
    ? markdownFiles(directory).map(file => relative(directory, file).replaceAll('\\', '/')).sort()
    : set.pages
  for (const name of names) {
    if (set.skip?.has(name)) {
      linkFiles.add(join(directory, name))
      continue
    }
    if (name.endsWith('.zh.md')) {
      const sourceName = `${name.slice(0, -'.zh.md'.length)}.md`
      if (!existsSync(join(directory, sourceName))) {
        fail(join(directory, name), 'translated pair has no English source document')
      }
      linkFiles.add(join(directory, name))
      continue
    }
    const source = join(directory, name)
    const pairName = `${name.slice(0, -'.md'.length)}.zh.md`
    const pair = join(directory, pairName)
    linkFiles.add(source)
    if (!existsSync(source)) {
      fail(source, 'maintained document is missing')
      continue
    }
    if (!existsSync(pair)) {
      fail(source, `maintained document has no Chinese pair (expected ${prefix}${pairName})`)
      continue
    }
    linkFiles.add(pair)
    if (!set.enumerate) pagePairs += 1
    // The switcher names its pair as a sibling file name, not as a docs-relative
    // path: a pair always shares one directory, and a docs-relative target would
    // not resolve from a nested document such as architecture/host-authority.md.
    const sibling = { source: basename(name), pair: basename(pairName) }
    checkSwitcher(source, set.switcher.english, sibling)
    checkSwitcher(pair, set.switcher.chinese, sibling)
    // Both halves carry the same outline. Only the levels are compared, never
    // the heading text: a translation rewords a heading by design.
    const englishHeadings = documentHeadings(readFileSync(source, 'utf8'))
    const chineseHeadings = documentHeadings(readFileSync(pair, 'utf8'))
    pairOutlines += 1
    if (englishHeadings.length !== chineseHeadings.length) {
      fail(pair, `outline has ${chineseHeadings.length} headings, but ${basename(source)} has ${englishHeadings.length}`)
    } else {
      for (const [index, heading] of englishHeadings.entries()) {
        const translated = chineseHeadings[index]
        if (heading.level !== translated.level) {
          fail(pair, `heading "${translated.text}" is level ${translated.level}, but "${heading.text}" is level ${heading.level} in ${basename(source)}`)
        }
      }
    }
  }
}

// 2. Relative links resolve inside the working tree.
let linkCount = 0
for (const file of [...linkFiles].sort()) {
  for (const target of relativeTargets(readFileSync(file, 'utf8'))) {
    linkCount += 1
    let path
    try {
      path = decodeURIComponent(target)
    } catch {
      fail(file, `link target is not valid percent-encoding: ${target}`)
      continue
    }
    if (!existsSync(resolve(dirname(file), path))) fail(file, `broken relative link: ${target}`)
  }
}

// 2b. Every `#fragment` names a real anchor of the document it points into; a
// same-file anchor names one of its own. Fragments onto a non-Markdown target
// (an image, a generated JSON) are not heading lookups and are left alone.
let anchorCount = 0
const anchorSets = new Map()
function anchorsOf(file) {
  let anchors = anchorSets.get(file)
  if (anchors === undefined) {
    anchors = documentAnchors(readFileSync(file, 'utf8'))
    anchorSets.set(file, anchors)
  }
  return anchors
}
for (const file of [...linkFiles].sort()) {
  for (const { path, fragment } of linkTargets(readFileSync(file, 'utf8'))) {
    if (fragment === null || fragment === '') continue
    anchorCount += 1
    let anchor
    try {
      anchor = decodeURIComponent(fragment)
    } catch {
      fail(file, `link fragment is not valid percent-encoding: #${fragment}`)
      continue
    }
    const target = path === '' ? file : resolve(dirname(file), path)
    if (!target.endsWith('.md')) continue
    // A missing path is already reported above; one failure per link is enough.
    if (!existsSync(target)) continue
    if (!anchorsOf(target).has(anchor)) {
      fail(file, `link fragment names no heading: ${path === '' ? basename(file) : path}#${anchor}`)
    }
  }
}

// 3. Both indexes name the same maintained documents, and exactly the ones that exist.
const actual = new Set()
for (const file of markdownFiles(docsDirectory)) {
  const name = relative(docsDirectory, file).replaceAll('\\', '/')
  if (!name.endsWith('.zh.md') && !NOT_INDEXED.has(name)) actual.add(name)
}
const rowsByIndex = new Map()
for (const { name, heading } of INDEXES) {
  const file = join(docsDirectory, name)
  if (!existsSync(file)) {
    fail(file, 'documentation index is missing')
    continue
  }
  const section = sectionLines(readFileSync(file, 'utf8'), heading)
  if (section === null) {
    fail(file, `no "${heading}" section to compare`)
    continue
  }
  const rows = new Set()
  for (const line of section) {
    if (!line.startsWith('|')) continue
    for (const target of relativeTargets(line)) rows.add(documentName(target))
  }
  rowsByIndex.set(name, rows)
  for (const document of actual) if (!rows.has(document)) fail(file, `index is missing a row for ${document}`)
  for (const document of rows) if (!actual.has(document)) fail(file, `index names ${document}, which is not a maintained document`)
}
const englishRows = rowsByIndex.get('README.md')
const chineseRows = rowsByIndex.get('README.zh.md')
if (englishRows !== undefined && chineseRows !== undefined) {
  for (const document of englishRows) {
    if (!chineseRows.has(document)) fail(join(docsDirectory, 'README.zh.md'), `listed in the English index but missing here: ${document}`)
  }
  for (const document of chineseRows) {
    if (!englishRows.has(document)) fail(join(docsDirectory, 'README.md'), `listed in the Chinese index but missing here: ${document}`)
  }
}

// 4. Every maintained document stays inside its recorded longest-block ceiling,
// in both languages. A document without a row fails: an unbudgeted document is
// how a wall gets in, and declaring the ceiling is a one-line decision.
const budgetRows = []
for (const document of actual) {
  if (!(document in BLOCK_CHARACTER_CEILINGS)) {
    fail(join(docsDirectory, document), 'no rendered-block ceiling recorded for this maintained document (add a row to BLOCK_CHARACTER_CEILINGS in scripts/check-docs.mjs)')
  }
}
for (const [document, [englishCeiling, chineseCeiling]] of Object.entries(BLOCK_CHARACTER_CEILINGS)) {
  if (!actual.has(document)) {
    fail(join(docsDirectory, document), 'rendered-block ceiling recorded for a document that does not exist')
    continue
  }
  for (const [name, ceiling] of [[document, englishCeiling], [document.replace(/\.md$/, '.zh.md'), chineseCeiling]]) {
    const file = join(docsDirectory, name)
    const longest = longestBlock(readFileSync(file, 'utf8'))
    budgetRows.push(`${longest.length <= ceiling ? 'ok  ' : 'OVER'} ${String(longest.length).padStart(5)} / ${String(ceiling).padEnd(5)} ${longest.kind}@L${longest.line} ${name}`)
    if (longest.length > ceiling) {
      fail(file, `longest rendered block is ${longest.length} characters (${longest.kind} at line ${longest.line}), over the recorded ceiling of ${ceiling}`)
    }
  }
}
if (budgetsOnly) {
  console.log(budgetRows.join('\n'))
  process.exit(0)
}

if (failures.length > 0) {
  console.error(`Documentation check failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Documentation check OK: ${actual.size} maintained documents, ${actual.size} bilingual pairs, `
  + `${pagePairs} page pairs, ${pairOutlines} pair outlines matched, ${linkCount} relative links resolved, `
  + `${anchorCount} heading anchors resolved, `
  + `${budgetRows.length} files inside their longest-block ceiling, both indexes agree.`,
)
