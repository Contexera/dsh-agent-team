import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamContextJudgeResult } from '@contexera/dsh-agent-team/types'
import { TeamContextJudgeCheck, type TeamContextJudgeLoader } from '../src/client/context-judge.ts'

/**
 * The judge status is read rather than derived, and unlike the environment
 * check it re-reads: a saved key or a corrected endpoint mounts the judge, and
 * the page has to say so without a reload. These tests lock both halves — the
 * demand-driven first read, and the replacement a later read performs.
 */

/** A read failure in the shape the carrier produces (code/details belong to it, not to the test). */
const readFailure = (message: string): RemoteResult<AgentTeamContextJudgeResult> =>
  ({ ok: false, error: { message } }) as RemoteResult<AgentTeamContextJudgeResult>

const READY: AgentTeamContextJudgeResult = {
  enabled: true,
  keyEnv: 'TYPESAFE_API_KEY',
  gate: { tokens: 24000, idleMs: 300000, judgeTimeoutMs: 5000 },
}

const NO_KEY: AgentTeamContextJudgeResult = {
  enabled: false,
  reason: 'no-key',
  keyEnv: 'TYPESAFE_API_KEY',
  gate: { tokens: 24000, idleMs: 300000, judgeTimeoutMs: 5000 },
}

function storeWith(load: () => Promise<RemoteResult<AgentTeamContextJudgeResult>> = async () => ({ ok: true as const, value: READY })) {
  const loadContextJudge = vi.fn(load)
  return { judge: new TeamContextJudgeCheck({ loadContextJudge } as unknown as TeamContextJudgeLoader), loadContextJudge }
}

describe('judge status projection', () => {
  it('does not read before the first subscriber asks', () => {
    const { judge, loadContextJudge } = storeWith()
    expect(judge.getSnapshot().status).toBe('loading')
    expect(judge.getSnapshot().report).toBeUndefined()
    expect(loadContextJudge).not.toHaveBeenCalled()
  })

  it('reads once for several concurrent subscribers and hands them one report', async () => {
    const { judge, loadContextJudge } = storeWith()
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = judge.subscribe(first)
    const offSecond = judge.subscribe(second)
    await judge.refresh()
    expect(loadContextJudge).toHaveBeenCalledTimes(1)
    expect(judge.getSnapshot().report).toEqual(READY)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    offFirst()
    offSecond()
  })

  it('replaces the report on the next read, so a saved key shows up without a reload', async () => {
    let report = NO_KEY
    const { judge } = storeWith(async () => ({ ok: true as const, value: report }))
    await judge.refresh()
    expect(judge.getSnapshot().report?.enabled).toBe(false)
    report = READY
    await judge.refresh()
    expect(judge.getSnapshot().report?.enabled).toBe(true)
  })

  it('keeps the last report when a later read fails, and never blanks the block', async () => {
    let failure: string | undefined
    const { judge } = storeWith(async () => failure === undefined
      ? { ok: true as const, value: READY }
      : readFailure(failure))
    await judge.refresh()
    failure = 'carrier dropped'
    await judge.refresh()
    expect(judge.getSnapshot().report).toEqual(READY)
  })

  it('settles a first read that fails, so a reader stops waiting on a loading that never ends', async () => {
    const { judge } = storeWith(async () => readFailure('carrier dropped'))
    await judge.refresh()
    expect(judge.getSnapshot().status).toBe('ready')
    expect(judge.getSnapshot().report).toBeUndefined()
  })

  it('treats a thrown carrier error as a read failure rather than a verdict', async () => {
    const { judge } = storeWith(async () => { throw new Error('carrier dropped') })
    await judge.refresh()
    expect(judge.getSnapshot().status).toBe('ready')
    expect(judge.getSnapshot().report).toBeUndefined()
  })
})
