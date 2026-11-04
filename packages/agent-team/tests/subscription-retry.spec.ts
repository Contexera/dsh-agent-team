import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { cleanups, EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'

const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-retry-spill-'))
let spillId = 0

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

afterAll(() => {
  rmSync(spillRoot, { recursive: true, force: true })
})

describe('subscription request retries', () => {
  it('resolves an Agent script-path create after the file is gone, while still checking current ownership', async () => {
    const test = await realHarness(new EmptyAdapter())
    cleanups.push(async () => {
      await test.teamFiber.dispose()
      rmSync(test.root, { recursive: true, force: true })
    })
    let scriptRuns = 0
    const shell = {
      resolve: (request: ShellExecSpec) => request,
      execute: async (spec: ShellExecSpec) => {
        const isProbe = spec.command.includes('BASH_VERSION')
        if (!isProbe) scriptRuns += 1
        const path = join(spillRoot, `${spillId++}.log`)
        writeFileSync(path, isProbe ? '5.2.15' : '__DSH_TEAM_RAW_STDOUT__{"id":"a","title":"A"}\n')
        return { result: async (): Promise<ShellRunResult> => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: isProbe ? '5.2.15' : '{"id":"a","title":"A"}\n', truncated: false, spillPath: path },
          stderr: { text: '', truncated: false },
        }) }
      },
    }
    test.ctx.provide('shell', shell as never)
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('retry-project'), workspaceId: test.workspaceId,
      name: 'retry', description: '', memberIds: [] })
    const projectRef = project.project.projectRef
    const added = await test.ctx.agentTeam.addMember({ requestId: requestId('retry-member'), workspaceId: test.workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [projectRef] })
    const memberId = added.status.member.memberId
    const agent = test.ctx.agents.get(added.status.member.sessionId)!
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('retry-owner'), workspaceId: test.workspaceId, projectRef, memberId })
    const path = join(test.checkout, 'feed.sh')
    writeFileSync(path, 'printf events\n')
    const request = { requestId: requestId('path-create'), workspaceId: test.workspaceId, projectRef, name: 'path feed',
      intervalMinutes: 10, script: { scriptPath: 'feed.sh' }, credentials: [] }
    const created = await test.ctx.agentTeam.createSubscriptionForAgent(agent, request)
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    expect(scriptRuns).toBe(1)
    unlinkSync(path)
    const retried = await test.ctx.agentTeam.createSubscriptionForAgent(agent, request)
    if (retried.kind !== 'changed') throw new Error('the retry resolves the committed create')
    expect(retried.subscription.subscriptionRef).toBe(created.subscription.subscriptionRef)
    expect(scriptRuns, 'a committed request neither rereads its file nor runs the script again').toBe(1)

    const updatePath = join(test.checkout, 'updated-feed.sh')
    writeFileSync(updatePath, 'printf updated\n')
    const update = { requestId: requestId('path-update'), workspaceId: test.workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1, name: 'path feed', intervalMinutes: 10,
      script: { scriptPath: 'updated-feed.sh' }, credentials: [] }
    const updated = await test.ctx.agentTeam.updateSubscriptionForAgent(agent, update)
    if (updated.kind !== 'changed') throw new Error('expected a committed update')
    expect(scriptRuns).toBe(2)
    unlinkSync(updatePath)
    const updateRetried = await test.ctx.agentTeam.updateSubscriptionForAgent(agent, update)
    if (updateRetried.kind !== 'changed') throw new Error('the retry resolves the committed update')
    expect(updateRetried.subscription.revision).toBe(2)
    expect(scriptRuns, 'an update retry also skips the missing file and trial').toBe(2)
    await expect(test.ctx.agentTeam.updateSubscriptionForAgent(agent, { ...update, script: { scriptPath: 'other.sh' } }))
      .rejects.toThrow(/reused with a different operation or payload/)

    await test.ctx.agentTeam.removeProjectOwner({ requestId: requestId('revoke-owner'), workspaceId: test.workspaceId, projectRef, memberId })
    await expect(test.ctx.agentTeam.createSubscriptionForAgent(agent, request))
      .rejects.toThrow(/project_owner_required/)
    await expect(test.ctx.agentTeam.updateSubscriptionForAgent(agent, update))
      .rejects.toThrow(/project_owner_required/)
  })
})
