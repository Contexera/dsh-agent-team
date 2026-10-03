import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { changeBaseline, nextChange } from './helpers/change-stream.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(): Promise<{ readonly ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx }
}

/** One durable, enabled Member in the channel, added through the live ledger so the Host's own state carries it. */
async function addLiveMember(ctx: Context, channelRef: AgentTeamChannelRef): Promise<AgentTeamMemberActor> {
  const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
  const handle = 'reader'
  await ctx.agentTeam['ledger']!.addMember({
    requestId: requestId(`ledger-member-${memberId}`), workspaceId: alpha, handle, description: 'Reads work', presetId: 'team-member',
    channelRefs: [channelRef], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle, description: 'Reads work',
      presetId: 'team-member', privateMemoryPath: '/tmp/reader', state: 'enabled' as const,
    },
  })
  return { kind: 'member', memberId, handle }
}

/**
 * One fake live Agent whose wake can be made to fail on demand. Only the
 * surface `notifyMember` touches is implemented; successful deliveries are
 * recorded so a test can prove the wake is re-derived later.
 */
function wakeSeam(): { readonly agent: Agent; readonly state: { fail: boolean; readonly calls: UserMessage[] } } {
  const state = { fail: true, calls: [] as UserMessage[] }
  const wake = (message: UserMessage): void => {
    if (state.fail) throw new Error('wake failed (test seam)')
    state.calls.push(message)
  }
  const agent = {
    id: SessionId('session:post-commit-delivery'),
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], remove: () => {} },
    steer: wake,
    followup: wake,
  } as unknown as Agent
  return { agent, state }
}

describe('post-commit delivery', () => {
  it('answers with the committed reply when the recipient wake fails, and re-derives the wake later', async () => {
    const { ctx } = await harness()
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('wake-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, channel.channel.channelRef)
    const { agent, state } = wakeSeam()
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })

    const waiter = nextChange(ctx.agentTeam)
    const before = ctx.agentTeam.status().sequence
    // The message commits durably; only the recipient's wake fails afterwards.
    const sent = await ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId('wake-fail'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Needs a look', recipients: [member.memberId] })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    // Exactly one operation landed: the failure is not a second write or a rollback.
    expect(ctx.agentTeam.status().sequence).toBe(before + 1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    expect(state.calls).toHaveLength(0)
    // Client invalidation still reached the parked waiter for that same commit.
    expect(await waiter).toMatchObject({ version: sent.receipt.sequence })
    expect(await changeBaseline(ctx.agentTeam)).toMatchObject({ version: sent.receipt.sequence })

    // The failed wake only cleared its own signature, so the next commit that
    // touches the Member rederives the same durable Inbox facts and delivers.
    state.fail = false
    const second = await ctx.agentTeam.reply({ requestId: requestId('wake-recover'), workspaceId: alpha,
      threadRef: sent.thread.threadRef, body: 'Following up', recipients: [member.memberId], baseRevision: sent.thread.revision })
    expect(second.kind).toBe('committed')
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Team Inbox has unread work') })
  })

  it('answers with the committed result when a synchronous commit listener throws', async () => {
    const { ctx } = await harness()
    ctx.on('agent-team/committed', () => { throw new Error('listener failed (test seam)') })
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('listener-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    expect(channel.channel.channelRef).toBeDefined()
    expect(ctx.agentTeam.status().sequence).toBe(2)
  })

  it('keeps an invariant divergence loud on the caller frame instead of swallowing it', async () => {
    const { ctx } = await harness()
    ctx.on('agent-team/committed', () => { throw new agentTeamInvariant.AgentTeamInvariantError('projection diverged (test seam)') })
    await expect(ctx.agentTeam.createChannel({ requestId: requestId('invariant-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering' }))
      .rejects.toThrow(/invariant violated/)
    // The loud path still reports a real commit: the operation is durable.
    expect(ctx.agentTeam.status().sequence).toBe(2)
  })
})
