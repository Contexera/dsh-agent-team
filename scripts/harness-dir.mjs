// Single source of truth for which sibling deepseek-harness checkout this repository's scripts, tests,
// and generated facades resolve against.
//
// Resolution order:
//   1. DSH_HARNESS_DIR: certification runs point this at an isolated checkout at the candidate tag
//      (see docs/dsh-release-compatibility.md).
//   2. `.generated-harness` marker: scripts/sync-paths.mjs writes the checkout it generated the tsconfig
//      facades against, so the vitest harness project cannot silently split from the facades.
//   3. Default `deepseek-harness`, the daily sibling checkout tracking the latest certified release. The
//      name is the contract: scripts, generated facades, and the documented sandbox setup rely on it.
//
// A resolved directory that does not exist fails fast, listing the sibling checkouts that ARE present,
// instead of surfacing later as a misleading runtime error (a stale cordis bundle, "Cannot find module 'zod'").
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HARNESS_NAME = 'deepseek-harness'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const markerPath = join(projectRoot, '.generated-harness')

/** The checkout name sync-paths generated the current tsconfig facades against, when the marker exists. */
const generatedName = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : ''

/** Name of the harness checkout directory (env override > generated marker > the default contract name). */
export const harnessName = process.env.DSH_HARNESS_DIR?.trim() || generatedName || DEFAULT_HARNESS_NAME

const harnessRoot = resolve(projectRoot, '..', harnessName)

if (!existsSync(harnessRoot) || !statSync(harnessRoot).isDirectory()) {
  const siblings = readdirSync(join(projectRoot, '..'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()
      && entry.name !== 'dsh-agent-team'
      && !entry.name.startsWith('.')
      && existsSync(join(projectRoot, '..', entry.name, 'tsconfig.base.json')))
    .map(entry => entry.name)
  const source = process.env.DSH_HARNESS_DIR !== undefined
    ? `DSH_HARNESS_DIR points the harness resolution at '${harnessName}', but ../${harnessName} does not exist.`
    : `The tsconfig facades were generated against '${harnessName}' (see .generated-harness), but ../${harnessName} no longer exists.`
  throw new Error(
    `${source}`
    + ` DSH_HARNESS_DIR is only for certification runs against an isolated tag checkout;`
    + ` the daily default is the sibling '${DEFAULT_HARNESS_NAME}' directory (checkout the latest certified release tag, then run pnpm install && pnpm build:lib inside it).`
    + ` Harness checkouts that DO exist as siblings: ${siblings.length > 0 ? siblings.join(', ') : '(none)'}.`
    + ` Fix the checkout (docs/dsh-release-compatibility.md §3.2), rerun node scripts/sync-paths.mjs against the checkout you want,`
    + ` or unset DSH_HARNESS_DIR / remove .generated-harness to fall back to the daily sibling.`,
  )
}

/** Absolute path of the harness checkout every consumer must resolve against. */
export const harnessDir = harnessRoot
