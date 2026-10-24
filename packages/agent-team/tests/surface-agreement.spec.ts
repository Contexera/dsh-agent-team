import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentTeamProjectRef, AgentTeamMemberActor, AgentTeamRequestId } from '../src/types.ts'
import { isFactOnSurface } from '../src/surface-visibility.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'

/**
 * Project B's load-bearing agreement: the Host's real notice rendering and the
 * probe's notion of "the model saw this" must refer to the same bytes.
 *
 * The integration suite proves the gate honours the probe; the probe suite
 * proves the probe honours a body it is handed. Neither proves the two agree —
 * that a change to `notificationText` which stops carrying the body would
 * silently turn every direct mention into an unexempt write again. This suite
 * closes that gap by driving a real commit, capturing the notice the Host
 * actually rendered, and asking the real probe about the real unread facts.
 */

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

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
  provideQuietTokenMeter(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx }
}

/** One durable, enabled Member in the project, added through the live ledger. */
async function addLiveMember(ctx: Context, projectRef: AgentTeamProjectRef): Promise<AgentTeamMemberActor> {
  const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
  const handle = 'reader'
  await ctx.agentTeam['ledger']!.addMember({
    requestId: requestId(`ledger-member-${memberId}`), workspaceId: alpha, handle, description: 'Reads work', presetId: 'team-member',
    projectRefs: [projectRef], actor: agentTeamHumanActor(),
    member: { memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle, description: 'Reads work',
      presetId: 'team-member', privateMemoryPath: '/tmp/reader', state: 'enabled' as const },
  })
  return { kind: 'member', memberId, handle }
}

/** One fake live Agent whose wake records what the Host really delivered. */
function wakeSeam(): { readonly agent: Agent; readonly state: { readonly calls: UserMessage[] } } {
  const state = { calls: [] as UserMessage[] }
  const wake = (message: UserMessage): void => { state.calls.push(message) }
  const agent = { id: SessionId('session:agreement'), status: 'idle', inbox: { nextTurn: [], nextStep: [], remove: () => {} }, steer: wake, followup: wake } as unknown as Agent
  return { agent, state }
}

describe('the Host notice rendering and the probe agree on the same bytes', () => {
  it('a real direct-mention notice makes its own unread fact exempt', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, project.project.projectRef)
    const { agent, state } = wakeSeam()
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })

    // A real commit that names the Member, which is what makes the fact direct.
    const body = 'please review this before the release'
    const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('direct'), workspaceId: alpha,
      projectRef: project.project.projectRef, body, recipients: [member.memberId] })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    // The Host rendered and delivered one notice.
    expect(state.calls).toHaveLength(1)
    const noticeText = state.calls[0]!.content[0]
    expect(noticeText?.type).toBe('text')

    // The probe, asked about the real unread facts the gate would refuse over,
    // answers true for the fact whose body the notice carried.
    const unread = ctx.agentTeam['ledger']!.notificationFacts(member.memberId).flatMap(entry => entry.facts)
    expect(unread).toHaveLength(1)
    const text = noticeText!.type === 'text' ? noticeText!.text : ''
    expect(isFactOnSurface([text], unread[0]!)).toBe(true)
    // And the notice really does carry the body verbatim — the agreement is
    // about content, not about a marker that happens to be present.
    expect(text).toContain(body)
  })

  it('an ordinary notice carries no body, so its own fact stays unexempt', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, project.project.projectRef)
    const { agent, state } = wakeSeam()
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })

    // A commit that does not name the Member. An ordinary update only reaches a
    // Member who follows the Thread, so the Member is named once in the anchor
    // and then follows explicitly, and the update is ordinary.
    const anchor = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('anchor'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'anchor for the ordinary case', recipients: [member.memberId] })
    expect(anchor.kind).toBe('committed')
    if (anchor.kind !== 'committed') return
    await ctx.agentTeam['ledger']!.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, threadRef: anchor.thread.threadRef,
      action: 'follow', actor: { kind: 'member', memberId: member.memberId, handle: member.handle } })
    state.calls.length = 0
    // The update is an ordinary reply: it names nobody, so the notice's only
    // account of it is a count.
    const body = 'background note nobody was mentioned in'
    const sent = await ctx.agentTeam.reply({ requestId: requestId('ordinary'), workspaceId: alpha,
      threadRef: anchor.thread.threadRef, body, baseRevision: anchor.thread.revision })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    expect(state.calls).toHaveLength(1)

    // The Member now holds two unread facts: the anchor that named them (a
    // direct mention) and the ordinary reply that named nobody.
    const unread = ctx.agentTeam['ledger']!.notificationFacts(member.memberId).flatMap(entry => entry.facts)
    const ordinary = unread.filter(entry => !entry.direct)
    expect(ordinary).toHaveLength(1)
    // An ordinary notice renders a count and not one character of body, so the
    // probe correctly refuses to attest it and the write stays gated.
    const ordinaryText = 'Task task:abc: 1 unread update · newest at 2026-10-14T00:00:00.000Z.'
    const ordinaryBody = ordinary[0]!.fact.kind === 'message' ? ordinary[0]!.fact.message.body : ''
    expect(ordinaryText).not.toContain(ordinaryBody)
    expect(isFactOnSurface([ordinaryText], ordinary[0]!)).toBe(false)
  })
})
