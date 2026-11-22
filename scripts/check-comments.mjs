/**
 * Comment hygiene: actionable explanations, plus a read-only water line.
 *
 * WHY NO WORK MARKERS. Unfinished work belongs in a tracked issue, not an
 * unowned promise that silently ages beside the implementation.
 *
 * WHY NO COMMENTED-OUT CODE. Version control preserves old implementations;
 * leaving executable-looking fragments obscures which implementation is live.
 *
 * WHY EXPLAIN SUPPRESSIONS. Disabling a diagnostic hides a safety check, so the
 * exception must explain its need. Unchecked TypeScript escapes hide too much;
 * an explained expect-error also detects when the exception becomes obsolete.
 *
 * WHY NO RESTATING ONE-LINERS. A short label repeating the next line adds a
 * second description to maintain without explaining intent or constraints.
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
 * - Tests get only the work-marker, dead-code and suppression guards; regression
 *   explanations remain outside the reference and restatement rules.
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
const WORK_MARKER = /\b(?:TODO|FIXME|XXX|HACK|TBD)\b/
const CODE_STATEMENT = /^(?:(?:const|let|var|import|export|return|await|throw)\b|(?:if|for|while)\s*\().*[;{)]$/
const CODE_CALL = /^[\w$]+(?:\.[\w$]+)*\s*\(.*\);?$/
const CODE_ASSIGNMENT = /^[\w$]+(?:\.[\w$]+)*\s*=(?!=).*;$/
const STOPWORDS = new Set('the a of to and for in on is it this with from by as be or its s'.split(' '))
const words = text => (text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [])
const restates = (body, next) => {
  const singular = word => word.replace(/s$/, '')
  const content = words(body).filter(word => !STOPWORDS.has(word)).map(singular)
  const identifiers = new Set(words(next).map(singular))
  return content.length >= 1 && content.length <= 5 && content.every(word => identifiers.has(word))
}

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
const testScopes = (await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => `packages/${entry.name}/tests`)
const existingTests = []
for (const scope of testScopes) {
  try {
    await readdir(join(root, scope))
    existingTests.push(scope)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

const violations = []
const rows = []

for (const scope of [...scopes, ...existingTests]) {
  const tests = existingTests.includes(scope)
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
      const body = (COMMENT_BODY.exec(line)?.[1] ?? '').replace(/\*\/\s*$/, '').trim()
      const report = why => violations.push(`${relative(root, file)}:${index + 1} ${why}`)
      if (WORK_MARKER.test(body)) report('leftover work marker: file an issue or do it')
      if (/^\s*\/\//.test(line) && [CODE_STATEMENT, CODE_CALL, CODE_ASSIGNMENT].some(pattern => pattern.test(body))) {
        report('commented-out code: use version control instead')
      }
      if (/\b(?:oxlint|eslint)-disable[\w-]*\b/.test(body) && !/ -- \S/.test(body)) {
        report('lint suppression must explain its reason after " -- "')
      }
      if (/@ts-(?:ignore|nocheck)\b/.test(body)) report('unchecked TypeScript suppression is banned')
      if (/@ts-expect-error\b/.test(body) && !/@ts-expect-error(?:\s+|:\s*)(?:--\s*)?[\p{L}\p{N}]/u.test(body)) {
        report('TypeScript expect-error must explain its reason')
      }
      const singleLine = /^\s*\/\//.test(line) || /^\s*\/\*\*.*\*\/\s*$/.test(line)
      if (!tests && singleLine && !COMMENT_LINE.test(lines_[index - 1] ?? '') &&
        !COMMENT_LINE.test(lines_[index + 1] ?? '') && restates(body, lines_[index + 1] ?? '')) {
        report('comment restates the next line')
      }
      for (const [pattern, why] of tests ? [] : BANNED_REFERENCES) {
        if (pattern.test(body)) {
          violations.push(`${relative(root, file)}:${index + 1} cites a reference that cannot resolve — ${why}`)
        }
      }
    }
  }
  const density = counted === 0 ? 0 : (lines / counted) * 100
  if (!tests) rows.push(`${String(lines).padStart(5)}  (${density.toFixed(1)}% of ${counted}) ${scope}`)
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
