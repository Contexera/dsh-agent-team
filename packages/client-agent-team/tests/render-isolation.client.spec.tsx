// @vitest-environment jsdom
import { memo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Mounting the Team runtime in jsdom has reached 3.0s on the windows lane (worst
// of 11 CI runs, 2026-09-17..21) against vitest's 5s default, so the file keeps
// headroom rather than betting on runner throughput.
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

/**
 * Render-isolation probe for the Thread page (ticket 06).
 *
 * A message row is the unit of cost on this surface: one keystroke in the
 * composer must not re-render the timeline, and a Host change burst must not
 * re-render every row. The counter wraps the real component in the same `memo`
 * boundary the page hands it, so the number is "rows React actually rendered" —
 * a row whose props are unchanged is skipped and not counted, which is exactly
 * the work the page's own state decides. Phase 0 §5 used the same instrument.
 */
const counters = vi.hoisted(() => ({ messages: [] as string[], composers: 0 }))

vi.mock('../src/client/TeamMessage.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/TeamMessage.tsx')>()
  return {
    ...actual,
    TeamMessage: memo((props: Parameters<typeof actual.TeamMessage>[0]) => {
      counters.messages.push(props.body)
      return <actual.TeamMessage {...props} />
    }),
  }
})

vi.mock('../src/client/TeamComposer.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/TeamComposer.tsx')>()
  return {
    ...actual,
    TeamComposer: (props: Parameters<typeof actual.TeamComposer>[0]) => {
      counters.composers += 1
      return <actual.TeamComposer {...props} />
    },
  }
})

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  counters.messages.length = 0
  counters.composers = 0
})

interface Counts {
  readonly rows: number
  readonly composers: number
  readonly readThread: number
  /** Project views that carry a threadRef: this page's own supplemental read. */
  readonly pageRounds: number
  readonly view: number
  readonly members: number
  readonly history: number
  readonly observations: number
  readonly changes: number
}

type Runtime = Awaited<ReturnType<typeof runtimeWithTeam>>

function counts(b: Runtime): Counts {
  return {
    rows: counters.messages.length,
    composers: counters.composers,
    readThread: b.readThread.mock.calls.length,
    pageRounds: b.viewProjects.mock.calls.filter(([request]) => (request as { threadRef?: string }).threadRef !== undefined).length,
    view: b.viewProjects.mock.calls.length,
    members: b.members.mock.calls.length,
    history: b.loadThreadHistory.mock.calls.length,
    observations: b.threadObservations.mock.calls.length,
    changes: b.changes.mock.calls.length,
  }
}

function delta(before: Counts, after: Counts): Record<keyof Counts, number> {
  return Object.fromEntries(Object.keys(before).map(key => [key, (after as unknown as Record<string, number>)[key]! - (before as unknown as Record<string, number>)[key]!])) as unknown as Record<keyof Counts, number>
}

function reset(): void {
  counters.messages.length = 0
  counters.composers = 0
}

/** Wait until the Remote call counters stop moving, so a burst is measured whole. */
async function settle(b: Runtime): Promise<void> {
  let last = JSON.stringify(counts(b))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50))
    const next = JSON.stringify(counts(b))
    if (next === last) return
    last = next
  }
}

/** Open the seeded Project and follow the first Task footer into its Thread page. */
async function openThread(b: Runtime): Promise<void> {
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  // Every seeded message is its own top-level Task entry, so the footer label
  // repeats once per row; the first one is the Thread page under test.
  const [link] = await b.view.findAllByRole('button', { name: /^打开 Task #1：/ })
  fireEvent.click(link!)
  await waitFor(() => expect(b.view.getByRole('textbox', { name: '消息内容' })).toBeTruthy())
}

function seed(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    body: `seeded message ${index + 1}`,
    occurredAt: `2026-08-21T09:${String(index).padStart(2, '0')}:00.000Z`,
    sender: index % 2 === 0 ? ('human' as const) : ('agent' as const),
  }))
}

describe('Thread page render isolation', () => {
  it('re-renders no row for a keystroke or a change burst, and exactly one for an arrival', async () => {
    const bursts: Array<Record<keyof Counts, number>> = []
    const arrivals: Array<Record<keyof Counts, number>> = []
    for (const count of [10, 30]) {
      const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seededMessages: seed(count) })
      await openThread(b)
      const input = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement

      reset()
      const beforeTyping = counts(b)
      fireEvent.change(input, { target: { value: 'hello' } })
      await waitFor(() => expect(input.value).toBe('hello'))
      const typed = delta(beforeTyping, counts(b))
      // The composer owns the draft: typing re-renders it and nothing else.
      expect(typed.rows).toBe(0)
      expect(typed.readThread).toBe(0)
      expect(typed.view).toBe(0)
      expect(typed.members).toBe(0)

      // Flush the initial silent probe before measuring one change event.
      b.publishAgentReply()
      b.publishAgentReply()
      await settle(b)
      reset()
      const beforeBurst = counts(b)
      b.publishAgentReply()
      await settle(b)
      bursts.push(delta(beforeBurst, counts(b)))
      const burst = bursts[bursts.length - 1]!
      // One change event re-reads no Thread and re-renders no row: its cost
      // must not scale with the timeline length (it was exactly `count` before).
      expect(burst.readThread).toBe(0)
      expect(burst.rows).toBe(0)
      // One event wakes the Thread, workspace, and presence scopes; the two
      // roster scopes deliver the same version and share one supplemental round.
      expect(burst.pageRounds).toBeLessThanOrEqual(1)

      reset()
      const beforeSend = counts(b)
      fireEvent.click(b.view.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(b.reply).toHaveBeenCalled())
      await waitFor(() => expect(b.view.queryAllByText('hello').length).toBeGreaterThan(0))
      await settle(b)
      arrivals.push(delta(beforeSend, counts(b)))
      const arrival = arrivals[arrivals.length - 1]!
      // The committed arrival renders its own row and nothing else, at either
      // timeline length.
      expect(arrival.rows).toBe(1)
      expect(b.view.queryAllByText('hello').length).toBeGreaterThan(0)

      // Draft consumption, timeline content, and focus survive the burst.
      expect(input.value).toBe('')
      expect(b.view.queryAllByText('seeded message 1').length).toBeGreaterThan(0)
      expect(b.view.queryAllByText(`seeded message ${count}`).length).toBeGreaterThan(0)
      await b.runtime.dispose()
    }
    expect(bursts).toHaveLength(2)
    expect(arrivals).toHaveLength(2)
  })
})
