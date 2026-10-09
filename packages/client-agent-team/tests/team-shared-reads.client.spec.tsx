// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type Runtime = Awaited<ReturnType<typeof runtimeWithTeam>>

/**
 * Drive every continuation a resolved response queues — its landing, the guard
 * it runs through, the reads those issue — to quiescence. Each of them is a
 * microtask, so draining the microtask queue puts the test at a known point; a
 * wall-clock wait cannot, because a loaded machine ends it earlier and an update
 * that was still coming then reads as one that never happened.
 */
const drainContinuations = async (): Promise<void> => {
  for (let turn = 0; turn < 64; turn += 1) await Promise.resolve()
}

/** Let every mount-time read and stream baseline settle before scripting. */
const settleReads = (): Promise<void> => drainContinuations()

/**
 * Override the roster read with a scripted sequence of deferred answers,
 * indexed by issuance order (0-based from this point).
 */
function scriptReads(b: Runtime, answers: ReadonlyArray<Promise<unknown>>): () => number {
  let issued = 0
  ;(b.members as unknown as { mockImplementation(fn: () => Promise<unknown>): void }).mockImplementation(async () => {
    const index = issued
    issued += 1
    return await answers[Math.min(index, answers.length - 1)]!
  })
  return () => issued
}

/** The sidebar renders each Agent as one draggable row. */
const rosterTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[draggable="true"]')].map(node => (node.textContent ?? '').trim())

/**
 * The Channels panel's view answer with only the channel name swapped out;
 * every other field keeps the harness default shape so the panel's other
 * consumers stay intact.
 */
function viewPayload(name: string): { ok: true; value: Record<string, unknown> } {
  return {
    ok: true,
    value: {
      humanMemberId: 'member:human',
      channels: [{ channelRef: 'channel:engineering', workspaceId: 'w1', name, description: '', createdAtSequence: 1 }],
      members: [], tasks: [], threads: [], taskNumbers: [], items: [], claims: [], activities: [], cursor: 0, hasMore: false,
    },
  }
}

describe('shared client reads (issue 03)', () => {
  it('D4: a late-arriving stale roster read never replaces the newer result', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const rosterCounters = () => b.runtime.ctx.teamQueries.diagnostics()['members:w1']
    await b.view.findByText('builder')
    await settleReads()
    // Mount-time reads and the stream baseline coalesce on their own schedule,
    // so what follows is stated as deltas from this baseline: exact about what
    // this test asks for, indifferent to how the mount happened to share.
    const baseline = rosterCounters()
    const droppedBefore = baseline?.droppedStale ?? 0
    const issuedBefore = baseline?.issued ?? 0

    const stale = Promise.withResolvers<unknown>()
    const fresh = Promise.withResolvers<unknown>()
    const issued = scriptReads(b, [stale.promise, fresh.promise])

    // Two presence notifications as two distinct deliveries (the stream
    // transport coalesces wakes that land before the previous one is
    // delivered), the second while the first read is still in flight (issue
    // 03's tail requirement: a change during an in-flight read must still get
    // its own subsequent read).
    b.publishPresence()
    await waitFor(() => expect(issued()).toBe(1))
    b.publishPresence()
    await waitFor(() => expect(issued()).toBe(2))

    // The second request's answer arrives first and carries the newcomer...
    const oldRows = [b.status('member:builder', 'w1', 'builder', 'available')]
    const newRows = [...oldRows, b.status('member:newcomer', 'w1', 'newcomer', 'available')]
    fresh.resolve({ ok: true, value: newRows })
    await b.view.findByText('newcomer')

    // ...then the first request's old answer arrives late. It must be dropped:
    // the roster keeps the newer result instead of regressing to one row. The
    // drop is the positive signal — the per-query counter moves when the landing
    // runs through the guard — so nothing here is timed.
    stale.resolve({ ok: true, value: oldRows })
    await waitFor(() => expect(rosterCounters()?.droppedStale).toBe(droppedBefore + 1))
    expect(b.view.queryByText('newcomer')).not.toBeNull()
    expect(rosterTexts(b.view.container).some(text => text.includes('newcomer'))).toBe(true)

    // Exact: those two wakes issued two roster reads and no more, and exactly
    // one drop log carries the stale reason. The log line holds the query
    // identity and issuance positions only — no response body, no member names.
    expect(rosterCounters()?.issued).toBe(issuedBefore + 2)
    const staleDrops = infoSpy.mock.calls.filter(call => (call[1] as { reason?: string } | undefined)?.reason === 'stale')
    expect(staleDrops).toHaveLength(1)
    expect((staleDrops[0]![1] as { query?: string }).query).toBe('members:w1')
    for (const call of staleDrops) expect(JSON.stringify(call.slice(1))).not.toContain('newcomer')
    infoSpy.mockRestore()
    await b.runtime.dispose()
  })

  it('shares one in-flight roster read across the consumers of one wake', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const rosterCounters = () => b.runtime.ctx.teamQueries.diagnostics()['members:w1']
    await b.view.findByText('builder')
    await settleReads()
    const before = b.members.mock.calls.length
    const sharedBefore = rosterCounters()?.shared ?? 0

    // One projection-domain wake: the Channels panel and the Agents panel
    // both subscribe to the workspace scope and both refresh the same roster
    // query — they must share a single underlying read. The second consumer
    // joining the read in flight is the positive signal that sharing happened;
    // by then a Host call a broken share would have issued is counted too.
    b.publishWorkspaceUpdate()
    await waitFor(() => expect(rosterCounters()?.shared ?? 0).toBeGreaterThan(sharedBefore))
    expect(b.members.mock.calls.length).toBe(before + 1)
    await b.runtime.dispose()
  })

  it('a wake from outside this Workspace never re-reads the roster', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const rosterCounters = () => b.runtime.ctx.teamQueries.diagnostics()['members:w1']
    await b.view.findByText('builder')
    await settleReads()
    const issuedBefore = rosterCounters()?.issued ?? 0

    // A presence wake opens a roster read and leaves it in flight: the read
    // layer shares it across the panels, so exactly one underlying read runs.
    const held = Promise.withResolvers<unknown>()
    const issued = scriptReads(b, [held.promise])
    b.publishPresence()
    await waitFor(() => expect(issued()).toBe(1))

    // Now a commit whose narrow scopes match nothing this app subscribed to
    // (a change in another Workspace) reaches the scope-less stream the
    // sidebar badge and the Inbox ride. The roster query declares only its
    // own scopes — the Host always wakes the matching narrow scope for a
    // roster change — so this wake must leave the in-flight roster read
    // untouched: invalidating it here would drop the landing answer and cost
    // a redundant replacement read (issue 03 criterion 4: refresh what the
    // change actually touched, not the most conservative guess).
    const inboxBefore = b.inbox.mock.calls.length
    b.publishGlobalUpdate()
    // Positive control: the scope-less surfaces did receive the wake.
    await waitFor(() => expect(b.inbox.mock.calls.length).toBeGreaterThan(inboxBefore))

    // The held read answers with a marker row: rendering it is the positive
    // signal that this answer landed, so a replacement read — had the foreign
    // wake issued one — is already counted by the assertions below.
    held.resolve({ ok: true, value: [
      b.status('member:builder', 'w1', 'builder', 'available'),
      b.status('member:marker', 'w1', 'landed-roster', 'available'),
    ] })
    await b.view.findByText('landed-roster')
    expect(issued()).toBe(1)
    // Exact: the presence wake cost one roster read and the foreign wake none.
    expect(rosterCounters()?.issued).toBe(issuedBefore + 1)
    await b.runtime.dispose()
  })

  it('D5: a late-arriving stale view response never replaces the newer channels rows', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.view.findByText('# engineering')
    await settleReads()

    const held = Promise.withResolvers<unknown>()
    let issued = 0
    ;(b.viewChannels as unknown as { mockImplementation(fn: () => Promise<unknown>): void }).mockImplementation(async () => {
      issued += 1
      return issued === 1 ? await held.promise : viewPayload('fresh-channel')
    })

    // Two distinct workspace wakes with one landing read in between, so the
    // second wake issues its own view read instead of riding the first.
    b.publishWorkspaceUpdate()
    await waitFor(() => expect(issued).toBe(1))
    b.publishWorkspaceUpdate()
    await b.view.findByText('# fresh-channel')

    // The first read now lands late carrying the old rows: the panel must drop
    // it instead of painting it over the newer result. That guard is the only
    // outcome of this landing — nothing is rendered or counted either way — so
    // the deterministic point to assert from is the drained microtask queue the
    // guard runs on, while the exact issuance below pins what the two wakes
    // were allowed to cost.
    held.resolve(viewPayload('stale-channel'))
    await drainContinuations()

    expect(issued).toBe(2)
    expect(b.view.queryByText('# stale-channel')).toBeNull()
    expect(b.view.queryByText('# fresh-channel')).not.toBeNull()
    await b.runtime.dispose()
  })

  it('D6: a failed members read never blocks the landed view rows', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.view.findByText('# engineering')
    await b.view.findByText('builder')
    await settleReads()

    ;(b.members as unknown as { mockImplementation(fn: () => Promise<unknown>): void })
      .mockImplementation(async () => ({ ok: false, error: { message: 'roster unavailable' } }))
    ;(b.viewChannels as unknown as { mockImplementation(fn: () => Promise<unknown>): void })
      .mockImplementation(async () => viewPayload('fresh-channel'))

    b.publishWorkspaceUpdate()

    // The two legs carry independent freshness (the roster rides the shared
    // read layer, the catalog is still a direct read): one leg's failure must
    // not freeze the other leg's landed value...
    await b.view.findByText('# fresh-channel')
    // ...the failure stays visible on the error face...
    const alerts = await b.view.findAllByRole('alert')
    expect(alerts.some(node => node.textContent?.includes('roster unavailable'))).toBe(true)
    // ...and the previously loaded rows stay put instead of flashing empty.
    expect(b.view.queryByText('builder')).not.toBeNull()
    await b.runtime.dispose()
  })
})
