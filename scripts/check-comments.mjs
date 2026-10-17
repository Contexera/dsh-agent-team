/**
 * Comment hygiene: a per-scope budget, and references that cannot resolve.
 *
 * WHY A BUDGET. The root `AGENTS.md` already states the policy — "Comments
 * explain only non-obvious constraints, ownership, or reasons; they are not the
 * sole definition of current behavior" — but nothing measured it, so it drifted
 * silently. Over the twelve commits before 2026-10-15 the production comment
 * share rose from 24.8% to 25.3%, with no individual commit worth objecting to;
 * the audit that day then removed 1145 comment lines that restated the code
 * beside them. A budget is how the next drift becomes visible: a scope that
 * exceeds its recorded number fails, and someone has to decide.
 *
 * The discipline matches the persona budget in `packages/agent-team/tests/shipping.spec.ts`
 * and the per-document ceilings in `check-docs.mjs` — a ceiling is the value
 * recorded when it was reviewed, it ratchets down as comments are condensed,
 * and it rises only deliberately, in a commit that says why. Every
 * `packages/*\/src` directory and `scripts/` needs a row, so a new package
 * declares its own budget instead of inheriting an unbounded default.
 *
 * The budget is a proxy, not a proof: it cannot tell a comment that earns its
 * place from one that restates the line below it. It exists to make the total a
 * reviewed number rather than an accident, which is what the evidence showed
 * was missing.
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
 * SCOPE LIMITS, so the rule does not overreach:
 * - Tests are excluded. A test's comment often records which regression it pins,
 *   a kind the repository wants and this budget must not squeeze.
 * - Only whole comment lines count. A line of code carrying a trailing comment is
 *   code, and counting it would make the number depend on formatting.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Reviewed 2026-10-15, after the comment audit. Raise one only in a commit that
// says why; lower it when a scope is condensed.
//
// Each budget is the audited count plus slack, where slack absorbs one ordinary
// change and is exhausted by sustained drift. Measured over the 39 commits
// before the audit: a commit that adds comments adds around 28 lines here (24 in
// the Client, 18 in tools, 36 in scripts), and the largest single commit added
// 93. Slack of roughly 3% (a floor of 40 for the small scopes, where one function's
// doc block already spans a tenth of the total) therefore clears any normal
// change and needs several drifted commits to trip — while the drift the audit
// found, about 14 net lines per commit, still reaches it in about ten.
//
// `vendor/` is excluded from both rules: it is an upstream fork kept identical
// except for its module tag, so its comments are not ours to condense or rewrite
// (see the sync procedure in its file header).
const COMMENT_BUDGETS = {
  'packages/agent-team/src': 4150,
  'packages/client-agent-team/src': 1950,
  'packages/tool-agent-team/src': 280,
  'scripts': 1900,
}

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

/** Every scope the budget covers: each package source tree, plus `scripts/`. */
const scopes = [
  ...(await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !IGNORED_DIRECTORY.has(entry.name))
    .map(entry => `packages/${entry.name}/src`),
  'scripts',
]

const violations = []
const rows = []

for (const scope of scopes) {
  const budget = COMMENT_BUDGETS[scope]
  if (budget === undefined) {
    violations.push(`${scope} has no comment budget — add a row to COMMENT_BUDGETS in scripts/check-comments.mjs`)
    continue
  }
  let lines = 0
  for (const file of await sourceFiles(join(root, scope))) {
    // Both separators: `relative` yields `\` on Windows, where splitting on `/` alone counted `vendor/`.
    if (relative(root, file).split(/[\\/]/).includes(EXCLUDED_DIRECTORY)) continue
    const text = await readFile(file, 'utf8')
    const lines_ = text.split('\n')
    for (const [index, line] of lines_.entries()) {
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
  rows.push(`${scope} ${lines}/${budget}`)
  if (lines > budget) {
    violations.push(`${scope} holds ${lines} comment line(s), over its recorded budget of ${budget}`)
  }
}

if (violations.length > 0) {
  console.error('Comment check FAILED:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error('\nA scope over budget: condense the comments there, or raise its row in')
  console.error('COMMENT_BUDGETS in scripts/check-comments.mjs deliberately, in a commit that says why.')
  console.error('A citation that cannot resolve: point at a maintained document under docs/ instead.')
  process.exit(1)
}

console.log(`Comment check OK: ${rows.join(', ')} (comment lines / reviewed budget).`)
