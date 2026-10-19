import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Agent Team tests boot the real plugin, so they run its real activation and
// removal paths. Those act on Member directories resolved from DSH_HOME, and on
// 2026-08-23 three live Member memory directories were lost to a single
// unisolated spec file. Isolation is still not sufficient on its own: a ledger
// can record a Member's privateMemoryPath as an absolute path in the
// developer's real home, which a process resolving another home must never move
// or delete — that guard lives in member-runtime.ts and is covered by
// member-lifecycle.spec.ts. Give every test file its own throwaway DSH home
// unconditionally: the harness session exports DSH_HOME itself, so testing
// whether it is unset is never enough. Specs that need a specific home set
// `process.env.DSH_HOME` themselves and keep save/restore semantics around it
// (member-lifecycle).
/** The home this test file was forced onto, for a spec that needs to address it. */
export function isolateDshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-team-test-home-'))
  process.env.DSH_HOME = home
  return home
}

isolateDshHome()
