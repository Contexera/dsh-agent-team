import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { agentTeamHumanActor } from '../src/ledger.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, beta, committed, harness, ledgerAtBoot, requestId, storedPool, withTask, type TeamHarness } from './helpers/host-harness.ts'
import { counterfactualReceiptReadData, fabricateLegacyThreadReadSnapshot } from './helpers/legacy-thread-read.ts'
import { isThreadReadSnapshot } from '../src/ledger.ts'
import type { AgentTeamThreadReadData, AgentTeamThreadReadOperation, AgentTeamThreadReadReceipt, AgentTeamThreadReadResult, AgentTeamOperation, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam durable Thread read progress', () => {
  /**
   * A live facility holding one committed Human Thread read — a reply from a
   * Member the Human had not seen — plus the picture that read answered with,
   * which the legacy snapshot form needs to rebuild the record it used to write.
   */
  async function committedHumanRead(): Promise<{ readonly test: TeamHarness; readonly read: AgentTeamThreadReadResult; readonly records: Array<[string, unknown]> }> {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    const writer = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(writer, project.project.projectRef)
    let revision = sent.thread.revision
    for (const body of ['Working on it', 'Pushed a fix']) {
      revision = committed((await writer.reply({ requestId: requestId(body), workspaceId: alpha, taskRef: sent.task.taskRef, body, baseRevision: revision, actor })).value).thread.revision
    }
    const outcome = await writer.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    if (!outcome.committed) throw new Error('expected the Human read to commit a receipt')
    return { test, read: outcome.value, records: [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]> }
  }

  /** Rewrite every slim Thread read record of one ledger through `shape`. */
  function reshapeReads(records: Array<[string, unknown]>, shape: (operation: AgentTeamThreadReadOperation) => AgentTeamThreadReadData): Array<[string, unknown]> {
    return records.map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: shape(typed) }] as [string, unknown]
    })
  }

  it('answers a Thread with nothing unread for its reader without writing a receipt', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    const table = test.facility.get('agent_team')!.table('operations')
    const committedOperations = table.size
    const commits: unknown[] = []
    test.ctx.on('agent-team/committed', payload => commits.push(payload))

    // The creator's own opening is never unread for the creator, so this read
    // has no watermark to advance and no marker to consume.
    const read = await test.ctx.agentTeam.readThread({ requestId: requestId('read-nothing'), workspaceId: alpha, taskRef: sent.task.taskRef })

    // Nothing changed, so nothing is written: no record, no commit event (and
    // therefore no deferred replay), and no receipt for an operation that does
    // not exist.
    expect(table.size).toBe(committedOperations)
    expect(commits).toEqual([])
    expect(read.receipt).toBeUndefined()
    // The picture is still the whole Thread state, not a stub: a no-op read
    // shares the committed read's derivation.
    expect(read.task).toEqual(sent.task)
    expect(read.thread).toEqual(sent.thread)
    expect(read.anchor.messageRef).toBe(sent.message.messageRef)
    expect(read.remainingUnreadCount).toBe(0)
    expect(read.facts.some(fact => fact.unread)).toBe(false)
  })

  it('keeps the watermark a progress read advanced across a restart', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    const writer = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(writer, project.project.projectRef)
    committed((await writer.reply({ requestId: requestId('agent-reply'), workspaceId: alpha, taskRef: sent.task.taskRef, body: 'Working on it', baseRevision: sent.thread.revision, actor })).value)

    // A reply the reader has not seen is real progress: it commits a watermark.
    const first = await writer.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    expect(first.committed).toBe(true)
    expect(first.value.remainingUnreadCount).toBe(0)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()]

    const revived = await harness(storedPool(records as Array<[string, unknown]>))
    const reader = ledgerAtBoot(revived)
    const again = await reader.readThread({ requestId: requestId('human-read-after-restart'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })

    // The acknowledged reply stayed acknowledged: a restart that lost the
    // recorded progress would have to write it again here.
    expect(again.value.remainingUnreadCount).toBe(0)
    expect(again.committed).toBe(false)
  })

  it('drains unread replies by remainingUnreadCount and stops writing once caught up', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    const writer = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(writer, project.project.projectRef)
    let revision = sent.thread.revision
    for (const body of ['first reply', 'second reply', 'third reply']) {
      const replied = committed((await writer.reply({ requestId: requestId(body), workspaceId: alpha, taskRef: sent.task.taskRef, body, baseRevision: revision, actor })).value)
      revision = replied.thread.revision
    }

    const reader = ledgerAtBoot(test)
    const table = test.facility.get('agent_team')!.table('operations')
    let rounds = 0
    while (rounds < 10) {
      const read = await reader.readThread({ requestId: requestId(`drain-${rounds}`), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
      if (!read.committed) throw new Error('expected every unread round to commit')
      rounds += 1
      if (read.value.remainingUnreadCount === 0) break
    }
    expect(rounds).toBeGreaterThan(0)
    expect((await reader.readThread({ requestId: requestId('drain-final'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })).value.remainingUnreadCount).toBe(0)

    // Caught up: the drain stops on the unread count, and the next read writes
    // nothing at all — including a retry of that same request id, which is not
    // a durable operation and so is answered from the current projection.
    const settled = table.size
    const extra = await reader.readThread({ requestId: requestId('drain-extra'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    expect(extra.committed).toBe(false)
    expect(extra.value.receipt).toBeUndefined()
    const retry = await reader.readThread({ requestId: requestId('drain-extra'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    expect(retry.committed).toBe(false)
    expect(retry.value.remainingUnreadCount).toBe(0)
    expect(table.size).toBe(settled)
  })

  it('stores a committing read as the slim receipt: progress and its Inbox, with no Thread picture', async () => {
    const { records, read } = await committedHumanRead()
    const record = records.map(([, operation]) => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (record?.kind !== 'team/thread-read') throw new Error('expected a durable Thread read record')

    // The durable content is exactly the progress the read made and the Inbox
    // delta it consumed. The Thread, its facts, the anchor, the Attention row
    // and the count it left behind are projection state a replay re-derives for
    // every surface that needs them, so freezing them here only adds weight
    // nothing reads back.
    expect(isThreadReadSnapshot(record.data)).toBe(false)
    expect(Object.keys(record.data).sort()).toEqual(['inbox', 'memberId', 'readThroughSequence', 'taskRef', 'threadRef', 'workspaceId'])
    expect(record.data.readThroughSequence).toBe(read.readThroughSequence)
    expect(record.data.inbox).toEqual(expect.objectContaining({ attention: expect.objectContaining({ set: expect.any(Array) }) }))
  })

  it('refuses to open a slim Thread read record that grows a picture field or loses its watermark', async () => {
    const { records } = await committedHumanRead()
    const record = records.map(([, operation]) => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (record?.kind !== 'team/thread-read' || isThreadReadSnapshot(record.data)) throw new Error('expected one slim Thread read record')
    const attention = record.data.inbox.attention.set[0]
    if (attention === undefined) throw new Error('expected the read to record an Attention advance')

    // Both forms are strict and disjoint, so a stored record parses as exactly
    // one of them. A field that only the frozen picture form ever carried is
    // therefore not "extra data" a newer reader may ignore: it makes the record
    // neither form, and the whole domain refuses to open rather than guess.
    await expect(harness(storedPool(reshapeReads(records, operation => ({ ...operation.data as AgentTeamThreadReadReceipt, attention }))))).rejects.toThrow(/does not match its schema/)
    // Progress is the receipt's whole content, so a read that reports none is
    // not a receipt either.
    await expect(harness(storedPool(reshapeReads(records, operation => {
      const { readThroughSequence: _dropped, ...rest } = operation.data as AgentTeamThreadReadReceipt
      return rest as AgentTeamThreadReadData
    })))).rejects.toThrow(/does not match its schema/)
  })

  it('rejects a slim Thread read receipt that under-reports the progress it made or the Task it belongs to', async () => {
    const { records } = await committedHumanRead()
    // Forging the watermark down keeps the record internally consistent — the
    // Inbox delta still advances Attention to the real watermark — so only the
    // independent derivation from the record's own prior projection can catch
    // a read that claims less progress than the ledger already gave it.
    await expect(harness(storedPool(reshapeReads(records, operation => ({
      ...operation.data as AgentTeamThreadReadReceipt, readThroughSequence: (operation.data as AgentTeamThreadReadReceipt).readThroughSequence - 1,
    }))))).rejects.toThrow(/invalid Thread read receipt/)
    // Identity is derived too: a Task Thread read that drops the Task it
    // belongs to would otherwise shrink its own claim unchecked, because the
    // Thread alone still resolves the same read.
    await expect(harness(storedPool(reshapeReads(records, operation => {
      const { taskRef: _dropped, ...rest } = operation.data as AgentTeamThreadReadReceipt
      return rest as AgentTeamThreadReadData
    })))).rejects.toThrow(/invalid Thread read receipt/)
  })

  it('rejects a legacy Thread read snapshot whose recorded facts were trimmed', async () => {
    const { read, records } = await committedHumanRead()
    const snapshots = reshapeReads(records, operation => fabricateLegacyThreadReadSnapshot(operation.data as AgentTeamThreadReadReceipt, read))
    const stored = snapshots.map(([, operation]) => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (stored?.kind !== 'team/thread-read' || !isThreadReadSnapshot(stored.data)) throw new Error('expected one legacy Thread read snapshot')
    expect(stored.data.facts.length).toBeGreaterThan(1)

    // A snapshot is not a trusted record just because it is old: the legacy
    // form still gets the full picture derivation, so trimming one fact the
    // read answered with is a forged projection, not a smaller record.
    await expect(harness(storedPool(reshapeReads(records, operation => {
      const snapshot = fabricateLegacyThreadReadSnapshot(operation.data as AgentTeamThreadReadReceipt, read)
      return { ...snapshot, facts: snapshot.facts.slice(0, -1) }
    })))).rejects.toThrow(/invalid Thread read projection/)
  })

  it('opens and validates a legacy Thread read snapshot without rewriting one stored byte', async () => {
    const { read, records } = await committedHumanRead()
    const snapshots = reshapeReads(records, operation => fabricateLegacyThreadReadSnapshot(operation.data as AgentTeamThreadReadReceipt, read))
    const pool = storedPool(snapshots)
    const revived = await harness(pool)
    revived.ctx.agentTeam.validateLedger()

    // Loading normalizes the projection, never the record: an installation that
    // upgrades keeps every ledger byte it already committed, and the legacy
    // read stays a legacy read.
    expect([...pool.media.get('agent_team')!.tables.get('operations')!.entries()]).toEqual(snapshots)
    const stored = [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
      .map(operation => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (stored?.kind !== 'team/thread-read') throw new Error('expected the Thread read record to survive the boot')
    expect(isThreadReadSnapshot(stored.data)).toBe(true)
  })

  it('replays frozen snapshots and slim receipts into the same projections, mixed or uniform', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    const writer = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(writer, project.project.projectRef)
    await writer.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'follow', actor })
    const claimed = committed((await writer.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: sent.task.taskRef,
      action: 'claim', direction: 'read the regression', baseRevision: sent.thread.revision, actor })).value)
    committed((await writer.reply({ requestId: requestId('agent-reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: 'Working on it', baseRevision: claimed.thread.revision, actor })).value)
    const humanReadId = requestId('human-read')
    const memberReadId = requestId('member-read')
    // The Human drains the claim and the reply, replies in turn, and the Member
    // drains that: two committed reads over one Thread, at different points.
    const humanOutcome = await writer.readThread({ requestId: humanReadId, workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    if (!humanOutcome.committed) throw new Error('expected the Human read to commit a receipt')
    committed((await writer.reply({ requestId: requestId('human-reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: 'Please continue', baseRevision: humanOutcome.value.readThroughSequence, actor: agentTeamHumanActor() })).value)
    const memberOutcome = await writer.readThread({ requestId: memberReadId, workspaceId: alpha, taskRef: sent.task.taskRef, actor })
    if (!memberOutcome.committed) throw new Error('expected the Member read to commit a receipt')
    const pictures = new Map<AgentTeamRequestId, Omit<AgentTeamThreadReadResult, 'receipt'>>([[humanReadId, humanOutcome.value], [memberReadId, memberOutcome.value]])
    const base = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const asSnapshot = (operation: AgentTeamThreadReadOperation): AgentTeamThreadReadData => isThreadReadSnapshot(operation.data)
      ? operation.data : fabricateLegacyThreadReadSnapshot(operation.data, pictures.get(operation.requestId)!)
    const asReceipt = (operation: AgentTeamThreadReadOperation): AgentTeamThreadReadData => isThreadReadSnapshot(operation.data)
      ? counterfactualReceiptReadData(operation.data) : operation.data

    // Three ledgers that record the same two reads three ways: the pre-slim
    // shape, the slim shape, and one of each. Every other record is identical.
    const variants = [reshapeReads(base, asSnapshot), reshapeReads(base, asReceipt),
      reshapeReads(base, operation => operation.requestId === humanReadId ? asSnapshot(operation) : asReceipt(operation))]
    const summary = (instance: TeamHarness) => {
      const ledger = ledgerAtBoot(instance)
      return {
        status: instance.ctx.agentTeam.status(),
        view: instance.ctx.agentTeam.view({ workspaceId: alpha, threadRef: sent.thread.threadRef }),
        inbox: ledger.inbox(actor, { workspaceId: alpha }),
        attention: ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: sent.task.taskRef }),
        history: ledger.threadHistory(actor, { workspaceId: alpha, taskRef: sent.task.taskRef }),
      }
    }
    const booted: unknown[] = []
    for (const records of variants) {
      const revived = await harness(storedPool(records))
      ledgerAtBoot(revived).validate()
      booted.push(summary(revived))
    }
    expect(booted[0]).toBeDefined()
    expect(booted[1]).toEqual(booted[0])
    expect(booted[2]).toEqual(booted[0])
  })
})
