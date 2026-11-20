import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { AgentTeamMemberCapabilities } from '../src/types.ts'
import { EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'

const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-script-boundary-'))
let spillId = 0

const removeSpillRoot = (): void => {
  rmSync(spillRoot, { recursive: true, force: true })
}
afterAll(removeSpillRoot)
process.once('exit', removeSpillRoot)

async function ownerHarness(options: { readonly shell: boolean; readonly capabilities?: AgentTeamMemberCapabilities }) {
  const test = await realHarness(new EmptyAdapter(), 'jsonl', undefined, false, undefined, 'memory', { memberShellTool: options.shell })
  const runs: string[] = []
  test.ctx.provide('shell', {
    resolve: (request: ShellExecSpec) => request,
    execute: async (spec: ShellExecSpec) => {
      const isProbe = spec.command.includes('BASH_VERSION')
      if (!isProbe) runs.push(spec.command)
      const path = join(spillRoot, `${spillId++}.log`)
      writeFileSync(path, isProbe ? '5.2.15' : '__DSH_TEAM_RAW_STDOUT__')
      return { result: async (): Promise<ShellRunResult> => ({
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: isProbe ? '5.2.15' : '', truncated: false, spillPath: path },
        stderr: { text: '', truncated: false },
      }) }
    },
  } as never)
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('boundary-project'), workspaceId: test.workspaceId,
    name: 'boundary', description: '' })
  const projectRef = project.project.projectRef
  const added = await test.ctx.agentTeam.addMember({ requestId: requestId('boundary-member'), workspaceId: test.workspaceId,
    handle: 'owner', description: '', presetId: 'team-member', projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' },
    ...options.capabilities === undefined ? {} : { capabilities: options.capabilities } })
  const memberId = added.status.member.memberId
  await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('boundary-owner'), workspaceId: test.workspaceId, projectRef, memberId })
  const agent = test.ctx.agents.get(added.status.member.sessionId)!
  return { test, agent, projectRef, runs }
}

describe('subscription scripts an Agent asks the Host to run', () => {
  it.each([
    ['a preset without a shell tool', { shell: false }],
    ['an allow-list that drops the shell tool', { shell: true, capabilities: { tools: { allow: ['read'] } } }],
  ] as const)('are refused for a Project owner with %s, while the Human path still runs', async (_label, options) => {
    const { test, agent, projectRef, runs } = await ownerHarness(options)
    const base = { workspaceId: test.workspaceId, projectRef }
    const refused = /subscription_shell_required/
    await expect(test.ctx.agentTeam.createSubscriptionForAgent(agent, { ...base, requestId: requestId('agent-create'), name: 'probe',
      intervalMinutes: 10, script: { scriptContent: 'id; cat ~/.ssh/id_rsa\n' }, credentials: [] })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.createSubscriptionForAgent(agent, { ...base, requestId: requestId('agent-path'), name: 'probe',
      intervalMinutes: 10, script: { scriptPath: '/etc/passwd' }, credentials: [] })).rejects.toThrow(refused)

    const human = await test.ctx.agentTeam.createSubscription({ ...base, requestId: requestId('human-create'), name: 'human feed',
      intervalMinutes: 10, script: { scriptContent: 'printf human\n' }, credentials: [] })
    if (human.kind !== 'changed') throw new Error('expected the Human create to commit')
    expect(runs).toHaveLength(1)
    const subscriptionRef = human.subscription.subscriptionRef

    await expect(test.ctx.agentTeam.updateSubscriptionForAgent(agent, { ...base, requestId: requestId('agent-update'), subscriptionRef,
      expectedRevision: 1, name: 'human feed', intervalMinutes: 10, script: { scriptContent: 'id\n' }, credentials: [] })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.testSubscriptionForAgent(agent, { ...base, subscriptionRef })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.resumeSubscriptionForAgent(agent, { ...base, requestId: requestId('agent-resume'), subscriptionRef,
      expectedRevision: 1 })).rejects.toThrow(refused)
    await expect(test.ctx.agentTeam.replaySubscriptionDeliveryForAgent(agent, { ...base, requestId: requestId('agent-replay'),
      subscriptionRef, deliveryRef: 'delivery:unknown' })).rejects.toThrow(refused)
    expect(runs, 'no refused call reaches the shell').toHaveLength(1)

    const paused = await test.ctx.agentTeam.pauseSubscriptionForAgent(agent, { ...base, requestId: requestId('agent-pause'), subscriptionRef,
      expectedRevision: 1 })
    if (paused.kind !== 'changed') throw new Error('expected the pause to commit')
    expect(paused.subscription.state, 'a call that runs no script stays open to the owner').toBe('paused')
    expect((await test.ctx.agentTeam.testSubscriptionForClient({ ...base, subscriptionRef })).kind).toBe('tested')
  })

  it('reads a script path only inside the Member working directory', async () => {
    const { test, agent, projectRef, runs } = await ownerHarness({ shell: true })
    const base = { workspaceId: test.workspaceId, projectRef, intervalMinutes: 10, credentials: [] }
    const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-team-script-outside-'))
    try {
      const secret = join(outsideDir, 'secret.sh')
      writeFileSync(secret, 'printf secret\n')
      symlinkSync(secret, join(test.checkout, 'linked.sh'))
      writeFileSync(join(test.checkout, 'feed.sh'), 'printf feed\n')
      const create = (name: string, scriptPath: string) => test.ctx.agentTeam.createSubscriptionForAgent(agent,
        { ...base, requestId: requestId(`path-${name}`), name, script: { scriptPath } })
      const escapes = /outside your working directory/
      await expect(create('absolute', secret)).rejects.toThrow(escapes)
      await expect(create('parent', '../../outside.sh')).rejects.toThrow(escapes)
      await expect(create('symlink', 'linked.sh')).rejects.toThrow(escapes)
      expect(runs, 'an escaping path reaches no shell').toHaveLength(0)

      const relative = await create('relative', 'feed.sh')
      expect(relative.kind).toBe('changed')
      const absoluteInside = await create('absolute-inside', join(test.checkout, 'feed.sh'))
      expect(absoluteInside.kind).toBe('changed')
      expect(runs).toHaveLength(2)
      expect(runs.every(command => command.includes('printf feed'))).toBe(true)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })
})
