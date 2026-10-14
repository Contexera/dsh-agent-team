import { describe, expect, it, vi } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTaskRef } from '../src/types.ts'
import type { WorkspaceId as TeamWorkspaceId } from '@deepseek-ai/dsh-workspace'
import { harness } from './helpers/surface-harness.ts'

/**
 * Layer two's second shape: the writer invalidates their own credential.
 *
 * A read hands out one token. The write that consumes it commits and renders a
 * NEW token. So a member that writes twice in a row — read, write, write — has
 * a second write whose only legitimate token is the one the FIRST write
 * returned. Holding the read's token is stale by their own hand, and no change
 * to what a read or a write renders can fix that: the token was delivered and
 * not used.
 *
 * The evidence this suite pins is the pair that separates the two causes, and
 * the reason a future change to the gate cannot quietly reorganise them:
 *
 *  (a) the write that reuses the FIRST WRITE'S returned token COMMITS — the
 *      consecutive-write path is legal and its token is the one already
 *      rendered. A gate that stopped accepting its own returned token would
 *      make consecutive writes impossible, and this leg goes red.
 *  (b) the write that reuses the READ's older token is REFUSED — the gate does
 *      not accept a superseded token, which is the whole reason a stale writer
 *      learns what changed. A gate relaxed to accept older tokens ("close
 *      enough") makes this leg go red, and that red is a real decision rather
 *      than a regression.
 *
 * Together they answer the question the diagnosis could not: the credential is
 * delivered on every write, so "the model never saw it" is not the fault. What
 * remains is that it was seen and not picked up, which no ledger change fixes.
 */

vi.setConfig({ testTimeout: 30_000 })

/** A ledger over the same durable table, shared with every other ledger in a test. */
function ledgerFor(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>, {})
}

/** Every durable operation, so "nothing was written" is checked against the log. */
function operationsOf(facility: DomainFacility): readonly AgentTeamOperation[] {
  return [...facility.get('agent_team')!.table('operations').entries()].map(([, operation]) => operation) as AgentTeamOperation[]
}

/** One Agent Member, registered through the ledger so the durable row is real. */
async function addLedgerMember(ledger: AgentTeamLedger, workspaceId: TeamWorkspaceId, handle: string): Promise<{ readonly actor: AgentTeamMemberActor }> {
  const memberId = `member:${crypto.randomUUID()}` as AgentTeamAgentMember['memberId']
  const member: AgentTeamAgentMember = {
    memberId, sessionId: `session:${memberId}` as AgentTeamAgentMember['sessionId'], workspaceId, handle,
    description: 'Test Agent', presetId: 'team-member', privateMemoryPath: `/tmp/${memberId}`, state: 'enabled',
  }
  const added = (await ledger.addMember({ requestId: `add:${memberId}` as AgentTeamRequestId, actor: agentTeamHumanActor(), member,
    handle, description: member.description, presetId: member.presetId, workspaceId, channelRefs: [] })).value
  return { actor: { kind: 'member', memberId: added.member.memberId, handle } }
}

/** A followed Thread with the human having written one message after the anchor. */
async function followedThread(ledger: AgentTeamLedger, workspaceId: TeamWorkspaceId, actor: AgentTeamMemberActor) {
  const channel = (await ledger.createChannel({ requestId: 'channel' as AgentTeamRequestId, workspaceId,
    name: 'engineering', description: 'Engineering work', memberIds: [actor.memberId], actor: agentTeamHumanActor() })).value.channel
  const started = (await ledger.sendMessage({ requestId: 'start' as AgentTeamRequestId, workspaceId,
    channelRef: channel.channelRef, body: 'Thread anchor', asTask: true, actor: agentTeamHumanActor() })).value
  if (started.kind !== 'committed' || started.task === undefined) throw new Error('setup failed')
  await ledger.changeAttention({ requestId: 'follow' as AgentTeamRequestId, workspaceId,
    taskRef: started.task.taskRef, action: 'follow', actor })
  return started.task.taskRef
}

/** The write result, asserted committed, as the one shape this suite reads a token from. */
async function committedToken(ledger: AgentTeamLedger, workspaceId: TeamWorkspaceId, taskRef: AgentTeamTaskRef, body: string, baseRevision: number, actor: AgentTeamMemberActor): Promise<number> {
  const written = await ledger.reply({ requestId: `write:${body}` as AgentTeamRequestId, workspaceId, taskRef, body, baseRevision, actor })
  if (!written.committed || written.value.kind !== 'committed') throw new Error('setup write failed')
  return written.value.thread.revision
}

describe("a write whose credential was superseded by the writer's own previous write", () => {
  it("accepts the token the previous write rendered, and refuses the read's older one", async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)

    // Leg (a): read once, then write twice. The FIRST write renders a token.
    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const readToken = read.value.thread.revision
    const firstWriteToken = await committedToken(ledger, test.workspaceId, taskRef, 'first write', readToken, actor)
    expect(firstWriteToken).toBeGreaterThan(readToken)

    // Leg (a) proper: the second write uses the token the FIRST write
    // returned — the legal consecutive-write path — and commits.
    const second = await ledger.reply({ requestId: 'second-from-write-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'second write using the previous write token', baseRevision: firstWriteToken, actor })
    expect(second.committed).toBe(true)
    expect(second.value.kind).toBe('committed')

    // Leg (b): the same position written again, but holding the READ's older
    // token, is refused — even though the last write already rendered its own.
    const before = operationsOf(test.facility).length
    const stale = await ledger.reply({ requestId: 'second-from-read-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'second write holding the read token', baseRevision: readToken, actor })
    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    expect(operationsOf(test.facility).length).toBe(before)
  })

  it('renders the increment the stale writer missed, so the refusal teaches what changed', async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)

    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const readToken = read.value.thread.revision
    await committedToken(ledger, test.workspaceId, taskRef, 'first write', readToken, actor)
    const stale = await ledger.reply({ requestId: 'stale-write' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'holding an old token', baseRevision: readToken, actor })

    // The token the writer held is echoed, the current one is handed back, and
    // the facts between are the increment the writer never saw.
    expect(stale.value.kind === 'stale_revision' && stale.value.expectedRevision).toBe(readToken)
    expect(stale.value.kind === 'stale_revision' && stale.value.revision).toBeGreaterThan(readToken)
    expect(stale.value.kind === 'stale_revision' && stale.value.facts?.map(fact => fact.fact.kind)).toContain('message')
  })

  it('a token the Thread did reach stays the ordinary race, so the copied-token wording is not over-applied', async () => {
    // The fail-closed contract from the other side: a token the Thread DID
    // reach must be left as a race. Without this leg, the flag can be turned on
    // for every refusal and the suite stays green — the wrong model is told it
    // copied a token every time it loses a genuine race.
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)

    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const readToken = read.value.thread.revision
    const second = await committedToken(ledger, test.workspaceId, taskRef, 'a write that moves the Thread', readToken, actor)
    const stale = await ledger.reply({ requestId: 'stale-after-real-insert' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'holding the read token a real insert passed', baseRevision: readToken, actor })

    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    expect(stale.value.kind === 'stale_revision' && stale.value.revision).toBe(second)
    // Absent, not false: the ledger knows this token was reached, and the
    // field exists only to say "never reached".
    expect(stale.value.kind === 'stale_revision' && stale.value.tokenUnrecognized).toBeUndefined()
  })

  it('a token older than the Thread\'s first fact stays unknowable, so the copied-token wording is claimed only where provable', async () => {
    // The fail-closed half of the flag, and the reason it is a flag and not a
    // certainty: `expectedRevision < first fact` cannot be judged. A token
    // below the Thread's oldest fact may have been a real revision before
    // that fact was trimmed, so claiming it was copied would assert something
    // the ledger does not hold. Refusing is the gate's job; over-claiming is
    // the registry's, and this leg keeps the claim bounded to the provable case.
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const channel = (await ledger.createChannel({ requestId: 'channel' as AgentTeamRequestId, workspaceId: test.workspaceId,
      name: 'engineering', description: 'Engineering work', memberIds: [actor.memberId], actor: agentTeamHumanActor() })).value.channel
    const older = (await ledger.sendMessage({ requestId: 'older' as AgentTeamRequestId, workspaceId: test.workspaceId,
      channelRef: channel.channelRef, body: 'An older Thread', actor: agentTeamHumanActor() }))
    if (older.value.kind !== 'committed') throw new Error('setup failed')
    const olderToken = older.value.thread.revision

    // A second Thread, written after the first, so its first fact sits past
    // the older Thread's token: a cross-thread copy that is below the window.
    const newer = (await ledger.sendMessage({ requestId: 'newer' as AgentTeamRequestId, workspaceId: test.workspaceId,
      channelRef: channel.channelRef, body: 'A newer Thread', asTask: true, actor: agentTeamHumanActor() }))
    if (newer.value.kind !== 'committed' || newer.value.task === undefined) throw new Error('setup failed')
    await ledger.changeAttention({ requestId: 'follow' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef: newer.value.task.taskRef, action: 'follow', actor })
    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef: newer.value.task.taskRef })
    expect(read.value.thread.revision).toBeGreaterThan(olderToken)

    const stale = await ledger.reply({ requestId: 'old-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef: newer.value.task.taskRef, body: 'write carrying a token from the older Thread', baseRevision: olderToken, actor })

    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    // Refused — but not claimed as copied, because the token predates what the
    // Thread can vouch for.
    expect(stale.value.kind === 'stale_revision' && stale.value.tokenUnrecognized).toBeUndefined()
  })

  it('a token this Thread never reached is named as a copied token, not as an insertion race', async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)
    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const here = await ledger.reply({ requestId: 'here' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'a write on this Thread', baseRevision: read.value.thread.revision, actor })
    if (!here.committed || here.value.kind !== 'committed') throw new Error('setup write failed')

    // A token from another Thread: a plausible-looking revision the ledger
    // never issued HERE. It is past this Thread's first fact, so "never
    // reached" is knowable rather than assumed, and the ordinary sentence
    // would send the model hunting for an insertion that never happened.
    const foreignToken = here.value.thread.revision + 10_000
    const stale = await ledger.reply({ requestId: 'foreign-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'write with a copied token', baseRevision: foreignToken, actor })

    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    // The flag exists only when the ledger is certain: the token is past the
    // Thread's first fact, so "never reached" is knowable rather than assumed.
    expect(stale.value.kind === 'stale_revision' && stale.value.tokenUnrecognized).toBe(true)
  })
})
