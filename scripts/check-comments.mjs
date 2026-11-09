/**
 * Comment hygiene: references that cannot resolve, plus a read-only water line.
 *
 * WHY BANNED REFERENCES. A comment may cite a maintained document — `check-docs.mjs`
 * keeps those honest by resolving every relative link and heading anchor. It may
 * not cite `.scratch/`: `docs/AGENTS.md` states that work history "is not an
 * implementation or API authority", so such a citation points at something
 * explicitly allowed to go stale and that no reader of the published package can
 * open. For the same reason a comment may not cite a task number or an
 * acceptance criterion, because both live only in that tree.
 *
 * A bare `issue #<n>` is deliberately NOT banned: it resolves to a real GitHub
 * issue and is exactly the keep-category the review policy allows.
 *
 * WHY NO BUDGET. This file used to hold a per-scope comment-line budget, and the
 * budget never caught a defect: whether a comment earns its place is a judgement
 * a line count cannot make, and every raise cost a commit that explained a number
 * rather than the code. Comment quality is reviewed periodically by reading the
 * comments, not by gating on a total.
 *
 * `--budgets` prints the per-scope water line without deciding, so a reader
 * tracking a trend — or a review looking for a scope that grew heavy — sees the
 * numbers without turning a report into a gate. A number means nothing without
 * the tree it was measured in: the shared worktree carries whatever is
 * uncommitted, so its count is that worktree's, not `HEAD`'s.
 *
 * SCOPE LIMITS, so the rule does not overreach:
 * - Tests are excluded. A test's comment often records which regression it pins,
 *   a kind the repository wants and this check must not squeeze.
 * - Only whole comment lines count. A line of code carrying a trailing comment is
 *   code, and counting it would make the number depend on formatting.
 * - `vendor/` is excluded from both the scan and the water line: it is an
 *   upstream fork kept identical except for its module tag, so its comments are
 *   not ours to condense or rewrite (see the sync procedure in its file header).
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXCLUDED_DIRECTORY = 'vendor'

// Each rule names the exact text that cannot resolve, so domain vocabulary that
// merely looks similar does not trip it: `Task #1` is a documented Team entity
// (`docs/domain-model.md`), so only a lowercase work-item number is banned.
const BANNED_REFERENCES = [
  [/\.scratch\/[A-Za-z0-9]/, 'work history is not an authority (docs/AGENTS.md) and is not published'],
  [/\btask #[0-9]/, 'work-item numbers live only in the unreleased work history'],
  [/\bissue [0-9]+ criterion/i, 'acceptance criteria live only in the unreleased work history'],
]

const SOURCE_PATTERN = /\.(?:ts|tsx|mjs)$/
const IGNORED_DIRECTORY = new Set(['node_modules', 'lib', 'dist'])
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/
const COMMENT_BODY = /^\s*(?:\/\/|\/\*|\*)\s?(.*)$/

/** List one directory tree's source files. */
const sourceFiles = async directory => {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORY.has(entry.name)) found.push(...await sourceFiles(path))
      continue
    }
    if (entry.isFile() && SOURCE_PATTERN.test(entry.name)) found.push(path)
  }
  return found
}

/** Every scope the check covers: each package source tree, plus `scripts/`. */
const scopes = [
  ...(await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !IGNORED_DIRECTORY.has(entry.name))
    .map(entry => `packages/${entry.name}/src`),
  'scripts',
]

const budgetsOnly = process.argv.includes('--budgets')

const violations = []
const rows = []

for (const scope of scopes) {
  let lines = 0
  let counted = 0
  for (const file of await sourceFiles(join(root, scope))) {
    // Both separators: `relative` yields `\` on Windows, where splitting on `/` alone counted `vendor/`.
    if (relative(root, file).split(/[\\/]/).includes(EXCLUDED_DIRECTORY)) continue
    const text = await readFile(file, 'utf8')
    const lines_ = text.split('\n')
    for (const [index, line] of lines_.entries()) {
      if (line.trim() === '') continue
      counted += 1
      if (!COMMENT_LINE.test(line)) continue
      lines += 1
      const body = COMMENT_BODY.exec(line)?.[1] ?? ''
      for (const [pattern, why] of BANNED_REFERENCES) {
        if (pattern.test(body)) {
          violations.push(`${relative(root, file)}:${index + 1} cites a reference that cannot resolve — ${why}`)
        }
      }
    }
  }
  const density = counted === 0 ? 0 : (lines / counted) * 100
  rows.push(`${String(lines).padStart(5)}  (${density.toFixed(1)}% of ${counted}) ${scope}`)
}

if (budgetsOnly) {
  console.log(rows.join('\n'))
  process.exit(0)
}

if (violations.length > 0) {
  console.error('Comment check FAILED:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error('\nA citation that cannot resolve: point at a maintained document under docs/ instead.')
  process.exit(1)
}

console.log(`Comment check OK: no unresolvable references. Water line: ${rows.join(',')}`)
