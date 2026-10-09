import { describe, expect, it } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamReplySettings } from '@contexera/dsh-agent-team/types'
import { TeamReplyCapabilities } from '../src/client/reply-capabilities.ts'

const ok = (enabled: boolean) => async () => ({ ok: true as const, value: { enabled } })
// A rejected Remote call, as the transport reports it: the store only cares
// that the read did not produce an accepted value.
const failed = async () => { throw new Error('carrier dropped') }

describe('TeamReplyCapabilities', () => {
  it('starts at the Host default and publishes the Host answer', async () => {
    const store = new TeamReplyCapabilities(ok(false))
    // Before any read the store stands on the Host's own default, which is on:
    // a surface must not flash "hidden" for a feature that is actually offered.
    expect(store.getSnapshot()).toEqual({ status: 'loading', enabled: true })
    await store.refresh()
    expect(store.getSnapshot()).toEqual({ status: 'ready', enabled: false })
  })

  it('keeps the last accepted answer when a later read fails', async () => {
    let answer: () => Promise<RemoteResult<AgentTeamReplySettings>> = ok(false)
    const store = new TeamReplyCapabilities(() => answer())
    await store.refresh()
    expect(store.getSnapshot().enabled).toBe(false)
    answer = failed
    await store.refresh()
    // The switch did not move: a dropped carrier must not silently remove an
    // affordance the Team still offers.
    expect(store.getSnapshot()).toEqual({ status: 'ready', enabled: false })
  })

  it('wakes its subscribers only when the answer actually changes', async () => {
    const store = new TeamReplyCapabilities(ok(true))
    let wakes = 0
    const stop = store.subscribe(() => { wakes += 1 })
    await store.refresh()
    expect(wakes).toBe(1)
    await store.refresh()
    expect(wakes).toBe(1)
    stop()
  })
})
