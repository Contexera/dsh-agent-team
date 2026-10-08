import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamEnvironmentResult } from '@contexera/dsh-agent-team/types'
import { TeamEnvironmentCheck, type TeamEnvironmentLoader } from '../src/client/environment-check.ts'

/**
 * The environment projection is read-only, read once, and has no retry: the
 * page either states a verdict or states nothing, and a failed read never
 * blanks a report that already stands. These tests lock that shape — in
 * particular that a read failure is not an `undetermined` verdict, because the
 * two mean different things to a reader.
 */

/** A read failure in the shape the carrier produces (code/details belong to it, not to the test). */
const readFailure = (message: string): RemoteResult<AgentTeamEnvironmentResult> =>
  ({ ok: false, error: { message } }) as RemoteResult<AgentTeamEnvironmentResult>

const REPORT: AgentTeamEnvironmentResult = {
  verdict: 'ok',
  bundleVersion: '0.1.15',
  dshVersion: '0.1.7-rc.1',
  certifiedDshVersion: '0.1.7-rc.1',
  supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
}

function storeWith(load: () => Promise<RemoteResult<AgentTeamEnvironmentResult>> = async () => ({ ok: true as const, value: REPORT })) {
  const loadEnvironment = vi.fn(load)
  return { check: new TeamEnvironmentCheck({ loadEnvironment } as unknown as TeamEnvironmentLoader), loadEnvironment }
}

describe('environment projection', () => {
  it('does not read before the first subscriber asks', () => {
    const { check, loadEnvironment } = storeWith()
    expect(check.getSnapshot().status).toBe('loading')
    expect(check.getSnapshot().report).toBeUndefined()
    expect(loadEnvironment).not.toHaveBeenCalled()
  })

  it('reads once for several concurrent subscribers and hands them one report', async () => {
    const { check, loadEnvironment } = storeWith()
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = check.subscribe(first)
    const offSecond = check.subscribe(second)
    await check.refresh()
    expect(loadEnvironment).toHaveBeenCalledTimes(1)
    expect(check.getSnapshot().status).toBe('ready')
    expect(check.getSnapshot().report).toEqual(REPORT)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    offFirst()
    offSecond()
  })

  it('keeps the last report when a later read fails', async () => {
    let failure: string | undefined
    const { check } = storeWith(async () => failure === undefined
      ? { ok: true as const, value: REPORT }
      : readFailure(failure))
    await check.refresh()
    failure = 'the connection dropped'
    await check.refresh()
    expect(check.getSnapshot().report).toEqual(REPORT)
    expect(check.getSnapshot().status).toBe('ready')
  })

  it('treats a thrown carrier error as a read failure rather than a verdict', async () => {
    const { check } = storeWith(async () => { throw new Error('socket closed') })
    await check.refresh()
    // No report, so the page states nothing: an unreachable Host is not the
    // same fact as "the environment could not be determined". The read has
    // settled, so a reader is not left waiting on a `loading` that is over.
    expect(check.getSnapshot().report).toBeUndefined()
    expect(check.getSnapshot().status).toBe('ready')
  })

  it('stops notifying a listener that unsubscribed', async () => {
    const { check } = storeWith()
    const listener = vi.fn()
    const off = check.subscribe(listener)
    off()
    await check.refresh()
    expect(listener).not.toHaveBeenCalled()
  })
})
