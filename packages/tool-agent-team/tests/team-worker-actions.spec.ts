import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renderText, teamTools } from './render-text.ts'

/**
 * Execution-level tests for `team_worker`'s four call shapes: one delegation, one
 * stop, one diagnostic read, and one native-session steer share the tool
 * but never a request. A stop and an inspect are each a ref alone, and a steer is
 * one ref plus its instruction, so a half-filled start can never be read as any of
 * them, and the Host entry points stay distinct: none can smuggle a task, target,
 * engine, or directory.
 */

const PROJECT = 'project:00000000-0000-4000-8000-000000000001'
const WORKER = 'worker:00000000-0000-4000-8000-000000000002'
const CWD = '/tmp/worker'

function run(overrides: Record<string, unknown> = {}) {
  return {
    workerRef: WORKER, projectRef: PROJECT, engine: 'codex', state: 'running',
    startedAt: '2026-11-09T07:00:00.000Z', cwd: CWD, initiatedBy: 'member:owner',
    ...overrides,
  }
}

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    workerRef: WORKER, projectRef: PROJECT, engine: 'codex', state: 'failed', unconfirmed: false,
    startedAt: '2026-11-09T07:00:00.000Z', settledAt: '2026-11-09T07:10:00.000Z',
    summary: 'Team Worker failure (stage: turn; category: unknown).',
    stage: 'turn',
    native: { threadId: 'native-thread', turnId: 'native-turn',
      turnIds: ['native-turn', 'native-steer'], inputIds: ['native-turn', 'native-steer'],
      storage: '/tmp/home/sessions/2026/11/09/rollout-x.jsonl' },
    history: { kind: 'read', withheld: 0, truncated: false, fragments: [
      { kind: 'session', text: 'Native session record: engine 0.167.0' },
      { kind: 'failure', text: 'Native turn failed after 15674 ms: unexpected status 401 Unauthorized' },
    ] },
    ...overrides,
  }
}

function steered(overrides: Record<string, unknown> = {}) {
  return { workerRef: WORKER, engine: 'codex', state: 'submitted', turnId: 'native-turn', runState: 'running', ...overrides }
}

function fakeHost() {
  return {
    workerStartForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => run()),
    workerStopForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => run({
      state: 'stopped', settledAt: '2026-11-09T07:10:00.000Z',
    })),
    workerInspectForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => inspection()),
    workerSteerForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => steered()),
  }
}

async function call(tool: ToolDefinition, args: Record<string, unknown>, host: ReturnType<typeof fakeHost>, callId = 'call:1'): Promise<unknown> {
  const agent = { id: 'agent:tool-test', ctx: { get: (name: string) => name === 'agentTeam' ? host : undefined } }
  return tool.execute(args, { agent, callId, signal: new AbortController().signal } as never)
}

const tool = teamTools().get('team_worker')!

describe('team_worker starts with a task', () => {
  it('passes the delegation through and never invents a stop', async () => {
    const host = fakeHost()
    const result = await call(tool, { task: 'fix the parser', threadRef: 'thread:00000000-0000-4000-8000-000000000003', engine: 'claude', cwd: CWD }, host)
    expect(host.workerStartForAgent).toHaveBeenCalledTimes(1)
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerStartForAgent.mock.calls[0]![1]).toMatchObject({ task: 'fix the parser',
      threadRef: 'thread:00000000-0000-4000-8000-000000000003', engine: 'claude', cwd: CWD })
    expect(result).toMatchObject({ workerRef: WORKER, state: 'running', engine: 'codex', cwd: CWD })
  })

  it('refuses a start with no task instead of opening an empty run', async () => {
    const host = fakeHost()
    await expect(call(tool, { threadRef: 'thread:00000000-0000-4000-8000-000000000003' }, host))
      .rejects.toThrow(/needs a task to start/)
    expect(host.workerStartForAgent).not.toHaveBeenCalled()
  })
})

describe('team_worker stops with a ref alone', () => {
  it('calls only the stop entry with the ref, carrying no start fields', async () => {
    const host = fakeHost()
    const result = await call(tool, { stop: WORKER }, host)
    expect(host.workerStartForAgent).not.toHaveBeenCalled()
    expect(host.workerStopForAgent).toHaveBeenCalledTimes(1)
    // The Host entry takes the ref and nothing else: a start parameter cannot ride a stop.
    expect(host.workerStopForAgent.mock.calls[0]![1]).toEqual({ workerRef: WORKER })
    expect(result).toEqual({ workerRef: WORKER, state: 'stopped', engine: 'codex', settledAt: '2026-11-09T07:10:00.000Z' })
  })

  it('refuses a call that mixes a ref with any start parameter', async () => {
    for (const extra of [
      { task: 'also do this' }, { threadRef: 'thread:00000000-0000-4000-8000-000000000003' },
      { taskRef: 'task:00000000-0000-4000-8000-000000000004' }, { projectRef: PROJECT },
      { engine: 'claude' }, { cwd: CWD }, { requestId: 'request:1' },
    ]) {
      const host = fakeHost()
      await expect(call(tool, { stop: WORKER, ...extra }, host)).rejects.toThrow(/either a task to start or a stop ref/)
      expect(host.workerStartForAgent).not.toHaveBeenCalled()
      expect(host.workerStopForAgent).not.toHaveBeenCalled()
    }
  })

  it('returns the state the engine confirmed, not a guessed stop', async () => {
    const host = fakeHost()
    host.workerStopForAgent.mockResolvedValueOnce(run({ state: 'completed', settledAt: '2026-11-09T07:05:00.000Z' }))
    const result = await call(tool, { stop: WORKER }, host)
    expect(result).toMatchObject({ workerRef: WORKER, state: 'completed' })
  })

  it('says cleanup only for a confirmed stop, and reports an earlier ending as it was', async () => {
    const host = fakeHost()
    const stopped = await call(tool, { stop: WORKER }, host)
    const confirmed = renderText(tool, { stop: WORKER }, stopped)
    expect(confirmed).toContain('confirmed this run\'s cleanup')
    expect(confirmed).not.toContain('already ended')

    host.workerStopForAgent.mockResolvedValueOnce(run({ state: 'failed', settledAt: '2026-11-09T07:05:00.000Z',
      diagnostic: 'The engine may still be active; check it before starting another task.' }))
    const ended = await call(tool, { stop: WORKER }, host)
    // The receipt carries the Host's sentence, not just the state: a cleanup
    // warning is the one thing the model has to act on.
    expect(ended).toMatchObject({ state: 'failed', diagnostic: 'The engine may still be active; check it before starting another task.' })
    const receipt = renderText(tool, { stop: WORKER }, ended)
    expect(receipt).toContain('The run ended as failed; this stop did not change its ending.')
    expect(receipt).toContain('The engine may still be active; check it before starting another task.')
    expect(receipt).not.toContain('confirmed this run\'s cleanup')
  })

  it('passes the Host refusal through unchanged', async () => {
    const host = fakeHost()
    host.workerStopForAgent.mockRejectedValueOnce(new Error('Only the Member who delegated Worker or the Human may stop it.'))
    await expect(call(tool, { stop: WORKER }, host)).rejects.toThrow(/Only the Member who delegated/)
  })
})

describe('team_worker inspects with a ref alone', () => {
  it('calls only the inspect entry with the ref, carrying no start fields', async () => {
    const host = fakeHost()
    const result = await call(tool, { inspect: WORKER }, host)
    expect(host.workerStartForAgent).not.toHaveBeenCalled()
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerInspectForAgent).toHaveBeenCalledTimes(1)
    expect(host.workerInspectForAgent.mock.calls[0]![1]).toEqual({ workerRef: WORKER })
    expect(result).toMatchObject({ mode: 'inspect', workerRef: WORKER, state: 'failed', stage: 'turn',
      nativeThreadId: 'native-thread', nativeTurnId: 'native-turn', nativeRecord: 'read' })
    expect(result).toMatchObject({ nativeTurnIds: ['native-turn', 'native-steer'],
      nativeInputIds: ['native-turn', 'native-steer'] })
  })

  it('renders the summary, the native identities, and the fragments it could read', async () => {
    const host = fakeHost()
    const report = renderText(tool, { inspect: WORKER }, await call(tool, { inspect: WORKER }, host))
    expect(report).toContain('Summary: Team Worker failure (stage: turn; category: unknown).')
    expect(report).toContain('Failed at: turn')
    expect(report).toContain('Native thread: native-thread')
    expect(report).toContain('Native turn: native-turn')
    expect(report).toContain('Native turns: native-turn, native-steer')
    expect(report).toContain('Native inputs: native-turn, native-steer')
    expect(report).toContain('- failure: Native turn failed after 15674 ms: unexpected status 401 Unauthorized')
  })

  it('bounds native identity lists without crowding out the diagnostic', async () => {
    const host = fakeHost()
    const ids = Array.from({ length: 128 }, (_, index) => `${index}:` + 'x'.repeat(250))
    host.workerInspectForAgent.mockResolvedValueOnce(inspection({
      native: { threadId: 'native-thread', turnIds: ids, inputIds: ids },
    }))
    const result = await call(tool, { inspect: WORKER }, host)
    const report = renderText(tool, { inspect: WORKER }, result)
    expect(report.length).toBeLessThan(6_000)
    expect(report).toContain(ids[0])
    expect(report).toContain('retained ids omitted')
    expect(report).toContain('Native turn failed after 15674 ms: unexpected status 401 Unauthorized')
  })

  it('keeps the Team summary and names the reason when no native record answers', async () => {
    const host = fakeHost()
    host.workerInspectForAgent.mockResolvedValueOnce(inspection({ stage: 'installation', native: {},
      history: { kind: 'unpersisted', reason: 'The run ended before the engine opened a session.' } }))
    const result = await call(tool, { inspect: WORKER }, host)
    expect(result).toMatchObject({ nativeRecord: 'unpersisted', nativeReason: 'The run ended before the engine opened a session.' })
    const report = renderText(tool, { inspect: WORKER }, result)
    expect(report).toContain('Summary: Team Worker failure')
    expect(report).toContain('No native fragment to show: The run ended before the engine opened a session.')
  })

  it('refuses a look-up that mixes the ref with any start parameter', async () => {
    for (const extra of [
      { task: 'also do this' }, { threadRef: 'thread:00000000-0000-4000-8000-000000000003' },
      { taskRef: 'task:00000000-0000-4000-8000-000000000004' }, { projectRef: PROJECT },
      { engine: 'claude' }, { cwd: CWD }, { requestId: 'request:1' },
    ]) {
      const host = fakeHost()
      await expect(call(tool, { inspect: WORKER, ...extra }, host)).rejects.toThrow(/either a task to start or an inspect ref/)
      expect(host.workerInspectForAgent).not.toHaveBeenCalled()
      expect(host.workerStartForAgent).not.toHaveBeenCalled()
    }
  })

  it('refuses a call that names both a stop and an inspect', async () => {
    const host = fakeHost()
    await expect(call(tool, { stop: WORKER, inspect: WORKER }, host)).rejects.toThrow(/pass stop or inspect, not both/)
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerInspectForAgent).not.toHaveBeenCalled()
  })

  it('passes the Host refusal through unchanged', async () => {
    const host = fakeHost()
    host.workerInspectForAgent.mockRejectedValueOnce(new Error('Only the Member who delegated Worker may read its diagnostic.'))
    await expect(call(tool, { inspect: WORKER }, host)).rejects.toThrow(/Only the Member who delegated/)
  })
})

describe('team_worker steers a live run with one instruction', () => {
  it('calls only the steer entry, with the ref and the instruction, and no start field', async () => {
    const host = fakeHost()
    const result = await call(tool, { steer: WORKER, instruction: 'also update the changelog' }, host)
    expect(host.workerStartForAgent).not.toHaveBeenCalled()
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerInspectForAgent).not.toHaveBeenCalled()
    expect(host.workerSteerForAgent).toHaveBeenCalledTimes(1)
    expect(host.workerSteerForAgent.mock.calls[0]![1]).toMatchObject({
      workerRef: WORKER, instruction: 'also update the changelog' })
    // The tool derives the Host's idempotency key from this call, never from the
    // instruction text: a resend of the same call answers with the first receipt.
    expect(host.workerSteerForAgent.mock.calls[0]![1]).toMatchObject({ requestId: 'agent-team:tool:agent:tool-test:call:1' })
    expect(result).toMatchObject({ mode: 'steer', workerRef: WORKER, state: 'submitted', turnId: 'native-turn', runState: 'running' })
  })

  it('says submitted, never that the model read it, and names the turn the engine acknowledged', async () => {
    const host = fakeHost()
    const receipt = renderText(tool, { steer: WORKER, instruction: 'also update the changelog' },
      await call(tool, { steer: WORKER, instruction: 'also update the changelog' }, host))
    expect(receipt).toContain('native session accepted the instruction into this execution')
    expect(receipt).toContain('Turn: native-turn')
    expect(receipt).toContain('submitted, not confirmed read')
    expect(receipt).not.toContain('may never have been read')
  })

  it('returns the new worker ref when an ended execution is continued', async () => {
    const host = fakeHost()
    const nextWorker = 'worker:00000000-0000-4000-8000-000000000099'
    host.workerSteerForAgent.mockResolvedValueOnce(steered({ workerRef: nextWorker, state: 'started',
      continuedFrom: WORKER, turnId: undefined }))
    const result = await call(tool, { steer: WORKER, instruction: 'continue the work' }, host)
    expect(result).toMatchObject({ mode: 'steer', workerRef: nextWorker, state: 'started', continuedFrom: WORKER })
    const receipt = renderText(tool, { steer: WORKER, instruction: 'continue the work' }, result)
    expect(receipt).toContain(`New Worker: ${nextWorker}`)
    expect(receipt).toContain('started a new execution in the same native session')
    expect(receipt).toContain('submitted, not confirmed read')
  })

  it('repeats the run state when a stop landed while the answer was written', async () => {
    const host = fakeHost()
    host.workerSteerForAgent.mockResolvedValueOnce(steered({ runState: 'stopping', turnId: undefined }))
    const receipt = renderText(tool, { steer: WORKER, instruction: 'hurry' },
      await call(tool, { steer: WORKER, instruction: 'hurry' }, host))
    expect(receipt).toContain('By the time this answer was written the run was stopping')
    expect(receipt).not.toContain('Turn:')
  })

  it('refuses an instruction with no run, and a run with no instruction', async () => {
    const host = fakeHost()
    await expect(call(tool, { instruction: 'do more' }, host)).rejects.toThrow(/takes instruction only with steer/)
    await expect(call(tool, { steer: WORKER }, host)).rejects.toThrow(/needs the instruction to add/)
    await expect(call(tool, { steer: WORKER, instruction: '   ' }, host)).rejects.toThrow(/needs the instruction to add/)
    expect(host.workerSteerForAgent).not.toHaveBeenCalled()
  })

  it('refuses a steer that mixes the ref with a start field', async () => {
    for (const extra of [
      { task: 'also do this' }, { threadRef: 'thread:00000000-0000-4000-8000-000000000003' },
      { taskRef: 'task:00000000-0000-4000-8000-000000000004' }, { projectRef: PROJECT },
      { engine: 'claude' }, { cwd: CWD },
    ]) {
      const host = fakeHost()
      await expect(call(tool, { steer: WORKER, instruction: 'go on', ...extra }, host))
        .rejects.toThrow(/pass steer alone with instruction/)
      expect(host.workerSteerForAgent).not.toHaveBeenCalled()
      expect(host.workerStartForAgent).not.toHaveBeenCalled()
    }
  })

  it('refuses a call that names a steer beside a stop or an inspect', async () => {
    for (const extra of [{ stop: WORKER }, { inspect: WORKER }]) {
      const host = fakeHost()
      await expect(call(tool, { steer: WORKER, instruction: 'go on', ...extra }, host))
        .rejects.toThrow(/pass steer, stop, or inspect — never two of them/)
      expect(host.workerSteerForAgent).not.toHaveBeenCalled()
      expect(host.workerStopForAgent).not.toHaveBeenCalled()
      expect(host.workerInspectForAgent).not.toHaveBeenCalled()
    }
  })

  it('passes the Host refusal through unchanged', async () => {
    const host = fakeHost()
    host.workerSteerForAgent.mockRejectedValueOnce(new Error("Only the Member who delegated Worker may add an instruction to it."))
    await expect(call(tool, { steer: WORKER, instruction: 'go on' }, host))
      .rejects.toThrow(/Only the Member who delegated/)
  })
})

describe('team_worker tolerates the blank slots a model fills instead of omitting', () => {
  it('starts when the model sends empty stop and inspect beside the task', async () => {
    const host = fakeHost()
    await call(tool, { task: 'fix the parser', threadRef: 'thread:00000000-0000-4000-8000-000000000003', stop: '', inspect: '' }, host)
    expect(host.workerStartForAgent).toHaveBeenCalledTimes(1)
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerInspectForAgent).not.toHaveBeenCalled()
    expect(host.workerSteerForAgent).not.toHaveBeenCalled()
  })

  it('stops when the model fills the start slots with blanks', async () => {
    const host = fakeHost()
    await call(tool, { stop: WORKER, task: '', threadRef: '', cwd: '', requestId: '', steer: '', inspect: '' }, host)
    expect(host.workerStopForAgent).toHaveBeenCalledTimes(1)
    expect(host.workerStartForAgent).not.toHaveBeenCalled()
    expect(host.workerStopForAgent.mock.calls[0]![1]).toMatchObject({ workerRef: WORKER })
  })

  it('steers when the model sends empty stop and inspect beside the steer ref', async () => {
    const host = fakeHost()
    await call(tool, { steer: WORKER, instruction: 'also update the changelog', stop: '', inspect: '' }, host)
    expect(host.workerSteerForAgent).toHaveBeenCalledTimes(1)
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerInspectForAgent).not.toHaveBeenCalled()
  })

  it('drops the engine default a model fills on a stop, but still refuses the other engine', async () => {
    const host = fakeHost()
    await call(tool, { stop: WORKER, engine: 'codex' }, host)
    expect(host.workerStopForAgent).toHaveBeenCalledTimes(1)
    const other = fakeHost()
    await expect(call(tool, { stop: WORKER, engine: 'claude' }, other)).rejects.toThrow(/pass stop alone/)
    expect(other.workerStopForAgent).not.toHaveBeenCalled()
  })

  it('still refuses a real second ref and a real start field', async () => {
    const host = fakeHost()
    await expect(call(tool, { stop: WORKER, inspect: WORKER }, host)).rejects.toThrow(/pass stop or inspect, not both/)
    await expect(call(tool, { stop: WORKER, task: 'fix the parser' }, host)).rejects.toThrow(/pass stop alone/)
    await expect(call(tool, { steer: WORKER, instruction: 'go on', inspect: WORKER }, host))
      .rejects.toThrow(/pass steer, stop, or inspect — never two of them/)
    expect(host.workerStopForAgent).not.toHaveBeenCalled()
    expect(host.workerSteerForAgent).not.toHaveBeenCalled()
  })
})
