import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { SessionId } from '@deepseek-ai/dsh-session'
import { legacyJoinLedger } from './fixtures/legacy-membership-ledgers.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, beta, committed, harness, ledgerAtBoot, requestId, storedPool, type TeamHarness, withTask } from './helpers/host-harness.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { AGENT_TEAM_HUMAN_HANDLE } from '../src/index.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('body-authored mentions', () => {
  /** One Project and every write in it run through the same ledger projection. */
  async function projectOf(test: TeamHarness) {
    const ledger = ledgerAtBoot(test)
    const created = (await ledger.createProject({ requestId: requestId('project'), actor: agentTeamHumanActor(), workspaceId: alpha,
      name: 'engineering', description: 'Engineering work' })).value
    return { ledger, projectRef: created.project.projectRef }
  }

  /** A Member with a readable handle and a realistic branded id. */
  const enroll = (ledger: AgentTeamLedger, projectRef: string, handle: string) =>
    addLedgerMember(ledger, projectRef, `member:${crypto.randomUUID()}`, 'Test Agent', handle)

  const start = async (ledger: AgentTeamLedger, projectRef: string, body: string) =>
    withTask(committed((await ledger.startThread({ requestId: requestId(`start:${crypto.randomUUID()}`), actor: agentTeamHumanActor(),
      kind: 'task', workspaceId: alpha, projectRef: projectRef as never, body })).value))

  it('delivers a reply mention to a Project Member the Thread never carried, without making them follow', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    const sent = await start(ledger, projectRef, 'Investigate the regression')
    const author = await enroll(ledger, projectRef, 'author')
    const stranger = await enroll(ledger, projectRef, 'stranger')

    const reply = committed((await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@stranger, please look at this', baseRevision: sent.thread.revision, actor: author.actor })).value)
    expect(reply.undeliveredMentions).toBeUndefined()
    expect(reply.directMarkers).toEqual([expect.objectContaining({ memberId: stranger.member.memberId })])
    expect(ledger.attentionStatus(stranger.actor, { workspaceId: alpha, threadRef: sent.thread.threadRef }).attention).toBeUndefined()
    expect(ledger.inbox(stranger.actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1 })
  })

  it('names a Workspace participant who is not a Project Member', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    const insider = await enroll(ledger, projectRef, 'insider')
    // Participates in the Workspace, never enrolled in the Project: Project
    // membership is a Human-side organisation, not a gate on being addressed.
    const outsider = await addLedgerMember(ledger, undefined, undefined, 'Test Agent', 'outsider')
    expect(ledger.view({ workspaceId: alpha }, insider.member.memberId).projects.map(project => project.projectRef)).toEqual([projectRef as never])

    const sent = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('name-outsider'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: '@outsider, please look at this' })).value)
    expect(sent.directMarkers.map(marker => marker.memberId)).toEqual([outsider.member.memberId])
    // A Human naming someone is a pull-in, not a report: the write commits
    // outright and the marker is durable. (Inbox listing and Attention reads
    // stay Project-gated until visibility is derived from participation.)

  })

  it('treats @all as plain text while @Handle reaches the Workspace', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    await enroll(ledger, projectRef, 'insider')
    const outsider = await addLedgerMember(ledger, undefined, undefined, 'Test Agent', 'outsider')

    const all = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('all-is-text'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: '@all, standup in ten minutes' })).value)
    expect(all.directMarkers).toEqual([])
    const named = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('all-stays-named'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: `@${outsider.member.handle}, named from the Workspace` })).value)
    expect(named.directMarkers.map(marker => marker.memberId)).toEqual([outsider.member.memberId])
  })

  it('lists a derived Project participant in the view roster the composer reads', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('roster-project'), workspaceId: alpha, name: 'engineering', description: '' })
    const ledger = ledgerAtBoot(test)
    const insider = await addLedgerMember(ledger, project.project.projectRef, undefined, 'Test Agent', 'insider')
    const outsider = await addLedgerMember(ledger, undefined, undefined, 'Test Agent', 'outsider')
    committed((await ledger.startThread({ requestId: requestId('roster-msg'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: '@outsider, please look', kind: 'discussion', actor: agentTeamHumanActor() })).value)

    // The roster a UI mention picker reads is derived the same way visibility
    // is: the Member the Host now lets you address must appear in it, or the
    // composer offers a narrower set than the ledger accepts.
    const roster = ledger.view({ workspaceId: alpha }).members
    expect(roster).toContainEqual({ projectRef: project.project.projectRef, memberId: insider.member.memberId })
    expect(roster).toContainEqual({ projectRef: project.project.projectRef, memberId: outsider.member.memberId })

    // Removing the Member ends it: derivation never outlives the Member.
    await ledger.removeMember({ requestId: requestId('roster-remove'), memberId: outsider.member.memberId, actor: agentTeamHumanActor() })
    expect(ledger.view({ workspaceId: alpha }).members).not.toContainEqual({ projectRef: project.project.projectRef, memberId: outsider.member.memberId })
    ledger.validate()
  })

  it('reloads a ledger written with the widened mention rules and keeps committing', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    const insider = await enroll(ledger, projectRef, 'insider')
    const outsider = await addLedgerMember(ledger, undefined, undefined, 'Test Agent', 'outsider')

    const historic = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('historic-all'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: '@insider, historic write' })).value)
    const named = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('historic-named'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: '@outsider, named from the Workspace' })).value)
    expect(historic.directMarkers.map(marker => marker.memberId).sort()).toEqual([insider.member.memberId].sort())
    expect(named.directMarkers.map(marker => marker.memberId)).toEqual([outsider.member.memberId])

    // A fresh Ledger over the same persisted operations re-validates every
    // record on load. Widening is replay-safe, so both the Project Member and
    // the Workspace-only mention survive the re-check and the next commit still lands.
    const reopened = ledgerAtBoot(test)
    // Naming the Workspace-only Member again through the reloaded Ledger proves
    // the widened target check is live after a replay, not just on first write.
    const again = committed((await reopened.startThread({ kind: 'discussion', requestId: requestId('after-reload'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: '@outsider, again after the reload' })).value)
    expect(again.directMarkers.map(marker => marker.memberId)).toEqual([outsider.member.memberId])
  })

  it('shows a Member the Project of a Thread they took part in', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    await enroll(ledger, projectRef, 'insider')
    const outsider = await addLedgerMember(ledger, undefined, undefined, 'Test Agent', 'outsider')
    const elsewhere = (await ledger.createProject({ requestId: requestId('project-elsewhere'), workspaceId: alpha,
      name: 'elsewhere', description: '', memberIds: [], actor: agentTeamHumanActor() })).value.project

    // Project participation is derived now: no enrolment happens, and taking
    // part in one Thread of the Project is what makes it visible.
    expect(ledger.view({ workspaceId: alpha }, outsider.member.memberId).projects.map(project => project.projectRef)).toEqual([])
    await start(ledger, projectRef, '@outsider, please look')

    const seen = ledger.view({ workspaceId: alpha }, outsider.member.memberId).projects.map(project => project.projectRef)
    expect(seen).toEqual([projectRef as never])
    // The derived rule does not widen to the Workspace: a Project this Member
    // never took part in stays out of reach.
    expect(seen).not.toContain(elsewhere.projectRef)
  })

  it('keeps a Project visible for an explicit Member who never wrote, across a reload', async () => {
    // Enrolment by hand is retired, so this Member comes from a frozen old
    // ledger: the explicit membership it carries must stay visible even though
    // nothing can produce one any more.
    const ledger = ledgerAtBoot(await harness(storedPool(legacyJoinLedger.records)))
    const visible = () => ledger.view({ workspaceId: alpha }, legacyJoinLedger.memberId as never).projects.map(project => project.projectRef)
    expect(visible()).toEqual([legacyJoinLedger.projectRef as never])

    const reopened = ledgerAtBoot(await harness(storedPool(legacyJoinLedger.records)))
    expect(reopened.view({ workspaceId: alpha }, legacyJoinLedger.memberId as never).projects.map(project => project.projectRef))
      .toEqual([legacyJoinLedger.projectRef as never])
  })

  it('still refuses a Member who does not participate in the Workspace', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const { ledger, projectRef } = await projectOf(test)
    const sent = await start(ledger, projectRef, 'Investigate the regression')
    // A Member rooted in another Workspace: the boundary moved from Project
    // down to Workspace, it did not disappear, so this Member is refused
    // everywhere in this Workspace.
    const foreignMember: AgentTeamAgentMember = { memberId: `member:foreign-${crypto.randomUUID()}` as never, sessionId: SessionId('session:foreign'),
      workspaceId: beta, handle: 'foreign', description: 'Test Agent', presetId: 'team-member', privateMemoryPath: '/tmp/foreign', state: 'enabled' }
    await ledger.addMember({ requestId: requestId('add-foreign'), actor: agentTeamHumanActor(), member: foreignMember,
      handle: foreignMember.handle, description: foreignMember.description, presetId: foreignMember.presetId, workspaceId: beta, projectRefs: [] })
    const foreign = { member: foreignMember, actor: { kind: 'member' as const, memberId: foreignMember.memberId, handle: 'foreign' } }
    await expect(ledger.reply({ requestId: requestId('foreign-reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: 'Still here', baseRevision: sent.thread.revision, actor: foreign.actor })).rejects.toThrow(/not authorized|another Workspace/)
    await expect(ledger.changeAttention({ requestId: requestId('foreign-follow'), workspaceId: alpha, taskRef: sent.task.taskRef,
      action: 'follow', actor: foreign.actor })).rejects.toThrow(/not authorized|another Workspace/)
    await expect(ledger.changeClaim({ requestId: requestId('foreign-claim'), workspaceId: alpha, taskRef: sent.task.taskRef,
      action: 'claim', direction: 'Mine', baseRevision: sent.thread.revision, actor: foreign.actor })).rejects.toThrow(/not authorized|another Workspace/)
  })

  it('delivers one marker per named Member and none twice for a repeated name', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    const first = await enroll(ledger, projectRef, 'first')
    const second = await enroll(ledger, projectRef, 'second')

    const sent = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('dedupe'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: projectRef as never, body: '@first and @second please look; @first twice' })).value)
    expect(sent.directMarkers.map(marker => marker.memberId).sort()).toEqual([first.member.memberId, second.member.memberId].sort())
  })

  it('keeps @human deliverable after the human renames, under any casing', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    const sent = await start(ledger, projectRef, 'Investigate the regression')
    const author = await enroll(ledger, projectRef, 'author')
    ledger.setHumanDisplayHandle('YuCreate')

    // The historic literal survives as a permanent alias: every casing reaches
    // the same human, and the inbox counts it as a direct mention.
    const aliased = committed((await ledger.reply({ requestId: requestId('reply-alias'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@human and @Human, heads up', baseRevision: sent.thread.revision, actor: author.actor })).value)
    expect(aliased.undeliveredMentions).toBeUndefined()
    expect(aliased.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ totalDirectCount: 1 })

    const renamed = committed((await ledger.reply({ requestId: requestId('reply-renamed'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@YuCreate, same thing', baseRevision: aliased.thread.revision, actor: author.actor })).value)
    expect(renamed.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])

    // Both names in one body still notify the human exactly once.
    const both = committed((await ledger.reply({ requestId: requestId('reply-both'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@human aka @YuCreate, once please', baseRevision: renamed.thread.revision, actor: author.actor })).value)
    expect(both.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ totalDirectCount: 3 })
  })

  it('reserves the historic human literal against agent handles even after a rename', async () => {
    const test = await harness()
    const { ledger, projectRef } = await projectOf(test)
    ledger.setHumanDisplayHandle('YuCreate')
    await expect(enroll(ledger, projectRef, 'human')).rejects.toThrow('reserved human alias')
    await expect(enroll(ledger, projectRef, 'Human')).rejects.toThrow('reserved human alias')
  })
})
