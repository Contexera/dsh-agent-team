import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as current from '../../../../../packages/agent-team/src/member-context.ts'

const root = resolve(import.meta.dirname, '../../../../..')
const local = join(root, '.scratch/local/agent-context-implementation')
await mkdir(local, { recursive: true })
const priorPath = join(local, 'member-context-before.mts')
const priorSource = execFileSync('git', ['show', 'deaa671:packages/agent-team/src/member-context.ts'], { cwd: root, encoding: 'utf8' })
await writeFile(priorPath, priorSource.replace(/from '(\.\/[^']+)'/g,
  (_match, specifier: string) => `from '${pathToFileURL(resolve(root, 'packages/agent-team/src', specifier)).href}'`))
const prior = await import(pathToFileURL(priorPath).href) as typeof current
const memory = await mkdtemp(join(tmpdir(), 'team-context-scenario-'))
const indexV1 = 'Synthetic index v1\n' + 'Reference: notes/install.md\n'.repeat(250)
const indexV2 = indexV1.replace('index v1', 'index v2')

async function run(plugin: typeof current) {
  const ctx = new Context()
  const session = Session.create(SessionId('session:context-scenario'))
  const agent = { id: session.id, ctx, session, status: 'idle' } as Agent
  let owned: { projectRef: string; name: string; workspaceId: string }[] = []
  const rows: { stage: string; messages: number; emittedCharacters: number; indexCopies: number; surfaceCharacters: number }[] = []
  ctx.provide('agentTeam', {
    memberForAgent: (subject: Agent) => subject === agent
      ? { memberId: 'member:fixture', privateMemoryPath: memory, handle: 'Fixture', description: 'synthetic Member' }
      : undefined,
    ownedProjectsForAgent: () => owned,
    workspacesForAgent: () => [{ workspaceId: 'workspace:fixture', path: '/synthetic/workspace', default: true }],
  } as never)
  plugin.apply(ctx)
  async function step(stage: string) {
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [], turn: 1, step: rows.length + 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter' as const, messages: [] }))
    assert.equal(decision.kind, 'enter')
    if (decision.kind !== 'enter') throw new Error('unexpected rejected step')
    const texts = decision.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    const surfaceText = session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('')
    rows.push({ stage, messages: decision.messages.length, emittedCharacters: texts.join('').length,
      indexCopies: texts.filter(text => text.includes('Reference: notes/install.md\n'.repeat(250))).length,
      surfaceCharacters: surfaceText.length })
  }
  try {
    await writeFile(join(memory, 'memory.md'), indexV1)
    await step('start')
    await step('unchanged')
    await writeFile(join(memory, 'memory.md'), indexV2)
    await step('memory-update')
    await step('unchanged-after-update')
    owned = [{ projectRef: 'project:fixture', name: 'Fixture', workspaceId: 'workspace:fixture' }]
    await step('ownership-grant')
    const nodes = session.surface.nodes
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Synthetic compaction summary.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) },
      sourceEventSeqs: [...nodes],
    })
    await step('compaction-recovery')
    await step('unchanged-after-recovery')
    return rows
  } finally {
    await ctx.fiber.dispose()
  }
}

try {
  const before = await run(prior)
  const after = await run(current)
  assert.deepEqual(after.map(row => row.messages), [4, 0, 1, 0, 1, 4, 0])
  assert.deepEqual(after.map(row => row.indexCopies), [1, 0, 0, 0, 0, 1, 0])
  assert.deepEqual(before.map(row => row.indexCopies), [1, 0, 1, 0, 1, 1, 0])
  console.log(JSON.stringify({ fixtureMemoryBytes: Buffer.byteLength(indexV1), baseline: 'deaa671', before, after,
    note: 'One synthetic Session per implementation. Characters are UTF-16 code units, not tokens or cost; surface excludes fixed prompt and tools.' }, null, 2))
} finally {
  await rm(memory, { recursive: true, force: true })
  await rm(priorPath)
}
