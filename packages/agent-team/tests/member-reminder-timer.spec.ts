import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { addLedgerMember, alpha, harness, requestId } from './helpers/host-harness.ts'
import type { AgentTeamReminderRef } from '../src/types.ts'

/**
 * The wake timer itself: a pending occurrence farther out than Node's
 * 2^31-1 ms `setTimeout` cap must arm in capped slices. An unclamped delay
 * makes Node run the timer in 1 ms, and the early evaluation re-arms the same
 * far wake, spinning until the occurrence comes within reach.
 */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** One enabled Member whose handle answers for a stand-in Agent object. */
async function memberWithHandle(tag: string): Promise<{ readonly ctx: Awaited<ReturnType<typeof harness>>['ctx'], readonly agent: Agent }> {
  const test = await harness()
  cleanups.push(async () => { await test.fiber.dispose(); await test.facility.closeAll() })
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId(`${tag}-project`), workspaceId: alpha,
    name: 'engineering', description: 'Engineering work' })
  const added = await addLedgerMember(test.ctx.agentTeam['ledger']!, project.project.projectRef, `member:${tag}`, 'Timed', tag)
  const agent = {} as Agent
  test.ctx.agentTeam['handles'].set(added.member.memberId, { agent, dispose: async () => {} })
  return { ctx: test.ctx, agent }
}

describe('the Member reminder wake timer', () => {
  it('arms a wake beyond the setTimeout cap as a capped slice, not a 1 ms spin', async () => {
    const { ctx, agent } = await memberWithHandle('timer-clamp')
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    await ctx.agentTeam.createMemberReminderForAgent(agent, { requestId: requestId('create-far'), workspaceId: alpha,
      reminderRef: 'reminder:far' as AgentTeamReminderRef, schedule: { kind: 'once', at: far }, note: 'month-end review' })
    await ctx.agentTeam['reminderEvaluationTail']
    const delays = timer.mock.calls.map(([, delay]) => delay).filter((delay): delay is number => typeof delay === 'number')
    expect(delays).toContain(2 ** 31 - 1)
    expect(delays.every(delay => delay <= 2 ** 31 - 1)).toBe(true)
  })
})
