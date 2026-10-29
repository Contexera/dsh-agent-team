import { describe, expect, it, vi } from 'vitest'
// These boot real Hosts over throwaway trees; the same 30s headroom the
// Thread-read progress suite uses for cold replays applies here.
vi.setConfig({ testTimeout: 30_000 })
import { agentTeamHumanActor, isThreadReadSnapshot } from '../src/ledger.ts'
import { STALLED_PUBLIC_MS } from '../src/task-reminders.ts'
import type { AgentTeamOperation, AgentTeamThreadReadOperation, AgentTeamThreadReadReceipt } from '../src/types.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, makeOwner, requestId, storedPool, withTask, type TeamHarness } from './helpers/host-harness.ts'

/** Every durable Thread-read record in the harness's operation table, in ledger order. */
function readOperations(test: TeamHarness): readonly AgentTeamThreadReadOperation[] {
  return [...test.facility.get('agent_team')!.table('operations').entries()]
    .map(([, operation]) => operation as AgentTeamOperation)
    .filter((operation): operation is AgentTeamThreadReadOperation => operation.kind === 'team/thread-read')
}

function receiptOf(operation: AgentTeamThreadReadOperation): AgentTeamThreadReadReceipt {
  if (isThreadReadSnapshot(operation.data)) throw new Error('expected the slim receipt form')
  return operation.data
}

function operationTableSize(test: TeamHarness): number {
  return test.facility.get('agent_team')!.table('operations').size
}

/**
 * One Task Thread with a Human opening, a Member reader following it, and five
 * replies after the follow: ordinary, mention, ordinary, mention, ordinary.
 * The two mentions give the reader two sparse direct markers inside one batch.
 */
async function seededReaderThread() {
  const test = await harness()
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha,
    name: 'engineering', description: 'Engineering work' })
  const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'),
    workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
  const ledger = ledgerAtBoot(test)
  const reader = await addLedgerMember(ledger, project.project.projectRef, 'member:reader', 'Reader agent', 'reader')
  const human = agentTeamHumanActor()
  await ledger.changeAttention({ requestId: requestId('follow-reader'), workspaceId: alpha,
    taskRef: sent.task.taskRef, action: 'follow', actor: reader.actor })
  let revision = sent.thread.revision
  const replies: Array<{ readonly sequence: number; readonly body: string }> = []
  for (const body of ['first update', '@reader second update', 'third update', '@reader fourth update', 'fifth update']) {
    const replied = committed((await ledger.reply({ requestId: requestId(`reply-${body}`), workspaceId: alpha,
      taskRef: sent.task.taskRef, body, baseRevision: revision, actor: human })).value)
    replies.push({ sequence: replied.message.sequence, body })
    revision = replied.thread.revision
  }
  return { test, ledger, reader, sent, replies, revision }
}

/**
 * One in-progress Task with a stalled reminder still unread for its
 * accountable Member, plus one ordinary reply the Member has not read. The
 * Member is the Task accountable and a Project owner, so the reminder targets
 * exactly the reader under test.
 */
async function seededReminderThread() {
  const test = await harness()
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha,
    name: 'delivery', description: 'Delivery work' })
  const ledger = ledgerAtBoot(test)
  const worker = await addLedgerMember(ledger, project.project.projectRef, 'member:worker', 'Worker agent', 'worker')
  await makeOwner(ledger, project.project.projectRef, worker.member.memberId)
  const human = agentTeamHumanActor()
  const started = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha,
    projectRef: project.project.projectRef, body: 'Ship the change', accountable: worker.member.memberId, actor: human })).value))
  const base = await ledger.readThread({ requestId: requestId('claim-read'), workspaceId: alpha,
    taskRef: started.task.taskRef, actor: worker.actor })
  const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha,
    taskRef: started.task.taskRef, action: 'claim', direction: 'ship it', baseRevision: base.value.thread.revision, actor: worker.actor })).value)
  // The Claim is new public work for the Human, who must read it before
  // replying; that read is setup, not part of the selection under test.
  await ledger.readThread({ requestId: requestId('human-read'), workspaceId: alpha,
    taskRef: started.task.taskRef, actor: human })
  const replied = committed((await ledger.reply({ requestId: requestId('hurry'), workspaceId: alpha,
    taskRef: started.task.taskRef, body: 'status?', baseRevision: claimed.thread.revision, actor: human })).value)
  const now = Date.parse(replied.receipt.occurredAt) + STALLED_PUBLIC_MS + 1
  const candidate = ledger.planReminders(now, () => undefined, started.task.taskRef)
    .find(candidate => candidate.kind === 'stalled' && candidate.recipient === worker.member.memberId)
  if (candidate === undefined) throw new Error('expected a stalled reminder candidate')
  await ledger.raiseReminder(candidate, now, () => undefined)
  return { test, ledger, worker, taskRef: started.task.taskRef, revision: replied.thread.revision }
}

describe('AgentTeam Thread read selection', () => {
  it('previews without writing and confirms only the selected prefix of the default batch', async () => {
    const { test, ledger, reader, sent, replies } = await seededReaderThread()
    const sequences = replies.map(reply => reply.sequence)
    const before = operationTableSize(test)

    const preview = ledger.previewThreadRead({ requestId: requestId('preview'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor })
    expect(operationTableSize(test)).toBe(before)
    expect(preview.receipt).toBeUndefined()
    expect(preview.facts.filter(fact => fact.unread).map(fact => fact.fact.sequence)).toEqual(sequences)
    expect(preview.remainingUnreadCount).toBe(0)

    // The reader can fully deliver the first three facts but not the fourth,
    // so it confirms through the third and leaves the two mentions apart.
    const selected = await ledger.readThread({ requestId: requestId('selected'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: sequences[2]! })
    if (!selected.committed) throw new Error('expected the selective read to commit a receipt')
    expect(selected.value.facts.filter(fact => fact.unread).map(fact => fact.fact.sequence)).toEqual(sequences.slice(0, 3))
    expect(selected.value.remainingUnreadCount).toBe(2)
    expect(selected.value.consumedDirectMarkers.map(marker => marker.messageRef)).toHaveLength(1)

    const receipt = receiptOf(readOperations(test).at(-1)!)
    expect(receipt.selectedThroughSequence).toBe(sequences[2])
    expect(receipt.readThroughSequence).toBe(sequences[2])
    const item = ledger.inbox(reader.actor, { workspaceId: alpha }).items
      .find(item => item.thread.threadRef === sent.thread.threadRef)
    expect(item).toMatchObject({ unreadCount: 2, directCount: 1 })
  })

  it('confirms nothing and consumes no marker when the selection is zero', async () => {
    const { test, ledger, reader, sent } = await seededReaderThread()
    const before = operationTableSize(test)

    const withheld = await ledger.readThread({ requestId: requestId('withheld'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: 0 })
    expect(withheld.committed).toBe(false)
    expect(withheld.value.receipt).toBeUndefined()
    // Nothing from the unread batch is answered with. The only facts left are
    // background the reader already stood before: here the Thread anchor,
    // marked not-unread and not-direct.
    expect(withheld.value.facts.map(fact => [fact.fact.sequence, fact.unread, fact.direct]))
      .toEqual([[sent.message.sequence, false, false]])
    expect(withheld.value.consumedDirectMarkers).toEqual([])
    expect(withheld.value.remainingUnreadCount).toBe(5)
    expect(operationTableSize(test)).toBe(before)

    const item = ledger.inbox(reader.actor, { workspaceId: alpha }).items
      .find(item => item.thread.threadRef === sent.thread.threadRef)
    expect(item).toMatchObject({ unreadCount: 5, directCount: 2 })
  })

  it('holds Task reminders until a selection confirms at least one fact', async () => {
    const { test, ledger, worker, taskRef, revision } = await seededReminderThread()
    const before = operationTableSize(test)

    const withheld = await ledger.readThread({ requestId: requestId('withheld'), workspaceId: alpha,
      taskRef, actor: worker.actor, selectedThroughSequence: 0 })
    expect(withheld.committed).toBe(false)
    expect(withheld.value.remainingUnreadCount).toBe(2)
    // The reminder is reported so the caller knows it exists, but it is not
    // consumed: no receipt was written and the Inbox row still carries it.
    expect(withheld.value.reminders).toEqual([expect.objectContaining({ kind: 'stalled', recipient: worker.member.memberId })])
    expect(operationTableSize(test)).toBe(before)
    expect(ledger.inbox(worker.actor, { workspaceId: alpha }).items
      .find(item => item.task?.taskRef === taskRef)?.reminders).toHaveLength(1)

    // A selection reaching the Thread tail confirms the ordinary reply and the
    // reminder with it: withholding is specific to a selection that confirms
    // no fact at all.
    const confirmed = await ledger.readThread({ requestId: requestId('confirmed'), workspaceId: alpha,
      taskRef, actor: worker.actor, selectedThroughSequence: revision })
    expect(confirmed.committed).toBe(true)
    expect(confirmed.value.remainingUnreadCount).toBe(0)
    expect(ledger.inbox(worker.actor, { workspaceId: alpha }).items
      .find(item => item.task?.taskRef === taskRef)).toBeUndefined()
  })

  it('keeps an unselected read on the default first-20 batch with no stored selection', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha,
      name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'),
      workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    const ledger = ledgerAtBoot(test)
    const reader = await addLedgerMember(ledger, project.project.projectRef, 'member:reader2', 'Reader agent', 'reader2')
    const human = agentTeamHumanActor()
    await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha,
      taskRef: sent.task.taskRef, action: 'follow', actor: reader.actor })
    let revision = sent.thread.revision
    const sequences: number[] = []
    for (let index = 0; index < 25; index += 1) {
      const replied = committed((await ledger.reply({ requestId: requestId(`reply-${index}`), workspaceId: alpha,
        taskRef: sent.task.taskRef, body: `update ${index}`, baseRevision: revision, actor: human })).value)
      sequences.push(replied.message.sequence)
      revision = replied.thread.revision
    }

    const read = await ledger.readThread({ requestId: requestId('default-read'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor })
    if (!read.committed) throw new Error('expected the default read to commit a receipt')
    expect(read.value.facts.filter(fact => fact.unread)).toHaveLength(20)
    expect(read.value.remainingUnreadCount).toBe(5)
    expect(read.value.readThroughSequence).toBe(sequences[19])
    const receipt = receiptOf(readOperations(test).at(-1)!)
    expect('selectedThroughSequence' in receipt).toBe(false)
    expect(receipt.readThroughSequence).toBe(sequences[19])
  })

  it('replays selective and default receipts from their stored bound, never from a Session', async () => {
    const { test, ledger, reader, sent, replies } = await seededReaderThread()
    const sequences = replies.map(reply => reply.sequence)
    const selected = await ledger.readThread({ requestId: requestId('selected'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: sequences[2]! })
    if (!selected.committed) throw new Error('expected the selective read to commit a receipt')
    const rest = await ledger.readThread({ requestId: requestId('rest'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor })
    if (!rest.committed) throw new Error('expected the default read to commit a receipt')
    expect(rest.value.remainingUnreadCount).toBe(0)

    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const receipts = readOperations(test).map(receiptOf)
    expect(receipts).toHaveLength(2)
    expect(receipts[0]!.selectedThroughSequence).toBe(sequences[2])
    expect('selectedThroughSequence' in receipts[1]!).toBe(false)

    const revived = await harness(storedPool(records))
    const replay = ledgerAtBoot(revived)
    expect(() => replay.validate()).not.toThrow()
    expect(replay.inbox(reader.actor, { workspaceId: alpha }).items
      .find(item => item.thread.threadRef === sent.thread.threadRef)).toBeUndefined()

    // The receipt is the only replay input. Dropping the bound it stored, or
    // moving it, changes what that read should have acknowledged and fails the
    // independent derivation — a Session cannot stand in for it.
    const withoutSelection = records.map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)
        || typed.data.selectedThroughSequence === undefined) return [id, typed] as [string, unknown]
      const { selectedThroughSequence: _dropped, ...data } = typed.data
      return [id, { ...typed, data }] as [string, unknown]
    })
    await expect(harness(storedPool(withoutSelection))).rejects.toThrow(/invalid Thread read receipt/)
    const movedSelection = records.map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)
        || typed.data.selectedThroughSequence === undefined) return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, selectedThroughSequence: sequences[3]! } }] as [string, unknown]
    })
    await expect(harness(storedPool(movedSelection))).rejects.toThrow(/invalid Thread read receipt/)
  })

  it('rejects a selection outside the Thread revision or not a non-negative integer', async () => {
    const { ledger, reader, sent, revision } = await seededReaderThread()
    expect(() => ledger.previewThreadRead({ requestId: requestId('too-far'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: revision + 1 }))
      .toThrow(/selectedThroughSequence/)
    await expect(ledger.readThread({ requestId: requestId('negative'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: -1 }))
      .rejects.toThrow(/selectedThroughSequence/)
    await expect(ledger.readThread({ requestId: requestId('fractional'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: 1.5 }))
      .rejects.toThrow(/selectedThroughSequence/)
  })

  it('binds a request id to an explicit selection but not one computed inside the queue', async () => {
    const { ledger, reader, sent, replies } = await seededReaderThread()
    const sequences = replies.map(reply => reply.sequence)
    const id = requestId('once')
    let selectCalls = 0
    const first = await ledger.readThread({ requestId: id, workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor }, () => {
      selectCalls += 1
      return sequences[1]!
    })
    expect(first.committed).toBe(true)
    expect(selectCalls).toBe(1)

    // A stored request retry neither reruns the selection nor compares the
    // computed bound it persisted.
    const retry = await ledger.readThread({ requestId: id, workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor })
    expect(retry.committed).toBe(false)
    expect(retry.value.receipt?.requestId).toBe(id)
    expect(retry.value.readThroughSequence).toBe(sequences[1])
    expect(retry.value.remainingUnreadCount).toBe(3)
    expect(retry.value.facts.filter(entry => entry.unread)).toEqual([])
    expect(selectCalls).toBe(1)

    // An explicit request selection is still part of the payload comparison.
    await expect(ledger.readThread({ requestId: id, workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: sequences[2]! }))
      .rejects.toThrow(/was reused with a different operation or payload/)
    const sameExplicit = await ledger.readThread({ requestId: id, workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor, selectedThroughSequence: sequences[1]! })
    expect(sameExplicit.committed).toBe(false)
  })

  it('selects inside the queue so a fact or entry queued ahead is not skipped', async () => {
    const { test, ledger, reader, sent, revision } = await seededReaderThread()
    const human = agentTeamHumanActor()

    // Queue a reply first, then the read. Both run in one queue, so the
    // preview handed to select already carries the queued fact.
    const pendingReply = ledger.reply({ requestId: requestId('queued-reply'), workspaceId: alpha,
      taskRef: sent.task.taskRef, body: 'queued update', baseRevision: revision, actor: human })
    let threadPreview: readonly number[] = []
    const threadRead = await ledger.readThread({ requestId: requestId('queued-read'), workspaceId: alpha,
      taskRef: sent.task.taskRef, actor: reader.actor }, preview => {
      threadPreview = preview.facts.filter(fact => fact.unread).map(fact => fact.fact.sequence)
      return Math.max(...threadPreview)
    })
    const queuedReply = committed((await pendingReply).value)
    expect(threadPreview).toContain(queuedReply.message.sequence)
    if (!threadRead.committed) throw new Error('expected the queued Thread read to commit')
    expect(threadRead.value.remainingUnreadCount).toBe(0)
    expect(receiptOf(readOperations(test).at(-1)!).selectedThroughSequence).toBe(queuedReply.message.sequence)

    // The same seam on the Main stream: a post queued ahead of the read is in
    // the preview and is acknowledged by the resulting watermark.
    const mainProject = (await ledger.createProject({ requestId: requestId('main-project'), actor: human,
      workspaceId: alpha, name: 'main', description: 'Main queue', memberIds: [reader.member.memberId] })).value.project.projectRef
    await ledger.changeAttention({ requestId: requestId('main-follow'), workspaceId: alpha,
      projectRef: mainProject, action: 'follow', actor: reader.actor })
    const pendingPost = ledger.postMainMessage({ requestId: requestId('queued-main-post'), workspaceId: alpha,
      projectRef: mainProject, body: 'queued main update', actor: human })
    let mainPreview: readonly number[] = []
    const mainRead = await ledger.readMainStream({ requestId: requestId('queued-main-read'), workspaceId: alpha,
      projectRef: mainProject, actor: reader.actor }, preview => {
      mainPreview = preview.entries.map(entry => entry.sequence)
      return Math.max(...mainPreview)
    })
    const queuedPost = committed((await pendingPost).value)
    expect(mainPreview).toContain(queuedPost.message.sequence)
    expect(mainRead.committed).toBe(true)
    expect(mainRead.value.standing.unreadCount).toBe(0)
    expect(mainRead.value.readThroughSequence).toBeGreaterThanOrEqual(queuedPost.message.sequence)
  })

  it('previews a Main stream read without writing and matches the read that follows', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha,
      name: 'main', description: 'Main stream work' })
    const ledger = ledgerAtBoot(test)
    const reader = await addLedgerMember(ledger, project.project.projectRef, 'member:main-reader', 'Main reader', 'main-reader')
    const human = agentTeamHumanActor()
    await ledger.changeAttention({ requestId: requestId('follow-main'), workspaceId: alpha,
      projectRef: project.project.projectRef, action: 'follow', actor: reader.actor })
    for (const body of ['one', 'two', 'three']) {
      await ledger.postMainMessage({ requestId: requestId(`main-${body}`), workspaceId: alpha,
        projectRef: project.project.projectRef, body, actor: human })
    }
    const before = operationTableSize(test)

    const preview = ledger.previewMainStreamRead({ requestId: requestId('preview-main'), workspaceId: alpha,
      projectRef: project.project.projectRef, actor: reader.actor })
    expect(operationTableSize(test)).toBe(before)
    expect(preview.receipt).toBeUndefined()

    const read = await ledger.readMainStream({ requestId: requestId('read-main'), workspaceId: alpha,
      projectRef: project.project.projectRef, actor: reader.actor })
    expect(read.committed).toBe(true)
    expect(read.value.receipt).toBeDefined()
    expect(preview.projectRef).toBe(read.value.projectRef)
    expect(preview.readThroughSequence).toBe(read.value.readThroughSequence)
    expect(preview.entries).toEqual(read.value.entries)
    expect(preview.consumedMarkers).toEqual(read.value.consumedMarkers)
    expect(preview.standing).toEqual(read.value.standing)
  })
})
