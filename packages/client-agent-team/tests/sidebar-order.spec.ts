// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { attachSidebarOrderHost, ensureSidebarOrderHydrated, moveSidebarItem, reconcileSidebarOrder, useSidebarOrder, type SidebarOrderHost } from '../src/client/sidebar-order.ts'

type Ref = 'a' | 'b' | 'c' | 'd'

beforeEach(() => { localStorage.clear(); attachSidebarOrderHost(undefined) })
afterEach(cleanup)

describe('reconcileSidebarOrder', () => {
  it('keeps the saved relative order and appends newcomers in default positions', () => {
    expect(reconcileSidebarOrder<Ref>(['c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
    expect(reconcileSidebarOrder<Ref>([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('drops removed refs and collapses duplicates', () => {
    expect(reconcileSidebarOrder<Ref>(['d', 'a', 'd', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('is a pure function over its inputs', () => {
    const saved = ['b']
    expect(reconcileSidebarOrder(saved, ['a', 'b'])).toEqual(['b', 'a'])
    expect(saved).toEqual(['b'])
  })
})

describe('moveSidebarItem persistence semantics', () => {
  const refs: readonly Ref[] = ['a', 'b', 'c']

  it('commits once per gesture path and persists across reloads', () => {
    expect(moveSidebarItem('w1' as never, 'projects', refs, 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    const first = renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', refs)).result.current
    expect(first).toEqual(['c', 'a', 'b'])
  })

  it('no-ops on self-drops, no-op moves, unknown refs, and missing workspace', () => {
    expect(moveSidebarItem('w1' as never, 'projects', refs, 'a', 'a', 'after')).toBeUndefined()
    expect(moveSidebarItem('w1' as never, 'projects', refs, 'b', 'a', 'after')).toBeUndefined()
    expect(moveSidebarItem('w1' as never, 'projects', refs, 'x' as never, 'a', 'before')).toBeUndefined()
    expect(moveSidebarItem(undefined, 'projects', refs, 'c', 'a', 'before')).toBeUndefined()
    // None of the failed moves persisted.
    const after = renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', refs)).result.current
    expect(after).toEqual(refs)
  })

  it('isolates workspaces and list kinds; corrupted storage falls back to default order', () => {
    moveSidebarItem('w1' as never, 'projects', refs, 'c', 'a', 'before')
    moveSidebarItem('w2' as never, 'agents', ['x', 'y'], 'y', 'x', 'before')
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', refs)).result.current).toEqual(['c', 'a', 'b'])
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'agents', refs)).result.current).toEqual(refs)
    // A payload written behind this module's back replaces everything it can
    // no longer parse: the exact corruption semantics are "no preference".
    localStorage.setItem('dsh.agent-team.sidebar-order', '{oops')
    const corrupted = renderHook(() => useSidebarOrder<'x' | 'y'>('w2' as never, 'agents', ['x', 'y'] as ('x' | 'y')[])).result.current
    expect(corrupted).toEqual(['x', 'y'])
  })

  it('keeps a Project order saved before Projects were renamed from Channels', () => {
    localStorage.setItem('dsh.agent-team.sidebar-order', JSON.stringify({ 'w1|channels': ['channel:c', 'channel:a'] }))
    const projects = ['project:a', 'project:b', 'project:c'] as never[]
    expect(renderHook(() => useSidebarOrder('w1' as never, 'projects', projects)).result.current).toEqual(['project:c', 'project:a', 'project:b'])
  })

  it('presence-style data changes keep the personal relative order stable', () => {
    moveSidebarItem('w1' as never, 'agents', ['m1', 'm2', 'm3'] as never[], 'm3' as never, 'm1' as never, 'before')
    // Remote later reports a different secondary payload (same ids); the user's order holds.
    expect(renderHook(() => useSidebarOrder('w1' as never, 'agents', ['m1', 'm2', 'm3'] as string[])).result.current)
      .toEqual(['m3', 'm1', 'm2'])
  })
})

describe('the Host preference behind the browser cache', () => {
  const hostOrders = (lists: Record<string, readonly string[]>): {
    host: SidebarOrderHost
    saves: { key: string; refs: readonly string[] }[]
    loads: number
  } => {
    const saves: { key: string; refs: readonly string[] }[] = []
    let loads = 0
    return {
      saves,
      get loads() { return loads },
      host: {
        load: async () => { loads += 1; return { ok: true, value: { lists } } as never },
        save: async request => { saves.push({ key: request.key, refs: request.refs }); return { ok: true, value: { lists } } as never },
      },
    }
  }

  it('adopts the Host order over a stale cache and rewrites the cache', async () => {
    localStorage.setItem('dsh.agent-team.sidebar-order', JSON.stringify({ 'w1|projects': ['a', 'b', 'c'] }))
    attachSidebarOrderHost(hostOrders({ 'w1|projects': ['c', 'b', 'a'] }).host)
    await ensureSidebarOrderHydrated()
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', ['a', 'b', 'c'])).result.current)
      .toEqual(['c', 'b', 'a'])
    expect(JSON.parse(localStorage.getItem('dsh.agent-team.sidebar-order')!)).toEqual({ 'w1|projects': ['c', 'b', 'a'] })
  })

  it('migrates an order this browser arranged before the Host carried one', async () => {
    localStorage.setItem('dsh.agent-team.sidebar-order', JSON.stringify({ 'w1|projects': ['c', 'a', 'b'] }))
    const remote = hostOrders({})
    attachSidebarOrderHost(remote.host)
    await ensureSidebarOrderHydrated()
    expect(remote.saves).toEqual([{ key: 'w1|projects', refs: ['c', 'a', 'b'] }])
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', ['a', 'b', 'c'])).result.current)
      .toEqual(['c', 'a', 'b'])
  })

  it('saves a drag and keeps serving it when the write fails', async () => {
    const saves: string[] = []
    attachSidebarOrderHost({
      load: async () => ({ ok: true, value: { lists: {} } } as never),
      save: async request => { saves.push(request.key); return { ok: false, error: { message: 'settings unavailable' } } as never },
    })
    await ensureSidebarOrderHydrated()
    moveSidebarItem('w1' as never, 'projects', ['a', 'b', 'c'], 'c', 'a', 'before')
    await Promise.resolve()
    await Promise.resolve()
    expect(saves).toEqual(['w1|projects'])
    // The order the Human just dropped is still what renders; a later drag tries the write again.
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', ['a', 'b', 'c'])).result.current)
      .toEqual(['c', 'a', 'b'])
    expect(JSON.parse(localStorage.getItem('dsh.agent-team.sidebar-order')!)).toEqual({ 'w1|projects': ['c', 'a', 'b'] })
  })

  it('never overwrites a drag that landed while the Host read was in flight', async () => {
    let releaseLoad: (() => void) | undefined
    const saved: { key: string; refs: readonly string[] }[] = []
    attachSidebarOrderHost({
      load: () => new Promise(resolve => {
        releaseLoad = () => { resolve({ ok: true, value: { lists: { 'w1|projects': ['a', 'b', 'c'] } } } as never) }
      }),
      save: async request => { saved.push({ key: request.key, refs: request.refs }); return { ok: true, value: { lists: {} } } as never },
    })
    const hydration = ensureSidebarOrderHydrated()
    moveSidebarItem('w1' as never, 'projects', ['a', 'b', 'c'], 'c', 'a', 'before')
    releaseLoad!()
    await hydration
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', ['a', 'b', 'c'])).result.current)
      .toEqual(['c', 'a', 'b'])
    // The Host write carries the Human's newer drop, not the older answer.
    expect(saved.at(-1)).toEqual({ key: 'w1|projects', refs: ['c', 'a', 'b'] })
  })

  it('falls back to the cache when the Host read fails, and retries nothing on its own', async () => {
    localStorage.setItem('dsh.agent-team.sidebar-order', JSON.stringify({ 'w1|agents': ['m2', 'm1'] }))
    let loads = 0
    attachSidebarOrderHost({
      load: async () => { loads += 1; return { ok: false, error: { message: 'offline' } } as never },
      save: async () => ({ ok: true, value: { lists: {} } } as never),
    })
    await ensureSidebarOrderHydrated()
    expect(loads).toBe(1)
    expect(renderHook(() => useSidebarOrder('w1' as never, 'agents', ['m1', 'm2'])).result.current).toEqual(['m2', 'm1'])
  })

  it('reads the Host once even when several lists mount', async () => {
    const remote = hostOrders({ 'w1|projects': ['c', 'a', 'b'] })
    attachSidebarOrderHost(remote.host)
    renderHook(() => useSidebarOrder<Ref>('w1' as never, 'projects', ['a', 'b', 'c']))
    renderHook(() => useSidebarOrder('w1' as never, 'agents', ['m1']))
    await ensureSidebarOrderHydrated()
    expect(remote.loads).toBe(1)
  })
})
