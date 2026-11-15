/**
 * Archives and restores the sibling Harness checkout's gitignored build outputs
 * (`lib/` trees, native host addons, `.dsh-build`) across CI runs.
 *
 * `actions/cache` skips or mis-anchors `../` paths outside `$GITHUB_WORKSPACE`, and caching
 * Harness `node_modules` (~2.5 GB of symlinks/junctions) hurts both size and Windows stability.
 * Instead CI installs dependencies from the cached pnpm store and caches only one flat tarball of
 * build outputs at `<archivePath>` (inside `RUNNER_TEMP`). Staging the tar through the parent of
 * `<harnessDir>` keeps all `tar` paths purely relative so Windows `bsdtar`/GNU `tar` never sees a
 * drive-letter colon or cross-drive path.
 *
 * Usage:
 *   node scripts/ci-harness-cache.mjs pack <harnessDir> [archivePath]
 *   node scripts/ci-harness-cache.mjs unpack <harnessDir> [archivePath]
 * When omitted, archivePath defaults to `process.env.HARNESS_CACHE_ARCHIVE`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const [command, rawHarnessDir, rawArchiveArg] = process.argv.slice(2)
const rawArchivePath = rawArchiveArg || process.env.HARNESS_CACHE_ARCHIVE
if ((command !== 'pack' && command !== 'unpack') || !rawHarnessDir || !rawArchivePath) {
  console.error('Usage: node scripts/ci-harness-cache.mjs <pack|unpack> <harnessDir> [archivePath]')
  process.exit(1)
}

const harnessDir = realpathSync(resolve(rawHarnessDir))
const archivePath = resolve(rawArchivePath)
const stagedArchive = join(dirname(harnessDir), `.ci-harness-cache-${process.pid}.tar`)
const stagedArchiveName = basename(stagedArchive)
const manifestName = `.ci-harness-cache-${process.pid}.paths`
const manifestPath = join(harnessDir, manifestName)

const IGNORED_DIRS = new Set(['node_modules', '.git', '.sessions', '.cache'])

function collectBuildOutputs(directory, relativeDirectory, depth, collected) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const childRelative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    if (depth === 0 && (entry.name === '.dsh-build' || entry.name.endsWith('.tsbuildinfo'))) {
      collected.push(childRelative)
      continue
    }
    if (!entry.isDirectory()) continue
    if (entry.name === 'lib' || /^native\/system\/packages\/[^/]+\/bin$/.test(childRelative)) {
      collected.push(childRelative)
      continue
    }
    if (depth < 4) collectBuildOutputs(join(directory, entry.name), childRelative, depth + 1, collected)
  }
}

try {
  if (command === 'pack') {
    const entries = []
    collectBuildOutputs(harnessDir, '', 0, entries)
    if (entries.length === 0) {
      throw new Error(`No Harness build outputs found under ${harnessDir}`)
    }
    writeFileSync(manifestPath, `${entries.join('\n')}\n`)
    execFileSync('tar', ['-cf', `../${stagedArchiveName}`, '-T', manifestName], {
      cwd: harnessDir,
      stdio: 'inherit',
    })
    mkdirSync(dirname(archivePath), { recursive: true })
    copyFileSync(stagedArchive, archivePath)
    console.log(`packed ${entries.length} Harness build output directories to ${archivePath}`)
  } else {
    if (!existsSync(archivePath)) {
      throw new Error(`Missing cached Harness archive: ${archivePath}`)
    }
    copyFileSync(archivePath, stagedArchive)
    execFileSync('tar', ['-xf', `../${stagedArchiveName}`], {
      cwd: harnessDir,
      stdio: 'inherit',
    })
    const sentinel = join(harnessDir, 'packages/typert/generator/lib')
    if (!existsSync(sentinel)) {
      throw new Error(`Restored Harness archive missing expected build output: ${sentinel}`)
    }
    console.log(`restored Harness build outputs from ${archivePath}`)
  }
} finally {
  rmSync(manifestPath, { force: true })
  rmSync(stagedArchive, { force: true })
}
