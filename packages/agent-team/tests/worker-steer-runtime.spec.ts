/**
 * The runtime side of steer: accepted follow-up input belongs to the same run,
 * its later turn stays inside the one result, and a stop can still end the run
 * with the output already produced.
 */

import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startWorkerRun, workerAnchorsOf, workerSteerOf, type WorkerRunSpec } from '../src/worker-runtime.ts'

const runtimeControl = vi.hoisted(() => ({
  session: undefined as FakeSession | undefined,
  awaitCalls: 0,
}))

vi.mock('@botiverse/oar', () => ({
  codexRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' }),
    session: async () => runtimeControl.session,
  },
  claudeRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/claude', version: '2.1.319' }),
    session: async () => runtimeControl.session,
  },
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async (session: FakeSession, afterSeq: number, inputId?: string) => {
    runtimeControl.awaitCalls += 1
    return session.awaitTurnEnd(afterSeq, inputId)
  },
}))

interface TurnEnd {
  readonly seq: number
  readonly outcome: { readonly kind: 'completed' } | { readonly kind: 'failed'; readonly failure: 'unknown' }
  readonly inputId?: string | undefined
  readonly inputIds: readonly string[]
}

class FakeSession {
  readonly id = 'native-session-steer'
  readonly recordsList: object[] = [
    { sessionId: this.id, agentPath: [], seq: 0, receivedAt: 0, kind: 'frame',
      body: { type: 'thread/start', native: { thread: { id: this.id,
        path: `/fake/sessions/2026/11/10/rollout-${this.id}.jsonl` } }, events: [] } },
  ]
  readonly turnEnds: TurnEnd[] = []
  readonly steers: Array<{ readonly instruction: string; readonly inputId: string }> = []
  initialInputId = ''
  active = false
  releasedOutcome: TurnEnd['outcome'] | undefined
  releasedSeq: number | undefined
  disposed = 0
  disposeFails = false
  private readonly listeners = new Set<(event: object) => void>()
  private readonly wakeups = new Set<() => void>()
  private seq = 1

  events(listener: (event: object) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async prompt(_input: string, options?: { readonly inputId?: string }): Promise<object> {
    this.initialInputId = options?.inputId ?? ''
    this.active = true
    return { kind: 'accepted', seq: this.seq++, request: { id: `prompt-${this.seq}` },
      response: { body: { kind: 'accepted', native: {} } } }
  }

  async steer(instruction: string, options?: { readonly inputId?: string }): Promise<object> {
    const inputId = options?.inputId ?? ''
    this.steers.push({ instruction, inputId })
    return { kind: 'accepted', seq: this.seq++, request: { seq: this.seq - 1 },
      response: { body: { kind: 'accepted', native: {} } } }
  }

  status(): { readonly value: { readonly kind: 'idle' } | { readonly kind: 'running'; readonly sinceSeq: number }; readonly seq: number } {
    return this.active
      ? { value: { kind: 'running', sinceSeq: 1 }, seq: this.seq - 1 }
      : { value: { kind: 'idle' }, seq: this.seq - 1 }
  }

  async deliver(input: string, options?: { readonly inputId?: string }): Promise<object> {
    const inputId = options?.inputId ?? ''
    if (this.active) {
      const result = await this.steer(input, options)
      return { landed: 'steered', inputId, result }
    }
    const result = await this.prompt(input, options)
    return { landed: 'prompted', inputId, result }
  }

  async abort(): Promise<object> { return { kind: 'accepted' } }

  async dispose(): Promise<void> {
    this.disposed += 1
    if (this.disposeFails) throw new Error('the engine did not confirm cleanup')
  }

  records(): readonly object[] { return this.recordsList }

  text(messageId: string, text: string): void {
    for (const listener of this.listeners) {
      listener({ sessionId: this.id, agentPath: [], kind: 'text_delta', messageId, text })
    }
  }

  userMessage(inputId: string, text: string, turnId?: string): void {
    const seq = this.seq++
    this.recordsList.push({ sessionId: this.id, agentPath: [], seq, receivedAt: 0, kind: 'frame',
      ...(turnId === undefined ? {} : { spanId: turnId }),
      body: { type: 'user', native: { type: 'user', uuid: inputId },
        events: [{ kind: 'user_message', input: text, inputId, evidence: 'acknowledged',
          ...(turnId === undefined ? {} : { turnId }) }] } })
    this.wake()
  }

  claudeUserFrame(inputId: string): void {
    const seq = this.seq++
    this.recordsList.push({ sessionId: this.id, agentPath: [], seq, receivedAt: 0, kind: 'frame',
      body: { type: 'user', native: { type: 'user', uuid: inputId }, events: [] } })
    this.wake()
  }

  lifecycle(inputId: string, state: 'queued' | 'started' | 'completed' | 'cancelled'): void {
    const seq = this.seq++
    this.recordsList.push({ sessionId: this.id, agentPath: [], seq, receivedAt: 0, kind: 'frame',
      body: { type: 'command_lifecycle', native: { type: 'command_lifecycle', command_uuid: inputId, state }, events: [] } })
    this.wake()
  }

  result(outcome: TurnEnd['outcome'], inputIds: readonly string[] = [], turnId?: string): void {
    this.active = false
    const seq = this.seq++
    const inputId = inputIds[0]
    this.turnEnds.push({ seq, outcome, ...(inputId === undefined ? {} : { inputId }), inputIds })
    this.recordsList.push({ sessionId: this.id, agentPath: [], seq, receivedAt: 0, kind: 'frame',
      ...(turnId === undefined ? {} : { spanId: turnId }),
      body: { type: 'result', native: { type: 'result', ...(inputId === undefined ? {} : { user_message_uuid: inputId }),
        ...(inputIds.length === 0 ? {} : { user_message_uuids: inputIds }) },
      events: [{ kind: 'turn_ended', outcome, ...(inputId === undefined ? {} : { inputId }),
        ...(inputIds.length === 0 ? {} : { inputIds }) }] } })
    this.wake()
  }

  release(): void {
    this.active = false
    this.releasedOutcome = { kind: 'failed', failure: 'unknown' }
    const seq = this.seq++
    this.releasedSeq = seq
    this.recordsList.push({ sessionId: this.id, agentPath: [], seq, receivedAt: 0, kind: 'response',
      body: { kind: 'released' } })
    this.wake()
  }

  async awaitTurnEnd(afterSeq: number, inputId?: string): Promise<TurnEnd['outcome']> {
    for (;;) {
      const found = this.turnEnds.find(turn => turn.seq > afterSeq
        && (inputId === undefined || turn.inputIds.includes(inputId)))
      if (found !== undefined) return found.outcome
      if (this.releasedOutcome !== undefined && this.releasedSeq !== undefined && this.releasedSeq > afterSeq) {
        return this.releasedOutcome
      }
      await new Promise<void>(resolve => { this.wakeups.add(resolve) })
    }
  }

  private wake(): void {
    for (const resolve of this.wakeups) resolve()
    this.wakeups.clear()
  }
}

// The real subagent runtime validates the cwd before opening a session, so this
// must be a directory that exists on every lane — a literal '/tmp' is not one
// on the windows runner.
const request = (): ResolvedSubagentStartRequest => ({
  parent: { id: 'session:parent' },
  prompt: [{ type: 'text', text: 'do the task' }],
  cwd: tmpdir(),
  signal: new AbortController().signal,
}) as unknown as ResolvedSubagentStartRequest

const spec = (engine: 'codex' | 'claude'): WorkerRunSpec => ({ engine, env: {}, launchArgs: [] })

afterEach(() => {
  runtimeControl.session = undefined
  runtimeControl.awaitCalls = 0
})

describe('a running Worker with accepted steer input', () => {
  it('settles without waiting when no follow-up was submitted', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('codex'))
    session.text('answer', 'normal answer')
    session.result({ kind: 'completed' }, [session.initialInputId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
      output: [{ type: 'text', text: 'normal answer' }] })
  })

  it.each(['codex', 'claude'] as const)(
    'keeps an idle-before-settlement prompt in the same %s execution',
    async engineName => {
      const session = new FakeSession()
      runtimeControl.session = session
      const run = await startWorkerRun(request(), spec(engineName))
      const steerId = '00000000-0000-4000-8000-00000000000b'
      session.text('initial', 'initial answer')
      session.result({ kind: 'completed' }, [session.initialInputId])
      // The result has been recorded, but the runtime has not resumed and taken
      // its closing window yet. OAR sees an idle native session and prompts.
      const steered = await workerSteerOf(run)!('open one more turn', steerId)
      expect(steered).toMatchObject({ kind: 'submitted', landed: 'prompted' })
      session.text('follow-up', 'follow-up answer')
      session.result({ kind: 'completed' }, [steerId])
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
        output: [{ type: 'text', text: 'follow-up answer' }] })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'holds the %s closing window across durable steer admission', async engineName => {
      const session = new FakeSession()
      runtimeControl.session = session
      const run = await startWorkerRun(request(), spec(engineName))
      const control = workerSteerOf(run)!
      const releaseHold = control.hold!()
      expect(releaseHold).toBeTypeOf('function')
      session.text('initial', 'initial answer')
      session.result({ kind: 'completed' }, [session.initialInputId])
      // Let the monitor observe the initial ending while admission is still
      // pending. The hold keeps this execution open without sending early.
      await new Promise<void>(resolve => { setImmediate(resolve) })
      const steerId = '00000000-0000-4000-8000-00000000000c'
      await expect(control('open the admitted follow-up', steerId)).resolves.toMatchObject({
        kind: 'submitted', landed: 'prompted' })
      session.text('follow-up', 'follow-up answer')
      session.result({ kind: 'completed' }, [steerId])
      let settled = false
      void run.result.then(() => { settled = true })
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(settled).toBe(false)
      releaseHold!()
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
        output: [{ type: 'text', text: 'follow-up answer' }] })
    },
  )

  it.each(['codex', 'claude'] as const)(
    'settles %s when the accepted turn ends before deliver acknowledges it',
    async engineName => {
      const session = new FakeSession()
      runtimeControl.session = session
      const controller = new AbortController()
      const acknowledge = Promise.withResolvers<void>()
      const nativeDeliver = session.deliver.bind(session)
      vi.spyOn(session, 'deliver').mockImplementation(async (...args) => {
        const result = await nativeDeliver(...args)
        await acknowledge.promise
        return result
      })
      const run = await startWorkerRun({ ...request(), signal: controller.signal }, spec(engineName))
      const steerId = '00000000-0000-4000-8000-00000000000d'
      let settled: Awaited<typeof run.result> | undefined
      void run.result.then(result => { settled = result })
      try {
        await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(1) })
        const submitted = workerSteerOf(run)!('finish this turn with the extra check', steerId)
        session.text('answer', 'the extra check is complete')
        session.result({ kind: 'completed' }, [session.initialInputId, steerId])
        // Let the monitor consume the native ending while the delivery reply is held.
        await new Promise<void>(resolve => { setImmediate(resolve) })
        acknowledge.resolve()
        await expect(submitted).resolves.toMatchObject({ kind: 'submitted', landed: 'steered' })
        await vi.waitFor(() => {
          expect(settled).toMatchObject({ stopReason: 'completed',
            output: [{ type: 'text', text: 'the extra check is complete' }] })
        }, { timeout: 300 })
        expect(runtimeControl.awaitCalls).toBe(1)
      } finally {
        acknowledge.resolve()
        controller.abort()
        await run.dispose()
      }
    },
  )

  it('uses the acknowledged Codex turn when no follow-up input echo arrives', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const controller = new AbortController()
    vi.spyOn(session, 'steer').mockResolvedValue({ kind: 'accepted',
      response: { body: { kind: 'accepted', native: { turnId: 'shared-turn' } } } })
    const run = await startWorkerRun({ ...request(), signal: controller.signal }, spec('codex'))
    let settled: Awaited<typeof run.result> | undefined
    void run.result.then(result => { settled = result })
    try {
      const steered = await workerSteerOf(run)!('finish the shared turn', '00000000-0000-4000-8000-00000000000e')
      expect(steered).toMatchObject({ kind: 'submitted', turnId: 'shared-turn' })
      session.text('answer', 'shared turn complete')
      session.result({ kind: 'completed' }, [session.initialInputId], 'shared-turn')
      await vi.waitFor(() => {
        expect(settled).toMatchObject({ stopReason: 'completed',
          output: [{ type: 'text', text: 'shared turn complete' }] })
      }, { timeout: 300 })
    } finally {
      controller.abort()
      await run.dispose()
    }
  })

  it('does not claim ambiguous Codex root turns without owned input evidence', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('codex'))
    session.userMessage('unowned-input-one', 'another controller', 'unowned-turn-one')
    session.userMessage('unowned-input-two', 'another controller again', 'unowned-turn-two')
    session.release()
    const anchors = workerAnchorsOf(await run.result)
    expect(anchors?.nativeSessionId).toBe(session.id)
    expect(anchors?.nativeTurnId).toBeUndefined()
    expect(anchors?.nativeTurnIds).toBeUndefined()
    await run.dispose()
  })

  it('captures only input-proven Codex turns in a multi-turn execution', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('codex'))
    const steerId = '00000000-0000-4000-8000-00000000000f'
    await workerSteerOf(run)!('follow-up work', steerId)
    session.userMessage(session.initialInputId, 'initial work', 'owned-initial')
    session.userMessage(steerId, 'follow-up work', 'owned-follow-up')
    session.userMessage('external-input', 'external work', 'external-turn')
    session.result({ kind: 'completed' }, [session.initialInputId, steerId])
    expect(workerAnchorsOf(await run.result)?.nativeTurnIds).toEqual(['owned-initial', 'owned-follow-up'])
    await run.dispose()
  })

  it('waits for a Claude steer that opens the next native turn and keeps its answer', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    session.text('initial', 'initial answer')
    const steered = await workerSteerOf(run)!(
      'also check the second case', '00000000-0000-4000-8000-000000000001')
    expect(steered).toMatchObject({ kind: 'submitted' })
    session.lifecycle('00000000-0000-4000-8000-000000000001', 'queued')
    session.result({ kind: 'completed' }, [session.initialInputId])

    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(2) })
    session.lifecycle('00000000-0000-4000-8000-000000000001', 'started')
    session.text('follow-up', 'follow-up answer')
    session.result({ kind: 'completed' }, ['00000000-0000-4000-8000-000000000001'])

    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
      output: [{ type: 'text', text: 'follow-up answer' }] })
    expect(runtimeControl.awaitCalls).toBe(2)
    expect(session.steers[0]?.inputId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('does not mistake a native user-message echo for a finished follow-up turn', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    session.text('initial', 'initial answer')
    const steerId = '00000000-0000-4000-8000-000000000003'
    await workerSteerOf(run)?.('stay with this execution', steerId)
    session.userMessage(steerId, 'stay with this execution')
    session.result({ kind: 'completed' }, [session.initialInputId])
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(2) })
    session.text('follow-up', 'follow-up answer')
    session.result({ kind: 'completed' }, [steerId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
      output: [{ type: 'text', text: 'follow-up answer' }] })
  })

  it('uses the public Claude frame and result ids when steer has no input lifecycle projection', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    const steerId = '00000000-0000-4000-8000-000000000008'
    await workerSteerOf(run)!('stay with the same session', steerId)
    session.lifecycle(steerId, 'queued')
    session.result({ kind: 'completed' }, [session.initialInputId])
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(2) })
    session.lifecycle(steerId, 'started')
    session.claudeUserFrame(steerId)
    session.text('follow-up', 'the public frame carried the steer')
    session.result({ kind: 'completed' }, [steerId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
      output: [{ type: 'text', text: 'the public frame carried the steer' }] })
  })

  it('waits for every accepted follow-up in one execution and returns the last answer', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    const firstId = '00000000-0000-4000-8000-000000000004'
    const secondId = '00000000-0000-4000-8000-000000000005'
    await workerSteerOf(run)!('first follow-up', firstId)
    await workerSteerOf(run)!('second follow-up', secondId)
    session.result({ kind: 'completed' }, [session.initialInputId])
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(2) })
    session.text('first', 'first follow-up answer')
    session.result({ kind: 'completed' }, [firstId])
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(3) })
    session.text('second', 'second follow-up answer')
    session.result({ kind: 'completed' }, [secondId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed',
      output: [{ type: 'text', text: 'second follow-up answer' }] })
  })

  it('keeps a follow-up failure in the one final result', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    const steerId = '00000000-0000-4000-8000-000000000006'
    await workerSteerOf(run)!('try the follow-up', steerId)
    session.result({ kind: 'completed' }, [session.initialInputId])
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(2) })
    session.text('failed', 'partial follow-up answer')
    session.result({ kind: 'failed', failure: 'unknown' }, [steerId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error',
      output: [{ type: 'text', text: 'partial follow-up answer' }] })
  })

  it('settles the last follow-up when several completed before the monitor scanned them', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    const firstId = '00000000-0000-4000-8000-000000000009'
    const secondId = '00000000-0000-4000-8000-00000000000a'
    await workerSteerOf(run)!('first follow-up', firstId)
    await workerSteerOf(run)!('second follow-up', secondId)
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(1) })
    session.text('initial', 'initial answer')
    session.result({ kind: 'completed' }, [session.initialInputId])
    session.text('first', 'first answer')
    session.result({ kind: 'completed' }, [firstId])
    session.text('second', 'last partial answer')
    session.result({ kind: 'failed', failure: 'unknown' }, [secondId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error',
      output: [{ type: 'text', text: 'last partial answer' }] })
    expect(runtimeControl.awaitCalls).toBe(1)
  })

  it('settles with a failure when the native session cancels an accepted follow-up', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    const steerId = '00000000-0000-4000-8000-000000000007'
    await workerSteerOf(run)!('this input will be cancelled', steerId)
    session.lifecycle(steerId, 'cancelled')
    session.result({ kind: 'completed' }, [session.initialInputId])
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    await expect(run.result).resolves.toMatchObject({
      diagnostic: expect.stringContaining('cancelled an accepted follow-up') })
  })

  it('settles a released native session instead of waiting forever for an accepted follow-up', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const run = await startWorkerRun(request(), spec('claude'))
    const steerId = '00000000-0000-4000-8000-00000000000c'
    await workerSteerOf(run)!('this input may never receive a turn', steerId)
    session.release()
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('ended before confirming an accepted follow-up instruction')
  })

  it('lets a stop reclaim the execution while an accepted follow-up turn is pending', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const controller = new AbortController()
    const run = await startWorkerRun({ ...request(), signal: controller.signal }, spec('claude'))
    session.text('initial', 'partial answer')
    await workerSteerOf(run)!(
      'finish the next part', '00000000-0000-4000-8000-000000000002')
    session.lifecycle('00000000-0000-4000-8000-000000000002', 'queued')
    session.result({ kind: 'completed' }, [session.initialInputId])
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(2) })
    controller.abort()

    await expect(run.result).resolves.toEqual({ output: [{ type: 'text', text: 'partial answer' }],
      stopReason: 'aborted' })
    expect(session.disposed).toBeGreaterThan(0)
  })

  it.each(['completed', 'failed'] as const)('reports cleanup failure after a natural %s turn', async kind => {
    const session = new FakeSession()
    runtimeControl.session = session
    session.disposeFails = true
    const run = await startWorkerRun(request(), spec('codex'))
    session.text('answer', 'work before cleanup')
    session.result(kind === 'completed' ? { kind } : { kind, failure: 'unknown' }, [session.initialInputId])
    const result = await run.result
    expect(result).toMatchObject({ stopReason: 'error', output: [{ type: 'text', text: 'work before cleanup' }] })
    expect(result.diagnostic).toContain('engine may still be active')
    expect(session.disposed).toBe(1)
    await expect(run.dispose()).rejects.toThrow(/stage: dispose/)
  })

  it('bounds cleanup that never answers before releasing its terminal result', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    const gate = Promise.withResolvers<void>()
    vi.spyOn(session, 'dispose').mockImplementation(async () => { await gate.promise })
    const run = await startWorkerRun(request(), spec('codex'))
    let settled: Awaited<typeof run.result> | undefined
    void run.result.then(result => { settled = result })
    await vi.waitFor(() => { expect(runtimeControl.awaitCalls).toBe(1) })
    vi.useFakeTimers()
    try {
      session.text('answer', 'answer before stuck cleanup')
      session.result({ kind: 'completed' }, [session.initialInputId])
      await vi.advanceTimersByTimeAsync(5_001)
      expect(settled).toMatchObject({ stopReason: 'error',
        output: [{ type: 'text', text: 'answer before stuck cleanup' }],
        diagnostic: expect.stringContaining('engine may still be active') })
      await expect(run.dispose()).rejects.toThrow(/stage: dispose/)
    } finally {
      gate.resolve()
      vi.useRealTimers()
    }
  })

  it('reports a timeout, partial output, and unconfirmed cleanup together', async () => {
    const session = new FakeSession()
    runtimeControl.session = session
    session.disposeFails = true
    const run = await startWorkerRun(request(), { ...spec('codex'), timeoutMs: 10 })
    session.text('partial', 'work before the timeout')
    const result = await run.result
    expect(result).toMatchObject({ stopReason: 'error', output: [{ type: 'text', text: 'work before the timeout' }] })
    expect(result.diagnostic).toContain('exceeded its execution timeout')
    expect(result.diagnostic).toContain('engine may still be active')
    await expect(run.dispose()).rejects.toThrow(/stage: dispose/)
  })
})
