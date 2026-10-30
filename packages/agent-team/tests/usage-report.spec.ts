/**
 * `scripts/team-performance/team-live-usage.ts` folds a real ledger into a
 * usage report. This suite writes a real SQLite ledger through the Host, runs
 * the script over it as its own process, and reads the JSON back: the fold has
 * to agree with the states the ledger actually committed, which is the only way
 * the report can describe a real profile.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentTeamHumanActor } from '../src/ledger.ts'
import { addLedgerMember, alpha, committed, ledgerAtBoot, requestId, sqliteHarness } from './helpers/host-harness.ts'

const root = resolve(import.meta.dirname, '../../..')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** Distinctive text the report must never carry: a body, and four Member handles. */
const SECRET_BODY = 'ZEBRA-SECRET-BODY'
const ALPHA_HANDLE = 'alphaquux-agent'
const BETA_HANDLE = 'betaquux-agent'
const GAMMA_HANDLE = 'gammaquux-agent'
const DELTA_HANDLE = 'deltaquux-agent'

interface UsageReport {
  readonly operationKinds: Record<string, number>
  readonly members: { readonly current: number; readonly enabled: number; readonly byState: Record<string, number> }
  readonly attention: {
    readonly threadCount: number
    readonly allMembers: { readonly max: number | null }
    readonly enabledMembers: { readonly max: number | null }
  }
}

async function writeLedger(database: string): Promise<void> {
  const test = await sqliteHarness(database)
  try {
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('usage-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const projectRef = project.project.projectRef
    const started = committed(await test.ctx.agentTeam.startThread({ requestId: requestId('usage-start'), workspaceId: alpha, projectRef, kind: 'discussion', body: SECRET_BODY }))
    const ledger = ledgerAtBoot(test)
    // The enable→suspend→resume chain is the case the report used to mis-read;
    // the Member's Thread Attention is what ties it to the follower counts.
    const resumed = await addLedgerMember(ledger, projectRef, 'member:agent-alpha', 'Test Agent', ALPHA_HANDLE)
    await ledger.changeAttention({ requestId: requestId('usage-follow'), workspaceId: alpha, threadRef: started.thread.threadRef, action: 'follow', actor: resumed.actor })
    await ledger.suspendMember({ requestId: requestId('usage-suspend'), actor: agentTeamHumanActor(), memberId: resumed.member.memberId })
    await ledger.resumeMember({ requestId: requestId('usage-resume'), actor: agentTeamHumanActor(), memberId: resumed.member.memberId })
    expect(ledger.getMember(resumed.member.memberId)?.state).toBe('enabled')
    // A follower that stays suspended keeps its Attention row but leaves the
    // enabled slice, so the report cannot count it as working capacity.
    const suspended = await addLedgerMember(ledger, projectRef, 'member:agent-delta', 'Test Agent', DELTA_HANDLE)
    await ledger.changeAttention({ requestId: requestId('usage-follow-suspended'), workspaceId: alpha, threadRef: started.thread.threadRef, action: 'follow', actor: suspended.actor })
    await ledger.suspendMember({ requestId: requestId('usage-suspend-delta'), actor: agentTeamHumanActor(), memberId: suspended.member.memberId })
    expect(ledger.getMember(suspended.member.memberId)?.state).toBe('suspended')
    // Archived and removed Members leave the roster through different states,
    // and neither may keep inflating the enabled count.
    const archived = await addLedgerMember(ledger, projectRef, 'member:agent-beta', 'Test Agent', BETA_HANDLE)
    await ledger.archiveMember({ requestId: requestId('usage-archive'), actor: agentTeamHumanActor(), memberId: archived.member.memberId })
    const removed = await addLedgerMember(ledger, projectRef, 'member:agent-gamma', 'Test Agent', GAMMA_HANDLE)
    await ledger.removeMember({ requestId: requestId('usage-remove'), actor: agentTeamHumanActor(), memberId: removed.member.memberId })
    expect(ledger.getMember(archived.member.memberId)?.state).toBe('archived')
    expect(ledger.getMember(removed.member.memberId)?.state).toBe('inactive')
  } finally {
    await test.fiber.dispose()
    await test.facility.closeAll()
    await test.backend.close()
  }
}

function readReport(database: string, mode: '--json' | 'text'): string {
  const args = mode === '--json' ? ['--json'] : []
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/team-performance/team-live-usage.ts', database, ...args], { cwd: root, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe('team-live-usage member lifecycle report', () => {
  it('folds every lifecycle record so a resumed Member stays enabled and keeps its followers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-report-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const database = join(directory, 'ledger.sqlite')
    await writeLedger(database)
    const report = JSON.parse(readReport(database, '--json')) as UsageReport

    expect(report.operationKinds).toMatchObject({
      'team/member-added': 4, 'team/member-suspended': 2, 'team/member-resumed': 1, 'team/member-archived': 1, 'team/member-removed': 1,
    })
    // Only the resumed Member is enabled; the archived and removed Members are
    // reported as the states the ledger committed, and the still-suspended one
    // is on the roster without being enabled.
    expect(report.members).toEqual({ current: 2, enabled: 1, byState: { enabled: 1, suspended: 1, archived: 1, inactive: 1 } })
    // The Thread carries the Human author and two Agent followers; only the
    // resumed one is enabled, so the enabled slice must count it back in.
    expect(report.attention.threadCount).toBe(1)
    expect(report.attention.allMembers.max).toBe(3)
    expect(report.attention.enabledMembers.max).toBe(1)
  }, 30_000)

  it('reports counts only, never Message bodies or Member handles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-report-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const database = join(directory, 'ledger.sqlite')
    await writeLedger(database)
    for (const mode of ['--json', 'text'] as const) {
      const stdout = readReport(database, mode)
      for (const secret of [SECRET_BODY, ALPHA_HANDLE, BETA_HANDLE, GAMMA_HANDLE, DELTA_HANDLE]) {
        expect(stdout, `${mode} output must not carry '${secret}'`).not.toContain(secret)
      }
    }
  }, 30_000)
})
