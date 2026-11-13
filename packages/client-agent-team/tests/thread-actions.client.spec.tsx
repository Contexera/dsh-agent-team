// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamMemberId,
  AgentTeamThreadObservations,
  AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import { useThreadFollow, type AttentionObservation, type AttentionWrite } from '../src/client/thread-actions.ts'

afterEach(cleanup)

const workspaceId = 'w1' as never
const humanMemberId = 'member:human' as AgentTeamMemberId
const threadA = 'thread:a' as AgentTeamThreadRef
const threadB = 'thread:b' as AgentTeamThreadRef

type ObservationResult = RemoteResult<AgentTeamThreadObservations>

const observed = (...followers: AgentTeamMemberId[]): ObservationResult => ({
  ok: true,
  value: { items: [], followers, hasMore: false },
})

const defer = <T,>() => Promise.withResolvers<T>()

describe('Human Thread follow request ownership', () => {
  it('accepts the latest A opening instead of a late read from the first A', async () => {
    const firstA = defer<ObservationResult>()
    const b = defer<ObservationResult>()
    const latestA = defer<ObservationResult>()
    const reads = [firstA, b, latestA]
    const observe = vi.fn<AttentionObservation>(() => reads.shift()!.promise)
    const changeAttention = vi.fn<AttentionWrite>()
    const hook = renderHook(
      ({ threadRef }) => useThreadFollow(changeAttention, observe, { workspaceId, threadRef }, undefined, humanMemberId),
      { initialProps: { threadRef: threadA } },
    )

    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    act(() => { hook.rerender({ threadRef: threadB }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(2))
    act(() => { hook.rerender({ threadRef: threadA }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(3))

    await act(async () => { b.resolve(observed()) })
    expect(hook.result.current.following).toBeUndefined()
    await act(async () => { latestA.resolve(observed(humanMemberId)) })
    expect(hook.result.current.following).toBe(true)
    await act(async () => { firstA.resolve(observed()) })

    expect(hook.result.current.following).toBe(true)
  })

  it('keeps a late successful A write out of B and leaves B usable', async () => {
    const aRead = defer<ObservationResult>()
    const bRead = defer<ObservationResult>()
    const bRefresh = defer<ObservationResult>()
    const observe = vi.fn<AttentionObservation>(({ threadRef }) => threadRef === threadA ? aRead.promise : bRead.promise)
    const aWrite = defer<never>()
    const bWrite = defer<never>()
    const changeAttention = vi.fn<AttentionWrite>(({ threadRef }) => threadRef === threadA ? aWrite.promise : bWrite.promise)
    const hook = renderHook(
      ({ threadRef }) => useThreadFollow(changeAttention, observe, { workspaceId, threadRef }, undefined, humanMemberId),
      { initialProps: { threadRef: threadA } },
    )

    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    let writing!: Promise<void>
    act(() => { writing = hook.result.current.toggle('follow') })
    expect(hook.result.current.pending).toBe(true)

    act(() => { hook.rerender({ threadRef: threadB }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(2))
    await act(async () => { bRead.resolve(observed()) })
    expect(hook.result.current).toMatchObject({ following: false, pending: false, error: undefined })

    observe.mockImplementation(({ threadRef }) => threadRef === threadA ? aRead.promise : bRefresh.promise)
    let writingB!: Promise<void>
    act(() => { writingB = hook.result.current.toggle('follow') })
    expect(hook.result.current.pending).toBe(true)

    await act(async () => {
      aWrite.resolve({ ok: true, value: { attention: {} } } as never)
      await Promise.resolve()
    })
    expect(hook.result.current).toMatchObject({ following: false, pending: true })

    await act(async () => {
      bWrite.resolve({ ok: true, value: { attention: {} } } as never)
      await Promise.resolve()
    })
    await act(async () => { bRefresh.resolve(observed(humanMemberId)) })
    await Promise.all([writing, writingB])

    expect(hook.result.current).toMatchObject({ following: true, pending: false, error: undefined })
  })

  it('re-reads reopened A after an earlier A write succeeds', async () => {
    const firstA = defer<ObservationResult>()
    const bRead = defer<ObservationResult>()
    const reopenedA = defer<ObservationResult>()
    const reopenedARefresh = defer<ObservationResult>()
    const reads = [firstA, bRead, reopenedA, reopenedARefresh]
    const observe = vi.fn<AttentionObservation>(() => reads.shift()!.promise)
    const aWrite = defer<never>()
    const changeAttention = vi.fn<AttentionWrite>(() => aWrite.promise)
    const hook = renderHook(
      ({ threadRef }) => useThreadFollow(changeAttention, observe, { workspaceId, threadRef }, undefined, humanMemberId),
      { initialProps: { threadRef: threadA } },
    )

    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    await act(async () => { firstA.resolve(observed()) })
    let writing!: Promise<void>
    act(() => { writing = hook.result.current.toggle('follow') })

    act(() => { hook.rerender({ threadRef: threadB }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(2))
    await act(async () => { bRead.resolve(observed()) })
    act(() => { hook.rerender({ threadRef: threadA }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(3))

    await act(async () => {
      aWrite.resolve({ ok: true, value: { attention: {} } } as never)
    })
    expect(hook.result.current.following).toBeUndefined()

    await act(async () => { reopenedARefresh.resolve(observed(humanMemberId)) })
    await writing
    await act(async () => { reopenedA.resolve(observed()) })
    expect(hook.result.current).toMatchObject({ following: true, pending: false, error: undefined })
  })

  it('keeps a confirmed write when the original opening cannot read it back', async () => {
    const initialA = defer<ObservationResult>()
    const aWrite = defer<never>()
    const observe = vi.fn<AttentionObservation>()
      .mockImplementationOnce(() => initialA.promise)
      .mockResolvedValueOnce({ ok: false, error: { message: 'readback failed' } } as never)
    const changeAttention = vi.fn<AttentionWrite>(() => aWrite.promise)
    const hook = renderHook(() => useThreadFollow(changeAttention, observe, { workspaceId, threadRef: threadA }, undefined, humanMemberId))

    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    await act(async () => { initialA.resolve(observed()) })
    let writing!: Promise<void>
    act(() => { writing = hook.result.current.toggle('follow') })
    await act(async () => {
      aWrite.resolve({ ok: true, value: { attention: {} } } as never)
      await writing
    })

    expect(observe).toHaveBeenCalledTimes(2)
    expect(hook.result.current).toMatchObject({ following: true, pending: false, error: undefined })
  })

  it('starts only one write when the same opening toggles twice in one event turn', async () => {
    const initialA = defer<ObservationResult>()
    const refreshedA = defer<ObservationResult>()
    const observe = vi.fn<AttentionObservation>()
      .mockImplementationOnce(() => initialA.promise)
      .mockImplementationOnce(() => refreshedA.promise)
    const aWrite = defer<never>()
    const changeAttention = vi.fn<AttentionWrite>(() => aWrite.promise)
    const hook = renderHook(() => useThreadFollow(changeAttention, observe, { workspaceId, threadRef: threadA }, undefined, humanMemberId))

    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    await act(async () => { initialA.resolve(observed()) })
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = hook.result.current.toggle('follow')
      second = hook.result.current.toggle('follow')
    })

    expect(changeAttention).toHaveBeenCalledTimes(1)
    await act(async () => {
      aWrite.resolve({ ok: true, value: { attention: {} } } as never)
      await Promise.resolve()
    })
    await act(async () => { refreshedA.resolve(observed(humanMemberId)) })
    await Promise.all([first, second])
    expect(hook.result.current).toMatchObject({ following: true, pending: false, error: undefined })
  })

  it('keeps a late A failure out of B', async () => {
    const aRead = defer<ObservationResult>()
    const bRead = defer<ObservationResult>()
    const reopenedA = defer<ObservationResult>()
    const reads = [aRead, bRead, reopenedA]
    const observe = vi.fn<AttentionObservation>(() => reads.shift()!.promise)
    const aWrite = defer<never>()
    const changeAttention = vi.fn<AttentionWrite>(() => aWrite.promise)
    const hook = renderHook(
      ({ threadRef }) => useThreadFollow(changeAttention, observe, { workspaceId, threadRef }, undefined, humanMemberId),
      { initialProps: { threadRef: threadA } },
    )

    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1))
    let writing!: Promise<void>
    act(() => { writing = hook.result.current.toggle('follow') })
    act(() => { hook.rerender({ threadRef: threadB }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(2))
    await act(async () => { bRead.resolve(observed()) })

    await act(async () => {
      aWrite.resolve({ ok: false, error: { message: 'A failed' } } as never)
      await writing
    })

    expect(hook.result.current).toMatchObject({ following: false, pending: false, error: undefined })

    act(() => { hook.rerender({ threadRef: threadA }) })
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(3))
    expect(hook.result.current.error).toBeUndefined()
    await act(async () => { reopenedA.resolve(observed()) })
  })
})
