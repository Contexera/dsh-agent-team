/**
 * The Host decides who reads which Workspace rules: a Member reads the
 * Workspaces it participates in now, the current manager reads every registered
 * Workspace, and an ordinary Session reads none. Booted through the real Host
 * and the shipped preset rows, so the scope is the one production resolves.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { workspaceRulesFile, type WorkspaceRulesTag } from '../src/workspace-rules-context.ts'
import { realHarness, requestId } from './helpers/member-harness.ts'

async function step(ctx: Context, agent: Agent): Promise<readonly UserMessage[]> {
  const decision: PreStepDecision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    modelSelection: { provider: 'mock', model: 'mock' },
  }, async () => ({ kind: 'enter', messages: [] }))
  const messages = decision.kind === 'enter' ? decision.messages : []
  for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return messages
}

function rulesBlocks(messages: readonly UserMessage[]): { workspaceId: string; text: string }[] {
  return messages.flatMap(message => {
    const tag = (message.source as { readonly workspaceRules?: WorkspaceRulesTag }).workspaceRules
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    return tag === undefined ? [] : [{ workspaceId: tag.workspaceId, text }]
  })
}

async function writeRules(workspaceId: string, text: string): Promise<string> {
  const file = workspaceRulesFile(join(process.env.DSH_HOME!, 'agent-team'), workspaceId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
  return file
}

describe('Workspace rules scope', () => {
  it('follows a Member\'s participation, reaches the manager for every Workspace, and skips ordinary Sessions', async () => {
    const { ctx, workspaceId, workspaces, root } = await realHarness()
    const other = WorkspaceId('workspace:rules-other')
    workspaces.set(other, { id: other, path: join(root, 'other-checkout'), attachSession: async () => {} })
    const file = await writeRules(workspaceId, '- Stage explicit paths only.\n')
    await writeRules(other, '- Other checkout rule.\n')

    const added = await ctx.agentTeam.addMember({ requestId: requestId('rules-member'), workspaceId,
      handle: 'ruler', description: 'reads rules', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'mock' } })
    expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
    const memberId = added.status.member.memberId
    const member = ctx.agents.get(added.status.member.sessionId)!

    const first = rulesBlocks(await step(ctx, member))
    expect(first.map(block => block.workspaceId)).toEqual([workspaceId])
    expect(first[0]!.text).toContain('- Stage explicit paths only.')
    expect(first[0]!.text).toContain(`Rules file: ${file}`)
    expect(first[0]!.text).toContain('The Team manager curates this file')

    await ctx.agentTeam.joinWorkspace({ requestId: requestId('rules-join'), workspaceId: other, memberId })
    const joined = rulesBlocks(await step(ctx, member))
    expect(joined.map(block => block.workspaceId)).toEqual([other])
    expect(joined[0]!.text).toContain('- Other checkout rule.')

    const opened = await ctx.agentTeam.openManagerSession({})
    if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, got ${JSON.stringify(opened)}`)
    const manager = ctx.agents.get(opened.sessionId)!
    const curated = rulesBlocks(await step(ctx, manager))
    expect(curated.map(block => block.workspaceId).sort()).toEqual([other, workspaceId].sort())
    expect(curated.every(block => block.text.includes('You are the primary curator of this file.'))).toBe(true)

    const ordinary = await ctx.agents.create({ sessionId: SessionId('ordinary-workspace-rules') })
    onTestFinished(async () => { await ordinary.dispose() })
    expect(rulesBlocks(await step(ctx, ordinary.agent))).toEqual([])
  })
})
