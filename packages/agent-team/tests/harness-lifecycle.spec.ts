import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentTeamOperation } from '../src/types.ts'
import { harness } from './helpers/host-harness.ts'
import { EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'
import { mountTeamMemberHost, pushDshHome, runCleanupSteps } from './helpers/team-host-fixture.ts'

/**
 * Cleanup assertions inspect a parent this test owns: another Vitest project can
 * boot a harness into the shared tmpdir while this one runs, and its directory
 * must never be mistaken for a leak here.
 */
async function ownedParent(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-agent-team-lifecycle-'))
}

describe('test harness lifecycle and invariants', () => {
  it('cleans up allocated root and restores DSH_HOME when realHarness init throws partway through', async () => {
    const beforeDshHome = process.env.DSH_HOME
    const parent = await ownedParent()
    try {
      await expect(realHarness(
        new EmptyAdapter(),
        'jsonl',
        undefined,
        false,
        async () => { throw new Error('seed failed midway') },
        'memory',
        { tempParent: parent },
      )).rejects.toThrow('seed failed midway')

      expect(process.env.DSH_HOME).toBe(beforeDshHome)
      expect(await readdir(parent)).toEqual([])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('cleans up allocated root and restores DSH_HOME when mountTeamMemberHost prepare throws', async () => {
    const beforeDshHome = process.env.DSH_HOME
    const parent = await ownedParent()
    try {
      await expect(mountTeamMemberHost({
        presetPlugins: [],
        prepare: () => { throw new Error('prepare failed midway') },
        tempParent: parent,
      })).rejects.toThrow('prepare failed midway')

      expect(process.env.DSH_HOME).toBe(beforeDshHome)
      expect(await readdir(parent)).toEqual([])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('still disposes fiber, removes root, and restores DSH_HOME when validateLedger throws', async () => {
    const beforeDshHome = process.env.DSH_HOME
    const h = await realHarness()
    await h.ctx.agentTeam.createProject({
      requestId: requestId('corrupt-proj'),
      workspaceId: h.workspaceId,
      name: 'corrupt',
      description: 'Corrupt ledger test',
    })
    const table = h.ctx.storageDomain.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()].at(-1)!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 99 })

    await expect(h.close()).rejects.toThrow(/expected sequence/)
    expect(h.teamFiber.uid).toBeNull()
    expect(process.env.DSH_HOME).toBe(beforeDshHome)
    await expect(access(h.root)).rejects.toThrow()
  })

  it('restores nested DSH_HOME overrides in LIFO order and deletes when originally undefined', async () => {
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      const h1 = await realHarness()
      expect(process.env.DSH_HOME).toBe(join(h1.root, 'dsh-home'))
      const h2 = await realHarness()
      expect(process.env.DSH_HOME).toBe(join(h2.root, 'dsh-home'))

      await h2.close()
      expect(process.env.DSH_HOME).toBe(join(h1.root, 'dsh-home'))

      await h1.close()
      expect('DSH_HOME' in process.env).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('preserves active top DSH_HOME on out-of-order close and restores original once all close', () => {
    const saved = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = '/tmp/original-home'
      const restore1 = pushDshHome('/tmp/home-1')
      const restore2 = pushDshHome('/tmp/home-2')
      expect(process.env.DSH_HOME).toBe('/tmp/home-2')

      restore1()
      expect(process.env.DSH_HOME).toBe('/tmp/home-2')

      restore2()
      expect(process.env.DSH_HOME).toBe('/tmp/original-home')
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('makes explicit close() idempotent with onTestFinished for realHarness and host-harness', async () => {
    const member = await realHarness()
    await member.close()
    await member.close()
    expect(member.teamFiber.uid).toBeNull()

    const host = await harness()
    await host.close()
    await host.close()
    expect(host.fiber.uid).toBeNull()
  })

  it('runs every cleanup step and aggregates multiple failures', async () => {
    const ran: string[] = []
    await expect(runCleanupSteps([
      () => { ran.push('first'); throw new Error('first error') },
      () => { ran.push('second') },
      () => { ran.push('third'); throw new Error('third error') },
    ])).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: 'first error' }), expect.objectContaining({ message: 'third error' })],
    })
    expect(ran).toEqual(['first', 'second', 'third'])
  })
})
