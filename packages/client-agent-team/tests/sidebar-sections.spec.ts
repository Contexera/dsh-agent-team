// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook, act } from '@testing-library/react'
import { setSidebarSectionOpen, useSidebarSectionOpen } from '../src/client/sidebar-sections.ts'

beforeEach(() => { localStorage.clear() })
afterEach(cleanup)

describe('sidebar section collapse persistence', () => {
  it('defaults to expanded and remembers a collapse across remounts', () => {
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(true)
    act(() => { setSidebarSectionOpen('w1' as never, 'channels', false) })
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(false)
    expect(localStorage.getItem('dsh.agent-team.sidebar-sections')).toBe('{"collapsed":["w1|channels"]}')
    act(() => { setSidebarSectionOpen('w1' as never, 'channels', true) })
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(true)
    expect(localStorage.getItem('dsh.agent-team.sidebar-sections')).toBe('{"collapsed":[]}')
  })

  it('keys channels and agents per workspace', () => {
    act(() => {
      setSidebarSectionOpen('w1' as never, 'channels', false)
      setSidebarSectionOpen('w1' as never, 'agents', false)
    })
    expect(renderHook(() => useSidebarSectionOpen('w2' as never, 'channels')).result.current).toBe(true)
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(false)
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'agents')).result.current).toBe(false)
    // The two panels are independent keys even within one workspace.
    act(() => { setSidebarSectionOpen('w1' as never, 'agents', true) })
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(false)
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'agents')).result.current).toBe(true)
  })

  it('has no preference without a workspace: the Workspace selector is a field, not a section', () => {
    act(() => { setSidebarSectionOpen(undefined, 'channels', false) })
    expect(localStorage.getItem('dsh.agent-team.sidebar-sections')).toBeNull()
    expect(renderHook(() => useSidebarSectionOpen(undefined, 'channels')).result.current).toBe(true)
  })

  it('notifies live hooks about changes from any mutation site', () => {
    const hook = renderHook(() => useSidebarSectionOpen('w1' as never, 'channels'))
    act(() => { setSidebarSectionOpen('w1' as never, 'channels', false) })
    expect(hook.result.current).toBe(false)
  })

  it('falls back to expanded when storage is corrupted or unavailable', () => {
    localStorage.setItem('dsh.agent-team.sidebar-sections', '{oops')
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(true)
    localStorage.setItem('dsh.agent-team.sidebar-sections', JSON.stringify({ collapsed: [42] }))
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(true)
    // A corrupted store does not block a fresh write of a valid preference.
    act(() => { setSidebarSectionOpen('w1' as never, 'channels', false) })
    expect(renderHook(() => useSidebarSectionOpen('w1' as never, 'channels')).result.current).toBe(false)
  })
})
