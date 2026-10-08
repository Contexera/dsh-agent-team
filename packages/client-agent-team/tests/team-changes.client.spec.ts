// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { RemoteStream, RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { AgentTeamChangesRequest } from '@contexera/dsh-agent-team/types'
import { TeamChangeStream } from '../src/client/team-changes.ts'

/** Clean end of one Host generation: the Host-side generator returns without an error. */
const END = Symbol('end')

function harness() {
  const calls: Array<{
    request: AgentTeamChangesRequest
    signal: AbortSignal
    push(value: number | Error | typeof END): void
  }> = []
  const changes = vi.fn(async function* (request: AgentTeamChangesRequest, signal: AbortSignal) {
    let pending = Promise.withResolvers<number | Error | typeof END>()
    calls.push({ request, signal, push: value => pending.resolve(value) })
    const abort = () => pending.resolve(new Error('aborted'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted) {
        const value = await pending.promise
        pending = Promise.withResolvers<number | Error | typeof END>()
        if (value === END) return
        if (value instanceof Error) throw value
        yield { version: value }
      }
    } finally { signal.removeEventListener('abort', abort) }
  })
  const remote = {
    $stream: <T>(options: ConstructorParameters<typeof RemoteStream<T>>[1]) => new RemoteStream<T>({
      generation: { getSnapshot: () => ({}) as never, subscribe: () => () => {} },
    }, options),
    agentTeam: { changes },
  } as unknown as Pick<ClientRemote, '$stream' | 'agentTeam'>
  return { calls, changes, stream: new TeamChangeStream(remote) }
}

const scope = { kind: 'thread' as const, threadRef: 'thread:1' as never }

describe('TeamChangeStream', () => {
  it('shares a subscription, refreshes on the opening baseline, and cancels only after the last listener leaves', async () => {
    const { stream, calls, changes } = harness()
    const first = vi.fn(), second = vi.fn()
    const leaveFirst = stream.subscribe(scope, first)
    const leaveSecond = stream.subscribe(scope, second)
    calls[0]!.push(7)
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ type: 'changed', version: 7 }))
    expect(second).toHaveBeenCalledWith({ type: 'changed', version: 7 })
    expect(changes).toHaveBeenCalledTimes(1)
    leaveFirst()
    expect(calls[0]!.signal.aborted).toBe(false)
    calls[0]!.push(8)
    await vi.waitFor(() => expect(second).toHaveBeenLastCalledWith({ type: 'changed', version: 8 }))
    expect(first).toHaveBeenCalledTimes(1)
    leaveSecond()
    expect(calls[0]!.signal.aborted).toBe(true)
    await stream.dispose()
  })

  it('keeps scopes independent and ignores an old subscription after rapid replacement', async () => {
    const { stream, calls } = harness()
    const first = vi.fn(), replacement = vi.fn(), global = vi.fn()
    const leave = stream.subscribe(scope, first)
    stream.subscribe(undefined, global)
    leave()
    stream.subscribe(scope, replacement)
    calls[0]!.push(9)
    calls[1]!.push(4)
    calls[2]!.push(3)
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledWith({ type: 'changed', version: 3 }))
    expect(first).not.toHaveBeenCalled()
    expect(global).toHaveBeenCalledWith({ type: 'changed', version: 4 })
    await stream.dispose()
    expect(calls.every(call => call.signal.aborted)).toBe(true)
  })

  it('uses Harness recovery and refreshes on equal or rolled-back baselines', async () => {
    const { stream, calls } = harness()
    const listener = vi.fn()
    stream.subscribe(scope, listener)
    calls[0]!.push(40)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    calls[0]!.push(new RemoteStreamCarrierError('offline'))
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(listener).toHaveBeenLastCalledWith({ type: 'failed', message: 'offline' })
    calls[1]!.push(40)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3))
    expect(listener).toHaveBeenLastCalledWith({ type: 'changed', version: 40 })
    calls[1]!.push(new RemoteStreamCarrierError('restart'))
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    calls[2]!.push(0)
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith({ type: 'changed', version: 0 }))
    await stream.dispose()
  })

  it('reports terminal failures without reopening indefinitely, including to a later listener', async () => {
    const { stream, calls } = harness()
    const first = vi.fn(), second = vi.fn()
    stream.subscribe(scope, first)
    calls[0]!.push(new Error('invalid scope'))
    await vi.waitFor(() => expect(first).toHaveBeenCalledWith({ type: 'failed', message: 'invalid scope' }))
    stream.subscribe(scope, second)
    expect(second).toHaveBeenCalledWith({ type: 'failed', message: 'invalid scope' })
    expect(calls).toHaveLength(1)
    await stream.dispose()
  })

  // A Host that shuts a stream down after accepting it (plugin disposal, graceful
  // restart) ends the generation cleanly while the socket stays open. The Harness
  // contract calls that an outage to retry, not a verdict: classifying it as any
  // other error leaves the page subscribed to a stream that will never speak again.
  it('treats a clean end after the baseline as an outage the Harness retries', async () => {
    const { stream, calls } = harness()
    const listener = vi.fn()
    stream.subscribe(scope, listener)
    calls[0]!.push(5)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ type: 'changed', version: 5 }))
    calls[0]!.push(END)
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(listener).toHaveBeenLastCalledWith({ type: 'failed', message: 'Team change subscription ended without a terminal result' })
    calls[1]!.push(6)
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith({ type: 'changed', version: 6 }))
    await stream.dispose()
  })

  it('leaves a live scope alone when a new Host generation arrives', async () => {
    const { stream, calls } = harness()
    const listener = vi.fn()
    stream.subscribe(scope, listener)
    calls[0]!.push(3)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ type: 'changed', version: 3 }))
    stream.recover()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.signal.aborted).toBe(false)
    await stream.dispose()
  })

  // A terminated stream cannot be resumed by anyone, so the reconnect edge is where
  // this layer has to rebuild it — for the listeners already sitting on the scope.
  it('rebuilds a terminated scope on the next Host generation for its seated listeners', async () => {
    const { stream, calls } = harness()
    const listener = vi.fn()
    stream.subscribe(scope, listener)
    calls[0]!.push(new Error('invalid scope'))
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith({ type: 'failed', message: 'invalid scope' }))
    expect(calls).toHaveLength(1)
    stream.recover()
    expect(calls).toHaveLength(2)
    expect(calls[0]!.signal.aborted).toBe(true)
    calls[1]!.push(11)
    await vi.waitFor(() => expect(listener).toHaveBeenLastCalledWith({ type: 'changed', version: 11 }))
    await stream.dispose()
  })
})
