import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { teamTools } from './render-text.ts'

/**
 * Execution-level tests for the Task accountability surface: the parameters a
 * model passes must reach the Host request unchanged (branded, and only where
 * the action accepts them), and the tool must not re-derive an authority the
 * Host already owns. Renders are covered in `team-tools-render.spec.ts`; these
 * lock the call shape between the tool and the Host.
 */

const THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb'
const SOURCE = 'thread:aaaa1111-0000-4000-8000-000000000001'
const TASK = 'task:3245ad40-43fd-4191-a416-7dcaf3a340f2'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const OWNER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'
const REVIEWER = 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5'

interface FakeTask {
  taskRef: string
  projectRef: string
  threadRef: string
  status: string
  resolution: string
  accountable: string
  sourceThreadRefs: string[]
}

function task(overrides: Partial<FakeTask> = {}): FakeTask {
  return { taskRef: TASK, projectRef: PROJECT, threadRef: THREAD, status: 'in_review', resolution: 'open',
    accountable: OWNER, sourceThreadRefs: [], ...overrides }
}

/** The Host surface these actions touch, recorded so the assertion is on the request the tool built. */
function fakeHost(overrides: Record<string, unknown> = {}) {
  const host = {
    workspacesForAgent: () => [{ workspaceId: 'workspace:alpha', path: undefined, default: true }],
    humanHandle: () => 'human',
    members: () => [
      { member: { memberId: OWNER, handle: 'Tars' } },
      { member: { memberId: REVIEWER, handle: 'Cole' } },
    ],
    listClaimsForAgent: () => ({ task: task(), thread: { threadRef: THREAD, taskRef: TASK, revision: 9100 }, claims: [] }),
    startThreadForAgent: vi.fn(async (_agent: unknown, request: Record<string, unknown>) => ({
      kind: 'committed',
      receipt: { occurredAt: '2026-10-25T03:00:00.000Z' },
      message: { messageRef: 'message:anchor' },
      thread: { threadRef: THREAD, taskRef: TASK, revision: 9100 },
      task: task({ status: 'todo', resolution: 'open', ...(request.accountable === undefined ? {} : { accountable: request.accountable as string }),
        ...(request.sourceThreadRefs === undefined ? {} : { sourceThreadRefs: request.sourceThreadRefs as string[] }) }),
      attention: [],
      directMarkers: [],
    })),
    transferTaskForAgent: vi.fn(async (_agent: unknown, request: Record<string, unknown>) => ({
      kind: 'committed',
      receipt: { occurredAt: '2026-10-25T03:00:00.000Z' },
      activity: { activityRef: 'activity:transfer', kind: 'transfer', taskRef: TASK, threadRef: THREAD, actor: OWNER,
        from: OWNER, to: request.target, sequence: 9101 },
      task: task({ accountable: request.target as string }),
      thread: { threadRef: THREAD, taskRef: TASK, revision: 9101 },
    })),
    changeTaskForAgent: vi.fn(async (_agent: unknown, request: Record<string, unknown>) => ({
      kind: 'committed',
      receipt: { occurredAt: '2026-10-25T03:00:00.000Z' },
      activity: { activityRef: 'activity:accept', kind: request.action, taskRef: TASK, threadRef: THREAD, actor: OWNER,
        acceptedClaimRefs: ['claim:7ad04d38-3889-4414-ac0c-23f73c0b962a'], sequence: 9101 },
      task: task({ status: 'done', resolution: 'accepted' }),
      thread: { threadRef: THREAD, taskRef: TASK, revision: 9101 },
      claims: [],
    })),
    ...overrides,
  }
  return host
}

/** One tool call against a fake Host: the real `defineTool` wrapper validates the arguments first. */
async function call(tool: ToolDefinition, args: Record<string, unknown>, host: ReturnType<typeof fakeHost>): Promise<unknown> {
  const agent = { id: 'agent:tool-test', ctx: { get: (name: string) => name === 'agentTeam' ? host : undefined } }
  return tool.execute(args, { agent, callId: 'call:1', signal: new AbortController().signal } as never)
}

describe('team_message start passes Task accountability through', () => {
  it('forwards accountable and sourceThreadRefs to the Host request', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_message')!, { action: 'start', kind: 'task', projectRef: PROJECT, body: 'x',
      accountable: REVIEWER, sourceThreadRefs: [SOURCE] }, host)
    expect(host.startThreadForAgent).toHaveBeenCalledTimes(1)
    const request = host.startThreadForAgent.mock.calls[0]![1]
    expect(request).toMatchObject({ kind: 'task', projectRef: PROJECT, accountable: REVIEWER, sourceThreadRefs: [SOURCE] })
    // The result carries accountability back, so the caller need not re-read the Task.
    expect(result).toMatchObject({ kind: 'committed', accountable: REVIEWER, sourceThreadRefs: [SOURCE] })
  })

  it('resolves the Human by role, because member:human is on no roster', async () => {
    const host = fakeHost()
    await call(teamTools().get('team_message')!, { action: 'start', kind: 'task', projectRef: PROJECT, body: 'x', accountable: 'human' }, host)
    expect(host.startThreadForAgent.mock.calls[0]![1]).toMatchObject({ accountable: 'member:human' })
  })

  it('refuses accountable and sourceThreadRefs on a discussion start instead of dropping them', async () => {
    const host = fakeHost()
    await expect(call(teamTools().get('team_message')!, { action: 'start', projectRef: PROJECT, body: 'x', accountable: REVIEWER }, host))
      .rejects.toThrow(/start \(discussion\) does not accept accountable/)
    await expect(call(teamTools().get('team_message')!, { action: 'start', projectRef: PROJECT, body: 'x', sourceThreadRefs: [SOURCE] }, host))
      .rejects.toThrow(/start \(discussion\) does not accept sourceThreadRefs/)
    expect(host.startThreadForAgent).not.toHaveBeenCalled()
  })

  it('refuses the Task-only fields on post and reply', async () => {
    const host = fakeHost()
    await expect(call(teamTools().get('team_message')!, { action: 'post', projectRef: PROJECT, body: 'x', accountable: REVIEWER }, host))
      .rejects.toThrow(/post does not accept accountable/)
    await expect(call(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 9100, body: 'x', sourceThreadRefs: [SOURCE] }, host))
      .rejects.toThrow(/reply does not accept sourceThreadRefs/)
  })
})

describe('team_task transfer', () => {
  it('sends target and the write token to the Host and reports the responsibility change', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_task')!, { action: 'transfer', taskRef: TASK, target: REVIEWER, baseRevision: 9100 }, host)
    expect(host.transferTaskForAgent.mock.calls[0]![1]).toMatchObject({ taskRef: TASK, target: REVIEWER, baseRevision: 9100 })
    expect(result).toMatchObject({ kind: 'committed', action: 'transfer', accountable: REVIEWER, from: OWNER, to: REVIEWER })
  })

  it('returns responsibility to the Human when target names them by role', async () => {
    const host = fakeHost()
    await call(teamTools().get('team_task')!, { action: 'transfer', taskRef: TASK, target: 'human', baseRevision: 9100 }, host)
    expect(host.transferTaskForAgent.mock.calls[0]![1]).toMatchObject({ target: 'member:human' })
  })

  it('resolves an @Handle to the Member ref, because a model reads handles and the ledger resolves refs', async () => {
    const host = fakeHost()
    await call(teamTools().get('team_task')!, { action: 'transfer', taskRef: TASK, target: '@Cole', baseRevision: 9100 }, host)
    expect(host.transferTaskForAgent.mock.calls[0]![1]).toMatchObject({ target: REVIEWER })
  })

  it('requires a target and rejects the Claim parameters a transfer never takes', async () => {
    const host = fakeHost()
    await expect(call(teamTools().get('team_task')!, { action: 'transfer', taskRef: TASK, baseRevision: 9100 }, host))
      .rejects.toThrow(/transfer needs target/)
    await expect(call(teamTools().get('team_task')!, { action: 'transfer', taskRef: TASK, target: REVIEWER, baseRevision: 9100, claimRef: 'claim:x' }, host))
      .rejects.toThrow(/transfer does not accept claimRef/)
    expect(host.transferTaskForAgent).not.toHaveBeenCalled()
  })

  it('refuses target on promote, which creates a Task rather than moving one', async () => {
    const host = fakeHost()
    await expect(call(teamTools().get('team_task')!, { action: 'promote', threadRef: THREAD, baseRevision: 9100, target: REVIEWER }, host))
      .rejects.toThrow(/promote does not accept target/)
    expect(host.transferTaskForAgent).not.toHaveBeenCalled()
  })

  it('refuses target on every other Task action', async () => {
    const host = fakeHost()
    await expect(call(teamTools().get('team_task')!, { action: 'list', taskRef: TASK, target: REVIEWER }, host))
      .rejects.toThrow(/list does not accept target/)
    await expect(call(teamTools().get('team_task')!, { action: 'accept', taskRef: TASK, baseRevision: 9100, target: REVIEWER }, host))
      .rejects.toThrow(/accept does not accept target/)
    expect(host.changeTaskForAgent).not.toHaveBeenCalled()
  })
})

describe('team_task resolution actions', () => {
  it('routes accept, close and reopen to the Agent Host method with the action intact', async () => {
    for (const action of ['accept', 'close', 'reopen'] as const) {
      const host = fakeHost()
      await call(teamTools().get('team_task')!, { action, taskRef: TASK, baseRevision: 9100 }, host)
      expect(host.changeTaskForAgent.mock.calls[0]![1]).toMatchObject({ action, taskRef: TASK, baseRevision: 9100 })
    }
  })

  it('a committed acceptance names the Claims it concluded', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_task')!, { action: 'accept', taskRef: TASK, baseRevision: 9100 }, host)
    expect(result).toMatchObject({ kind: 'committed', action: 'accept', status: 'done', resolution: 'accepted',
      acceptedClaimRefs: ['claim:7ad04d38-3889-4414-ac0c-23f73c0b962a'] })
  })

  it('rejects the Claim parameters a resolution never takes', async () => {
    const host = fakeHost()
    await expect(call(teamTools().get('team_task')!, { action: 'close', taskRef: TASK, baseRevision: 9100, claimRef: 'claim:x' }, host))
      .rejects.toThrow(/close does not accept claimRef/)
    expect(host.changeTaskForAgent).not.toHaveBeenCalled()
  })

  it('adds the Task state and the way out to a self-acceptance refusal the Host only verdicts', async () => {
    const host = fakeHost({
      changeTaskForAgent: vi.fn(async () => { throw new Error('An Agent who held any Claim cannot accept this Task (self_acceptance_forbidden) — transfer it or ask the Human to verify') }),
    })
    const refusal = await call(teamTools().get('team_task')!, { action: 'accept', taskRef: TASK, baseRevision: 9100 }, host)
      .then(() => { throw new Error('the refusal was not thrown') }, (error: Error) => error)
    expect(refusal.message).toContain('self_acceptance_forbidden')
    // The ledger supplies the verdict and the way out; the tool adds only what
    // it alone can read after the refusal — the Task as it now stands.
    expect(refusal.message).toContain(`Currently ${TASK} is in_review, accountable to @Tars (${OWNER}).`)
  })

  it('names the accountable owner in an accountable_owner_required refusal', async () => {
    const host = fakeHost({
      changeTaskForAgent: vi.fn(async () => { throw new Error('Only the accountable owner can close this Task (accountable_owner_required) — transfer it first or ask the Human') }),
    })
    const refusal = await call(teamTools().get('team_task')!, { action: 'close', taskRef: TASK, baseRevision: 9100 }, host)
      .then(() => { throw new Error('the refusal was not thrown') }, (error: Error) => error)
    expect(refusal.message).toContain('accountable_owner_required')
    expect(refusal.message).toContain(`Currently ${TASK} is in_review, accountable to @Tars (${OWNER}).`)
  })

  it('leaves every other Host refusal exactly as the Host wrote it', async () => {
    const host = fakeHost({
      changeTaskForAgent: vi.fn(async () => { throw new Error('Task is already closed') }),
    })
    await expect(call(teamTools().get('team_task')!, { action: 'close', taskRef: TASK, baseRevision: 9100 }, host)).rejects.toThrow(/^Task is already closed$/)
  })
})
