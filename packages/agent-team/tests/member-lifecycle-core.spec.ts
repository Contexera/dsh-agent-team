import { afterEach, describe, expect, it, vi } from 'vitest'

/** The `rm` fault this spec injects into the fs mock below. */
const rmFault = vi.hoisted(() => ({ match: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: ((path: import('node:fs').PathLike, options?: import('node:fs').RmOptions): Promise<void> => {
      if (rmFault.match.length > 0 && typeof path === 'string' && path.includes(rmFault.match)) {
        return Promise.reject(Object.assign(new Error(`private memory removal failed (test seam): ${path}`), { code: 'EACCES' }))
      }
      return actual.rm(path, options)
    }) as typeof actual.rm,
  }
})
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import AgentTeam from '../src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { EmptyAdapter, GatedAdapter, realHarness, ScriptedAdapter, textResponse, toolCallResponse, waitFor, waitForIdle, requestId, persistenceRaceError } from './helpers/member-harness.ts'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AGENT_TEAM_HUMAN_MEMBER_ID, teamPresetScopeMismatchMessage } from '../src/index.ts'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { RECOVERY_DELAY_MS } from '../src/recovery.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import type { AgentTeamProjectRef, AgentTeamClaimRef, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'




describe('Agent Team Member lifecycle', () => {
  it('works in a joined Workspace through the existing live Session and withdraws without disposing it', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, checkout, root, workspaces, archived } = await realHarness(adapter)
    const otherId = WorkspaceId('workspace:joined')
    workspaces.set(otherId, { id: otherId, path: join(root, 'other-checkout'), attachSession: async () => {} })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('global-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.joinWorkspace({ requestId: requestId('global-join'), workspaceId: otherId, memberId })
    expect(ctx.agentTeam.membersForClient({ workspaceId: otherId }).map(status => status.member.memberId)).toEqual([memberId])
    adapter.enqueue(textResponse('Acknowledged the participation change.'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const noticeRequest = JSON.stringify(adapter.requests[0]!.messages)
    expect(noticeRequest).toContain('Team participation changed')
    expect(noticeRequest).toContain(otherId)
    expect(noticeRequest).toContain('Your Session and cwd have not moved')
    for (const [name, args] of [
      ['team_view', {}],
      ['team_thread', { action: 'read', threadRef: 'thread:missing' }],
      ['team_attention', { action: 'status', threadRef: 'thread:missing' }],
      ['team_message', { action: 'start', projectRef: 'project:missing', body: 'Do not route implicitly' }],
      ['team_dm', { memberRef: 'member:missing', body: 'Do not route implicitly' }],
      ['team_task', { action: 'list', taskRef: 'task:missing' }],
    ] as const) {
      const omitted = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`global-missing-${name}`),
        name, arguments: args, agent })
      expect(omitted.isError).toBe(true)
      if (!omitted.isError) throw new Error('Expected an explicit Workspace requirement')
      expect(omitted.error.message).toContain('workspace is required')
      expect(omitted.error.message).toContain(workspaceId)
      expect(omitted.error.message).toContain(otherId)
    }
    const project = await ctx.agentTeam.createProject({ requestId: requestId('global-project'), workspaceId: otherId,
      name: 'work', description: '', memberIds: [memberId] })
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('global-owner'), workspaceId: otherId, projectRef: project.project.projectRef, memberId })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('global-start'),
      name: 'team_message', arguments: { action: 'start', workspace: otherId, projectRef: project.project.projectRef, body: 'Working in joined checkout' }, agent })
    expect(result.isError, result.isError ? result.error.message : '').toBe(false)
    expect(ctx.agentTeam.view({ workspaceId: otherId }).items[0]?.message.body).toBe('Working in joined checkout')
    const legacyRef = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('global-start-channel-ref'),
      name: 'team_message', arguments: { action: 'start', workspace: otherId, projectRef: project.project.projectRef.replace('project:', 'channel:'), body: 'Cited by its Channel ref' }, agent })
    expect(legacyRef.isError, legacyRef.isError ? legacyRef.error.message : 'Agents still cite the channel: refs older history shows').toBe(false)
    expect(agent.session.header.cwd).toBe(checkout)
    expect(ctx.agents.get(added.status.member.sessionId)).toBe(agent)
    await ctx.agentTeam.leaveWorkspace({ requestId: requestId('global-leave'), workspaceId: otherId, memberId })
    expect(ctx.agentTeam.membersForClient({ workspaceId: otherId })).toEqual([])
    expect(ctx.agents.get(added.status.member.sessionId)).toBe(agent)
    expect(ctx.agentTeam.memberForAgent(agent)).toEqual(added.status.member)
    expect(archived).toEqual([])
    expect(() => ctx.agentTeam.viewForAgent(agent, { workspaceId: otherId })).toThrow(/another Workspace/)
    ctx.agentTeam.validateLedger()
  })

  it('speaks, reads and starts through the Main stream tools', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('main-project'), workspaceId, name: 'work', description: '', memberIds: [] })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('main-add'), workspaceId, handle: 'builder', description: '', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`main-${name}-${JSON.stringify(args)}`), name, arguments: args, agent })
      return result.isError ? { error: result.error.message } : { text: JSON.stringify(result) }
    }

    await ctx.agentTeam.postMainMessage({ requestId: requestId('main-human'), workspaceId, projectRef, body: 'Plain note from the Human' })
    expect(await run('team_thread', { action: 'read', projectRef })).toMatchObject({ text: expect.stringContaining('Plain note from the Human') })
    expect(await run('team_message', { action: 'post', projectRef, body: 'Agent speaking' })).toMatchObject({ text: expect.stringContaining('Main stream message posted') })
    // Not an owner yet: starting a Thread points back to the Main stream.
    expect(await run('team_message', { action: 'start', projectRef, kind: 'discussion', body: 'x' })).toMatchObject({ error: expect.stringMatching(/project_owner_required.*team_message post/s) })
    // The removed asTask spelling is refused with the route to kind, never dropped: a silent drop would commit a
    // discussion while the model believes it started a Task.
    expect(await run('team_message', { action: 'start', projectRef, asTask: true, body: 'x' })).toMatchObject({ error: expect.stringMatching(/start does not accept asTask.*kind: 'task'/s) })

    adapter.enqueue(textResponse('Noted my new ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('main-owner'), workspaceId, projectRef, memberId: added.status.member.memberId })
    await agent.whenIdle()
    expect(await run('team_message', { action: 'start', projectRef, kind: 'task', body: 'Build the importer' })).toMatchObject({ text: expect.stringContaining('Thread created') })
    expect(ctx.agentTeam.mainStreamHistory({ workspaceId, projectRef }).entries.map(entry => entry.kind)).toEqual(['message', 'message', 'activity', 'thread-card'])
    ctx.agentTeam.validateLedger()
  })

  it('accepts a unique Workspace id abbreviation and points at the fix when the abbreviation is not unique', async () => {
    const { ctx, workspaces } = await realHarness()
    const homeId = WorkspaceId('workspace:1a2b3c4d-0000-4000-8000-000000000001')
    const otherId = WorkspaceId('workspace:1a2b3c4d-0000-4000-8000-000000000002')
    workspaces.set(homeId, { id: homeId, path: '/tmp/other-checkout', attachSession: async () => {} })
    workspaces.set(otherId, { id: otherId, path: '/tmp/other-checkout', attachSession: async () => {} })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('abbrev-add'), workspaceId: homeId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.joinWorkspace({ requestId: requestId('abbrev-join'), workspaceId: otherId, memberId: added.status.member.memberId })
    const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId(`abbrev-${name}-${JSON.stringify(args)}`), name, arguments: args, agent })

    const abbreviated = await call('team_view', { workspace: 'workspace:1a2b3c4d-0000-4000-8000-000000000001' })
    expect(abbreviated.isError, abbreviated.isError ? abbreviated.error.message : '').toBe(false)

    const ambiguous = await call('team_view', { workspace: 'workspace:1a2b3c4d' })
    expect(ambiguous.isError).toBe(true)
    if (!ambiguous.isError) throw new Error('expected an ambiguous-Workspace rejection')
    expect(ambiguous.error.message).toContain(homeId)
    expect(ambiguous.error.message).toContain(otherId)
    expect(ambiguous.error.message).toMatch(/longer prefix|full Workspace id/i)
    expect(ambiguous.error.message.match(/matches/g) ?? []).toHaveLength(1)

    const unknown = await call('team_view', { workspace: 'workspace:9f8e7d6c-0000-4000-8000-000000000009' })
    expect(unknown.isError).toBe(true)
    if (!unknown.isError) throw new Error('expected an unknown-Workspace rejection')
    expect(unknown.error.message).toContain('Not participating in Workspace')
    expect(unknown.error.message).toContain(homeId)
  })

  it('wakes an idle accountable once for a private review reminder and consumes it on the Task read', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-25T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('reminder-project'), workspaceId, name: 'engineering', description: '' })
      const projectRef = project.project.projectRef
      const added = await ctx.agentTeam.addMember({ requestId: requestId('reminder-add'), workspaceId, handle: 'builder', description: '', presetId: 'team-member', projectRefs: [projectRef] })
      const memberId = added.status.member.memberId
      const agent = ctx.agents.get(added.status.member.sessionId)!
      const executor = await ctx.agentTeam.addMember({ requestId: requestId('reminder-executor-add'), workspaceId, handle: 'executor', description: '', presetId: 'team-member', projectRefs: [projectRef] })
      const executorAgent = ctx.agents.get(executor.status.member.sessionId)!
      await ctx.agentTeam.addProjectOwner({ requestId: requestId('reminder-owner'), workspaceId, projectRef, memberId })
      const started = await ctx.agentTeam.startThread({ requestId: requestId('reminder-task'), workspaceId, projectRef, kind: 'task', body: 'Review this work', accountable: memberId })
      if (started.kind !== 'committed' || started.task === undefined) throw new Error('Task did not start')
      const read = await ctx.agentTeam.readThreadForAgent(executorAgent, { requestId: requestId('reminder-claim-read'), workspaceId, taskRef: started.task.taskRef })
      const claimed = await ctx.agentTeam.changeClaimForAgent(executorAgent, { requestId: requestId('reminder-claim'), workspaceId, taskRef: started.task.taskRef,
        action: 'claim', direction: 'implementation', baseRevision: read.thread.revision })
      if (claimed.kind !== 'committed') throw new Error('Claim did not start')
      const doneRead = await ctx.agentTeam.readThreadForAgent(executorAgent, { requestId: requestId('reminder-done-read'), workspaceId, taskRef: started.task.taskRef })
      const done = await ctx.agentTeam.changeClaimForAgent(executorAgent, { requestId: requestId('reminder-done'), workspaceId, taskRef: started.task.taskRef,
        action: 'done', claimRef: claimed.claim.claimRef, baseRevision: doneRead.thread.revision })
      if (done.kind !== 'committed') throw new Error('Claim did not finish')
      await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reminder-owner-responsibility'), workspaceId, taskRef: started.task.taskRef })
      await agent.whenIdle()
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      expect(Date.now() - Date.parse(done.receipt.occurredAt)).toBeGreaterThanOrEqual(31 * 60_000)
      adapter.enqueue(textResponse('Reviewed the reminder.'))
      await ctx.agentTeam.inboxForAgent(agent, { workspaceId })
      const reminderOperation = await vi.waitFor(() => {
        const found = ctx.agentTeam['ledger']!['state'].ordered.find(operation => operation.kind === 'team/reminder-raised')
        if (found === undefined) throw new Error('the event evaluation has not committed the reminder')
        return found
      }, { timeout: 10_000 })
      expect(reminderOperation.kind).toBe('team/reminder-raised')
      const request = await vi.waitFor(() => {
        const found = adapter.requests.find(candidate => JSON.stringify(candidate.messages).includes('Team Task reminder'))
        if (found === undefined) throw new Error('the private reminder did not wake the accountable Agent')
        return found
      }, { timeout: 10_000 })
      expect(JSON.stringify(request.messages)).toContain('waiting for acceptance')
      expect(JSON.stringify(request.messages)).toContain(started.task.taskRef)
      await agent.whenIdle()
      const inbox = ctx.agentTeam.inboxForAgent(agent, { workspaceId })
      expect(inbox.items.find(item => item.task?.taskRef === started.task!.taskRef)?.reminders).toHaveLength(1)
      const before = ctx.agentTeam.threadHistory({ workspaceId, taskRef: started.task.taskRef })
      const consumed = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reminder-consume'), workspaceId, taskRef: started.task.taskRef })
      expect(consumed.reminders).toHaveLength(1)
      expect(ctx.agentTeam.threadHistory({ workspaceId, taskRef: started.task.taskRef }).facts).toEqual(before.facts)
      expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items.find(item => item.task?.taskRef === started.task!.taskRef)?.reminders ?? []).toEqual([])
      await ctx.agentTeam.inboxForAgent(agent, { workspaceId })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items.find(item => item.task?.taskRef === started.task!.taskRef)?.reminders ?? []).toEqual([])
      ctx.agentTeam.validateLedger()
    } finally { vi.useRealTimers() }
  })

  it('every argument-shape rejection names the next action', async () => {
    const { ctx, workspaceId } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('shape-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('shape-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ requestId: requestId('shape-task'), workspaceId, projectRef: project.project.projectRef, body: 'Shape the argument contract', kind: 'task' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const threadRef = started.thread!.threadRef
    const taskRef = started.task!.taskRef
    const rejected = async (name: string, args: unknown): Promise<string> => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`shape-${name}-${JSON.stringify(args)}`), name, arguments: args, agent })
      expect(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`).toBe(true)
      if (!result.isError) throw new Error('expected a rejection')
      return result.error.message
    }

    // read drains unread and cannot page: the fix is the history action. A read ignores a
    // page size instead of refusing, because a model that fills every optional slot reaches
    // for one and a refusal it cannot act on only bought an identical retry.
    const historyArgs = await rejected('team_thread', { action: 'message', threadRef, messageRef: 'message:23011', beforeSequence: 1, limit: 5 })
    expect(historyArgs).toContain('action: history')
    expect(historyArgs).toMatch(/cannot page/i)
    const paged = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('shape-read-page'), name: 'team_thread',
      arguments: { action: 'read', threadRef, beforeSequence: 1, limit: 5 }, agent })
    expect(paged.isError, `read with a page size was refused: ${paged.isError ? paged.error.message : ''}`).toBe(false)
    for (const action of ['read', 'history'] as const) {
      const strayRef = await rejected('team_thread', { action, threadRef, messageRef: 'message:23011' })
      expect(strayRef, `${action} silently dropped messageRef`).toContain('does not accept messageRef')
      expect(strayRef).toContain('action: message')
    }
    const owned = await rejected('team_thread', { action: 'message', threadRef })
    expect(owned).toContain('messageRef')
    expect(owned).not.toContain('does not accept')
    expect(await rejected('team_message', { action: 'reply', threadRef, body: 'no token' })).toMatch(/team_thread read/)
    expect(await rejected('team_task', { action: 'done', taskRef, claimRef: 'claim:missing' })).toMatch(/team_thread read/)
    expect(await rejected('team_task', { action: 'done', baseRevision: 1, claimRef: 'claim:missing' })).toContain('taskRef')
    expect(await rejected('team_task', { action: 'list' })).toContain('taskRef')
    expect(await rejected('team_task', { action: 'claim', taskRef, baseRevision: 1, direction: 'd', claimRef: 'claim:missing' })).toContain('direction')
    expect(await rejected('team_task', { action: 'done', taskRef, baseRevision: 1, direction: 'd' })).toContain('claimRef')
    expect(await rejected('team_message', { action: 'reply', threadRef, baseRevision: 1, replyToMessageRef: 'message:23011', body: 'bad target' })).toContain('recorded Message')
    expect(await rejected('team_message', { action: 'reply', threadRef, baseRevision: 1, attachments: ['relative/shot.png'], body: 'bad attachment' })).toMatch(/absolute|does not exist/)
    expect(await rejected('team_message', { action: 'start', body: 'no project' })).toContain('projectRef')
    expect(await rejected('team_dm', { body: 'no recipient' })).toContain('memberRef')

    const peer = await ctx.agentTeam.addMember({ requestId: requestId('shape-peer'), workspaceId, handle: 'peer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const peerAgent = ctx.agents.get(peer.status.member.sessionId)!
    const peerRead = await ctx.agentTeam.readThreadForAgent(peerAgent, { requestId: requestId('shape-peer-read'), workspaceId, threadRef })
    const peerClaim = await ctx.agentTeam.changeClaimForAgent(peerAgent, { requestId: requestId('shape-peer-claim'), workspaceId, taskRef, action: 'claim', baseRevision: peerRead.thread.revision, direction: 'Peer claim on this Task' })
    if (peerClaim.kind !== 'committed') throw new Error(`expected committed peer claim, received ${peerClaim.kind}`)
    const builderRead = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('shape-builder-read'), workspaceId, threadRef })
    const ownAttempt = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('shape-own-claim'), name: 'team_task', arguments: { action: 'done', taskRef, baseRevision: builderRead.thread.revision, claimRef: peerClaim.claim.claimRef }, agent })
    expect(ownAttempt.isError).toBe(true)
    if (!ownAttempt.isError) throw new Error('expected an ownership rejection')
    expect(ownAttempt.error.message).toContain('own Claim')
    expect(ownAttempt.error.message).toContain('team_task list')
  })

  it('archives a Member: session disposed and archived, private memory kept, claims released', async () => {
    const { ctx, workspaceId, archived } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('archive-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('archive-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')

    // Give the Member an active Claim so the release cleanup is observable
    // end-to-end.
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('archive-task'), workspaceId, projectRef: project.project.projectRef, body: 'Build the feature' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const live = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('archive-read'), workspaceId, taskRef: started.task!.taskRef })
    const claimed = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('archive-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', direction: 'implements the feature', baseRevision: started.thread.revision })
    if (claimed.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed.kind}`)
    expect(claimed.task.status).toBe('in_progress')

    const result = await ctx.agentTeam.archiveMember({ requestId: requestId('archive'), memberId })
    expect(result.member.state).toBe('archived')
    expect(result.member.sessionId).toBe(added.status.member.sessionId)
    expect(result.releasedClaims).toEqual([expect.objectContaining({ owner: memberId, state: 'released' })])
    expect(result.removedAttention).toEqual([expect.objectContaining({ memberId, threadRef: started.task!.threadRef })])

    // Runtime effects: the live session is disposed and its Session archived
    // from grouping surfaces; private memory stays on disk.
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(archived).toContain(added.status.member.sessionId)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.members().find(status => status.member.memberId === memberId)).toMatchObject({ availability: 'archived', presence: 'unavailable' })

    // The released Claim drops the Task back to todo in the shared view.
    const view = ctx.agentTeam.view({ workspaceId })
    expect(view.tasks.find(task => task.taskRef === started.task!.taskRef)).toMatchObject({ status: 'todo' })
    expect(view.members).toEqual([])

    // Idempotent retry returns the same receipt; removal from archived stays
    // available as the data hygiene path and deletes the private namespace.
    const again = await ctx.agentTeam.archiveMember({ requestId: requestId('archive'), memberId })
    expect(again.receipt.operationId).toBe(result.receipt.operationId)
    const removed = await ctx.agentTeam.removeMember({ requestId: requestId('archive-remove'), memberId })
    expect(removed.member.state).toBe('inactive')
    await expect(access(added.status.member.privateMemoryPath)).rejects.toThrow()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('retries an archive after the post-commit Session archive fails', async () => {
    const { ctx, workspaceId, archived, archiveFailures } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('archive-retry-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    archiveFailures.remaining = 1

    await expect(ctx.agentTeam.archiveMember({ requestId: requestId('archive-retry'), memberId }))
      .rejects.toThrow('workspace archive failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('archived')
    expect(archived).toEqual([])

    const retried = await ctx.agentTeam.archiveMember({ requestId: requestId('archive-retry'), memberId })
    expect(retried.member.state).toBe('archived')
    expect(archived).toEqual([added.status.member.sessionId])
  })

  it('converges an archive interrupted after its commit during startup', async () => {
    const { ctx, workspaceId, archived, archiveFailures, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('arch-boot-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    archiveFailures.remaining = 1

    // The commit landed and the disposal succeeded; only the hide half
    // failed, so the durable state already says archived while no effect
    // hid the Session from grouping surfaces.
    await expect(ctx.agentTeam.archiveMember({ requestId: requestId('arch-boot'), memberId }))
      .rejects.toThrow('workspace archive failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('archived')
    expect(archived).toEqual([])
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    // Startup finishes the owed hide half from the durable state alone and
    // never activates the archived Member as an enabled one.
    expect(archived).toEqual([added.status.member.sessionId])
    const restored = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(restored).toMatchObject({ availability: 'archived', presence: 'unavailable' })
    expect(restored?.member.sessionId).toBe(added.status.member.sessionId)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.view({ workspaceId }).members).toEqual([])
    expect(ctx.agentTeam.members().filter(item => item.member.memberId === memberId)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('converges an archive whose Agent disposal failed during startup', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('arch-dispose-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    const handle = ctx.agentTeam['handles'].get(memberId)!
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('agent disposal failed (test seam)'))

    // Durable state says archived while the generation is still live — the
    // window a caller that never retries would leave standing.
    await expect(ctx.agentTeam.archiveMember({ requestId: requestId('arch-dispose'), memberId }))
      .rejects.toThrow('agent disposal failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('archived')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeDefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(true)

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    expect(archived).toEqual([added.status.member.sessionId])
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.members().filter(item => item.member.memberId === memberId)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes a removal whose private-memory cleanup failed when the Host restarts', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('remove-fs-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    const memoryPath = added.status.member.privateMemoryPath
    await writeFile(join(memoryPath, 'notes', 'kept.md'), 'persistent note')
    rmFault.match = join('agent-team', 'members')

    await expect(ctx.agentTeam.removeMember({ requestId: requestId('remove-fs'), memberId }))
      .rejects.toThrow('failed to clean up removed Member')
    rmFault.match = ''
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('inactive')
    // The Session half of the cleanup already ran; the memory half is owed.
    expect(archived).toEqual([added.status.member.sessionId])
    await expect(access(join(memoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    await expect(access(memoryPath)).rejects.toThrow()
    expect(archived).toEqual([added.status.member.sessionId])
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps a failing private-memory cleanup from failing startup and retries it at the next boot', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const removed = await ctx.agentTeam.addMember({ requestId: requestId('boot-fs-remove'), workspaceId,
      handle: 'victim', description: '', presetId: 'team-member', projectRefs: [] })
    const keeper = await ctx.agentTeam.addMember({ requestId: requestId('boot-fs-keep'), workspaceId,
      handle: 'keeper', description: '', presetId: 'team-member', projectRefs: [] })
    await writeFile(join(removed.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    rmFault.match = join('agent-team', 'members')
    await expect(ctx.agentTeam.removeMember({ requestId: requestId('boot-fs'), memberId: removed.status.member.memberId }))
      .rejects.toThrow('failed to clean up removed Member')

    // Restart while the fault still stands: startup retries the owed
    // cleanup, fails again, and must neither take the Host down with it nor
    // cost the rest of the roster their activation.
    await teamFiber.dispose()
    const boot = await ctx.plugin(AgentTeam)
    expect(boot).toBeDefined()
    expect(ctx.agentTeam.members().find(item => item.member.memberId === removed.status.member.memberId)?.availability).toBe('inactive')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === keeper.status.member.memberId)?.availability).toBe('active')
    await expect(access(removed.status.member.privateMemoryPath)).resolves.toBeUndefined()
    expect(archived).toEqual([removed.status.member.sessionId])

    // The fault clears like the failed call it stands for; the next startup
    // finishes what is still owed.
    rmFault.match = ''
    await boot.dispose()
    await ctx.plugin(AgentTeam)
    await expect(access(removed.status.member.privateMemoryPath)).rejects.toThrow()
    expect(archived).toEqual([removed.status.member.sessionId])
    expect(ctx.agentTeam.members().find(item => item.member.memberId === keeper.status.member.memberId)?.availability).toBe('active')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps a suspended Member suspended across startup and finishes a disposal-failed suspension on retry', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('susp-boot-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    const handle = ctx.agentTeam['handles'].get(memberId)!
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('agent disposal failed (test seam)'))

    await expect(ctx.agentTeam.suspendMember({ requestId: requestId('susp-boot'), memberId }))
      .rejects.toThrow('agent disposal failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('suspended')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(true)

    const retried = await ctx.agentTeam.suspendMember({ requestId: requestId('susp-boot'), memberId })
    expect(retried.status.availability).toBe('suspended')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    // Suspended keeps the Session: nothing archives it, memory stays.
    expect(archived).toEqual([])
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    const restored = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(restored).toMatchObject({ availability: 'suspended', presence: 'unavailable' })
    expect(restored?.member.sessionId).toBe(added.status.member.sessionId)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(archived).toEqual([])
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes an interrupted suspension through explicit recovery instead of steering the stray generation', async () => {
    const { ctx, workspaceId, archived } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('susp-recover-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    const handle = ctx.agentTeam['handles'].get(memberId)!
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('agent disposal failed (test seam)'))
    await expect(ctx.agentTeam.suspendMember({ requestId: requestId('susp-recover'), memberId }))
      .rejects.toThrow('agent disposal failed')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(true)

    // The durable state already says no live generation, so explicit
    // recovery converges the stray handle instead of feeding it a resume.
    const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('susp-recover-recover'), workspaceId, memberId })
    expect(recovered.status.availability).toBe('suspended')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(archived).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('creates, suspends, resumes, and removes an exact Team-owned Agent session', async () => {
    const { ctx, workspaceId, root, checkout } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    expect(added.status.availability).toBe('active')
    expect(added.status.member.privateMemoryPath).toBe(join(root, 'dsh-home', 'agent-team', 'members', added.status.member.memberId.replaceAll(':', '-')))
    // The first-run scaffold states the index's four sections and routes the
    // writing rules to the bundled skill instead of restating them.
    const scaffold = await readFile(join(added.status.member.privateMemoryPath, 'memory.md'), 'utf8')
    expect(scaffold).toContain('# Member memory')
    expect(scaffold).toContain('## Identity and role')
    expect(scaffold).toContain('## Durable rules')
    expect(scaffold).toContain('## In hand')
    expect(scaffold).toContain('## Notes index')
    expect(scaffold).toContain('the bundled `member-memory-manager` skill')
    await expect(access(join(added.status.member.privateMemoryPath, 'notes'))).resolves.toBeUndefined()
    const live = ctx.agents.get(added.status.member.sessionId)
    expect(live?.session.header.cwd).toBe(checkout)
    expect(live?.session.ownEvents()).toContainEqual(expect.objectContaining({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }))
    expect(ctx.agentTeam.memberForAgent(live!)).toEqual(added.status.member)
    expect(ctx.agentTeam.membersForClient({ workspaceId })[0]?.member).not.toHaveProperty('privateMemoryPath')
    const sessionTitle = ctx.get('sessionTitle')
    expect(sessionTitle?.get(live!.session)).toMatchObject({ title: 'builder', source: { kind: 'user' } })

    const suspended = await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: added.status.member.memberId })
    expect(suspended.status.availability).toBe('suspended')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: added.status.member.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(resumed.status.member.sessionId).toBe(added.status.member.sessionId)
    const resumedLive = ctx.agents.get(added.status.member.sessionId)
    expect(sessionTitle?.get(resumedLive!.session)).toMatchObject({ title: 'builder', source: { kind: 'user' } })

    const removed = await ctx.agentTeam.removeMember({ requestId: requestId('remove'), memberId: added.status.member.memberId })
    expect(removed.member.state).toBe('inactive')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    await expect(access(added.status.member.privateMemoryPath)).rejects.toThrow()
  })

  it('surfaces an orphaned preset composition and rebuilds the Member on resume', async () => {
    const { ctx, workspaceId, presets } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [] })
    expect(added.status.presence).toBe('available')
    const live = ctx.agents.get(added.status.member.sessionId)!
    expect(ctx.agentPresets.serviceFor(live, 'compaction')).toBeDefined()

    // Arm the orphan seam: this agent now resolves no preset composition,
    // as members composed before a bundle-row reload do after it.
    presets.orphaned.add(live.ctx)
    const orphaned = ctx.agentTeam.members().find(member => member.member.memberId === added.status.member.memberId)!
    expect(orphaned.presence).toBe('error')
    expect(orphaned.diagnostic).toMatchObject({ class: 'preset-composition' })
    expect(orphaned.diagnostic?.detail).toContain('preset composition was lost')

    const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('recover'), workspaceId, memberId: added.status.member.memberId })
    expect(recovered.status.presence).toBe('available')
    const rebuilt = ctx.agents.get(added.status.member.sessionId)!
    expect(rebuilt).not.toBe(live)
    expect(ctx.agentPresets.serviceFor(rebuilt, 'compaction')).toBeDefined()
    expect(ctx.tools.schemas(rebuilt).length).toBeGreaterThan(0)
  })

  it('re-derives a Member\u2019s failed last turn when the Host restarts', async () => {
    // The runtime failure slot is process-local memory, so nothing of it
    // survives a restart. Its durable source is the Session log, and a
    // restart re-runs the failure: the wake leaves facts to deliver, so the
    // Member reports the same failure again from the same durable origin.
    const adapter = new ScriptedAdapter()
    adapter.failWith = new LlmError('gateway answered 401', 'AUTH')
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('restart-project'), workspaceId, name: 'engineering', description: '' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('restart-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const memberId = added.status.member.memberId
    await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('restart-send'), workspaceId, projectRef: project.project.projectRef, body: '@builder go' })
    await ctx.agents.get(added.status.member.sessionId)!.whenIdle()
    const before = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
    expect(before?.presence).toBe('error')
    expect(before?.diagnostic?.detail).toContain('401')

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    // Straight after the boot the Member has already been woken by the
    // restart, so it is working rather than still marked failed — the error
    // presence returns once that turn settles on the same durable failure.
    const booting = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
    expect(booting?.availability).toBe('active')
    expect(booting?.presence).toBe('working')
    const agent = ctx.agents.get(booting!.member.sessionId)!
    await agent.whenIdle()
    const after = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
    expect(after?.presence).toBe('error')
    expect(after?.diagnostic).toMatchObject({ class: 'runtime' })
    expect(after?.diagnostic?.detail).toContain('401')
  })

  it('reports an unexpected Team wake cancellation before turn start without blaming ordinary notice replacement', async () => {
    const adapter = new EmptyAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('pre-turn-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('pre-turn-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const discarded: string[] = []
    ctx.on('agent/inbox/discarded', ({ message }) => { discarded.push(message.id) })
    // Park every Team wake instead of letting an idle Agent run and claim it:
    // the reproduced bug is a wake that is queued and then discarded with no
    // turn/start, which the live loop only produces from a maintenance-latched
    // wake cleared before convergence. Parking reaches that end-state directly.
    const steer = vi.spyOn(agent, 'steer').mockImplementation(input => { agent.inbox.append('next-turn', input) })

    const first = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('pre-turn-first'), workspaceId, projectRef: project.project.projectRef, body: '@builder investigate' })
    expect(first.kind).toBe('committed')
    const firstNotice = agent.inbox.nextTurn.at(-1)!
    expect(firstNotice.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'notice' })
    expect((ctx.agentTeam as unknown as { pendingTeamWakes: Map<string, unknown> }).pendingTeamWakes.has(firstNotice.id)).toBe(true)

    const second = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('pre-turn-second'), workspaceId, projectRef: project.project.projectRef, body: '@builder investigate again' })
    expect(second.kind).toBe('committed')
    const replacement = ctx.agentTeam.members().find(status => status.member.memberId === added.status.member.memberId)!
    expect(replacement.diagnostic).toBeUndefined()
    expect(agent.inbox.nextTurn).toHaveLength(1)
    const replacementNotice = agent.inbox.nextTurn[0]!
    expect(replacementNotice.id).not.toBe(firstNotice.id)
    expect(agent.inbox.remove(replacementNotice.id)).toBe(true)
    expect(discarded).toContain(replacementNotice.id)

    const failed = ctx.agentTeam.members().find(status => status.member.memberId === added.status.member.memberId)!
    expect(failed).toMatchObject({ presence: 'error', diagnostic: {
      class: 'runtime', source: 'agent/inbox/discarded', sessionId: added.status.member.sessionId,
    } })
    expect(failed.diagnostic?.occurredAt).toEqual(expect.any(String))
    steer.mockRestore()
  })

  it('restarts a Member whose activation failed and rejects restart for suspended Members', async () => {
    const { ctx, workspaceId, presets } = await realHarness()
    presets.failingMount = true
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [] })
    expect(added.status.availability).toBe('unavailable')
    expect(added.status.presence).toBe('unavailable')
    expect(added.status.diagnostic).toMatchObject({ class: 'preset-composition' })
    expect(added.status.diagnostic?.detail).toContain('failed to load')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()

    presets.failingMount = false
    const restarted = await ctx.agentTeam.recoverMember({ requestId: requestId('restart'), workspaceId, memberId: added.status.member.memberId })
    expect(restarted.status.availability).toBe('active')
    expect(restarted.status.member.sessionId).toBe(added.status.member.sessionId)
    const live = ctx.agents.get(restarted.status.member.sessionId)!
    expect(ctx.tools.schemas(live).length).toBeGreaterThan(0)
    // Restart is runtime-only: the durable ledger stays replay-consistent.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: added.status.member.memberId })
    await expect(ctx.agentTeam.recoverMember({ requestId: requestId('restart-suspended'), workspaceId, memberId: added.status.member.memberId }))
      .rejects.toThrow('only enabled Members can be restarted')
  })

  it('resumes a suspended Member without consulting the persistence tree walk', async () => {
    const { ctx, workspaceId } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('resume-add'), workspaceId, handle: 'restorer', description: 'Restores the exact session', presetId: 'team-member', projectRefs: [] })
    expect(added.status.availability).toBe('active')
    const memberId = added.status.member.memberId
    await ctx.agentTeam.suspendMember({ requestId: requestId('resume-suspend'), memberId })

    // The Host retires the suspended log fire-and-forget, and the JSONL
    // backend publishes its win32 directories through transient staging
    // entries; a tree walk concurrent with that retirement sees ENOENT. The
    // resume path must rely on agents.resume() waiting for the retirement
    // instead of re-listing, so any consult here fails the test loudly.
    ctx.sessionPersistence.list = async () => { throw persistenceRaceError() }
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-resume'), memberId })
    expect(resumed.status.availability, JSON.stringify(resumed.status)).toBe('active')
    expect(ctx.agents.get(resumed.status.member.sessionId)).toBeDefined()
  })

  it('retries a transient persistence walk failure while restarting a Member', async () => {
    const { ctx, workspaceId, teamFiber } = await realHarness()
    await ctx.agentTeam.addMember({ requestId: requestId('retry-add'), workspaceId, handle: 'retrier', description: 'Survives a transient walk failure', presetId: 'team-member', projectRefs: [] })

    // Host restart remounts the plugin and the startup restore walks the
    // persistence tree once for every Member. The previous generation's
    // retirement is still draining in the background; that walk sees the
    // JSONL backend's transient staging entries as ENOENT. One injected
    // failure must not fail the restore: the idempotent read retries and
    // activation proceeds on whichever branch the second read supports.
    await teamFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    const realList = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
    let consulted = 0
    ctx.sessionPersistence.list = async () => {
      consulted += 1
      if (consulted === 1) throw persistenceRaceError()
      return realList()
    }
    await ctx.plugin(AgentTeam)
    const restored = await waitFor(() => {
      const status = ctx.agentTeam.members().find(item => item.member.handle === 'retrier')
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(restored.member.handle).toBe('retrier')
    expect(consulted).toBe(2)
  })

  it('creates a Member with no description and no Projects and lights delivery on mention', async () => {
    const { ctx, workspaceId, teamFiber } = await realHarness()
    const bare = await ctx.agentTeam.addMember({ requestId: requestId('bare'), workspaceId, handle: 'bare', description: '', presetId: 'team-member', projectRefs: [] })
    expect(bare.status.availability).toBe('active')
    expect(bare.status.member.description).toBe('')
    // The invariant companion replays the same durable record shape; an empty
    // initial Project list is valid and must not be rejected as divergent.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    expect(ctx.agentTeam.status().agentMemberCount).toBe(1)
    const agent = ctx.agents.get(bare.status.member.sessionId)!
    expect(agent).toBeDefined()

    // A message to an empty Project commits with an empty notification set.
    const project = await ctx.agentTeam.createProject({ requestId: requestId('bare-project'), workspaceId, name: 'ops', description: 'Ops work' })
    const before = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('pre-join'), workspaceId, projectRef: project.project.projectRef, body: 'Posted before anyone joined' })
    expect(before.kind).toBe('committed')
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })

    // Project enrolment is retired — membership is derived from participation
    // — so a Workspace participant with no Projects at all is reachable by
    // mention, and that mention is what lights the delivery chain.
    const after = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('post-join'), workspaceId, projectRef: project.project.projectRef, body: '@bare Pinged without joining' })
    expect(after.kind).toBe('committed')
    if (after.kind !== 'committed') throw new Error(`expected committed mention, received ${after.kind}`)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: after.task!.taskRef }), directCount: 1 })] })
  })

  it('requires referenced Project authority and rejects an incomplete Team preset before publication', async () => {
    const { ctx, workspaceId } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    await expect(ctx.agentTeam.addMember({ requestId: requestId('wrong-workspace'), workspaceId, handle: 'wrong', description: 'Wrong project', presetId: 'team-member', projectRefs: ['project:missing' as AgentTeamProjectRef] })).rejects.toThrow(/unknown Project/)
    const first = await ctx.agentTeam.addMember({ requestId: requestId('first'), workspaceId, handle: 'first', description: 'First', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    await expect(ctx.agentTeam.addMember({ requestId: requestId('duplicate'), workspaceId, handle: 'FIRST', description: 'Duplicate', presetId: 'team-member', projectRefs: [project.project.projectRef] })).rejects.toThrow(/already active/)
    expect(first.status.member.state).toBe('enabled')
  })

  it('runs the five-tool pull protocol through one live Team Member', async () => {
    const { ctx, workspaceId } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('protocol-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('protocol-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('protocol-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-${++callNumber}`), name, arguments: args, agent })
      expect(result.isError, `${name} ${JSON.stringify(args)}: ${result.isError ? result.error.message : 'ok'}`).toBe(false)
      expect(result.concludesTurn).toBeUndefined()
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    const discovered = await call('team_view', {})
    expect(discovered.projects).toEqual([{ projectRef: project.project.projectRef, name: 'engineering', role: 'member', owners: ['human'] }])
    expect(discovered.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'human' }),
      expect.objectContaining({ memberId: builder.status.member.memberId, handle: 'builder' }),
      expect.objectContaining({ memberId: reviewer.status.member.memberId, handle: 'reviewer' }),
    ]))
    expect(discovered).not.toHaveProperty('items')
    expect(ctx.tools.schemas(agent).every(schema => !Object.hasOwn(schema.parameters.properties ?? {}, 'workspaceId'))).toBe(true)

    // team_view enumerates every top-level Thread of joined Projects, taskless
    // included, without message bodies: a Member who joined late and was never
    // mentioned can discover prior discussions and address them by ref (issue #2).
    const beforeThreads = await call('team_view', {})
    expect(beforeThreads.threads).toEqual([])
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('protocol-owner'), workspaceId, projectRef: project.project.projectRef, memberId: builder.status.member.memberId })
    const plainStart = await call('team_message', { action: 'start', projectRef: project.project.projectRef, body: 'Agent-led taskless discussion' })
    expect(plainStart).toMatchObject({ kind: 'committed' })
    const taskfulStart = await call('team_message', { action: 'start', kind: 'task', projectRef: project.project.projectRef, body: 'Agent-led task with work' })
    expect(taskfulStart).toMatchObject({ kind: 'committed' })
    await call('team_message', { action: 'reply', threadRef: plainStart.threadRef, body: 'One follow-up reply', baseRevision: plainStart.revision })
    const threadDirectory = await call('team_view', {})
    expect(threadDirectory.threads).toHaveLength(2)
    const taskless = threadDirectory.threads.find((thread: { threadRef: string }) => thread.threadRef === plainStart.threadRef)
    expect(taskless).toMatchObject({ projectRef: project.project.projectRef, messageCount: 2 })
    expect(taskless.taskRef).toBeUndefined()
    const taskful = threadDirectory.threads.find((thread: { threadRef: string }) => thread.threadRef === taskfulStart.threadRef)
    expect(taskful).toMatchObject({ projectRef: project.project.projectRef, messageCount: 1, taskRef: taskfulStart.taskRef, status: 'todo' })
    expect(typeof taskful.taskNumber).toBe('number')
    // Directory entries stay address-book summaries: each Thread row carries
    // its bounded anchor subject (the approved output enrichment), and reply
    // bodies still never leak — only the anchor becomes the subject.
    expect(taskless.subject).toBe('Agent-led taskless discussion')
    expect(JSON.stringify(threadDirectory.threads)).not.toContain('One follow-up reply')
    // A second Member who joined after both Threads started sees them too.
    const lateJoinerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
    const lateJoinerView = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-${++callNumber}`), name: 'team_view', arguments: {}, agent: lateJoinerAgent }).then(result => {
      expect(result.isError).toBe(false)
      return result.value as Record<string, any>
    })
    expect(lateJoinerView.threads.map((thread: { threadRef: string }) => thread.threadRef)).toEqual(expect.arrayContaining([plainStart.threadRef, taskfulStart.threadRef]))
    // Threads in a Project the Member has not joined stay invisible.
    const privateProject = await ctx.agentTeam.createProject({ requestId: requestId('protocol-private'), workspaceId, name: 'private', description: 'Unjoined' })
    const privateStart = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('protocol-private-start'), workspaceId, projectRef: privateProject.project.projectRef, body: 'Taskless discussion outside membership' })
    expect(privateStart).toMatchObject({ kind: 'committed' })
    const privateThreadRef = (privateStart as { thread: { threadRef: string } }).thread.threadRef
    const afterPrivate = await call('team_view', {})
    expect(afterPrivate.threads.some((thread: { threadRef: string }) => thread.threadRef === privateThreadRef)).toBe(false)
    expect(afterPrivate.projects.some((entry: { projectRef: string }) => entry.projectRef === privateProject.project.projectRef)).toBe(false)

    // team_message attachments: the tool passes absolute paths, the Host
    // validates and copies them into the cache, and the committed message
    // carries the same metadata and prompt lines as a manual upload.
    const shotPath = join(process.env.DSH_HOME!, 'protocol-shot.png')
    await writeFile(shotPath, Buffer.from('png-bytes'))
    const shotMessage = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: 'Agent-created task with a screenshot', attachments: [shotPath] })
    expect(shotMessage).toMatchObject({ kind: 'committed' })
    const shotThreadRef = (shotMessage as { threadRef: string }).threadRef
    const shotHistory = ctx.agentTeam.threadHistory({ workspaceId, threadRef: shotThreadRef as never })
    const shotFact = shotHistory.facts.find(fact => fact.kind === 'message' && fact.message.attachments !== undefined)
    expect(shotFact).toBeDefined()
    expect(shotHistory.facts.some(fact => fact.kind === 'message' && new RegExp(`\\[attachment\\] .*attachments${sep === '/' ? '\\/' : '\\\\'}v1${sep === '/' ? '\\/' : '\\\\'}`).test(fact.message?.body ?? ''))).toBe(true)
    const rejected = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-bad-${++callNumber}`), name: 'team_message', arguments: { action: 'start', projectRef: project.project.projectRef, body: 'Never committed', attachments: ['relative/shot.png'] }, agent })
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message ?? rejected.value).toMatch(/must be absolute/)
    expect(ctx.agentTeam.threadHistory({ workspaceId, threadRef: shotThreadRef as never }).facts.some(fact => fact.kind === 'message' && fact.message?.body === 'Never committed')).toBe(false)

    const agentStarted = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: 'Agent-created task for @human' })
    expect(agentStarted).toMatchObject({ kind: 'committed' })
    expect(ctx.agentTeam.inbox({ workspaceId })).toMatchObject({ totalDirectCount: 1,
      items: [expect.objectContaining({ directCount: 1 })] })
    expect(await call('team_attention', { action: 'unfollow', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'unfollow', following: false })
    expect(await call('team_attention', { action: 'follow', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'follow', following: true })
    expect(await call('team_attention', { action: 'status', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'status', following: true })

    const enrolled = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: 'Agent-led task for @reviewer' })
    expect(enrolled).toMatchObject({ kind: 'committed', threadRef: expect.any(String) })
    const enrolledThreadRef = (enrolled as { threadRef: string }).threadRef
    const reviewerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
    const reviewerInbox = ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId })
    expect(reviewerInbox).toMatchObject({ totalDirectCount: 1,
      items: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: enrolledThreadRef }), directCount: 1 })] })
    expect(reviewerInbox.items[0]!.task).toBeUndefined()
    // Being named delivers a notice; following the Thread stays the Member's own choice.
    expect(ctx.agentTeam.attentionStatusForAgent(reviewerAgent, { workspaceId, threadRef: enrolledThreadRef as never }).attention).toBeUndefined()

    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('protocol-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the pull protocol' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const background = await ctx.agentTeam.reply({ requestId: requestId('protocol-background'), workspaceId, taskRef: started.task!.taskRef, body: 'Older context', baseRevision: started.thread.revision })
    if (background.kind !== 'committed') throw new Error(`expected committed background, received ${background.kind}`)
    const invitation = await ctx.agentTeam.reply({ requestId: requestId('protocol-invite'), workspaceId, taskRef: started.task!.taskRef, body: '@builder Builder, please investigate', baseRevision: background.thread.revision })
    if (invitation.kind !== 'committed') throw new Error(`expected committed invitation, received ${invitation.kind}`)

    const inbox = await call('team_inbox', {})
    // An owner learns of the ownership change as a Main stream marker, and the
    // invitation as a Thread marker: two direct notices, no body text.
    expect(inbox).toMatchObject({ totalDirectCount: 2, items: [expect.objectContaining({ taskRef: started.task!.taskRef, directCount: 1 })],
      main: [expect.objectContaining({ directCount: 1 })] })
    expect(JSON.stringify(inbox)).not.toContain('Builder, please investigate')

    const firstRead = await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(firstRead).toMatchObject({
      kind: 'read', taskRef: started.task!.taskRef, status: 'todo', resolution: 'open', following: false,
      anchor: { body: 'Investigate the pull protocol' }, claims: [],
    })
    expect(firstRead.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: '@builder Builder, please investigate', unread: true, direct: true }),
    ]))

    // A mention delivers a notice; the Member follows the Thread by choosing to.
    expect(await call('team_attention', { action: 'follow', taskRef: started.task!.taskRef })).toMatchObject({ kind: 'follow', following: true })
    const update = await ctx.agentTeam.reply({ requestId: requestId('protocol-update'), workspaceId, taskRef: started.task!.taskRef, body: 'New evidence', baseRevision: invitation.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Premature reply', baseRevision: invitation.thread.revision }))
      .toMatchObject({ kind: 'unread_required', revision: update.thread.revision, unreadCount: 1 })
    await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Stale reply', baseRevision: invitation.thread.revision }))
      .toMatchObject({ kind: 'stale_revision', expectedRevision: invitation.thread.revision, revision: update.thread.revision })
    const reply = await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Current reply', baseRevision: update.thread.revision })
    expect(reply).toMatchObject({ kind: 'committed', taskRef: started.task!.taskRef })

    // A reply naming a Project Member who has never taken part in this Thread
    // delivers a notice to them without making them follow it.
    const dropped = await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: '@reviewer, please look', baseRevision: reply.revision })
    expect(dropped).toMatchObject({ kind: 'committed', taskRef: started.task!.taskRef, threadRef: started.thread.threadRef })
    expect(dropped.undeliveredMentions).toBeUndefined()
    expect(ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId }).items.map(item => item.thread.threadRef).sort()).toEqual([enrolledThreadRef, started.thread.threadRef].sort())

    expect(await call('team_attention', { action: 'unfollow', taskRef: started.task!.taskRef })).toMatchObject({ following: false })
    const claim = await call('team_task', { action: 'claim', taskRef: started.task!.taskRef, direction: 'implementation', baseRevision: dropped.revision })
    // A committed Claim mutation returns the authoritative affected Claim;
    // the structured claims archive and Task status stay real (compat) —
    // the render is what omits the archive, never the structured value.
    expect(claim).toMatchObject({ kind: 'committed', action: 'claim', threadRef: started.thread.threadRef, status: 'in_progress',
      claim: expect.objectContaining({ owner: builder.status.member.memberId, direction: 'implementation', state: 'active' }),
      claims: [expect.objectContaining({ owner: builder.status.member.memberId, direction: 'implementation', state: 'active' })] })
    expect(await call('team_attention', { action: 'status', taskRef: started.task!.taskRef })).toMatchObject({ following: true })
    expect(await call('team_task', { action: 'list', taskRef: started.task!.taskRef })).toMatchObject({ kind: 'listed', claims: [expect.objectContaining({ direction: 'implementation' })] })
    const done = await call('team_task', { action: 'done', taskRef: started.task!.taskRef, claimRef: claim.claim.claimRef, baseRevision: claim.revision })
    expect(done).toMatchObject({ kind: 'committed', action: 'done', status: 'in_review', claim: expect.objectContaining({ state: 'done' }),
      claims: [expect.objectContaining({ direction: 'implementation', state: 'done' })] })
    const secondClaim = await call('team_task', { action: 'claim', taskRef: started.task!.taskRef, direction: 'follow-up', baseRevision: done.revision })
    const released = await call('team_task', { action: 'release', taskRef: started.task!.taskRef, claimRef: secondClaim.claim.claimRef, baseRevision: secondClaim.revision })
    expect(released).toMatchObject({ kind: 'committed', action: 'release', claim: expect.objectContaining({ direction: 'follow-up', state: 'released' }),
      claims: [expect.objectContaining({ direction: 'implementation', state: 'done' }), expect.objectContaining({ direction: 'follow-up', state: 'released' })] })

    const humanReadAfterClaims = await ctx.agentTeam.readThread({ requestId: requestId('protocol-human-read-after-claims'), workspaceId,
      taskRef: started.task!.taskRef })
    const unreadAfterClaims = await ctx.agentTeam.reply({ requestId: requestId('protocol-history-unread'), workspaceId,
      taskRef: started.task!.taskRef, body: 'Unread during history', baseRevision: humanReadAfterClaims.thread.revision })
    if (unreadAfterClaims.kind !== 'committed') throw new Error(`expected committed history update, received ${unreadAfterClaims.kind}`)
    const history = await call('team_thread', { action: 'history', taskRef: started.task!.taskRef, limit: 2 })
    expect(history).toMatchObject({ kind: 'history', anchor: { body: 'Investigate the pull protocol' }, claims: expect.arrayContaining([expect.objectContaining({ direction: 'implementation' })]) })
    expect(typeof history.cursor).toBe('number')
    // The owner-change Main stream marker is still unread; only the Thread row carries new work.
    expect(await call('team_inbox', {})).toMatchObject({ totalUnreadCount: 2, items: [expect.objectContaining({ taskRef: started.task!.taskRef })],
      main: [expect.objectContaining({ unreadCount: 1 })] })
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'History did not read', baseRevision: unreadAfterClaims.thread.revision }))
      .toMatchObject({ kind: 'unread_required', unreadCount: 1 })
    await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(await call('team_inbox', {})).toMatchObject({ totalUnreadCount: 1, items: [], main: [expect.objectContaining({ unreadCount: 1 })] })
  })

  it('delivers a direct message through the tool and injects it into the live recipient session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('dm-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('dm-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('dm-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const sender = ctx.agents.get(builder.status.member.sessionId)!
    const recipient = ctx.agents.get(reviewer.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-${++callNumber}`), name, arguments: args, agent: sender })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    // The recipient's model answers briefly; the DM relay is one user turn.
    const sent = await call('team_dm', { memberRef: reviewer.status.member.memberId, body: 'quick check: is the build green?' })
    expect(sent).toMatchObject({ kind: 'dm-sent', recipientMemberId: reviewer.status.member.memberId, recipientHandle: 'reviewer', delivered: true })
    expect(sent).toMatchObject({ kind: 'dm-sent', recipientMemberId: reviewer.status.member.memberId, recipientHandle: 'reviewer', delivered: true })

    // The injected relay carries the DM body, the sender attribution, and the
    // plugin relay source; it is durable in the recipient's session log.
    adapter.enqueue(textResponse('Build is green.'))
    await waitForIdle(ctx, recipient)
    const relay = recipient.session.ownEvents().findLast(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(relay).toBeDefined()
    const relayData = relay!.data as { content: Array<{ type: string; text: string }>; source: { kind: string; form: string } }
    expect(relayData.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' })
    expect(relayData.content[0]!.text).toContain('Direct message from @builder')
    expect(relayData.content[0]!.text).toContain('quick check: is the build green?')

    // Audit-only: no Thread or Message appears in the Project, and neither
    // Member's Inbox gains unread work from the DM.
    const view = ctx.agentTeam.view({ workspaceId })
    expect(view.threads).toHaveLength(0)
    expect(view.items).toHaveLength(0)
    expect(ctx.agentTeam.inboxForAgent(recipient, { workspaceId })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    // A second DM carries the bounded adjacent context of the first exchange:
    // the context line cites the prior DM's body, never the one being sent.
    // Direction is from the reader's perspective: the cited DM came from the
    // other Member (the sender), so the reviewer reads (them → you).
    const second = await call('team_dm', { memberRef: reviewer.status.member.memberId, body: 'still green?' })
    expect(second).toMatchObject({ kind: 'dm-sent', delivered: true })
    adapter.enqueue(textResponse('Still green.'))
    await waitForIdle(ctx, recipient)
    const relays = recipient.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(relays).toHaveLength(2)
    const secondText = (relays[1]!.data as { content: Array<{ type: string; text: string }> }).content[0]!.text
    expect(secondText).toContain('most recent prior DM')
    expect(secondText).toMatch(/\(them → you, at [^)]+\+08:00\) quick check: is the build green\?/)
    expect(secondText.slice(secondText.indexOf('[most recent prior DM'))).not.toContain('still green?')

    // A reply DM in the mirror direction: the builder now reads the reviewer's
    // prior DM, which the reader received from the other Member — but the
    // latest prior exchange from the reader's own side is the builder's own
    // 'still green?', so the reader (builder) reads (you → them).
    adapter.enqueue(textResponse('Thanks.'))
    const replyFromReviewer = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-mirror-${++callNumber}`), name: 'team_dm', arguments: { memberRef: builder.status.member.memberId, body: 'yes, all green' }, agent: recipient })
    expect(replyFromReviewer.isError).toBe(false)
    adapter.enqueue(textResponse('Noted.'))
    await waitForIdle(ctx, sender)
    const senderRelays = sender.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(senderRelays).toHaveLength(1)
    const mirrorText = (senderRelays[0]!.data as { content: Array<{ type: string; text: string }> }).content[0]!.text
    expect(mirrorText).toMatch(/\(you → them, at [^)]+\+08:00\) still green\?/)

    // Parameter matrix: human recipients, unknown Members, and stray fields.
    const bad = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-bad-${++callNumber}`), name: 'team_dm', arguments: { memberRef: AGENT_TEAM_HUMAN_MEMBER_ID, body: 'hi' }, agent: sender })
    expect(bad.isError).toBe(true)
    expect(bad.error?.message ?? '').toMatch(/Agent Member/)
    expect(bad.error?.message ?? '').toMatch(/Agent Member/)
    const unknown = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-unknown-${++callNumber}`), name: 'team_dm', arguments: { memberRef: 'member:nobody', body: 'hi' }, agent: sender })
    expect(unknown.isError).toBe(true)
    // A Thread write's parameters are not merely ignored here: the schema does
    // not carry them, so a model reaching for one is refused before the Host.
    const stray = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-stray-${++callNumber}`), name: 'team_dm', arguments: { memberRef: reviewer.status.member.memberId, body: 'hi', projectRef: project.project.projectRef }, agent: sender })
    expect(stray.isError).toBe(true)
    expect(stray.error?.message ?? '').toMatch(/does not accept|unexpected/i)

    // A suspended peer is not a sendable target: the ledger rejects the send
    // outright (nothing is recorded), which is the pre-delivery guard.
    await ctx.agentTeam.suspendMember({ requestId: requestId('dm-suspend'), memberId: reviewer.status.member.memberId })
    const suspended = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-suspended-${++callNumber}`), name: 'team_dm', arguments: { memberRef: reviewer.status.member.memberId, body: 'are you back?' }, agent: sender })
    expect(suspended.isError).toBe(true)
    expect(suspended.error?.message ?? '').toMatch(/suspended/)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    // Missing live session: an enabled Member whose handle is gone records
    // the DM durably but surfaces the structured delivery error to the sender.
    await ctx.agentTeam.resumeMember({ requestId: requestId('dm-resume'), memberId: reviewer.status.member.memberId })
    ctx.agentTeam['handles'].delete(reviewer.status.member.memberId)
    const beforeUndeliveredDm = ctx.agentTeam.status().sequence
    await expect(ctx.agentTeam.dmForAgent(sender, { requestId: requestId('dm-undelivered'), workspaceId,
      recipientMemberId: reviewer.status.member.memberId, body: 'are you back?' })).rejects.toMatchObject({ name: 'AgentTeamDmDeliveryError', recipientHandle: 'reviewer' })
    // The delivery error reports a committed write, not a failed one: the
    // dm-sent operation is the durable fact the error is talking about.
    expect(ctx.agentTeam.status().sequence).toBe(beforeUndeliveredDm + 1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('injects one durable clock snapshot at turn start and stays quiet within the refresh interval', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('clock-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('clock-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('clock-start'), workspaceId, projectRef: project.project.projectRef,
      body: '@builder Drive the clock' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)

    // One real, tool-dense Member turn from the direct-mention wake: two
    // tool steps, then the closing text. The turn's first step appends one
    // durable clock snapshot; the quick follow-up steps fall inside the
    // default refresh interval and stay quiet, so the whole turn produces
    // exactly one snapshot line.
    adapter.enqueue(toolCallResponse('clock-tool-1', 'team_view', {}))
    adapter.enqueue(toolCallResponse('clock-tool-2', 'team_inbox', {}))
    adapter.enqueue(textResponse('Clock observed.'))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(3)
    const first = JSON.stringify(adapter.requests[0]!.messages)
    // The snapshot is model-visible inside the turn's first request.
    expect(first).toContain('Team clock sampled while preparing turn ')
    expect(first).toContain('Team collaboration timestamps use UTC+8.')
    const last = JSON.stringify(adapter.requests[2]!.messages)
    // The closing step still carries the turn's single snapshot in history.
    const lastSnapshots = adapter.requests[2]!.messages.filter(message =>
      (message as { source?: { kind?: string } }).source?.kind === 'wowyuarm-agent-team-member-time-context')
    expect(lastSnapshots).toHaveLength(1)
    expect(last).toContain('Team clock sampled while preparing turn ')
    const snapshots = agent.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { kind?: string; form?: string } }).source?.kind === 'wowyuarm-agent-team-member-time-context')
    expect(snapshots).toHaveLength(1)
    const data = snapshots[0]!.data as { content: Array<{ type: string; text: string }>; source: { kind: string; form: string; sections?: unknown[] } }
    expect(data.source.form).toBe('snapshot')
    // ContextFormed snapshot messages must carry sections.
    expect(Array.isArray(data.source.sections)).toBe(true)
    const text = data.content[0]!.text
    expect(text).toContain('Team clock sampled while preparing turn ')
    expect(text).toMatch(/Elapsed since the preceding model-visible event: (unavailable|[0-9dhms ]+)\./)
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
    // Absolute instants only: no relative time vocabulary.
    expect(text).not.toContain(' ago')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('returns a rejected Team result to the next model step without ending the turn', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('loop-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('loop-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('loop-start'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the rejection flow' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('loop-follow'), workspaceId,
      taskRef: started.task!.taskRef, action: 'follow' })
    const firstRead = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('loop-read'), workspaceId,
      taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('loop-update'), workspaceId,
      taskRef: started.task!.taskRef, body: 'Newer context arrived', baseRevision: firstRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)

    adapter.enqueue(toolCallResponse('model-team-view', 'team_view', {}))
    adapter.enqueue(toolCallResponse('model-team-rejected', 'team_message', { action: 'reply',
      taskRef: started.task!.taskRef, body: 'Premature reply', baseRevision: update.thread.revision }))
    adapter.enqueue(textResponse('I will read the Thread before replying.'))

    // The committed Human update leaves durable unread work, so its pending
    // hint wakes the idle Member; that wake carries the model steps under test.
    const idle = waitForIdle(ctx, agent)
    await idle

    expect(adapter.requests).toHaveLength(3)
    const afterRejection = JSON.stringify(adapter.requests[2]!.messages)
    expect(afterRejection).toContain(started.task!.taskRef)
    expect(afterRejection).toContain('unread_required')
    const results = agent.session.ownEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    // 0.1.7 carries the outcome on the message, not inside a tool-result block.
    expect(results.map(result => (result.data.message as { isError?: boolean }).isError)).toEqual([false, false])
  })

  it('coalesces updates and delivers a running Member hint only at the next step boundary', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('safe-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('safe-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('safe-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate safe delivery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('safe-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    let revision = (await ctx.agentTeam.readThread({ requestId: requestId('safe-human-read'), workspaceId, taskRef: started.task!.taskRef })).thread.revision
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start ordinary checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const first = await ctx.agentTeam.reply({ requestId: requestId('safe-update-1'), workspaceId, taskRef: started.task!.taskRef, body: 'First hidden update', baseRevision: revision })
    if (first.kind !== 'committed') throw new Error(`expected committed reply, received ${first.kind}`)
    revision = first.thread.revision
    const second = await ctx.agentTeam.reply({ requestId: requestId('safe-update-2'), workspaceId, taskRef: started.task!.taskRef, body: 'Second hidden update', baseRevision: revision })
    if (second.kind !== 'committed') throw new Error(`expected committed reply, received ${second.kind}`)
    expect(adapter.requests).toHaveLength(1)
    adapter.enqueue(textResponse('I will triage Team Inbox next.'))
    adapter.release.resolve()
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const safeBoundaryRequest = JSON.stringify(adapter.requests[1]!.messages)
    expect(safeBoundaryRequest).toContain('Team Inbox has unread work')
    expect(safeBoundaryRequest).toContain(started.task!.taskRef)
    expect(safeBoundaryRequest).toContain('2 unread updates')
    expect(safeBoundaryRequest).not.toContain('First hidden update')
    expect(safeBoundaryRequest).not.toContain('Second hidden update')
    const hints = agent.session.ownEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('Team Inbox has unread work'))
    expect(hints).toHaveLength(1)
  })

  it('wakes an idle Member with a direct mention body and source', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('top-level-wake-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('top-level-wake-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const committed = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('top-level-wake'), workspaceId, projectRef: project.project.projectRef,
      body: '@builder Please investigate the top-level wake path' })
    expect(committed.kind).toBe('committed')
    expect(adapter.requests).toHaveLength(0)

    adapter.enqueue(textResponse('I will inspect the mentioned Task.'))
    if (committed.kind !== 'committed') throw new Error(`expected committed top-level mention, received ${committed.kind}`)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: committed.task!.taskRef }), directCount: 1 })] })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Direct Team mention')
    expect(request).toContain('Please investigate the top-level wake path')
    // The rendered sender line, not the 'member:human' ids elsewhere in the request.
    expect(request).toContain('From: human')
    expect(request).toContain(committed.task!.taskRef)
    // The notification states the absolute commit instant in UTC+8.
    expect(request).toContain('Occurred at: ')
    expect(request).toMatch(/Occurred at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
  })

  it('delivers a mention in an owner-started Thread to the mentioned Member', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('peer-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const starter = await ctx.agentTeam.addMember({ requestId: requestId('peer-starter'), workspaceId, handle: 'starter', description: 'Starts work', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const peer = await ctx.agentTeam.addMember({ requestId: requestId('peer-peer'), workspaceId, handle: 'peer', description: 'Peers in', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const starterAgent = ctx.agents.get(starter.status.member.sessionId)!
    adapter.enqueue(textResponse('Noted my new ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('peer-owner'), workspaceId, projectRef: project.project.projectRef, memberId: starter.status.member.memberId })
    await starterAgent.whenIdle()
    const peerAgent = ctx.agents.get(peer.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`peer-mention-${++callNumber}`), name, arguments: args, agent: starterAgent })
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    const started = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: '@peer please verify the export path' })
    expect(started).toMatchObject({ kind: 'committed' })

    expect(ctx.agentTeam.inboxForAgent(peerAgent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.threadRef }), directCount: 1 })] })
    expect(ctx.agentTeam.inboxForAgent(peerAgent, { workspaceId }).items[0]!.task).toBeUndefined()

    adapter.enqueue(textResponse('I will verify the export path.'))
    await peerAgent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const request = JSON.stringify(adapter.requests[1]!.messages)
    expect(request).toContain('Direct Team mention')
    expect(request).toContain('@peer please verify the export path')
    expect(request).toContain('starter')
    expect(request).toContain(started.threadRef)
    expect(request).not.toContain('Task undefined')
    expect(request).toContain('workspace and threadRef for missing context and to acknowledge unread updates')
    expect(request).toContain('Complete Message facts shown here need not be fetched again just to reconsider a write')
    expect(request).toMatch(/Occurred at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
  })

  it('resolves what replies answer once per read, including restored background', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('reply-window-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('reply-window-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const anchor = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('reply-window-anchor'), workspaceId,
      projectRef: project.project.projectRef, body: 'Please investigate the anchored path' })
    if (anchor.kind !== 'committed') throw new Error('expected committed anchor')

    // The reader drains the anchor first, so both replies below arrive in one
    // batch whose answering target is already behind them.
    await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reply-window-read-1'), workspaceId, taskRef: anchor.task!.taskRef })
    const first = await ctx.agentTeam.reply({ requestId: requestId('reply-window-reply-1'), workspaceId, taskRef: anchor.task!.taskRef,
      baseRevision: anchor.thread.revision, body: '@builder Looking now', replyToMessageRef: anchor.message.messageRef })
    if (first.kind !== 'committed') throw new Error('expected committed first reply')
    const second = await ctx.agentTeam.reply({ requestId: requestId('reply-window-reply-2'), workspaceId, taskRef: anchor.task!.taskRef,
      baseRevision: first.thread.revision, body: '@builder One correction', replyToMessageRef: anchor.message.messageRef })
    if (second.kind !== 'committed') throw new Error('expected committed second reply')

    const spy = vi.spyOn(AgentTeamLedger.prototype, 'resolveMessageRefs')
    const read = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reply-window-read-2'), workspaceId, taskRef: anchor.task!.taskRef })
    const resolving = spy.mock.calls.filter(([, refs]) => refs.length > 0)
    spy.mockRestore()
    // The parent is asked for once for the whole window, not once per reply.
    expect(resolving).toHaveLength(1)

    const answered = read.facts.filter(entry => entry.fact.kind === 'message' && entry.fact.replyTo !== undefined)
    expect(answered).toHaveLength(2)
    for (const entry of answered) {
      if (entry.fact.kind !== 'message') continue
      // Reply context remains a Host projection even when the anchor is restored.
      expect(entry.fact.replyTo).toEqual({ sender: 'human', excerpt: 'Please investigate the anchored path' })
    }
    // Returning a Host result alone never places its text in the Member's Session.
    expect(read.facts.some(entry => entry.fact.kind === 'message' && entry.fact.message.messageRef === anchor.message.messageRef && !entry.unread)).toBe(true)

    // The context is a projection this read added, not a durable fact: the
    // stored records keep the shape their schema declares. Writing it into a
    // record is what stops a whole domain from reopening.
    const records = JSON.stringify([...(ctx.get('storageDomain') as DomainFacility)
      .get('agent_team')!.table('operations').entries()])
    expect(records).toContain('Looking now')
    // The durable link is `replyToMessageRef`; the resolved `replyTo` is not.
    expect(records).toContain('replyToMessageRef')
    expect(records).not.toContain('"replyTo":')
  })

  it('names what a reply answers in the mention notice, with the ref it hands back', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('replies-to-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('replies-to-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    // The anchor mentions nobody, so the only wake below is the reply's.
    const anchor = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('replies-to-anchor'), workspaceId,
      projectRef: project.project.projectRef, body: 'Please investigate the anchored path' })
    if (anchor.kind !== 'committed') throw new Error('expected committed anchor')
    // Following first: a Human reply naming a Member who is not yet following
    // goes through the one-use confirmation, which is a different test's subject.
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('replies-to-follow'), workspaceId, taskRef: anchor.task!.taskRef, action: 'follow' })
    const answer = await ctx.agentTeam.reply({ requestId: requestId('replies-to-reply'), workspaceId, taskRef: anchor.task!.taskRef,
      baseRevision: anchor.thread.revision, body: '@builder Answering the anchored path',
      replyToMessageRef: anchor.message.messageRef })
    if (answer.kind !== 'committed') throw new Error('expected committed reply')

    adapter.enqueue(textResponse('Reading the answer.'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Direct Team mention')
    // Author, the original's first line, and the full ref last — the ref is
    // what the reader hands back to team_message.replyToMessageRef.
    // The request is inspected as JSON, so the quoted summary arrives escaped.
    expect(request).toContain('Replies to: @human — \\"Please investigate the anchored path\\"')
    expect(request).toContain(`[${anchor.message.messageRef}]`)
  })

  it('bounds automatic direct context while retaining omitted Messages in durable Inbox', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('bounded-project'), workspaceId,
      name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('bounded-builder'), workspaceId, handle: 'builder',
      description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const started = []
    for (let index = 1; index <= 5; index++) {
      const body = `@builder ${`x${index}`.repeat(4_500)}\nDIRECT-END-${index}`
      const result = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId(`bounded-direct-${index}`), workspaceId,
        projectRef: project.project.projectRef, body })
      if (result.kind !== 'committed') throw new Error(`expected committed direct Message, received ${result.kind}`)
      started.push(result)
    }
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 5, totalDirectCount: 5 })

    adapter.enqueue(textResponse('I will inspect the routed Team work.'))
    adapter.release.resolve()
    await agent.whenIdle()
    const request = JSON.stringify(adapter.requests[1]!.messages)
    expect(request).toContain('More unread work remains in team_inbox')
    expect(request).not.toContain('DIRECT-END-5')

    const omitted = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('bounded-read-omitted'), workspaceId,
      taskRef: started[4]!.task!.taskRef })
    expect(omitted.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ direct: true, fact: expect.objectContaining({ kind: 'message', message: expect.objectContaining({ body: expect.stringContaining('DIRECT-END-5') }) }) }),
    ]))
  })

  it('wakes an affected Member with a Task close and released Claim summary', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('task-update-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('task-update-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('task-update-start'), workspaceId,
      projectRef: project.project.projectRef, body: 'Prepare a close notification test' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('task-update-follow'), workspaceId,
      taskRef: started.task!.taskRef, action: 'follow' })
    const initialRead = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('task-update-agent-read'), workspaceId,
      taskRef: started.task!.taskRef })
    const claim = await ctx.agentTeam.changeClaimForAgent(agent, { requestId: requestId('task-update-claim'), workspaceId,
      taskRef: started.task!.taskRef, action: 'claim', direction: 'browser verification', baseRevision: initialRead.thread.revision })
    expect(claim).toMatchObject({ kind: 'committed', claim: { state: 'active' } })
    if (claim.kind !== 'committed') throw new Error(`expected committed Claim, received ${claim.kind}`)
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('task-update-human-read'), workspaceId,
      taskRef: started.task!.taskRef })

    adapter.enqueue(textResponse('I will stop work on the closed Task.'))
    const closed = await ctx.agentTeam.changeTask({ requestId: requestId('task-update-close'), workspaceId,
      taskRef: started.task!.taskRef, action: 'close', baseRevision: humanRead.thread.revision })
    expect(closed).toMatchObject({ kind: 'committed', task: { resolution: 'closed' }, claims: [
      expect.objectContaining({ claimRef: claim.claim.claimRef, state: 'released' }),
    ] })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Team Task update')
    expect(request).toContain(`human close Task ${started.task!.taskRef}`)
    expect(request).toContain(claim.claim.claimRef)
    expect(request).toContain('Released Claims')
  })

  it('wakes an idle Member from durable Inbox state without injecting Thread bodies', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('wake-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('wake-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('wake-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the wake path' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('wake-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('wake-human-read'), workspaceId, taskRef: started.task!.taskRef })
    adapter.enqueue(textResponse('I will inspect Team Inbox.'))
    const first = await ctx.agentTeam.reply({ requestId: requestId('wake-reply-1'), workspaceId, taskRef: started.task!.taskRef, body: 'Please inspect the durable wake.', baseRevision: humanRead.thread.revision })
    if (first.kind !== 'committed') throw new Error(`expected committed reply, received ${first.kind}`)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Team Inbox has unread work')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Please inspect the durable wake.')

    adapter.enqueue(textResponse('I will triage both updates.'))
    const second = await ctx.agentTeam.reply({ requestId: requestId('wake-reply-2'), workspaceId, taskRef: started.task!.taskRef, body: 'A second update should coalesce.', baseRevision: first.thread.revision })
    if (second.kind !== 'committed') throw new Error(`expected committed reply, received ${second.kind}`)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).not.toContain('A second update should coalesce.')
  })

  it('recovers a needed hint from durable unread state on Member resume', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('resume-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('resume-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('resume-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate resume recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('resume-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('resume-human-read'), workspaceId, taskRef: started.task!.taskRef })
    await ctx.agentTeam.suspendMember({ requestId: requestId('resume-suspend'), memberId: builder.status.member.memberId })
    const update = await ctx.agentTeam.reply({ requestId: requestId('resume-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread while suspended', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)

    adapter.enqueue(textResponse('I will inspect recovered Inbox work.'))
    await ctx.agentTeam.resumeMember({ requestId: requestId('resume-enable'), memberId: builder.status.member.memberId })
    const resumed = ctx.agents.get(builder.status.member.sessionId)!
    await resumed.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Team Inbox has unread work')
    expect(request).not.toContain('Unread while suspended')
  })

  it('keeps the automatic recovery instruction with durable Inbox routing', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('automatic-recovery-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('automatic-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('automatic-recovery-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate automatic recovery' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('automatic-recovery-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('automatic-recovery-read'), workspaceId, taskRef: started.task!.taskRef })
      const update = await ctx.agentTeam.reply({ requestId: requestId('automatic-recovery-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through automatic recovery', baseRevision: humanRead.thread.revision })
      if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
      await agent.whenIdle()
      ctx.emit('agent/error', { agent, turn: 2, step: 1, error: new Error('fetch failed') })

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)
      await agent.whenIdle()

      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('temporary service error')
      expect(request).toContain('Please continue the work you were doing before the error.')
      expect(request).toContain('Team Inbox has unread work')
      expect(request).toContain(started.task!.taskRef)
      expect(request).not.toContain('Unread through automatic recovery')
      expect(request).not.toMatch(/operator asked|automatic recovery|attempt|stop|handoff/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports automatic recovery classification, wakeup, and stand-down with stable ids', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('recovery-trace-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = builder.status.member.memberId
      const sessionId = builder.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      await agent.whenIdle()
      const info = vi.spyOn(ctx.logger, 'info')
      const warn = vi.spyOn(ctx.logger, 'warn')
      const lines = (spy: typeof info): string[] => spy.mock.calls.map(args => String(args[0]))

      // One recoverable failure: the classification, the occurrence count, and
      // the armed wait are readable before any wakeup happens.
      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('fetch failed') })
      const scheduled = lines(info).find(line => line.includes('automatic recovery scheduled'))
      expect(scheduled).toBeDefined()
      expect(scheduled).toContain(`memberId '${memberId}'`)
      expect(scheduled).toContain(`session '${sessionId}'`)
      expect(scheduled).toContain("errorKind 'transient network'")
      expect(scheduled).toContain('occurrence 1/3')
      expect(scheduled).toContain(`wait ${RECOVERY_DELAY_MS}ms`)

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)
      await agent.whenIdle()
      const steered = lines(info).find(line => line.includes('automatic recovery continuation steered'))
      expect(steered).toBeDefined()
      expect(steered).toContain(`memberId '${memberId}'`)
      expect(steered).toContain(`session '${sessionId}'`)
      expect(steered).toContain('not yet read by the model')

      // Three consecutive occurrences with no clean turn between them stand the
      // episode down, and the stop says how many failures it counted.
      ctx.emit('agent/error', { agent, turn: 2, step: 1, error: new Error('HTTP 429') })
      ctx.emit('agent/error', { agent, turn: 3, step: 1, error: new Error('HTTP 429') })
      ctx.emit('agent/error', { agent, turn: 4, step: 1, error: new Error('ETIMEDOUT') })
      const stoodDown = lines(warn).find(line => line.includes('automatic recovery stood down'))
      expect(stoodDown).toBeDefined()
      expect(stoodDown).toContain(`memberId '${memberId}'`)
      expect(stoodDown).toContain(`session '${sessionId}'`)
      expect(stoodDown).toContain('3/3')
      expect(stoodDown).toContain('no further automatic wakeup')
      info.mockRestore()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an automatic wakeup when a Member is suspended before the delay', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('suspend-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!

      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('fetch failed') })
      await ctx.agentTeam.suspendMember({ requestId: requestId('suspend-recovery'), memberId: builder.status.member.memberId })
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

      expect(adapter.requests).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes a Member for a structured transport failure carried by the Harness event', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('structured-transport-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!

      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new LlmError('DeepSeek Messages transport failed', 'TRANSPORT') })
      adapter.enqueue(textResponse('Continuing after the transport failure.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)
      await agent.whenIdle()

      expect(adapter.requests.length).toBeGreaterThan(0)
      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('temporary service error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a structured terminal failure to manual recovery while keeping its diagnostic', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('structured-terminal-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!

      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new LlmError('upstream answered 429 while settling quota', 'QUOTA', { status: 402 }) })
      adapter.enqueue(textResponse('Never reached.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

      expect(adapter.requests).toEqual([])
      const row = ctx.agentTeam.members().find(status => status.member.memberId === builder.status.member.memberId)
      expect(row).toMatchObject({ availability: 'active', presence: 'error', diagnostic: { class: 'runtime' } })
      expect(row?.diagnostic?.detail).toContain('429')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the manual recovery instruction with durable Inbox routing and cancels the pending wakeup', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('manual-recovery-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('manual-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('manual-recovery-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate manual recovery' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('manual-recovery-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('manual-recovery-read'), workspaceId, taskRef: started.task!.taskRef })
      const update = await ctx.agentTeam.reply({ requestId: requestId('manual-recovery-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through manual recovery', baseRevision: humanRead.thread.revision })
      if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
      await agent.whenIdle()

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      const info = vi.spyOn(ctx.logger, 'info')
      await ctx.agentTeam.recoverMember({ requestId: requestId('manual-recovery'), workspaceId, memberId: builder.status.member.memberId })
      await agent.whenIdle()
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

      // The operator action is traceable to the Member and Session it steered
      // into, and claims a queue — not that the model has read anything.
      const steered = info.mock.calls.map(args => String(args[0])).find(line => line.includes('operator recovery continuation steered'))
      expect(steered).toBeDefined()
      expect(steered).toContain(`memberId '${builder.status.member.memberId}'`)
      expect(steered).toContain(`session '${builder.status.member.sessionId}'`)
      expect(steered).toContain('carrying 1 unread Thread(s)')
      expect(steered).toContain('not yet read by the model')
      info.mockRestore()

      expect(adapter.requests).toHaveLength(2)
      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('The operator asked you to resume after the previous turn ended early.')
      expect(request).not.toContain('temporary service error')
      expect(request).toContain('Please continue the work you were doing before the error.')
      expect(request).toContain('Team Inbox has unread work')
      expect(request).toContain(started.task!.taskRef)
      expect(request).not.toContain('Unread through manual recovery')
      expect(request).not.toMatch(/automatic recovery|attempt|stop|handoff/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reissues a durable hint when a failed Member starts recovery work', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('error-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('error-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('error-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate error recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('error-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('error-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('error-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through runtime error', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)
    await agent.whenIdle()
    expect(ctx.agentTeam.members().find(status => status.member.memberId === builder.status.member.memberId)?.presence).toBe('error')

    adapter.enqueue(textResponse('I will recover by inspecting Team Inbox.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recover now.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const request = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(request).toContain('Team Inbox has unread work')
    expect(request).not.toContain('Unread through runtime error')
  })

  it('reissues a needed hint from durable unread state after Host remount', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('remount-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('remount-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('remount-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate remount recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('remount-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('remount-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('remount-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread across Host remount', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)
    await agent.whenIdle()
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).totalUnreadCount).toBe(1)

    adapter.enqueue(textResponse('I will inspect remounted Inbox work.'))
    const info = vi.spyOn(ctx.logger, 'info')
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = ctx.agents.get(builder.status.member.sessionId)!
    await restored.whenIdle()
    const lastRequest = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(lastRequest).toContain('Team Inbox has unread work')
    expect(lastRequest).not.toContain('Unread across Host remount')

    // The catch-up wake states the lifecycle step that caused it, with the
    // stable Member and Session ids, and claims no more than a queue.
    const queued = info.mock.calls.map(args => String(args[0])).find(line => line.includes('Team Inbox notice queued'))
    expect(queued).toBeDefined()
    expect(queued).toContain(`memberId '${builder.status.member.memberId}'`)
    expect(queued).toContain(`session '${builder.status.member.sessionId}'`)
    expect(queued).toContain('cause Member activation')
    expect(queued).toContain('not yet read by the model')
    info.mockRestore()
  })

  it('surfaces an actionable diagnostic for the tsx source-mode dsh-scope mismatch', () => {
    const message = teamPresetScopeMismatchMessage(true)
    expect(message).toContain('selected preset is not team-enabled')
    expect(message).toContain('running from source via tsx')
    expect(message).toContain('compiled CLI')
    const generic = teamPresetScopeMismatchMessage(false)
    expect(generic).toContain('different physical copies')
    expect(generic).toContain('pnpm install')
  })

  it('keeps a persisted Member session active after switching its model and restarting', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('persisted-model-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'initial-model' },
    })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    adapter.enqueue(textResponse('initial response'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create a persisted transcript.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const edited = await ctx.agentTeam.updateMember({
      requestId: requestId('persisted-model-edit'), memberId: added.status.member.memberId,
      handle: 'builder', description: 'Builds the implementation',
      model: { provider: 'mock', model: 'switched-model' },
    })
    expect(edited.status.availability).toBe('active')

    // Host restart on the persisted Session: the switched selection, not the
    // creation-time model, drives the reactivated Agent.
    await ctx.agentTeam.suspendMember({ requestId: requestId('persisted-model-suspend'), memberId: added.status.member.memberId })
    await teamFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    await ctx.agentTeam.resumeMember({ requestId: requestId('persisted-model-resume'), memberId: added.status.member.memberId })
    const resumed = await waitFor(() => {
      const restarted = ctx.agents.get(added.status.member.sessionId)
      return restarted !== undefined && restarted.status === 'idle' ? restarted : undefined
    })
    adapter.enqueue(textResponse('after the restart.'))
    resumed.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the switched model after the restart.' }], source: { kind: 'user' } }))
    await resumed.whenIdle()
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'mock', model: 'switched-model' })
    expect(ctx.agentTeam.members().find(entry => entry.member.memberId === added.status.member.memberId)!.availability).toBe('active')
  })

  it('applies Member model edits to a live Agent immediately and keeps pinned selections across restarts', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const createSpy = vi.spyOn(ctx.agents, 'create')
    const resumeSpy = vi.spyOn(ctx.agents, 'resume')
    // Activation goes through create or resume depending on whether the
    // Session transcript has been persisted yet; both carry agentOptions.
    const lastActivationOptions = () => {
      const call = resumeSpy.mock.calls.at(-1) ?? createSpy.mock.calls.at(-1)
      expect(call).toBeDefined()
      return call![0]!.agentOptions
    }
    const clearActivationSpies = () => { createSpy.mockClear(); resumeSpy.mockClear() }
    const project = await ctx.agentTeam.createProject({ requestId: requestId('model-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('model-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member',
      projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'pinned-model' },
    })
    const liveAgent = () => ctx.agents.get(added.status.member.sessionId)!
    // Creation activates with the pinned selection instead of the Host default.
    expect(added.status.member.model).toEqual({ provider: 'mock', model: 'pinned-model' })
    expect(lastActivationOptions()).toMatchObject({ provider: 'mock', model: 'pinned-model' })
    const liveBeforeEdit = liveAgent()

    // Editing the model on the ACTIVE Member updates the live selection in
    // place — the same Session id remains usable by the Web Composer.
    clearActivationSpies()
    const edited = await ctx.agentTeam.updateMember({
      requestId: requestId('re-model'), memberId: added.status.member.memberId,
      handle: 'builder', description: 'Builds the implementation',
      model: { provider: 'mock', model: 'switched-model' },
    })
    expect(edited.status.availability).toBe('active')
    expect(edited.status.member.sessionId).toBe(added.status.member.sessionId)
    expect(liveAgent()).toBe(liveBeforeEdit)
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    adapter.enqueue(textResponse('switched response'))
    liveAgent().followup(createUserMessage({ content: [{ type: 'text', text: 'Use the switched model.' }], source: { kind: 'user' } }))
    await liveAgent().whenIdle()
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'mock', model: 'switched-model' })

    // A display-only edit that re-states the current pin leaves the live
    // Agent untouched; an edit that OMITS model clears the override (below).
    clearActivationSpies()
    await ctx.agentTeam.updateMember({ requestId: requestId('desc-only'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things', model: { provider: 'mock', model: 'switched-model' } })
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()

    // Clearing the override updates the same live Agent back to the Host default.
    clearActivationSpies()
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things', model: null })
    expect(cleared.status.member.model).toBeUndefined()
    expect(cleared.status.availability).toBe('active')
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()

    // A pinned selection survives suspend/resume without any further edit.
    await ctx.agentTeam.updateMember({ requestId: requestId('repin'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things', model: { provider: 'mock', model: 'pinned-again' } })
    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: added.status.member.memberId })
    clearActivationSpies()
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: added.status.member.memberId })
    expect(resumed.status.member.model).toEqual({ provider: 'mock', model: 'pinned-again' })
    expect(lastActivationOptions()).toMatchObject({ provider: 'mock', model: 'pinned-again' })
  })
})
