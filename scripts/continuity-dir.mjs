// Single source of truth for which `@contexera/dsh-context-continuity` this
// repository resolves against.
//
// The engine is a separate repository with its own release cadence, published
// as `@contexera/dsh-context-continuity` and declared by this root package both
// as a runtime dependency (what a profile install resolves for the bundle) and
// as the version floor this bundle is written against. Three shapes are
// therefore legitimate, and the difference matters to the link step:
//
//   1. DSH_CONTEXT_CONTINUITY_DIR — an explicit checkout, used exactly as
//      named. This is the escape hatch for a release or certification run, and
//      for deliberately testing an older generation, so it is never second-
//      guessed; a version below the declared floor only earns a warning.
//   2. A sibling checkout — development against an engine working tree. Two
//      locations carry one: the monorepo it lives in now
//      (`../dsh-plugins/packages/dsh-context-continuity`) and the retired
//      repository of the same name (`../dsh-context-continuity`). Neither is a
//      package install, so `link-harness-packages.mjs` links the chosen one
//      into node_modules to make the package name resolve to it
//      (`continuityFromSibling` is true).
//   3. The installed package in node_modules — a clean checkout (CI) after
//      `pnpm install`. Nothing to link there: the package manager already put
//      the published, prebuilt engine where the package name resolves.
//
// A checkout only wins when it can serve this bundle: it must BE the engine
// package, and its version must not be older than the floor the root manifest
// declares. The retired sibling checkout is what makes this necessary — it
// stays on disk at an old generation, and resolving it silently turns every
// engine change into a red test run that has nothing to do with the change
// under test. A skipped candidate is named once, in one warning line.
//
// A resolution that carries no usable package fails fast here, at its cause,
// instead of surfacing later as a far-away `Cannot find module
// '@contexera/dsh-context-continuity'` inside an unrelated test.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_CONTINUITY_NAME = 'dsh-context-continuity'

// The monorepo directory that publishes the engine is named after the domain
// concept, not after the published package, so it is spelled separately rather
// than derived from the package name.
const MONOREPO_CONTINUITY_DIR = 'context-continuity'

const ENGINE_PACKAGE = '@contexera/dsh-context-continuity'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Name of the sibling engine checkout directory (env override > the default name). */
export const continuityName = process.env.DSH_CONTEXT_CONTINUITY_DIR?.trim() || DEFAULT_CONTINUITY_NAME

/** One directory's manifest, or undefined when it has none that parses. */
function manifestOf(directory) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return typeof manifest === 'object' && manifest !== null ? manifest : undefined
  } catch {
    return undefined
  }
}

/** Whether one directory is an engine package layout — the package itself, not just any checkout. */
function isEngineDirectory(candidate) {
  return manifestOf(candidate)?.name === ENGINE_PACKAGE
}

/** The `major.minor.patch` triple of one version, or undefined when it states none. */
function tripleOf(version) {
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)/u.exec(version) : null
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether a checkout can serve this bundle: its version is not older than the
 * declared floor. Prerelease tags are ignored, so a release candidate of the
 * same triple passes — an engine working tree legitimately sits between
 * releases, and rejecting it would break the sibling workflow this exists for.
 * An unreadable version or floor passes: this is a guard against a known-stale
 * checkout, never a package manager.
 */
function servesBundle(version, floor) {
  const candidate = tripleOf(version)
  const required = tripleOf(floor)
  if (candidate === undefined || required === undefined) return true
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] !== required[index]) return candidate[index] > required[index]
  }
  return true
}

/** The engine range the root manifest declares, and its lower bound. */
const declaredRange = manifestOf(projectRoot)?.dependencies?.[ENGINE_PACKAGE]
const declaredFloor = typeof declaredRange === 'string'
  ? /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(declaredRange)?.[1]
  : undefined

const explicitDir = process.env.DSH_CONTEXT_CONTINUITY_DIR?.trim()
const siblingRoot = resolve(projectRoot, '..', DEFAULT_CONTINUITY_NAME)
const monorepoRoot = resolve(projectRoot, '..', 'dsh-plugins', 'packages', MONOREPO_CONTINUITY_DIR)
const installedRoot = join(projectRoot, 'node_modules', ...ENGINE_PACKAGE.split('/'))

/** One warning line, once per process, for a candidate that was passed over. */
function warn(message) {
  process.stderr.write(`continuity-dir: ${message}\n`)
}

/** Fail fast on the resolution cause, never later on a missing module. */
function unresolvable(skipped) {
  const siblings = readdirSync(join(projectRoot, '..'), { withFileTypes: true })
    .filter(entry => entry.isDirectory()
      && entry.name !== 'dsh-agent-team'
      && !entry.name.startsWith('.'))
    .map(entry => entry.name)
  throw new Error(
    'The context-continuity engine could not be resolved. Looked for, in order:'
    + ` DSH_CONTEXT_CONTINUITY_DIR${explicitDir === undefined ? ' (unset)' : ` (set to '${explicitDir}')`},`
    + ` the sibling checkouts '../dsh-plugins/packages/${MONOREPO_CONTINUITY_DIR}' and '../${DEFAULT_CONTINUITY_NAME}',`
    + ` and the installed package 'node_modules/${ENGINE_PACKAGE}'.`
    + (skipped.length === 0 ? '' : ` Passed over: ${skipped.join('; ')}.`)
    + ' Fix by installing it (pnpm install brings in the published engine),'
    + ' or by keeping an engine checkout as a sibling and building it there (npm run build).'
    + ` Sibling directories that DO exist: ${siblings.length > 0 ? siblings.join(', ') : '(none)'}.`,
  )
}

/** Which engine directory this run uses, and whether the link step must provide it. */
function resolveContinuity() {
  if (explicitDir !== undefined) {
    const explicit = resolve(explicitDir)
    const manifest = manifestOf(explicit)
    if (manifest?.name !== ENGINE_PACKAGE) unresolvable([])
    if (!servesBundle(manifest.version, declaredFloor)) {
      warn(`${explicit} states ${manifest.version}, below the ${declaredRange} this bundle declares;`
        + ' using it anyway because DSH_CONTEXT_CONTINUITY_DIR names it')
    }
    return { dir: explicit, fromSibling: explicit !== installedRoot }
  }
  const skipped = []
  const candidates = [
    { dir: monorepoRoot, fromSibling: true },
    { dir: siblingRoot, fromSibling: true },
    { dir: installedRoot, fromSibling: false },
  ]
  for (const candidate of candidates) {
    if (!isEngineDirectory(candidate.dir)) {
      // A directory that exists but is not this package is worth naming: it is
      // the shape a renamed or half-cloned checkout leaves behind.
      if (existsSync(candidate.dir)) skipped.push(`${candidate.dir} is not ${ENGINE_PACKAGE}`)
      continue
    }
    const { version } = manifestOf(candidate.dir)
    if (!servesBundle(version, declaredFloor)) {
      skipped.push(`${candidate.dir} states ${version}, below the declared ${declaredRange}`)
      continue
    }
    if (skipped.length > 0) warn(`ignoring ${skipped.join('; ')} — using ${candidate.dir} (${version})`)
    return { dir: candidate.dir, fromSibling: candidate.fromSibling }
  }
  return unresolvable(skipped)
}

const resolved = resolveContinuity()

/** Absolute path of the engine package every consumer resolves against. */
export const continuityDir = resolved.dir

/**
 * Whether the resolved engine is a checkout the link step must provide. False
 * means the package manager already installed it under the package name, where
 * a link would point the entry at itself.
 */
export const continuityFromSibling = resolved.fromSibling

/** The built package entry the resolved engine exposes. */
export const continuityEntry = join(continuityDir, 'lib', 'index.js')
