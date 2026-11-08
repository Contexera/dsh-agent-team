/**
 * The composition probe ticket 01 depends on: a Team Member's own Agent context
 * can reach a Host-mounted Harness subagent service, and an external run with
 * parent delivery reports back into that Member's session.
 *
 * The provider here is a stub on purpose. It exercises the seam, not OAR: the
 * native engines are acceptance targets, not unit-test doubles.
 */

import { afterEach, expect, it } from 'vitest'
import { realHarness, cleanups, waitFor } from './helpers/member-harness.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRuntime as SubagentRuntimeService } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
}, 30_000)

const stubProvider = (name: string, answer: string): SubagentProvider => ({
  name,
  capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
  inheritsParentContext: false,
  start: async () => ({
    id: SessionId(`probe-child-${name}`),
    result: Promise.resolve({ output: [{ type: 'text', text: answer }], stopReason: 'completed' as const }),
    dispose: async () => {},
  }),
})

it('reaches a Host-mounted subagent service from a Member context and delivers a parent notice', async () => {
  const harness = await realHarness()
  const ctx = harness.ctx
  await ctx.plugin(SubagentRuntime)
  const subagents = ctx.get('subagents') as SubagentRuntimeService

  const added = await ctx.agentTeam.addMember({
    requestId: 'add-probe-member' as never,
    workspaceId: harness.workspaceId,
    handle: 'probe-member',
    description: 'Probe member',
    presetId: 'team-member',
    projectRefs: [],
    model: { provider: 'mock', model: 'mock' },
  })
  if (added.status.availability !== 'active') console.log('STATUS', JSON.stringify(added.status, null, 1))
  expect(added.status.availability).toBe('active')
  const agent = ctx.agents.get(added.status.member.sessionId) as Agent | undefined
  expect(agent).toBeDefined()

  // The load-bearing fact: the Member's own context resolves the Host service.
  expect(agent!.ctx.get('subagents')).toBeDefined()

  const release = subagents.registerProvider(stubProvider('probe', 'the probe answer'))
  cleanups.push(async () => { release() })

  const activation = await subagents.startActivation({
    provider: 'probe',
    label: 'probe worker',
    request: { parent: agent!, prompt: [{ type: 'text', text: 'run the probe' }], cwd: harness.checkout },
    signal: new AbortController().signal,
    delivery: 'parent',
  })
  await activation.result

  const seen = await waitFor(() => {
    const text = agent!.session.ownEvents().map(event => JSON.stringify(event)).join('\n')
    return text.includes('the probe answer') ? text : undefined
  }, 20_000)
  expect(seen).toContain('the probe answer')
}, 60_000)
