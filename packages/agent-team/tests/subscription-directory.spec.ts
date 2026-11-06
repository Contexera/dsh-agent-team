import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { cleanups, EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'

const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-subscription-directory-'))

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

afterAll(() => {
  rmSync(spillRoot, { recursive: true, force: true })
})

describe('Workspace subscription discovery', () => {
  it('lists metadata without exposing scripts, credential references, webhook arms, or run history', async () => {
    const test = await realHarness(new EmptyAdapter())
    cleanups.push(async () => {
      await test.teamFiber.dispose()
      rmSync(test.root, { recursive: true, force: true })
    })
    test.ctx.provide('credentials', {
      resolve: async () => ({ value: 'fixture-secret', source: 'fixture' }),
      describe: async () => ({ configured: true, writable: false }),
    })
    test.ctx.provide('shell', {
      resolve: (request: ShellExecSpec) => request,
      execute: async (spec: ShellExecSpec) => {
        const probe = spec.command.includes('BASH_VERSION')
        const path = join(spillRoot, `${crypto.randomUUID()}.log`)
        writeFileSync(path, probe ? '5.2.15' : '__DSH_TEAM_RAW_STDOUT__')
        return { result: async (): Promise<ShellRunResult> => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: probe ? '5.2.15' : '', truncated: false, spillPath: path },
          stderr: { text: '', truncated: false },
        }) }
      },
    } as never)

    const createdProject = await test.ctx.agentTeam.createProject({ requestId: requestId('metadata-project'),
      workspaceId: test.workspaceId, name: 'metadata', description: '', memberIds: [] })
    const projectRef = createdProject.project.projectRef
    const owner = await test.ctx.agentTeam.addMember({ requestId: requestId('metadata-owner'), workspaceId: test.workspaceId,
      handle: 'owner', description: '', presetId: 'team-member', projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' }})
    const outsider = await test.ctx.agentTeam.addMember({ requestId: requestId('metadata-outsider'), workspaceId: test.workspaceId,
      handle: 'outsider', description: '', presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' }})
    const ownerAgent = test.ctx.agents.get(owner.status.member.sessionId)!
    const outsiderAgent = test.ctx.agents.get(outsider.status.member.sessionId)!
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('metadata-owner-grant'), workspaceId: test.workspaceId,
      projectRef, memberId: owner.status.member.memberId })
    const created = await test.ctx.agentTeam.createSubscriptionForAgent(ownerAgent, {
      requestId: requestId('metadata-create'), workspaceId: test.workspaceId, projectRef, name: 'CI watch', intervalMinutes: 15,
      script: { scriptContent: 'printf events\n' }, credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }],
    })
    if (created.kind !== 'changed') throw new Error('expected a committed subscription')

    const listed = test.ctx.agentTeam.subscriptionsForAgent(outsiderAgent, { workspaceId: test.workspaceId, projectRef })
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]!.subscription).toMatchObject({
      subscriptionRef: created.subscription.subscriptionRef, name: 'CI watch', state: 'active', revision: 1,
      triggers: { interval: { minutes: 15 } },
    })
    expect(listed.entries[0]!.subscription).not.toHaveProperty('script')
    expect(listed.entries[0]!.subscription).not.toHaveProperty('credentials')
    expect(listed.entries[0]!.subscription).not.toHaveProperty('webhook')
    expect(test.ctx.agentTeam.subscriptionsForAgent(ownerAgent, { workspaceId: test.workspaceId, projectRef })
      .entries[0]!.subscription).not.toHaveProperty('script')

    const clientList = test.ctx.agentTeam.subscriptionsForClient({ workspaceId: test.workspaceId, projectRef })
    expect(clientList.entries[0]!.subscription.script.content).toBe('printf events\n')
    expect(clientList.entries[0]!.subscription.credentials).toEqual([{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }])
    expect(() => test.ctx.agentTeam.subscriptionLogsForAgent(outsiderAgent, {
      workspaceId: test.workspaceId, projectRef, subscriptionRef: created.subscription.subscriptionRef,
    })).toThrow(/not_project_member/)
  })
})
