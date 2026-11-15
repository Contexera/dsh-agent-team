// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentTeamWorkerStateView } from '@contexera/dsh-agent-team/types'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')

/**
 * The same two facts a Thread page reads, met through the discussion panel: a
 * start row's state word comes from the read's own table, so two faces of one
 * fact cannot disagree about it.
 */
const started = (workerRef: string, sequence: number): Record<string, unknown> =>
  ({ activityRef: `activity:${workerRef}:started`, kind: 'worker_started', projectRef: 'project:engineering',
    threadRef: 'thread:1', actor: 'member:builder', sequence, workerRef, engine: 'codex' })

const view = (workerRef: string, state: AgentTeamWorkerStateView['state'], unconfirmed = false): AgentTeamWorkerStateView =>
  ({ workerRef, state, unconfirmed } as unknown as AgentTeamWorkerStateView)

describe('Worker runs in a discussion panel', () => {
  it('states a start row from the read table, exactly as the Thread page does', async () => {
    const bench = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seedFollowers: ['member:builder'],
      seededMessages: [{ body: '这条讨论里派了 Worker', occurredAt: '2026-10-14T09:00:00.000Z' }],
      seededWorkerActivities: [started('worker:live', 5), started('worker:gone', 6)],
      seededWorkerStates: [view('worker:live', 'running'), view('worker:gone', 'running', true)],
    })
    fireEvent.click(await bench.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await bench.view.findByRole('button', { name: /^打开讨论：/ }))
    // Only the discussion panel's own rows count: the page behind it renders
    // neither fact, so a match outside the panel would mean the wrong surface.
    const rows = await waitFor(() => {
      const panel = document.querySelector('[data-team-panel]')
      if (panel === null) throw new Error('the discussion panel is not open')
      const activities = [...panel.querySelectorAll('p')].map(row => row.textContent ?? '').filter(row => row.includes('Worker'))
      if (activities.length < 2) throw new Error(`the panel states ${activities.length} of 2 Worker rows`)
      return activities
    })
    expect(rows.filter(row => row.includes('运行中'))).toHaveLength(1)
    expect(rows.filter(row => row.includes('结果未确认'))).toHaveLength(1)
    expect(rows.join('\n')).not.toContain('worker:')
  })
})
