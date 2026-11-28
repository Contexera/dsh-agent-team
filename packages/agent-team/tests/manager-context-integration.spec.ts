import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PrivateMemoryTag } from '../src/private-memory.ts'
import { realHarness, requestId } from './helpers/member-harness.ts'

const MANAGER_BEGIN = '<team-manager-private-memory>'

function managerRoot(): string {
  return join(process.env.DSH_HOME!, 'agent-team', 'manager')
}

async function preStep(ctx: Context, agent: Agent): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
    modelSelection: { provider: 'mock', model: 'mock' },
  }, async () => ({ kind: 'enter', messages: [] }))
}

/** Run one step and commit what the injection asked the Session to carry, as the loop would. */
async function step(ctx: Context, agent: Agent): Promise<readonly UserMessage[]> {
  const decision = await preStep(ctx, agent)
  const messages = decision.kind === 'enter' ? decision.messages : []
  for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return messages
}

function managerBlocks(messages: readonly UserMessage[]): { text: string; tag: PrivateMemoryTag }[] {
  return messages.flatMap(message => {
    const text = message.content[0]?.type === 'text' ? message.content[0].text : ''
    const tag = (message.source as { readonly managerContext?: PrivateMemoryTag }).managerContext
    return text.startsWith(MANAGER_BEGIN) && tag !== undefined ? [{ text, tag }] : []
  })
}

async function openManager(ctx: Context): Promise<Agent> {
  const opened = await ctx.agentTeam.openManagerSession({})
  if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, got ${JSON.stringify(opened)}`)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('the manager Session has no live Agent')
  return agent
}

describe('Team manager private memory injection', () => {
  it('injects the manager index once, then only a stale-copy notice when it changes', async () => {
    const { ctx } = await realHarness()
    const agent = await openManager(ctx)
    const root = managerRoot()
    const indexPath = join(root, 'memory.md')
    // The scaffold the runtime provisioned is the first thing the manager reads.
    expect(await readFile(indexPath, 'utf8')).toContain('# Team manager memory')

    const first = managerBlocks(await step(ctx, agent))
    expect(first).toHaveLength(1)
    expect(first[0]!.tag.variant).toBe('baseline')
    expect(first[0]!.text).toContain('# Team manager memory')
    expect(first[0]!.text).toContain(`Memory index: ${indexPath}`)

    // Replay: the block is on the surface and the file is unchanged, so a
    // resumed step injects nothing rather than a second copy.
    expect(managerBlocks(await step(ctx, agent))).toHaveLength(0)

    // A rewritten index supersedes the earlier copy with a notice, not a body:
    // the manager reads the file when it needs the detail.
    await writeFile(indexPath, '# Team manager memory\n\n## Durable rules\n- Prefer the reversible option.\n')
    const update = managerBlocks(await step(ctx, agent))
    expect(update).toHaveLength(1)
    expect(update[0]!.tag.variant).toBe('update')
    expect(update[0]!.text).toContain('no longer represents the latest memory.md')
    expect(update[0]!.text).toContain(indexPath)
    expect(update[0]!.text).not.toContain('Prefer the reversible option.')
    expect(managerBlocks(await step(ctx, agent))).toHaveLength(0)
  })

  it('restores a complete baseline when only the current notice and a truncated baseline survive', async () => {
    const { ctx } = await realHarness()
    const agent = await openManager(ctx)
    const indexPath = join(managerRoot(), 'memory.md')
    const baseline = managerBlocks(await step(ctx, agent))[0]
    if (baseline?.tag.variant !== 'baseline') throw new Error('expected an initial manager memory baseline')
    await writeFile(indexPath, 'Current manager index')
    expect(managerBlocks(await step(ctx, agent))[0]?.tag.variant).toBe('update')

    const derive = agent.session.deriveEventMessage.bind(agent.session)
    const projection = vi.spyOn(agent.session, 'deriveEventMessage').mockImplementation(event => {
      const message = derive(event)
      if (message?.role !== 'user' || message.content[0]?.type !== 'text' || message.content[0].text !== baseline.text) return message
      return freezeMessage({ ...message, content: [{ type: 'text', text: '[Truncated by compaction]' }] })
    })
    onTestFinished(() => { projection.mockRestore() })

    const recovered = managerBlocks(await step(ctx, agent))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.tag.variant).toBe('baseline')
    expect(recovered[0]?.text).toContain('Current manager index')
    expect(managerBlocks(await step(ctx, agent))).toEqual([])
  })

  it('distinguishes an absent index from a readable zero-byte index', async () => {
    const { ctx } = await realHarness()
    const agent = await openManager(ctx)
    const indexPath = join(managerRoot(), 'memory.md')
    await rm(indexPath)
    expect(managerBlocks(await step(ctx, agent))[0]?.tag.variant).toBe('unavailable')
    expect(managerBlocks(await step(ctx, agent))).toEqual([])

    await writeFile(indexPath, '')
    const empty = managerBlocks(await step(ctx, agent))
    expect(empty).toHaveLength(1)
    expect(empty[0]?.tag.variant).toBe('baseline')
    expect(empty[0]?.text).toContain('Private memory index: 0.0 KiB / 16 KiB (0%).')
    expect(managerBlocks(await step(ctx, agent))).toEqual([])
  })

  it('keeps notes out of context and reads them only when the index names them', async () => {
    const { ctx } = await realHarness()
    const agent = await openManager(ctx)
    const root = managerRoot()
    await mkdir(join(root, 'notes', 'habits'), { recursive: true })
    await writeFile(join(root, 'notes', 'habits', 'README.md'), 'The Human reviews the board on Mondays.\n')
    await writeFile(join(root, 'memory.md'), '# Team manager memory\n\n## Notes index\n- habits: `notes/habits/README.md`\n')

    const blocks = managerBlocks(await step(ctx, agent))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toContain('notes/habits/README.md')
    expect(blocks[0]!.text).not.toContain('reviews the board on Mondays')
    // The note is a real file at the path the index names, which is the whole
    // contract: the index routes, the reader opens the file.
    expect(await readFile(join(root, 'notes', 'habits', 'README.md'), 'utf8')).toContain('reviews the board on Mondays')
  })

  it('injects nothing into an ordinary Session or a Member', async () => {
    const { ctx, workspaceId } = await realHarness()
    await openManager(ctx)
    const ordinary = await ctx.agents.create({ sessionId: SessionId('ordinary-manager-memory') })
    onTestFinished(async () => { await ordinary.dispose() })
    expect(managerBlocks(await step(ctx, ordinary.agent))).toHaveLength(0)

    const member = await ctx.agentTeam.addMember({ requestId: requestId('manager-memory-member'), workspaceId,
      handle: 'bystander', description: 'Ordinary Member', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'mock' } })
    const memberAgent = ctx.agents.get(member.status.member.sessionId)
    expect(memberAgent).toBeDefined()
    const memberMessages = await step(ctx, memberAgent!)
    expect(managerBlocks(memberMessages)).toHaveLength(0)
    // The Member still receives its own block, so this is isolation rather than
    // a missing injection.
    expect(memberMessages.some(message => (message.content[0] as { text?: string } | undefined)?.text?.startsWith('<team-member-private-memory>')))
      .toBe(true)
  })

  it('replaces an archived manager Session without losing the private directory', async () => {
    const { ctx } = await realHarness()
    const agent = await openManager(ctx)
    const root = managerRoot()
    await writeFile(join(root, 'memory.md'), '# Team manager memory\n\n## Durable rules\n- Never publish without a word.\n')
    expect(managerBlocks(await step(ctx, agent))[0]!.text).toContain('Never publish without a word.')

    // Archival makes the registered Session replacement-eligible; the successor
    // is a different Session over the same private root.
    await ctx.workspaceRegistry.archiveSession(agent.id, { stopActivity: true })
    const successor = await openManager(ctx)
    expect(successor.id).not.toBe(agent.id)
    const blocks = managerBlocks(await step(ctx, successor))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toContain('Never publish without a word.')
    expect(blocks[0]!.text).toContain(`Private memory directory: ${root}`)
  })

  it('keeps one directory across a new conversation and a Host restart', async () => {
    const first = await realHarness(undefined, 'jsonl', undefined, false, undefined, 'sqlite')
    const agent = await openManager(first.ctx)
    const root = managerRoot()
    await writeFile(join(root, 'memory.md'), '# Team manager memory\n\n## Durable rules\n- Ask before publishing.\n')
    expect(managerBlocks(await step(first.ctx, agent))[0]!.text).toContain('Ask before publishing.')

    // A new conversation is a new Session over the same private directory.
    const replaced = await first.ctx.agentTeam.newManagerSession({ expectedSessionId: agent.id })
    if (replaced.status !== 'ready') throw new Error('expected a ready manager replacement')
    expect(replaced.sessionId).not.toBe(agent.id)
    const successor = first.ctx.agents.get(replaced.sessionId)!
    expect(managerBlocks(await step(first.ctx, successor))[0]!.text).toContain('Ask before publishing.')

    // A restart resumes the registered Session. Its persisted surface already
    // carries the block, so the replay injects no second copy — and the memory
    // the manager read before the restart is still what it reads after it.
    await first.teamFiber.dispose()
    const second = await realHarness(undefined, 'jsonl', { root: first.root }, false, undefined, 'sqlite')
    const restored = await openManager(second.ctx)
    expect(managerBlocks(await step(second.ctx, restored))).toHaveLength(0)
    const carried = restored.session.ownEvents().flatMap(event => event.type === 'user/message'
      ? event.data.content.flatMap(part => part.type === 'text' ? [part.text] : [])
      : [])
    expect(carried.some(text => text.includes('Ask before publishing.'))).toBe(true)
    expect(carried.filter(text => text.startsWith(MANAGER_BEGIN))).toHaveLength(1)
    expect(carried.find(text => text.startsWith(MANAGER_BEGIN))).toContain(`Private memory directory: ${root}`)
  })
})
