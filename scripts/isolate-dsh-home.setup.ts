import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Each test file gets its own throwaway DSH home: the real plugin activation and
// removal act on Member directories resolved from DSH_HOME, and the harness session
// exports DSH_HOME itself, so testing whether it is unset is never enough. Specs that
// need a specific home set `process.env.DSH_HOME` themselves and restore it.
// The guard against moving or deleting a privateMemoryPath that lives in a real home
// is in member-runtime.ts (covered by member-lifecycle.spec.ts).
/** The home this test file was forced onto, for a spec that needs to address it. */
export function isolateDshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-team-test-home-'))
  process.env.DSH_HOME = home
  return home
}

const isolatedHome = isolateDshHome()

// The home is per test file, so leaving it behind costs one directory per file
// per run; a Windows lane can still hold a handle briefly after the last test.
const removeIsolatedHome = (): void => {
  rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
afterAll(removeIsolatedHome)
// A file that fails before its hooks can run still exits the worker; clean there
// too so one broken import does not leave a directory behind.
process.once('exit', removeIsolatedHome)
