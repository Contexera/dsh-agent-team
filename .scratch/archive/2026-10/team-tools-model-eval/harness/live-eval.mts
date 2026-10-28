/**
 * Tier-2 live model eval: drive the real seven Team tools with the real model
 * (gpt-6.1-sol via the local codex-proxy) against a real Host over a throwaway
 * memory pool. One fresh boot+seed per scenario. Measures, per tool×action:
 * calls, outcome class (ok / design-gate reject / other reject / thrown),
 * blank-slot fills, stray parameters, and recovery turns after a rejection.
 *
 * Run from the repository root:
 *   node --import tsx .scratch/archive/2026-10/team-tools-model-eval/harness/live-eval.mts [scenario...]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { harness, alpha, addLedgerMember, makeOwner } from '../../../../../packages/agent-team/tests/helpers/host-harness.ts'
import { agentTeamHumanActor, AgentTeamLedger } from '../../../../../packages/agent-team/src/ledger.ts'
import { apply as applyTeamTools } from '../../../../../packages/tool-agent-team/src/index.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const PROXY_URL = 'http://127.0.0.1:3425/v1/chat/completions'
const PROXY_KEY = 'magpie'
const MODEL = 'auto/gpt-6.1-sol'
const MAX_TURNS = 14
const REPO_ROOT = join(import.meta.dirname, '../../../../..')
const OUT_DIR = join(REPO_ROOT, '.scratch/local/team-tools-model-eval')
mkdirSync(OUT_DIR, { recursive: true })

let counter = 0
const reqId = (label: string) => `eval:${label}:${++counter}` as never

/** The team-member preset's persona prefix, verbatim from cordis.patch.yml. */
function extractPersona(): string {
  const lines = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === 'prefix: |-')
  if (start < 0) throw new Error('persona prefix not found in cordis.patch.yml')
  const keyIndent = lines[start]!.search(/\S/)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyIndent) break
    body.push(line)
  }
  const indents = body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/))
  const cut = Math.min(...indents)
  return body.map((l) => (l.trim() === '' ? '' : l.slice(cut))).join('\n').trimEnd()
}

interface ScenarioSeed { readonly name: string; readonly task: string; readonly setup: 'thread-question' | 'task' | 'plain' | 'long-history' | 'claimed-task' | 'multi-message' }

const SCENARIOS: readonly ScenarioSeed[] = [
  { name: 'inbox-triage', task: 'You have unread Team updates. Triage your inbox, read the Thread that has unread updates, and reply in that Thread answering the question the human asked you.', setup: 'thread-question' },
  { name: 'board-claim', task: 'Check the Task board of the Eval Project. Claim the open Task, reply once in its Thread with one sentence on the angle you are taking, then mark your Claim done.', setup: 'task' },
  { name: 'main-post', task: 'Post a short status update to the Eval Project Main stream saying the tool-friction corpus is built and the live eval is running.', setup: 'plain' },
  { name: 'view-team', task: 'Use the directory tool to report who is on the team and which Projects exist.', setup: 'plain' },
  { name: 'dm-peer', task: 'Send @Ben a direct message asking whether the error-text reclassification landed.', setup: 'plain' },
  { name: 'long-history', task: 'Read the whole conversation in this Thread and summarize in one reply what was decided about error-text classification.', setup: 'long-history' },
  { name: 'claim-conflict', task: 'There is an open Task on the board of the Eval Project. Claim it and start working on it.', setup: 'claimed-task' },
  { name: 'reply-to-message', task: 'In the Thread the human opened, reply specifically to Ben\u2019s latest message.', setup: 'multi-message' },
  { name: 'attention-follow', task: 'Follow the Thread about tool error texts so you receive its updates.', setup: 'multi-message' },
  { name: 'list-claims', task: 'The human asked who is working the Task in that Thread. List the Claims on it.', setup: 'claimed-task' },
]

interface CallLog {
  scenario: string; turn: number; tool: string; action: string; args: Record<string, unknown>
  kind: 'ok' | 'reject' | 'thrown'; reason: string; text: string
  blankFills: string[]; strayParams: string[]; ms: number
}

const DESIGN_GATES = new Set(['unread_required', 'the Thread changed after your last read (stale_revision)', 'the Main stream changed after your last read (main_unread_required)'])

async function bootScenario(seed: ScenarioSeed) {
  const boot = await harness()
  const host = boot.ctx.get('agentTeam') as never
  const table = boot.facility.get('agent_team')!.table('operations') as never
  const ledger = new AgentTeamLedger(table)
  ;(host as { ledger: AgentTeamLedger }).ledger = ledger
  const human = agentTeamHumanActor()

  const project = await ledger.createProject({ requestId: reqId('project'), actor: human, workspaceId: alpha, name: 'Eval Project', description: 'live model eval', memberIds: [] })
  const projectRef = project.value.project.projectRef
  const ava = await addLedgerMember(ledger, projectRef, 'member:eval-ava', 'Eval Ava — quality evaluation agent', 'Ava')
  await addLedgerMember(ledger, projectRef, 'member:eval-ben', 'Eval Ben', 'Ben')
  await makeOwner(ledger, projectRef, ava.member.memberId)

  let seeded: Record<string, unknown> = { projectRef }
  const benActor = { kind: 'member' as const, memberId: 'member:eval-ben', handle: 'Ben' }
  if (seed.setup === 'thread-question') {
    const started = await ledger.startThread({ requestId: reqId('thread'), actor: human, workspaceId: alpha, projectRef, kind: 'discussion',
      body: '@Ava 工具报错文案的归类你看下有没有问题，特别是读操作带页大小那种。' })
    const threadRef = started.value.thread.threadRef
    await ledger.reply({ requestId: reqId('reply'), actor: benActor, workspaceId: alpha, threadRef, body: '我扫了日志，那个形状占读操作拒绝的一半以上。', baseRevision: started.value.thread.revision })
    seeded = { ...seeded, threadRef }
  } else if (seed.setup === 'task') {
    const started = await ledger.startThread({ requestId: reqId('task-thread'), actor: human, workspaceId: alpha, projectRef, kind: 'task',
      body: '把 team tools 的拒绝原因按「设计门」与「传参习惯」两类归档。' })
    seeded = { ...seeded, threadRef: started.value.thread.threadRef, taskRef: started.value.task?.taskRef }
  } else if (seed.setup === 'long-history') {
    const started = await ledger.startThread({ requestId: reqId('long-thread'), actor: human, workspaceId: alpha, projectRef, kind: 'discussion',
      body: '@Ava 这个 Thread 记录我们关于报错文案归类的讨论，你读完总结一下结论。' })
    const threadRef = started.value.thread.threadRef
    let revision = started.value.thread.revision
    for (let index = 0; index < 30; index++) {
      const body = index % 2 === 0
        ? `第 ${index + 1} 条：${['空字符串当已传', '页大小在 read 上无意义', 'history 才尊重 limit', '报错要指下一步', '空 body 要单独报'][index % 5]}，证据见日志扫描。`
        : `第 ${index + 1} 条：同意，补一条：恢复指引必须含可执行动词。`
      const sent = await ledger.reply({ requestId: reqId(`long-${index}`), actor: benActor, workspaceId: alpha, threadRef, body, baseRevision: revision })
      if (sent.value?.kind !== 'committed') throw new Error(`long-history seed reply ${index} not committed: ${JSON.stringify(sent).slice(0, 200)}`)
      revision = sent.value.thread.revision
    }
    seeded = { ...seeded, threadRef }
  } else if (seed.setup === 'multi-message') {
    const started = await ledger.startThread({ requestId: reqId('multi-thread'), actor: human, workspaceId: alpha, projectRef, kind: 'discussion',
      body: '@Ava 关于工具报错文案，我们聊聊。' })
    const threadRef = started.value.thread.threadRef
    const first = await ledger.reply({ requestId: reqId('multi-ben'), actor: benActor, workspaceId: alpha, threadRef, body: '分类我赞成按「设计门」与「传参习惯」两类，先出语料。', baseRevision: started.value.thread.revision })
    await ledger.reply({ requestId: reqId('multi-human'), actor: human, workspaceId: alpha, threadRef, body: '@Ben 先出一版分类表，@Ava 你 review。', baseRevision: first.value.thread.revision })
    seeded = { ...seeded, threadRef }
  } else if (seed.setup === 'claimed-task') {
    const started = await ledger.startThread({ requestId: reqId('claimed-task-thread'), actor: human, workspaceId: alpha, projectRef, kind: 'task',
      body: '把 team tools 的拒绝原因按「设计门」与「传参习惯」两类归档。' })
    const threadRef = started.value.thread.threadRef
    await ledger.changeClaim({ requestId: reqId('ben-claim'), workspaceId: alpha, taskRef: started.value.task!.taskRef, baseRevision: started.value.thread.revision, action: 'claim', direction: 'Ben 正在做分类表', actor: benActor })
    seeded = { ...seeded, threadRef, taskRef: started.value.task?.taskRef }
  }

  const agent = { id: 'agent:eval-ava', ctx: { get: (name: string) => (name === 'agentTeam' ? host : undefined) } }
  ;(host as { handles: Map<string, { agent: unknown }> }).handles.set(ava.member.memberId, { agent })

  const tools = new Map<string, ToolDefinition>()
  applyTeamTools({ tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } } as never)
  return { boot, host, ledger, agent, tools, seeded, projectRef }
}

async function chat(messages: unknown[], tools: unknown[]): Promise<never> {
  let lastError = ''
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PROXY_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools, max_completion_tokens: 8192 }),
    })
    if (response.ok) {
      const data = await response.json() as { choices?: Array<{ message?: never }> }
      const message = data.choices?.[0]?.message
      if (message === undefined) throw new Error(`proxy returned no message: ${JSON.stringify(data).slice(0, 300)}`)
      return message
    }
    lastError = `proxy ${response.status}: ${(await response.text()).slice(0, 300)}`
    process.stderr.write(`[chat attempt ${attempt} failed] ${lastError}\n`)
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt))
  }
  throw new Error(lastError)
}

const PERSONA = extractPersona()

function systemPrompt(seeded: Record<string, unknown>): string {
  return [
    PERSONA,
    '',
    'Team identity: you are @Ava — quality evaluation agent.',
    '',
    'Team Project ownership — this list replaces all earlier ownership context.',
    `You own these Projects:`,
    `- Eval Project ${seeded.projectRef} (Workspace ${alpha})`,
    '',
    `Workspace: ${alpha} (your sole Workspace). Current date: 2026-10-28.`,
    'You collaborate only through the team_* tools. Do your work with them, then stop.',
  ].join('\n')
}

function classifyText(text: string): { kind: 'ok' | 'reject'; reason: string } {
  if (/^Not committed/.test(text)) {
    const m = /^Not committed — (.+?)(?:\.|$)/m.exec(text)
    return { kind: 'reject', reason: (m?.[1] ?? 'unparsed').trim() }
  }
  return { kind: 'ok', reason: '' }
}

async function runScenario(seed: ScenarioSeed, tag = ''): Promise<CallLog[]> {
  const { boot, agent, tools, seeded } = await bootScenario(seed)
  const logs: CallLog[] = []
  const toolSpecs = [...tools.values()].map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
  }))
  const messages: unknown[] = [
    { role: 'system', content: systemPrompt(seeded) },
    { role: 'user', content: seed.task },
  ]
  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const message = await chat(messages, toolSpecs) as { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
      messages.push(message)
      const calls = message.tool_calls ?? []
      if (calls.length === 0) break
      for (const call of calls) {
        const tool = tools.get(call.function.name)
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments || '{}') } catch { /* keep empty */ }
        const startedAt = Date.now()
        let kind: CallLog['kind'] = 'ok'
        let reason = ''
        let text = ''
        if (tool === undefined) {
          kind = 'thrown'; reason = 'unknown_tool'; text = `no such tool: ${call.function.name}`
        } else {
          try {
            const value = await tool.execute(args, { agent, callId: call.id, signal: new AbortController().signal } as never)
            const blocks = tool.output.render(args as never, value as never) as Array<{ type: string; text?: string }>
            text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
            const classified = classifyText(text)
            kind = classified.kind; reason = classified.reason
          } catch (error) {
            kind = 'thrown'; reason = (error as Error).message.slice(0, 120); text = reason
          }
        }
        const schemaProps = new Set(Object.keys(((tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {}))
        const blankFills = Object.entries(args).filter(([, v]) => v === '' || v === 0 || v === false).map(([k]) => k)
        const strayParams = Object.keys(args).filter((k) => k !== 'action' && !schemaProps.has(k))
        logs.push({ scenario: seed.name, turn, tool: call.function.name, action: String(args.action ?? ''), args, kind, reason, text: text.slice(0, 400), blankFills, strayParams, ms: Date.now() - startedAt })
        messages.push({ role: 'tool', tool_call_id: call.id, content: text || '(empty result)' })
      }
    }
  } finally {
    writeFileSync(join(OUT_DIR, `transcript-${seed.name}${tag}.json`), JSON.stringify({ scenario: seed.name, round: tag, task: seed.task, seeded, messages, calls: logs }, null, 2))
    await (boot.ctx as { dispose?: () => Promise<void> }).dispose?.()
  }
  return logs
}

function summarize(all: CallLog[]): void {
  const per = new Map<string, { calls: number; ok: number; gate: number; otherReject: number; thrown: number; blank: number; stray: number }>()
  for (const log of all) {
    const key = `${log.tool} ${log.action}`.trim()
    const row = per.get(key) ?? { calls: 0, ok: 0, gate: 0, otherReject: 0, thrown: 0, blank: 0, stray: 0 }
    row.calls++
    if (log.kind === 'ok') row.ok++
    else if (log.kind === 'reject') (DESIGN_GATES.has(log.reason) ? row.gate++ : row.otherReject++)
    else row.thrown++
    if (log.blankFills.length > 0) row.blank++
    if (log.strayParams.length > 0) row.stray++
    per.set(key, row)
  }
  console.log('\n=== per tool×action ===')
  console.log('tool action'.padEnd(34), 'calls', 'ok', 'gate', 'reject', 'thrown', 'blank', 'stray')
  for (const [key, row] of [...per.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    console.log(key.padEnd(34), String(row.calls).padStart(5), String(row.ok).padStart(2), String(row.gate).padStart(4), String(row.otherReject).padStart(6), String(row.thrown).padStart(6), String(row.blank).padStart(5), String(row.stray).padStart(5))
  }
  const total = all.length
  const ok = all.filter((l) => l.kind === 'ok').length
  const gate = all.filter((l) => l.kind === 'reject' && DESIGN_GATES.has(l.reason)).length
  const otherReject = all.filter((l) => l.kind === 'reject' && !DESIGN_GATES.has(l.reason)).length
  const thrown = all.filter((l) => l.kind === 'thrown').length
  console.log(`\ntotal ${total}: ok ${ok}, design-gate rejects ${gate}, other rejects ${otherReject}, thrown ${thrown}`)
  const rejects = all.filter((l) => l.kind !== 'ok')
  for (const log of rejects) console.log(`  [${log.scenario}] turn ${log.turn} ${log.tool} ${log.action} -> ${log.kind}: ${log.reason}`)
}

const argv = process.argv.slice(2)
const repeatIndex = argv.indexOf('--repeat')
const repeat = repeatIndex >= 0 ? Math.max(1, Number(argv[repeatIndex + 1] ?? 1)) : 1
const only = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--repeat')
const chosen = only.length > 0 ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS
const all: CallLog[] = []
for (let round = 1; round <= repeat; round++) {
  for (const scenario of chosen) {
    process.stderr.write(`--- round ${round} scenario ${scenario.name} ---\n`)
    try {
      const logs = await runScenario(scenario, `#r${round}`)
      all.push(...logs.map((l) => ({ ...l, scenario: `${l.scenario}#r${round}` })))
      const summary = logs.map((l) => `${l.kind}${l.reason ? ':' + l.reason : ''}`).join(' | ')
      process.stderr.write(`${scenario.name}: ${logs.length} calls — ${summary}\n`)
    } catch (error) {
      process.stderr.write(`${scenario.name}: SCENARIO ERROR — ${(error as Error).message.slice(0, 200)}\n`)
    }
  }
}
writeFileSync(join(OUT_DIR, `eval-run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`), JSON.stringify(all, null, 2))
summarize(all)
process.exit(0)
