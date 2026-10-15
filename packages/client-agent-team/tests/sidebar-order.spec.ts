// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { moveSidebarItem, reconcileSidebarOrder, useSidebarOrder } from '../src/client/sidebar-order.ts'

type Ref = 'a' | 'b' | 'c' | 'd'

beforeEach(() => { localStorage.clear() })
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
    expect(moveSidebarItem('w1' as never, 'channels', refs, 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    const first = renderHook(() => useSidebarOrder<Ref>('w1' as never, 'channels', refs)).result.current
    expect(first).toEqual(['c', 'a', 'b'])
  })

  it('no-ops on self-drops, no-op moves, unknown refs, and missing workspace', () => {
    expect(moveSidebarItem('w1' as never, 'channels', refs, 'a', 'a', 'after')).toBeUndefined()
    expect(moveSidebarItem('w1' as never, 'channels', refs, 'b', 'a', 'after')).toBeUndefined()
    expect(moveSidebarItem('w1' as never, 'channels', refs, 'x' as never, 'a', 'before')).toBeUndefined()
    expect(moveSidebarItem(undefined, 'channels', refs, 'c', 'a', 'before')).toBeUndefined()
    // None of the failed moves persisted.
    const after = renderHook(() => useSidebarOrder<Ref>('w1' as never, 'channels', refs)).result.current
    expect(after).toEqual(refs)
  })

  it('isolates workspaces and list kinds; corrupted storage falls back to default order', () => {
    moveSidebarItem('w1' as never, 'channels', refs, 'c', 'a', 'before')
    moveSidebarItem('w2' as never, 'agents', ['x', 'y'], 'y', 'x', 'before')
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'channels', refs)).result.current).toEqual(['c', 'a', 'b'])
    expect(renderHook(() => useSidebarOrder<Ref>('w1' as never, 'agents', refs)).result.current).toEqual(refs)
    // A payload written behind this module's back replaces everything it can
    // no longer parse: the exact corruption semantics are "no preference".
    localStorage.setItem('dsh.agent-team.sidebar-order', '{oops')
    const corrupted = renderHook(() => useSidebarOrder<'x' | 'y'>('w2' as never, 'agents', ['x', 'y'] as ('x' | 'y')[])).result.current
    expect(corrupted).toEqual(['x', 'y'])
  })

  it('presence-style data changes keep the personal relative order stable', () => {
    moveSidebarItem('w1' as never, 'agents', ['m1', 'm2', 'm3'] as never[], 'm3' as never, 'm1' as never, 'before')
    // Remote later reports a different secondary payload (same ids); the user's order holds.
    expect(renderHook(() => useSidebarOrder('w1' as never, 'agents', ['m1', 'm2', 'm3'] as string[])).result.current)
      .toEqual(['m3', 'm1', 'm2'])
  })
})
