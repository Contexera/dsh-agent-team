/**
 * The manager's Session evidence locator: where one Member's current Session
 * lives and which shipped reader can inspect it. This module resolves paths,
 * never reads a log. The bounded read belongs to the reader script, which the
 * manager runs as an ordinary shell command and which reuses the Harness
 * session-persistence backend instead of decoding storage itself.
 * @module @contexera/dsh-agent-team/session-evidence
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The installed reader script, beside the bundled manager skills in this package. */
export function managerSessionEvidenceScriptPath(): string {
  return fileURLToPath(new URL('../manager-skills/manager-session-evidence/scripts/session-evidence.mjs', import.meta.url))
}

/**
 * The running DSH installation's package manifest. The reader resolves the
 * Harness session-persistence backend from here, so it reads with the same
 * packages the Host runs instead of a development checkout or a second copy.
 * Walks up from the launcher entry because `dsh` may be started through a bin
 * symlink; an unknown layout answers `undefined` rather than guessing. The entry
 * is a parameter so the resolution is provable without a live Host process.
 */
export function dshInstallAnchor(entry: string | undefined = process.argv[1]): string | undefined {
  if (entry === undefined) return undefined
  let current: string
  try {
    current = dirname(realpathSync(resolve(entry)))
  } catch {
    return undefined
  }
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (parsed.name === '@deepseek-ai/dsh') return manifest
      } catch {
        // An unreadable manifest is not this installation's anchor; keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}
