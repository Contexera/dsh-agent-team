// Mechanical gate for the archived work area, which CI otherwise never reads:
// the archive index and work-item directories must agree, every work item needs
// an entry README, links written in archived READMEs must resolve, a sealed
// ticket may keep an active status only behind an archive note, and no debug
// residue may be committed. Historical code citations in spec/issues/materials
// are deliberately out of scope: they describe the tree of their time.
//
// Two month-level entries are structure, not work items: an optional `README.md`
// overview and the shared `validation/` evidence directory. Both are documented
// in the scratch rules; the overview must cover every work item of its month.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(root, '.scratch')
const archive = join(scratch, 'archive')
const indexFile = join(scratch, 'README.md')

const MONTH = /^\d{4}-\d{2}$/
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const UNCLOSED = new Set(['pending', 'ready', 'in-progress', 'review'])
const ARCHIVE_NOTE = '> 已归档'
const TRANSIENT = /\.(?:log|tmp|bak|swp)$/

const findings = []
const report = (file, line, reason) => findings.push(`${relative(root, file).split(sep).join('/')}:${line}: ${reason}`)
const read = file => readFileSync(file, 'utf8')

const inside = (path, base) => path === base || path.startsWith(base + sep)

function workItemOf(path) {
  if (!inside(path, archive)) return undefined
  const [month, name] = relative(archive, path).split(sep)
  if (month === undefined || name === undefined || !MONTH.test(month)) return undefined
  const candidate = join(archive, month, name)
  return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : undefined
}

function markdownFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path)
  }
  return found
}

/** Inline links outside fenced blocks and code spans, with their line numbers. */
function linksIn(file) {
  const links = []
  let fenced = false
  read(file).split('\n').forEach((line, position) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    const cleaned = line.replace(/`[^`]*`/g, ' ')
    for (const match of cleaned.matchAll(LINK)) links.push({ target: match[1], line: position + 1 })
  })
  return links
}

function checkLinks(file) {
  for (const { target, line } of linksIn(file)) {
    if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const path = target.split('#')[0]
    if (path === '') continue
    const resolved = resolve(dirname(file), path)
    if (inside(resolved, join(scratch, 'active')) || inside(resolved, join(scratch, 'local'))) {
      report(file, line, `archived README links at working material: ${path}`)
      continue
    }
    // A link that leaves the repository is an external citation (for example the
    // adjacent Harness checkout); this tree cannot prove it resolves.
    if (!inside(resolved, root)) continue
    if (!existsSync(resolved)) report(file, line, `archived README link does not resolve: ${path}`)
  }
}

if (!existsSync(archive)) {
  console.log('scratch archive clean: no archive directory')
  process.exit(0)
}

const months = readdirSync(archive)
  .filter(name => MONTH.test(name) && statSync(join(archive, name)).isDirectory())
  .sort()
const workItems = []
for (const month of months) {
  const monthDir = join(archive, month)
  for (const name of readdirSync(monthDir).sort()) {
    if (name === 'README.md' || name === 'validation') continue
    const path = join(monthDir, name)
    if (statSync(path).isDirectory()) workItems.push(path)
    else report(path, 1, 'loose file outside a work-item directory')
  }
  const shared = join(monthDir, 'validation')
  if (existsSync(shared) && !existsSync(join(shared, 'README.md'))) {
    report(shared, 1, 'shared validation directory needs a README.md')
  }
}

const indexed = new Set()
let sawArchiveSection = false
if (!existsSync(indexFile)) {
  report(scratch, 1, 'missing the archive index README.md')
} else {
  const sectionLines = new Set()
  let inSection = false
  read(indexFile).split('\n').forEach((line, position) => {
    if (/^##\s+Archived\b/.test(line)) {
      inSection = true
      sawArchiveSection = true
      return
    }
    if (inSection && /^##\s+/.test(line)) inSection = false
    if (inSection) sectionLines.add(position + 1)
  })
  for (const { target, line } of linksIn(indexFile)) {
    if (!sectionLines.has(line)) continue
    if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const path = target.split('#')[0]
    if (path === '') continue
    const resolved = resolve(dirname(indexFile), path)
    if (inside(resolved, join(scratch, 'active')) || inside(resolved, join(scratch, 'local'))) {
      report(indexFile, line, `archive index points at working material: ${path}`)
      continue
    }
    if (!existsSync(resolved)) {
      report(indexFile, line, `broken archive index link: ${path}`)
      continue
    }
    const item = workItemOf(resolved)
    if (item !== undefined) indexed.add(item)
  }
  if (!sawArchiveSection) report(indexFile, 1, 'missing the "## Archived" section')
  for (const item of workItems) {
    if (!indexed.has(item)) report(indexFile, 1, `archived work item missing from the index: ${relative(root, item).split(sep).join('/')}`)
  }
}

for (const item of workItems) {
  const entry = join(item, 'README.md')
  if (!existsSync(entry)) {
    report(item, 1, 'archived work item missing README.md')
    continue
  }
  if (existsSync(join(item, 'local'))) report(join(item, 'local'), 1, 'transient directory committed in the archive')
  const issues = join(item, 'issues')
  if (!existsSync(issues)) continue
  for (const name of readdirSync(issues).filter(file => file.endsWith('.md')).sort()) {
    const file = join(issues, name)
    const text = read(file)
    if (text.split('\n').slice(0, 12).some(line => line.includes(ARCHIVE_NOTE))) continue
    const match = text.match(/^\*\*Status:\*\*\s*([a-z-]+)/mi)
    if (match === null || !UNCLOSED.has(match[1].toLowerCase())) continue
    const line = text.slice(0, match.index).split('\n').length
    report(file, line, `unclosed ticket status in archive: ${match[1]}`)
  }
}

for (const month of months) {
  const overview = join(archive, month, 'README.md')
  if (!existsSync(overview)) continue
  const linked = new Set()
  for (const { target } of linksIn(overview)) {
    if (target === '' || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const item = workItemOf(resolve(dirname(overview), target.split('#')[0]))
    if (item !== undefined) linked.add(item)
  }
  for (const item of workItems.filter(candidate => dirname(candidate) === join(archive, month))) {
    if (!linked.has(item)) report(overview, 1, `month overview missing work item: ${relative(root, item).split(sep).join('/')}`)
  }
}

for (const file of markdownFiles(archive)) {
  if (basename(file) === 'README.md') checkLinks(file)
  if (TRANSIENT.test(file)) report(file, 1, 'transient file committed in the archive')
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding)
  console.error(`\n${findings.length} scratch finding(s)`)
  process.exit(1)
}
console.log(`scratch archive clean: ${workItems.length} work item(s) across ${months.length} month(s)`)
