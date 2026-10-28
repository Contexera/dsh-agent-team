/**
 * Smoke: boot the real Host over a memory pool, seed a Project/Members/Thread,
 * bind a fake eval Agent to one Member, and execute real Team tools against it.
 * No model yet — proves the harness substrate the live eval will drive.
 */
import { harness, alpha, addLedgerMember, makeOwner } from '../../../../../packages/agent-team/tests/helpers/host-harness.ts'
import { agentTeamHumanActor, AgentTeamLedger } from '../../../../../packages/agent-team/src/ledger.ts'
import { apply as applyTeamTools } from '../../../../../packages/tool-agent-team/src/index.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

let counter = 0
const reqId = (label: string) => `eval:${label}:${++counter}` as never

const boot = await harness()
const host = boot.ctx.get('agentTeam') as never
console.log('host service:', host === undefined ? 'MISSING' : 'ok')
// The plugin built its ledger projection at mount, before any seeding exists.
// Rebuild it over the same table so the seed below is visible to tool calls.
const table = boot.facility.get('agent_team')!.table('operations') as never
const ledger = new AgentTeamLedger(table)
;(host as { ledger: AgentTeamLedger }).ledger = ledger
const human = agentTeamHumanActor()

const project = await ledger.createProject({ requestId: reqId('project'), actor: human, workspaceId: alpha, name: 'Eval Project', description: 'model eval', memberIds: [] })
const projectRef = project.value.project.projectRef
console.log('project:', projectRef)

const ava = await addLedgerMember(ledger, projectRef, 'member:eval-ava', 'Eval Ava', 'Ava')
const ben = await addLedgerMember(ledger, projectRef, 'member:eval-ben', 'Eval Ben', 'Ben')
await makeOwner(ledger, projectRef, ava.member.memberId)
console.log('members:', ava.member.handle, ben.member.handle)

const started = await ledger.startThread({ requestId: reqId('thread'), actor: human, workspaceId: alpha, projectRef, kind: 'discussion',
  body: '@Ava 请 review 一下工具报错文案的归类，@Ben 也看看。' })
const threadRef = started.value.thread.threadRef
console.log('thread:', threadRef, 'revision:', started.value.thread.revision)

await ledger.reply({ requestId: reqId('reply'), actor: ben.actor, workspaceId: alpha, threadRef, body: '我看了，unread_required 占大头，先读再写那道门没问题。', baseRevision: started.value.thread.revision })

// Bind the fake eval Agent: tools resolve the Host through ctx.get('agentTeam')
// and the Member through the Host's handle map (agent identity is the key).
const avaAgent = { id: 'agent:eval-ava', ctx: { get: (name: string) => (name === 'agentTeam' ? host : undefined) } }
;(host as { handles: Map<string, { agent: unknown }> }).handles.set(ava.member.memberId, { agent: avaAgent })

const tools = new Map<string, ToolDefinition>()
applyTeamTools({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } } as never)
console.log('tools registered:', [...tools.keys()].join(', '))

const run = async (name: string, args: Record<string, unknown>) => {
  const tool = tools.get(name)!
  try {
    const value = await tool.execute(args, { agent: avaAgent, callId: `call:${name}`, signal: new AbortController().signal } as never)
    const blocks = tool.output.render(args as never, value as never) as Array<{ type: string; text?: string }>
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    console.log(`\n=== ${name} ${JSON.stringify(args)} -> OK ===\n${text.slice(0, 400)}`)
  } catch (error) {
    console.log(`\n=== ${name} ${JSON.stringify(args)} -> THROWN ===\n${(error as Error).message.slice(0, 300)}`)
  }
}

await run('team_inbox', {})
await run('team_view', {})
await run('team_thread', { action: 'read', threadRef })
await run('team_task', { action: 'board' })
await run('team_message', { action: 'reply', threadRef, baseRevision: 1, body: '收到，我来看。' })
await boot.ctx.dispose?.()
process.exit(0)
