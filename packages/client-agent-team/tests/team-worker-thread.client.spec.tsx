// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentTeamWorkerStateView } from '@contexera/dsh-agent-team/types'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/**
 * One Worker run the Thread names: the start fact every run has, and the
 * terminal fact it may or may not have. The state word is never on the fact, so
 * each case pairs facts with the derived table a Thread read carries.
 */
const started = (workerRef: string, sequence: number, engine: 'codex' | 'claude' = 'codex'): Record<string, unknown> =>
  ({ activityRef: `activity:${workerRef}:started`, kind: 'worker_started', projectRef: 'project:1', threadRef: 'thread:1',
    taskRef: 'task:1', actor: 'member:builder', sequence, workerRef, engine })

const settled = (workerRef: string, sequence: number, state: 'completed' | 'failed', reason?: string,
  engine: 'codex' | 'claude' = 'codex'): Record<string, unknown> =>
  ({ activityRef: `activity:${workerRef}:settled`, kind: 'worker_settled', projectRef: 'project:1', threadRef: 'thread:1',
    taskRef: 'task:1', actor: 'member:builder', sequence, workerRef, engine, state,
    ...(reason === undefined ? {} : { reason }) })

const view = (workerRef: string, state: AgentTeamWorkerStateView['state'], unconfirmed = false): AgentTeamWorkerStateView =>
  ({ workerRef, state, unconfirmed } as unknown as AgentTeamWorkerStateView)

/** Open the seeded Task Thread, whose feed holds the Worker run facts seeded beside it. */
async function openWorkerThread(seed: {
  readonly activities: readonly Record<string, unknown>[]
  readonly states: readonly AgentTeamWorkerStateView[]
}): Promise<Awaited<ReturnType<typeof runtimeWithTeam>>> {
  const bench = await runtimeWithTeam({
    mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskRef: 'task:1', seedFollowers: ['member:builder'],
    seededMessages: [{ body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' }],
    seededWorkerActivities: seed.activities,
    seededWorkerStates: seed.states,
  })
  fireEvent.click(await bench.view.findByRole('button', { name: '# engineering' }))
  fireEvent.click(await bench.view.findByRole('button', { name: /^打开 Task #1：/ }))
  await bench.view.findByRole('heading', { name: 'Task #1' })
  return bench
}

describe('Worker runs in a Thread', () => {
  it('states each run from the read table, never from whether its settled fact is in this window', async () => {
    const bench = await openWorkerThread({
      // worker:run is live, worker:gone was left behind, worker:later settled in a page this read does not carry.
      activities: [started('worker:run', 5), started('worker:gone', 6), started('worker:later', 7), settled('worker:done', 8, 'completed')],
      states: [view('worker:run', 'running'), view('worker:gone', 'running', true), view('worker:later', 'completed'), view('worker:done', 'completed')],
    })
    const text = (await bench.view.findAllByText(/Worker/)).map(row => row.textContent ?? '')
    expect(text.filter(row => row.includes('运行中'))).toHaveLength(1)
    expect(text.filter(row => row.includes('结果未确认'))).toHaveLength(1)
    // A run whose settled fact sits outside this window still reads as settled: a plain start, no guess.
    expect(text.filter(row => row.includes('派出了 Codex Worker') && !row.includes('（'))).toHaveLength(1)
    expect(text.filter(row => row.includes('完成'))).toHaveLength(1)
    expect(text.join('\n')).not.toContain('worker:')
    await bench.runtime.dispose()
  })

  it('says how a run ended, and keeps the engine it ran on in the settled row', async () => {
    const bench = await openWorkerThread({
      activities: [started('worker:a', 5), settled('worker:a', 6, 'failed', 'codex 不在 PATH 里'),
        started('worker:b', 7, 'claude'), settled('worker:b', 8, 'completed', undefined, 'claude')],
      states: [view('worker:a', 'failed'), view('worker:b', 'completed')],
    })
    const failed = await bench.view.findByText(/失败/)
    expect(failed.textContent).toContain('失败：codex 不在 PATH 里')
    // The engine travels with the run, so one Thread can hold both engines without ambiguity.
    expect(await bench.view.findByText(/Claude Worker 完成/)).toBeTruthy()
    await bench.runtime.dispose()
  })
})
