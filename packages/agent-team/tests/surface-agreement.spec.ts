import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { harness as bootHostHarness } from './helpers/host-harness.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentTeamProjectRef, AgentTeamMemberActor, AgentTeamRequestId } from '../src/types.ts'
import { isFactOnSurface, visibleTeamSurface } from '../src/surface-visibility.ts'

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

const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

async function harness(): Promise<{ readonly ctx: Context }> {
  const { ctx } = await bootHostHarness()
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
      presetId: 'team-member', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: '/tmp/reader', state: 'enabled' as const },
   model: { provider: 'mock', model: 'mock' },})
  return { kind: 'member', memberId, handle }
}

/** One fake live Agent whose wake records what the Host really delivered. */
function wakeSeam(): { readonly agent: Agent; readonly state: { readonly calls: UserMessage[] } } {
  const state = { calls: [] as UserMessage[] }
  const session = Session.create(SessionId('session:agreement'))
  const wake = (message: UserMessage): void => { state.calls.push(message); session.append('user/message', message, { surfaceOp: 'append' }) }
  const agent = { id: session.id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [], remove: () => {} }, steer: wake, followup: wake } as unknown as Agent
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
    const body = '@reader please review this before the release'
    const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('direct'), workspaceId: alpha,
      projectRef: project.project.projectRef, body })
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
    expect(isFactOnSurface(visibleTeamSurface(agent), unread[0]!, sent.thread.threadRef)).toBe(true)
    // And the notice really does carry the body verbatim — the agreement is
    // about content, not about a marker that happens to be present.
    expect(text).toContain(body)
  })

  it('an ordinary digest carries text without attesting its complete fact', async () => {
    const { ctx } = await harness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering' })
    const member = await addLiveMember(ctx, project.project.projectRef)
    const { agent, state } = wakeSeam()
    ctx.agentTeam['handles'].set(member.memberId, { agent, dispose: async () => {} })

    // A commit that does not name the Member. An ordinary update only reaches a
    // Member who follows the Thread, so the Member follows explicitly and the
    // update is ordinary.
    const anchor = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('anchor'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'anchor for the ordinary case' })
    expect(anchor.kind).toBe('committed')
    if (anchor.kind !== 'committed') return
    await ctx.agentTeam['ledger']!.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, threadRef: anchor.thread.threadRef,
      action: 'follow', actor: { kind: 'member', memberId: member.memberId, handle: member.handle } })
    state.calls.length = 0
    // The update is an ordinary reply: it names nobody, so the notice renders
    // a digest rather than a complete bound Message.
    const body = 'background note nobody was mentioned in'
    const sent = await ctx.agentTeam.reply({ requestId: requestId('ordinary'), workspaceId: alpha,
      threadRef: anchor.thread.threadRef, body, baseRevision: anchor.thread.revision })
    expect(sent.kind).toBe('committed')
    if (sent.kind !== 'committed') return
    expect(state.calls).toHaveLength(1)

    // The Member holds one unread fact: the ordinary reply that named nobody.
    // The anchor predates the follow, so it is not one of them.
    const unread = ctx.agentTeam['ledger']!.notificationFacts(member.memberId).flatMap(entry => entry.facts)
    const ordinary = unread.filter(entry => !entry.direct)
    expect(ordinary).toHaveLength(1)
    // The digest makes the update intelligible, but binds no complete body, so
    // the probe correctly refuses to attest it and the write stays gated.
    const ordinaryText = state.calls[0]!.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(ordinaryText).toContain(body)
    expect(isFactOnSurface(visibleTeamSurface(agent), ordinary[0]!, anchor.thread.threadRef)).toBe(false)
  })
})
