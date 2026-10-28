/** Replay the exact eval failure shape (messageRef = fact sequence) and print the error. */
import { harness, alpha, addLedgerMember } from '../../../../../packages/agent-team/tests/helpers/host-harness.ts'
import { agentTeamHumanActor, AgentTeamLedger } from '../../../../../packages/agent-team/src/ledger.ts'
import { apply as applyTeamTools } from '../../../../../packages/tool-agent-team/src/index.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

let counter = 0
const reqId = (label: string) => `eval:${label}:${++counter}` as never
const boot = await harness()
const host = boot.ctx.get('agentTeam') as never
const table = boot.facility.get('agent_team')!.table('operations') as never
const ledger = new AgentTeamLedger(table)
;(host as { ledger: AgentTeamLedger }).ledger = ledger
const human = agentTeamHumanActor()
const project = await ledger.createProject({ requestId: reqId('p'), actor: human, workspaceId: alpha, name: 'P', description: '', memberIds: [] })
const ava = await addLedgerMember(ledger, project.value.project.projectRef, 'member:eval-ava', 'Ava', 'Ava')
const started = await ledger.startThread({ requestId: reqId('t'), actor: human, workspaceId: alpha, projectRef: project.value.project.projectRef, kind: 'discussion', body: 'hello @Ava' })
const agent = { id: 'agent:eval-ava', ctx: { get: (n: string) => (n === 'agentTeam' ? host : undefined) } }
;(host as { handles: Map<string, { agent: unknown }> }).handles.set(ava.member.memberId, { agent })
const tools = new Map<string, ToolDefinition>()
applyTeamTools({ tools: { register: (t: ToolDefinition) => { tools.set(t.name, t) } } } as never)

for (const badRef of ['8', 'message:7']) {
  try {
    await tools.get('team_thread')!.execute({ action: 'message', threadRef: started.value.thread.threadRef, messageRef: badRef }, { agent, callId: 'c', signal: new AbortController().signal } as never)
    console.log(`messageRef=${badRef}: NO ERROR (unexpected)`)
  } catch (error) {
    console.log(`messageRef=${badRef} ->\n  ${(error as Error).message}\n`)
  }
}
process.exit(0)
