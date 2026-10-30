import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { changeBaseline, nextChange } from './helpers/change-stream.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentTeamProjectRef, AgentTeamMemberActor, AgentTeamRequestId } from '../src/types.ts'

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
  provideQuietTokenMeter(ctx)
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx }
}

/** One durable, enabled Member in the project, added through the live ledger so the Host's own state carries it. */
async function addLiveMember(ctx: Context, projectRef: AgentTeamProjectRef, handle = 'reader'): Promise<AgentTeamMemberActor> {
  const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
  await ctx.agentTeam['ledger']!.addMember({
    requestId: requestId(`ledger-member-${memberId}`), workspaceId: alpha, handle, description: 'Reads work', presetId: 'team-member',
    projectRefs: [projectRef], actor: agentTeamHumanActor(),
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
    session: Session.create(SessionId('session:post-commit-delivery')),
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
    const warn = vi.spyOn(ctx.logger, 'warn')
    const info = vi.spyOn(ctx.logger, 'info')
    const project = await ctx.agentTeam.createProject({ requestId: requestId('wake-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, project.project.projectRef)
    const { agent, state } = wakeSeam()
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })
    const lines = (spy: typeof info): string[] => spy.mock.calls.map(args => String(args[0]))

    const waiter = nextChange(ctx.agentTeam)
    const before = ctx.agentTeam.status().sequence
    // The message commits durably; only the recipient's wake fails afterwards.
    const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('wake-fail'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: `@${member.handle} needs a look` })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    // Exactly one operation landed: the failure is not a second write or a rollback.
    expect(ctx.agentTeam.status().sequence).toBe(before + 1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    expect(state.calls).toHaveLength(0)
    // Client invalidation still reached the parked waiter for that same commit.
    expect(await waiter).toMatchObject({ version: sent.receipt.sequence })
    expect(await changeBaseline(ctx.agentTeam)).toMatchObject({ version: sent.receipt.sequence })

    // The failure names the business commit, the Member, the Session, and the
    // attempt it spent — and it never reads as a failed write.
    const failed = lines(warn).find(line => line.includes('Team Inbox notice delivery failed'))
    expect(failed).toBeDefined()
    expect(failed).toContain(`memberId '${member.memberId}'`)
    expect(failed).toContain("session 'session:post-commit-delivery'")
    expect(failed).toContain(`requestId '${sent.receipt.requestId}'`)
    expect(failed).toContain(`operationId '${sent.receipt.operationId}'`)
    expect(failed).toContain("operation 'team/thread-started'")
    expect(failed).toContain(`sequence ${sent.receipt.sequence}`)
    expect(failed).toContain('attempt 1')
    expect(failed).toContain('Error: wake failed (test seam)')
    expect(failed).toContain('committed and stands')
    // The precise line replaces the generic post-commit notice for this path,
    // and a failed delivery never reports a queued notice.
    expect(lines(warn).some(line => line.includes('post-commit notification'))).toBe(false)
    expect(lines(info).some(line => line.includes('Team Inbox notice queued'))).toBe(false)

    // The failed wake only cleared its own signature, so the next commit that
    // touches the Member rederives the same durable Inbox facts and delivers.
    state.fail = false
    const second = await ctx.agentTeam.reply({ requestId: requestId('wake-recover'), workspaceId: alpha,
      threadRef: sent.thread.threadRef, body: `@${member.handle} following up`, baseRevision: sent.thread.revision })
    expect(second.kind).toBe('committed')
    if (second.kind !== 'committed') return
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Team Inbox has unread work') })

    // The retry is the next attempt over the same Member and Session, under the
    // request that revealed the facts — the attempt is not a second request.
    const queued = lines(info).find(line => line.includes('Team Inbox notice queued'))
    expect(queued).toBeDefined()
    expect(queued).toContain('attempt 2')
    expect(queued).toContain(`memberId '${member.memberId}'`)
    expect(queued).toContain(`requestId '${second.receipt.requestId}'`)
    expect(queued).toContain('not yet read by the model')
    info.mockRestore()
    warn.mockRestore()
  })

  it('retries a failed wake over ordinary Thread unread alone, which no marker explains', async () => {
    const { ctx } = await harness()
    const info = vi.spyOn(ctx.logger, 'info')
    const project = await ctx.agentTeam.createProject({ requestId: requestId('ordinary-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const projectRef = project.project.projectRef
    const owner = await addLiveMember(ctx, projectRef, 'owner')
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('ordinary-owner'), workspaceId: alpha, projectRef, memberId: owner.memberId })
    const reader = await addLiveMember(ctx, projectRef, 'writer')
    const ledger = ctx.agentTeam['ledger']!
    const { agent, state } = wakeSeam()
    state.fail = false
    ctx.agentTeam['handles'].set(owner.memberId, { agent, dispose: async () => {} })
    const lines = (spy: typeof info): string[] => spy.mock.calls.map(args => String(args[0]))

    // The Human starts the Thread, so it belongs to nobody's Attention yet; the
    // owner's grant left it Main stream unread, which this read drains so the
    // Thread notice is the only thing the next wake has to carry.
    const drained = await ctx.agentTeam.readMainStream({ requestId: requestId('ordinary-drain'), workspaceId: alpha, projectRef })
    expect(drained.standing.unreadCount).toBe(0)
    const started = await ctx.agentTeam.startThread({ requestId: requestId('ordinary-start'), workspaceId: alpha, projectRef, kind: 'discussion', body: 'Plan the release' })
    if (started.kind !== 'committed') throw new Error('expected a started Thread')
    const followed = await ledger.changeAttention({ requestId: requestId('ordinary-follow'), actor: owner, workspaceId: alpha,
      threadRef: started.thread.threadRef, action: 'follow' })
    expect(followed.committed).toBe(true)
    state.calls.length = 0
    // Everything so far — the grant, the Thread start, the follow — is setup;
    // the notices this test counts start after it.
    const baseline = info.mock.calls.length

    // The reader's reply carries no mention, so the owner's unread is ordinary
    // work and nothing else.
    const replied = await ctx.agentTeam.reply({ requestId: requestId('ordinary-reply'), workspaceId: alpha,
      threadRef: started.thread.threadRef, baseRevision: started.thread.revision, body: 'First ordinary update' })
    if (replied.kind !== 'committed') throw new Error('expected a committed reply')
    expect(state.calls).toHaveLength(1)
    const notice = state.calls[0]!.content[0]
    expect(notice).toMatchObject({ type: 'text', text: expect.stringContaining('1 unread update') })
    // No direct marker is involved, so nothing in the notice quotes a body.
    expect(notice).not.toMatchObject({ text: expect.stringContaining('Direct Team mention') })

    // A second ordinary update on an unread Thread spends its own attempt: the
    // queued notice is replaced rather than stacked, so the count rises with
    // the commits that touched the Member and never with the facts themselves.
    const again = await ctx.agentTeam.reply({ requestId: requestId('ordinary-reply-2'), workspaceId: alpha,
      threadRef: started.thread.threadRef, baseRevision: replied.thread.revision, body: 'Second ordinary update' })
    if (again.kind !== 'committed') throw new Error('expected a committed reply')
    expect(state.calls).toHaveLength(2)
    const queued = lines(info).slice(baseline).filter(line => line.includes('Team Inbox notice queued'))
    expect(queued).toHaveLength(2)
    // The attempt count is the Member's own, carried across every commit that
    // touched it, so it keeps rising where the notice count starts fresh.
    expect(queued.map(line => /attempt (\d+)/.exec(line)?.[1])).toEqual(['2', '3'])
    // The reader is a Member who never followed the Thread, so nothing woke it.
    expect(ctx.agentTeam['handles'].get(reader.memberId)).toBeUndefined()
    expect(ledger.notificationFacts(reader.memberId)).toEqual([])
    info.mockRestore()
  })

  it('wakes a non-owner Main stream follower for ordinary updates', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('main-wake-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const follower = await addLiveMember(ctx, project.project.projectRef, 'follower')
    const ledger = ctx.agentTeam['ledger']!
    await ledger.changeAttention({ requestId: requestId('main-wake-follow'), workspaceId: alpha, projectRef: project.project.projectRef,
      action: 'follow', actor: follower })
    const { agent, state } = wakeSeam()
    state.fail = false
    ctx.agentTeam['handles'].set(follower.memberId, { agent, dispose: async () => {} })
    state.calls.length = 0

    const posted = await ctx.agentTeam.postMainMessage({ requestId: requestId('main-wake-post'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Ordinary Main update' })
    if (posted.kind !== 'committed') throw new Error('expected a committed Main stream post')
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Main stream: 1 unread update') })
  })

  it('spends no second attempt or log line on unread facts a later wake leaves unchanged', async () => {
    const { ctx } = await harness()
    const info = vi.spyOn(ctx.logger, 'info')
    const debug = vi.spyOn(ctx.logger, 'debug')
    const project = await ctx.agentTeam.createProject({ requestId: requestId('duplicate-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, project.project.projectRef)
    const { agent, state } = wakeSeam()
    state.fail = false
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })
    const lines = (spy: typeof info): string[] => spy.mock.calls.map(args => String(args[0]))

    const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('duplicate-send'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: `@${member.handle} needs a look` })
    expect(sent.kind).toBe('committed')
    expect(state.calls).toHaveLength(1)
    expect(lines(info).filter(line => line.includes('Team Inbox notice queued'))).toHaveLength(1)

    // A Member's own turn start re-runs the same wake over the same durable
    // facts: it spends no attempt, appends no notice, and logs no second line
    // above diagnostic level.
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(state.calls).toHaveLength(1)
    expect(lines(info).filter(line => line.includes('Team Inbox notice queued'))).toHaveLength(1)
    const skipped = lines(debug).find(line => line.includes('Team Inbox notice not attempted'))
    expect(skipped).toBeDefined()
    expect(skipped).toContain(`memberId '${member.memberId}'`)
    expect(skipped).toContain('already have a delivery attempt')
    info.mockRestore()
    debug.mockRestore()
  })

  it('answers with the committed result when a synchronous commit listener throws', async () => {
    const { ctx } = await harness()
    ctx.on('agent-team/committed', () => { throw new Error('listener failed (test seam)') })
    const project = await ctx.agentTeam.createProject({ requestId: requestId('listener-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    expect(project.project.projectRef).toBeDefined()
    expect(ctx.agentTeam.status().sequence).toBe(3)
  })

  it('keeps an invariant divergence loud on the caller frame instead of swallowing it', async () => {
    const { ctx } = await harness()
    ctx.on('agent-team/committed', () => { throw new agentTeamInvariant.AgentTeamInvariantError('projection diverged (test seam)') })
    await expect(ctx.agentTeam.createProject({ requestId: requestId('invariant-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' }))
      .rejects.toThrow(/invariant violated/)
    // The loud path still reports a real commit: the operation is durable.
    expect(ctx.agentTeam.status().sequence).toBe(3)
  })

  it('wakes a Member through its Main stream markers: a mention, and its own grant of ownership', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('main-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, project.project.projectRef)
    const { agent, state } = wakeSeam()
    state.fail = false
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })

    await ctx.agentTeam.addProjectOwner({ requestId: requestId('main-owner'), workspaceId: alpha, projectRef: project.project.projectRef, memberId: member.memberId })
    const owner = state.calls.at(-1)?.content[0]
    expect(owner).toMatchObject({ type: 'text', text: expect.stringContaining('made you an owner of Project engineering') })

    const posted = await ctx.agentTeam.postMainMessage({ requestId: requestId('main-post'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: `@${member.handle} over to you` })
    expect(posted.kind).toBe('committed')
    const mention = state.calls.at(-1)?.content[0]
    expect(mention).toMatchObject({ type: 'text', text: expect.stringContaining('Direct Main stream mention') })
    expect(mention).toMatchObject({ text: expect.stringContaining(`team_thread read with the relevant workspace and projectRef`) })
  })
  it('wakes the other owners for an ordinary Main stream post and a new discussion, never a new Task', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('owner-wake-project'), workspaceId: alpha, name: 'platform', description: 'Owner wake' })
    const projectRef = project.project.projectRef
    const member = await addLiveMember(ctx, projectRef)
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner-wake-owner'), workspaceId: alpha, projectRef, memberId: member.memberId })
    const { agent, state } = wakeSeam()
    state.fail = false
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })
    state.calls.length = 0

    const posted = await ctx.agentTeam.postMainMessage({ requestId: requestId('owner-wake-post'), workspaceId: alpha, projectRef, body: 'Ordinary owner-facing note' })
    expect(posted.kind).toBe('committed')
    const post = state.calls.at(-1)?.content[0]
    expect(post).toMatchObject({ type: 'text', text: expect.stringContaining('platform') })
    expect(post).toMatchObject({ text: expect.stringContaining('Main stream') })

    await ctx.agentTeam.startThread({ requestId: requestId('owner-wake-discussion'), workspaceId: alpha, projectRef, kind: 'discussion', body: 'Plan the retro' })
    const discussion = state.calls.at(-1)?.content[0]
    expect(discussion).toMatchObject({ type: 'text', text: expect.stringContaining('Plan the retro') })

    state.calls.length = 0
    await ctx.agentTeam.startThread({ requestId: requestId('owner-wake-task'), workspaceId: alpha, projectRef, kind: 'task', body: 'Build the gateway' })
    expect(state.calls).toEqual([])
  })

  it('wakes an owner for its own Thread\'s first ordinary update, because it follows the Thread it started', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('threshold-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const projectRef = project.project.projectRef
    const member = await addLiveMember(ctx, projectRef)
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('threshold-owner'), workspaceId: alpha, projectRef, memberId: member.memberId })
    const ledger = ctx.agentTeam['ledger']!
    await ledger.readMainStream({ requestId: requestId('threshold-read-grant'), actor: member, workspaceId: alpha, projectRef })
    const started = await ledger.startThread({ requestId: requestId('threshold-start'), actor: member, workspaceId: alpha, projectRef, kind: 'discussion', body: 'Plan the release' })
    if (started.value.kind !== 'committed') throw new Error('expected a started Thread')
    const { agent, state } = wakeSeam()
    state.fail = false
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })

    let revision = started.value.thread.revision
    const reply = async (index: number) => {
      const result = await ctx.agentTeam.reply({ requestId: requestId(`threshold-reply-${index}`), workspaceId: alpha, threadRef: started.value.thread.threadRef,
        body: `update ${index}`, baseRevision: revision })
      if (result.kind !== 'committed') throw new Error(`expected a committed reply, got ${result.kind}`)
      revision = result.thread.revision
    }
    await reply(1)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Your role: follower of this Thread') })
    await reply(2)
    expect(state.calls).toHaveLength(2)
  })
})
