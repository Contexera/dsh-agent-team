// Explicit benchmark entry point for Team performance work.
// Timing runs are opt-in; tests enable only small scenario-contract fixtures.
import { execFile as execFileCallback, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harnessDir } from '../harness-dir.mjs'
import AgentTeam from '../../packages/agent-team/src/index.ts'
import { agentTeamHumanActor, AgentTeamLedger } from '../../packages/agent-team/src/ledger.ts'
import { foldTeamContextProjection } from '../../packages/agent-team/src/context-projection.ts'
import { advanceSessionEventCursor, initSessionEventCursor, type SessionEventFold } from '../../packages/agent-team/src/session-event-cursor.ts'
import { mountTeamMemberHost, provideQuietTokenMeter } from '../../packages/agent-team/tests/helpers/team-host-fixture.ts'
import { addLedgerMember, alpha, harness, ledgerAtBoot, makeOwner, sqliteHarness } from '../../packages/agent-team/tests/helpers/host-harness.ts'
import type { AgentTeamMemberActor, AgentTeamMemberId, AgentTeamProjectRef, AgentTeamRequestId } from '../../packages/agent-team/src/types.ts'

if (process.env.DSH_BENCH_TEAM !== '1') {
  console.error('Set DSH_BENCH_TEAM=1 to run the Team performance baseline.')
  process.exit(0)
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const harnessRoot = harnessDir
const execFile = promisify(execFileCallback)
const workspaceId = WorkspaceId('workspace:fixture')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const samplesPerScenario = Number(process.env.DSH_BENCH_SAMPLES ?? 3)
const warmupsPerScenario = Number(process.env.DSH_BENCH_WARMUPS ?? 1)
if (!Number.isInteger(samplesPerScenario) || samplesPerScenario < 1) throw new Error('DSH_BENCH_SAMPLES must be a positive integer')
if (!Number.isInteger(warmupsPerScenario) || warmupsPerScenario < 0) throw new Error('DSH_BENCH_WARMUPS must be a non-negative integer')
const followerCount = Number(process.env.DSH_BENCH_FOLLOWERS ?? 1)
const threadCount = Number(process.env.DSH_BENCH_THREADS ?? 1)
const sessionEventCount = Number(process.env.DSH_BENCH_SESSION_EVENTS ?? 10_000)
const sessionCompression = process.env.DSH_BENCH_SESSION_COMPRESSION ?? 'zstd'
const memberCount = Number(process.env.DSH_BENCH_MEMBERS ?? 8)
if (!Number.isInteger(followerCount) || followerCount < 1) throw new Error('DSH_BENCH_FOLLOWERS must be a positive integer')
if (!Number.isInteger(threadCount) || threadCount < 1) throw new Error('DSH_BENCH_THREADS must be a positive integer')
if (!Number.isInteger(sessionEventCount) || sessionEventCount < 2) throw new Error('DSH_BENCH_SESSION_EVENTS must be an integer >= 2')
if (sessionCompression !== 'zstd' && sessionCompression !== 'none') throw new Error('DSH_BENCH_SESSION_COMPRESSION must be zstd or none')
if (!Number.isInteger(memberCount) || memberCount < 2) throw new Error('DSH_BENCH_MEMBERS must be an integer >= 2')
const requestedScenarios = (process.env.DSH_BENCH_SCENARIOS ?? 'bundle-size,host-boot,member-activation,member-activation-batch,member-resume,tool-call,tool-read-sweep,thread-read-reply,notification-retry,tool-write,collaboration-fanout,collaboration-agent-turn,session-fold,session-replay-jsonl,ledger-read-memory,ledger-replay-sqlite').split(',').map(value => value.trim()).filter(Boolean)
const supportedScenarios = new Set(['bundle-size', 'host-boot', 'member-activation', 'member-activation-batch', 'member-resume', 'tool-call', 'tool-read-sweep', 'thread-read-reply', 'notification-retry', 'tool-write', 'collaboration-fanout', 'collaboration-agent-turn', 'session-fold', 'session-replay-jsonl', 'ledger-read-memory', 'ledger-replay-sqlite'])
for (const scenario of requestedScenarios) if (!supportedScenarios.has(scenario)) throw new Error(`Unknown DSH_BENCH_SCENARIOS entry: ${scenario}`)
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const outputRoot = resolve(root, 'artifacts/team-perf/runs', runId)

class EmptyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } })
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* []
  }
}

class CollaborationAdapter extends EmptyAdapter {
  receiverSessionId: string | undefined
  phase: 'cold' | 'warm' = 'cold'
  step = 0
  completed = 0
  readonly requests: GenerateOptions[] = []
  readonly requestTimes: number[] = []

  constructor(private readonly sample: number) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.sessionId === this.receiverSessionId) {
      this.requests.push(options)
      this.requestTimes.push(now())
      const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
      const threadRef = text.match(/thread:[0-9a-f-]{36}/)?.[0]
      if (threadRef === undefined) throw new Error('Collaboration notice did not expose a Thread address')
      if (this.step < 2) {
        const result = options.messages.findLast(message => message.role === 'tool')
        if (this.step === 1 && (result === undefined || result.role !== 'tool' || result.isError)) throw new Error('Collaboration read failed')
        const resultText = result?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
        const revision = resultText.match(/baseRevision: (\d+)/)?.[1]
        if (this.step === 1 && revision === undefined) throw new Error('Collaboration read did not expose its write revision')
        const name = this.step === 0 ? 'team_thread' : 'team_message'
        const args = this.step === 0 ? { action: 'read', threadRef }
          : { action: 'reply', threadRef, baseRevision: Number(revision), body: `Benchmark ${this.phase} reply.` }
        const id = ToolCallId(`baseline-collaboration-${this.sample}-${this.phase}-${this.step}`)
        const argumentsJson = JSON.stringify(args)
        this.step += 1
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const result = options.messages.findLast(message => message.role === 'tool')
      const resultText = result?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
      if (result?.role !== 'tool' || result.isError || !resultText.includes('Committed — reply added.')) throw new Error('Collaboration reply did not commit')
      this.completed += 1
    }
    const text = 'Benchmark response.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Sample {
  readonly runId: string
  readonly scenario: string
  readonly sample: number
  readonly phase: 'warmup' | 'measure'
  readonly startedAt: string
  readonly teamCommit: string
  readonly harnessCommit: string
  readonly node: string
  readonly workload: Record<string, unknown>
  readonly stages: Record<string, number | null>
  readonly ids: Record<string, string | null>
  readonly counters: Record<string, number>
}

function now(): number {
  return performance.now()
}

function elapsed(start: number): number {
  return Math.round((now() - start) * 1000) / 1000
}


function instrumentLedgerQueue(ledger: any): { readonly timings: { queueWaitMs: number; operationMs: number }; readonly operationCount: () => number } {
  const originalEnqueue = ledger.enqueue.bind(ledger)
  const timings = { queueWaitMs: 0, operationMs: 0 }
  let operationCount = 0
  ledger.enqueue = (operation: () => Promise<unknown>) => {
    const enqueuedAt = now()
    return originalEnqueue(async () => {
      timings.queueWaitMs += elapsed(enqueuedAt)
      const operationBegin = now()
      try {
        return await operation()
      } finally {
        timings.operationMs += elapsed(operationBegin)
        operationCount += 1
      }
    })
  }
  return { timings, operationCount: () => operationCount }
}

async function commitOf(directory: string): Promise<string> {
  try {
    const result = await execFile('git', ['-C', directory, 'rev-parse', 'HEAD'])
    return result.stdout.trim()
  } catch {
    return 'unknown'
  }
}

async function mount() {
  const cleanups: Array<() => Promise<void>> = []
  const host = await mountTeamMemberHost({
    cleanups,
    prepare: provideQuietTokenMeter,
    presetPlugins: [
      { id: 'member-context', name: '@contexera/dsh-agent-team/member-context' },
      { id: 'team-tools', name: pathToFileURL(join(root, 'packages/agent-team/tests/helpers/team-tools-fixture.mjs')).href },
    ],
    workingDirectory: 'stub',
  })
  return { ...host, dispose: async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) } }
}

async function bundleSizeSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const bundlePath = join(root, 'packages/client-agent-team/lib/client.js')
  const begin = now()
  const bundle = await readFile(bundlePath).catch(error => {
    throw new Error(`bundle-size needs a built client bundle at ${bundlePath}; run npm run build first (${String(error)})`)
  })
  const gzipBytes = gzipSync(bundle).byteLength
  const brotliBytes = brotliCompressSync(bundle).byteLength
  const measureMs = elapsed(begin)
  return { runId, scenario: 'bundle-size', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
    teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
    workload: { asset: 'packages/client-agent-team/lib/client.js', metric: 'asset-size', offlineCompression: 'gzip+brotli' },
    stages: { bundleCompressionMs: measureMs }, ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null },
    counters: { rawBytes: bundle.byteLength, gzipBytes, brotliBytes } }
}

async function bootSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const begin = now()
  const child = fork(fileURLToPath(import.meta.url), ['--boot-child'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const result = await new Promise<{ stages: Record<string, number>; counters: Record<string, number> }>((resolveResult, reject) => {
    let report: { stages: Record<string, number>; counters: Record<string, number> } | undefined
    let stderr = ''
    child.stdout?.resume()
    child.stderr?.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Cold Host child exceeded 60 seconds')) }, 60_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('message', (message: any) => {
      if (message.kind === 'ready') report = { stages: { ...message.stages, processToHostReadyMs: elapsed(begin) }, counters: message.counters }
      else if (message.kind === 'restored' && report !== undefined) {
        Object.assign(report.stages, message.stages)
        Object.assign(report.counters, message.counters)
      }
    })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code !== 0 || report === undefined || report.counters.restoredMembers === undefined) reject(new Error(`Cold Host child failed (${code}): ${stderr}`))
      else resolveResult(report)
    })
  })
  return { runId, scenario: 'host-boot', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
    teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
    workload: { memberCount: 2, mode: 'fresh-node-process-and-populated-host-remount', schema: 2 },
    stages: result.stages, ids: {}, counters: result.counters }
}

async function coldBootChild(): Promise<void> {
  const stages: Record<string, number> = {}
  const counters: Record<string, number> = {}
  const prototype = AgentTeam.prototype as any
  for (const [method, metric] of [['persistedSessionHeaders', 'sessionInventoryMs'], ['activateMember', 'restoreActivationMs']]) {
    const original = prototype[method!]
    prototype[method!] = async function (...args: unknown[]) {
      const begin = now()
      try { return await original.apply(this, args) } finally { stages[metric!] = (stages[metric!] ?? 0) + elapsed(begin) }
    }
  }
  const begin = now()
  const host = await mount()
  stages.hostBootMs = elapsed(begin)
  process.send?.({ kind: 'ready', stages, counters: { bootMembers: host.ctx.agentTeam.members().length } })
  const release = host.ctx.llm.registerAdapter(['mock'], new CollaborationAdapter(0))
  try {
    for (let index = 0; index < 2; index += 1) {
      const member = await addMember(host.ctx, `boot-restore-${index}`)
      const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`boot-session-${index}`),
        name: 'team_view', arguments: {}, agent: member.agent })
      if (result.isError) throw new Error('Cold boot fixture could not initialize its Member')
    }
    await host.teamFiber.dispose()
    stages.sessionInventoryMs = 0
    stages.restoreActivationMs = 0
    const restoreBegin = now()
    await host.ctx.plugin(AgentTeam)
    stages.populatedHostRestoreMs = elapsed(restoreBegin)
    const members = host.ctx.agentTeam.members()
    counters.restoredMembers = members.filter(member => member.availability === 'active').length
    if (counters.restoredMembers !== 2) throw new Error('Cold boot fixture lost a Member during restore')
    host.ctx.agentTeam.validateLedger()
    process.send?.({ kind: 'restored', stages: { sessionInventoryMs: stages.sessionInventoryMs,
      restoreActivationMs: stages.restoreActivationMs, populatedHostRestoreMs: stages.populatedHostRestoreMs }, counters })
  } finally {
    release()
    await host.dispose()
  }
}

async function memberActivationSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  try {
    const begin = now()
    const member = await addMember(host.ctx, `baseline-activation-${sample}`)
    const activationMs = elapsed(begin)
    return {
      runId, scenario: 'member-activation', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { memberCount: 1, previousSession: false, model: 'mock', activation: 'new-member' },
      stages: { memberActivationMs: activationMs },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null, agentSessionId: member.agent.id },
      counters: { activatedMembers: 1 },
    }
  } finally {
    await host.dispose()
  }
}

async function memberActivationBatchSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const sequentialHost = await mount()
  const sequentialDurations: number[] = []
  let sequentialBatchMs = 0
  try {
    const begin = now()
    for (let index = 0; index < memberCount; index += 1) {
      const memberBegin = now()
      await addMember(sequentialHost.ctx, `baseline-activation-sequential-${sample}-${index}`)
      sequentialDurations.push(elapsed(memberBegin))
    }
    sequentialBatchMs = elapsed(begin)
  } finally {
    await sequentialHost.dispose()
  }
  const concurrentHost = await mount()
  const concurrentDurations: number[] = []
  let concurrentBatchMs = 0
  try {
    const begin = now()
    await Promise.all(Array.from({ length: memberCount }, async (_unused, index) => {
      const memberBegin = now()
      await addMember(concurrentHost.ctx, `baseline-activation-concurrent-${sample}-${index}`)
      concurrentDurations.push(elapsed(memberBegin))
    }))
    concurrentBatchMs = elapsed(begin)
    return {
      runId, scenario: 'member-activation-batch', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { memberCount, sequential: true, concurrent: true, model: 'mock', activation: 'new-member' },
      stages: { sequentialBatchMs, concurrentBatchMs, sequentialPerMemberP95Ms: percentile(sequentialDurations, 0.95), concurrentPerMemberP95Ms: percentile(concurrentDurations, 0.95) },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null },
      counters: { requestedMembers: memberCount, sequentialActivatedMembers: sequentialDurations.length, concurrentActivatedMembers: concurrentDurations.length },
    }
  } finally {
    await concurrentHost.dispose()
  }
}

async function addMember(ctx: Context, handle: string, projectRef?: AgentTeamProjectRef): Promise<{ memberId: AgentTeamMemberId; actor: AgentTeamMemberActor; agent: Agent }> {
  const result = await ctx.agentTeam.addMember({ requestId: requestId(`baseline:add:${handle}`), workspaceId, handle,
    description: 'Performance baseline member', presetId: 'team-member', projectRefs: projectRef === undefined ? [] : [projectRef] })
  const agent = ctx.agents.get(result.status.member.sessionId)
  if (agent === undefined) throw new Error(`Member ${handle} did not produce a live Agent`)
  return { memberId: result.status.member.memberId, actor: { kind: 'member', memberId: result.status.member.memberId, handle }, agent }
}

async function memberResumeSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  try {
    const member = await addMember(host.ctx, `baseline-resume-${sample}`)
    await host.ctx.agentTeam.suspendMember({ requestId: requestId(`baseline:suspend:${sample}`), memberId: member.memberId })
    const begin = now()
    const resumed = await host.ctx.agentTeam.resumeMember({ requestId: requestId(`baseline:resume:${sample}`), memberId: member.memberId })
    const resumeMs = elapsed(begin)
    if (resumed.status.member.memberId !== member.memberId || host.ctx.agents.get(resumed.status.member.sessionId) === undefined) {
      throw new Error(`Member ${member.memberId} did not produce a live Agent after resume`)
    }
    return {
      runId, scenario: 'member-resume', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { memberCount: 1, previousSession: true, model: 'mock', activation: 'resume-member' },
      stages: { memberResumeMs: resumeMs },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null, agentSessionId: resumed.status.member.sessionId },
      counters: { activatedMembers: 1 },
    }
  } finally {
    await host.dispose()
  }
}

async function toolSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  const adapter = new EmptyAdapter()
  const releaseAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const member = await addMember(host.ctx, `baseline-tool-${sample}`)
    const team = host.ctx.agentTeam as any
    let hostViewMs: number | null = null
    const originalView = team.viewForAgent.bind(team)
    team.viewForAgent = (...args: unknown[]) => {
      const begin = now()
      try { return originalView(...args) } finally { hostViewMs = elapsed(begin) }
    }
    const begin = now()
    const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-view-${sample}`),
      name: 'team_view', arguments: {}, agent: member.agent })
    const total = elapsed(begin)
    if (result.isError) throw new Error(`team_view baseline failed: ${JSON.stringify(result)}`)
    return {
      runId, scenario: 'tool-call', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt: startedAt, teamCommit: commits.team, harnessCommit: commits.harness,
      node: process.version, workload: { tool: 'team_view', memberCount: 1, action: 'read' },
      stages: { toolTotalMs: total, hostViewMs, clientMs: null }, ids: { requestId: null, operationId: null, noticeMessageId: null, callId: `baseline-view-${sample}`, turnId: null, agentSessionId: member.agent.id }, counters: { resultBytes: Buffer.byteLength(JSON.stringify(result)) },
    }
  } finally {
    releaseAdapter()
    await host.dispose()
  }
}

async function toolReadSweepSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  const adapter = new EmptyAdapter()
  const releaseAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const member = await addMember(host.ctx, `baseline-tool-sweep-${sample}`)
    const project = await host.ctx.agentTeam.createProject({ requestId: requestId(`baseline:tool-sweep-project:${sample}`), workspaceId,
      name: 'tool-read-sweep', description: 'Tool read performance benchmark' })
    const projectMember = await addMember(host.ctx, `baseline-tool-sweep-project-member-${sample}`, project.project.projectRef)
    const started = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId(`baseline:tool-sweep-thread:${sample}`), workspaceId,
      projectRef: project.project.projectRef, body: 'Tool read sweep Thread' })
    if (started.kind !== 'committed') throw new Error(`tool-read-sweep Thread did not commit: ${started.kind}`)
    const calls = [
      { name: 'team_inbox', arguments: {} },
      { name: 'team_task', arguments: { action: 'board' } },
      { name: 'team_view', arguments: {} },
      { name: 'team_attention', arguments: { action: 'status', threadRef: started.thread.threadRef } },
      { name: 'team_thread', arguments: { action: 'read', threadRef: started.thread.threadRef } },
    ] as const
    const stages: Record<string, number> = {}
    const counters: Record<string, number> = {}
    const begin = now()
    for (const [index, call] of calls.entries()) {
      const callBegin = now()
      const agent = call.name === 'team_inbox' || call.name === 'team_task' || call.name === 'team_view' ? member.agent : projectMember.agent
      const result = await host.ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`baseline-sweep-${sample}-${index}`), name: call.name, arguments: call.arguments, agent })
      stages[`${call.name}Ms`] = elapsed(callBegin)
      if (result.isError) throw new Error(`${call.name} baseline failed: ${JSON.stringify(result)}`)
      counters[`${call.name}ResultBytes`] = Buffer.byteLength(JSON.stringify(result))
    }
    return { runId, scenario: 'tool-read-sweep', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { tools: calls.map(call => call.name), memberCount: 2, action: 'read' },
      stages: { toolSweepMs: elapsed(begin), ...stages }, ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null, agentSessionId: member.agent.id }, counters }
  } finally {
    releaseAdapter()
    await host.dispose()
  }
}

async function threadReadReplySample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  const adapter = new EmptyAdapter()
  const releaseAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const project = await host.ctx.agentTeam.createProject({ requestId: requestId(`baseline:read-reply-project:${sample}`), workspaceId,
      name: 'thread-read-reply', description: 'Thread read and reply performance benchmark' })
    const member = await addMember(host.ctx, `baseline-read-reply-${sample}`, project.project.projectRef)
    await host.ctx.agentTeam.addProjectOwner({ requestId: requestId(`baseline:read-reply-owner:${sample}`), workspaceId,
      projectRef: project.project.projectRef, memberId: member.memberId })
    const started = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId(`baseline:read-reply-start:${sample}`), workspaceId,
      projectRef: project.project.projectRef, body: 'Performance benchmark read and reply' })
    if (started.kind !== 'committed') throw new Error(`thread-read-reply Thread did not commit: ${started.kind}`)
    const readBegin = now()
    const read = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-thread-read-${sample}`),
      name: 'team_thread', arguments: { action: 'read', threadRef: started.thread.threadRef }, agent: member.agent })
    const threadReadMs = elapsed(readBegin)
    if (read.isError) throw new Error(`team_thread read baseline failed: ${JSON.stringify(read)}`)
    const replyBegin = now()
    const reply = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-thread-reply-${sample}`),
      name: 'team_message', arguments: { action: 'reply', threadRef: started.thread.threadRef, baseRevision: started.thread.revision,
        body: 'Performance benchmark reply' }, agent: member.agent })
    const threadReplyMs = elapsed(replyBegin)
    if (reply.isError) throw new Error(`team_message reply baseline failed: ${JSON.stringify(reply)}`)
    return {
      runId, scenario: 'thread-read-reply', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { tools: ['team_thread', 'team_message'], actions: ['read', 'reply'], memberCount: 1, threadCount: 1 },
      stages: { threadReadMs, threadReplyMs, readReplyMs: threadReadMs + threadReplyMs, clientMs: null },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null, readCallId: `baseline-thread-read-${sample}`,
        replyCallId: `baseline-thread-reply-${sample}`, agentSessionId: member.agent.id },
      counters: { readResultBytes: Buffer.byteLength(JSON.stringify(read)), replyResultBytes: Buffer.byteLength(JSON.stringify(reply)), reads: 1, replies: 1 },
    }
  } finally {
    releaseAdapter()
    await host.dispose()
  }
}

async function waitForCallCount(calls: readonly unknown[], expected: number): Promise<void> {
  const deadline = now() + 5_000
  while (calls.length < expected) {
    if (now() >= deadline) throw new Error(`notification retry benchmark expected ${expected} wake calls, received ${calls.length}`)
    await new Promise<void>(resolveCall => setImmediate(resolveCall))
  }
}

async function notificationRetrySample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  try {
    const project = await host.ctx.agentTeam.createProject({ requestId: requestId(`baseline:notification-retry-project:${sample}`), workspaceId,
      name: 'notification-retry', description: 'Notification failure recovery performance benchmark' })
    const member = await addMember(host.ctx, `baseline-notification-retry-${sample}`, project.project.projectRef)
    await host.ctx.agentTeam.addProjectOwner({ requestId: requestId(`baseline:notification-retry-owner:${sample}`), workspaceId,
      projectRef: project.project.projectRef, memberId: member.memberId })
    const calls: unknown[] = []
    let failNext = true
    const wake = (message: unknown): void => {
      calls.push(message)
      if (failNext) {
        failNext = false
        throw new Error('performance benchmark wake failure')
      }
    }
    member.agent.steer = wake
    member.agent.followup = wake
    const firstBegin = now()
    const started = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId(`baseline:notification-retry-start:${sample}`), workspaceId,
      projectRef: project.project.projectRef, body: `@${member.actor.handle} benchmark failure` })
    const firstCommitMs = elapsed(firstBegin)
    if (started.kind !== 'committed') throw new Error(`notification-retry Thread did not commit: ${started.kind}`)
    await waitForCallCount(calls, 1)
    const firstDeliveryMs = elapsed(firstBegin)
    const retryBegin = now()
    const retry = await host.ctx.agentTeam.reply({ requestId: requestId(`baseline:notification-retry-reply:${sample}`), workspaceId,
      threadRef: started.thread.threadRef, baseRevision: started.thread.revision, body: `@${member.actor.handle} benchmark retry` })
    if (retry.kind !== 'committed') throw new Error(`notification-retry reply did not commit: ${retry.kind}`)
    await waitForCallCount(calls, 2)
    const retryDeliveryMs = elapsed(retryBegin)
    return {
      runId, scenario: 'notification-retry', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { memberCount: 1, firstDelivery: 'forced-failure', retryTrigger: 'reply', deliveryMode: 'synchronous-host' },
      stages: { firstCommitMs, firstDeliveryMs, retryDeliveryMs, clientMs: null },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null, agentSessionId: member.agent.id },
      counters: { deliveryAttempts: calls.length, failedAttempts: 1, successfulAttempts: 1 },
    }
  } finally {
    await host.dispose()
  }
}

async function toolWriteSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  const adapter = new EmptyAdapter()
  const releaseAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const project = await host.ctx.agentTeam.createProject({ requestId: requestId(`baseline:tool-write-project:${sample}`), workspaceId,
      name: 'tool-write', description: 'Tool write performance benchmark' })
    const member = await addMember(host.ctx, `baseline-tool-write-${sample}`, project.project.projectRef)
    const recipient = await addMember(host.ctx, `baseline-tool-dm-recipient-${sample}`, project.project.projectRef)
    await host.ctx.agentTeam.addProjectOwner({ requestId: requestId(`baseline:tool-write-owner:${sample}`), workspaceId,
      projectRef: project.project.projectRef, memberId: member.memberId })
    const team = host.ctx.agentTeam as any
    let hostPostMs: number | null = null
    const originalPost = team.postMainMessageForAgent.bind(team)
    team.postMainMessageForAgent = async (...args: unknown[]) => {
      const begin = now()
      try { return await originalPost(...args) } finally { hostPostMs = elapsed(begin) }
    }
    const begin = now()
    const result = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-write-${sample}`),
      name: 'team_message', arguments: { action: 'post', projectRef: project.project.projectRef, body: 'Performance benchmark post' }, agent: member.agent })
    const total = elapsed(begin)
    if (result.isError) throw new Error(`team_message post baseline failed: ${JSON.stringify(result)}`)
    const dmBegin = now()
    const dmResult = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-dm-${sample}`),
      name: 'team_dm', arguments: { memberRef: recipient.memberId, body: 'Performance benchmark DM' }, agent: member.agent })
    const dmTotal = elapsed(dmBegin)
    if (dmResult.isError) throw new Error(`team_dm baseline failed: ${JSON.stringify(dmResult)}`)
    const taskBegin = now()
    const taskResult = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-task-${sample}`),
      name: 'team_message', arguments: { action: 'start', kind: 'task', projectRef: project.project.projectRef, body: 'Performance benchmark task' }, agent: member.agent })
    const taskTotal = elapsed(taskBegin)
    if (taskResult.isError) throw new Error(`team_message task start baseline failed: ${JSON.stringify(taskResult)}`)
    return {
      runId, scenario: 'tool-write', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { tools: ['team_message', 'team_dm'], actions: ['post', 'send', 'start-task'], memberCount: 2, deliveryTargets: 1 },
      stages: { toolTotalMs: total, hostPostMs, teamDmMs: dmTotal, taskStartMs: taskTotal, clientMs: null },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null, callId: `baseline-write-${sample}`, dmCallId: `baseline-dm-${sample}`, taskCallId: `baseline-task-${sample}`, agentSessionId: member.agent.id },
      counters: { resultBytes: Buffer.byteLength(JSON.stringify(result)), dmResultBytes: Buffer.byteLength(JSON.stringify(dmResult)), taskResultBytes: Buffer.byteLength(JSON.stringify(taskResult)), committedMessages: 1, directMessages: 1, startedTasks: 1 },
    }
  } finally {
    releaseAdapter()
    await host.dispose()
  }
}

async function waitForAgentIdle(ctx: any, agent: any): Promise<void> {
  if (agent.status === 'idle') return
  await new Promise<void>((resolveIdle, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error('benchmark Agent did not become idle within 20 seconds')) }, 20_000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }: { agent: unknown; status: string }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolveIdle()
    })
  })
}

async function collaborationAgentTurnSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  const adapter = new CollaborationAdapter(sample)
  const releaseAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const team = host.ctx.agentTeam
    const project = await team.createProject({ requestId: requestId(`baseline:agent-project:${sample}`), workspaceId, name: 'agent-turn', description: 'Performance benchmark' })
    const sender = await addMember(host.ctx, `baseline-sender-${sample}`, project.project.projectRef)
    const receiver = await addMember(host.ctx, `baseline-receiver-${sample}`, project.project.projectRef)
    await team.addProjectOwner({ requestId: requestId(`baseline:sender-owner:${sample}`), workspaceId,
      projectRef: project.project.projectRef, memberId: sender.memberId })
    await waitForAgentIdle(host.ctx, sender.agent)
    adapter.receiverSessionId = receiver.agent.id
    const stages: Record<string, number> = {}
    const ids: Record<string, string> = { agentSessionId: receiver.agent.id, senderSessionId: sender.agent.id }
    const counters: Record<string, number> = { reads: 0, replies: 0, modelRequests: 0 }
    let phase: 'cold' | 'warm' = 'cold'
    let marks: Record<string, number> = {}
    const key = (name: string): string => phase === 'cold' ? name : `warm${name[0]!.toUpperCase()}${name.slice(1)}`
    const recordNotice = (message: { id: string }): void => {
      marks.noticeQueued ??= now()
      ids[key('noticeMessageId')] ??= message.id
    }
    const steer = receiver.agent.steer.bind(receiver.agent)
    const followup = receiver.agent.followup.bind(receiver.agent)
    receiver.agent.steer = message => { recordNotice(message); return steer(message) }
    receiver.agent.followup = message => { recordNotice(message); return followup(message) }
    host.ctx.on('agent/inbox/claimed', event => {
      if (event.agent !== receiver.agent || event.message.id !== ids[key('noticeMessageId')]) return
      marks.noticeClaimed = now()
      ids[key('turnId')] = String(event.turn)
    })
    host.ctx.on('tools/execute', async (execution, next) => {
      if (execution.agent !== receiver.agent) return next()
      const begin = now()
      const result = await next()
      if (result.isError) throw new Error(`Collaboration ${execution.name} failed`)
      const action = execution.name === 'team_thread' ? 'read' : 'reply'
      marks[`${action}Finished`] = now()
      stages[key(`${action}ToolMs`)] = now() - begin
      ids[key(`${action}CallId`)] = execution.callId
      counters[action === 'read' ? 'reads' : 'replies']! += 1
      return result
    })
    host.ctx.on('agent-team/committed', ({ receipt }) => {
      const operation = team['ledger']!.getOperation(receipt.operationId)!
      if (operation.actor.kind !== 'member' || operation.actor.memberId !== receiver.memberId) return
      if (operation.kind !== 'team/thread-read' && operation.kind !== 'team/thread-replied') return
      const action = operation.kind === 'team/thread-read' ? 'read' : 'reply'
      marks[`${action}Committed`] = now()
      ids[key(`${action}OperationId`)] = receipt.operationId
      ids[key(`${action}RequestId`)] = receipt.requestId
    })
    let threadRef: string | undefined
    for (const current of ['cold', 'warm'] as const) {
      phase = current
      adapter.phase = current
      adapter.step = 0
      let baseRevision: number | undefined
      if (current === 'warm') {
        const read = await host.ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`baseline-sender-read-${sample}`),
          name: 'team_thread', arguments: { action: 'read', threadRef }, agent: sender.agent })
        const text = read.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        const revision = text.match(/baseRevision: (\d+)/)?.[1]
        if (read.isError || revision === undefined) throw new Error('Sender could not read the current Thread revision')
        baseRevision = Number(revision)
      }
      marks = { begin: now() }
      const requestIndex = adapter.requests.length
      const started = current === 'cold'
        ? await team.startThreadForAgent(sender.agent, { kind: 'discussion', requestId: requestId(`baseline:agent-thread:${sample}`), workspaceId,
          projectRef: project.project.projectRef, body: `@${receiver.actor.handle} run the benchmark` })
        : await team.replyForAgent(sender.agent, { requestId: requestId(`baseline:agent-warm:${sample}`), workspaceId,
          threadRef: threadRef as never, baseRevision: baseRevision!,
          body: `@${receiver.actor.handle} run the warm benchmark` })
      if (started.kind !== 'committed') throw new Error(`Collaboration trigger failed: ${started.kind}`)
      threadRef = started.thread.threadRef
      marks.ack = now()
      ids[key('requestId')] = started.receipt.requestId
      ids[key('operationId')] = started.receipt.operationId
      const deadline = now() + 20_000
      const expected = current === 'cold' ? 1 : 2
      while (adapter.completed < expected) {
        if (now() > deadline) throw new Error('Collaboration model did not finish its read/reply cycle')
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      await waitForAgentIdle(host.ctx, receiver.agent)
      marks.idle = now()
      marks.modelRequest = adapter.requestTimes[requestIndex]!
      for (const required of ['noticeQueued', 'noticeClaimed', 'readCommitted', 'replyCommitted', 'readFinished', 'replyFinished']) {
        if (marks[required] === undefined) throw new Error(`Collaboration did not observe ${required}`)
      }
      const intervals = {
        triggerCommitMs: ['begin', 'ack'], triggerToNoticeQueuedMs: ['begin', 'noticeQueued'],
        noticeQueuedToClaimedMs: ['noticeQueued', 'noticeClaimed'], noticeQueuedToModelRequestMs: ['noticeQueued', 'modelRequest'],
        modelRequestToReadMs: ['modelRequest', 'readFinished'], readToReplyCommittedMs: ['readFinished', 'replyCommitted'],
        triggerToReplyCommittedMs: ['begin', 'replyCommitted'], triggerToAgentIdleMs: ['begin', 'idle'],
      }
      for (const [name, [from, to]] of Object.entries(intervals)) stages[key(name)] = marks[to!]! - marks[from!]!
      const history = team['ledger']!.threadHistory(agentTeamHumanActor(), { workspaceId, threadRef: threadRef as never, limit: 100 })
      if (!JSON.stringify(history).includes(`Benchmark ${current} reply.`)) throw new Error('Collaboration reply missing from durable history')
    }
    counters.modelRequests = adapter.requests.length
    if (counters.reads !== 2 || counters.replies !== 2 || counters.modelRequests !== 6) throw new Error(`Unexpected collaboration counts: ${JSON.stringify(counters)}`)
    team.validateLedger()
    return { runId, scenario: 'collaboration-agent-turn', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { receiver: receiver.memberId, sender: sender.memberId, model: 'mock', response: 'team-tool-read-reply', schema: 2, warmMode: 'same-agent-same-host' },
      stages, ids, counters }
  } finally {
    releaseAdapter()
    await host.dispose()
  }
}

async function collaborationSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const host = await mount()
  const adapter = new CollaborationAdapter(sample)
  const releaseAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
  try {
    const project = await host.ctx.agentTeam.createProject({ requestId: requestId(`baseline:project:${sample}`), workspaceId, name: 'baseline', description: 'Performance baseline' })
    const receiver = await addMember(host.ctx, `baseline-receiver-${sample}`, project.project.projectRef)
    const sender = await addMember(host.ctx, `baseline-sender-${sample}`, project.project.projectRef)
    const followers = []
    for (let index = 0; index < followerCount; index += 1) followers.push(await addMember(host.ctx, `baseline-follower-${sample}-${index}`, project.project.projectRef))
    const threads = []
    for (let index = 0; index < threadCount; index += 1) {
      const started = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId(`baseline:thread:${sample}:${index}`), workspaceId,
        projectRef: project.project.projectRef, body: `Performance baseline thread ${index}` })
      if (started.kind !== 'committed') throw new Error('baseline Thread did not commit')
      threads.push(started.thread)
    }
    const ledger = host.ctx.agentTeam['ledger'] as any
    for (const [index, follower] of [receiver, ...followers].entries()) {
      for (const [threadIndex, thread] of threads.entries()) await ledger.changeAttention({ requestId: requestId(`baseline:follow:${sample}:${index}:${threadIndex}`), actor: follower.actor, workspaceId,
        threadRef: thread.threadRef, action: 'follow' })
    }
    for (const [index, thread] of threads.entries()) {
      const unread = await ledger.reply({ requestId: requestId(`baseline:unread:${sample}:${index}`), actor: agentTeamHumanActor(), workspaceId,
        threadRef: thread.threadRef, baseRevision: thread.revision, body: 'Unread performance fixture' })
      if (!unread.committed) throw new Error('Could not populate unread Thread fixture')
      threads[index] = unread.value.thread
    }
    const unreadThreads = ledger.memberInbox(receiver.actor, {}).items.length
    if (unreadThreads !== Math.min(threadCount, 50)) throw new Error(`Expected ${threadCount} unread Threads (bounded at 50), found ${unreadThreads}`)
    const targetThread = threads[0]!
    const ledgerQueue = instrumentLedgerQueue(ledger)
    let notificationDispatches = 0
    const teamDispatch = host.ctx.agentTeam as any
    const notify = teamDispatch.notifyMember.bind(teamDispatch)
    teamDispatch.notifyMember = (...args: any[]) => {
      try { return notify(...args) } finally { if (args[1]?.kind === 'commit') notificationDispatches += 1 }
    }
    const counts = { notificationFacts: 0, mainNotificationFacts: 0, mainUnreadFrom: 0, deliveryPlans: 0, deliveryPlansDuringText: 0, deliveryPlansOutsideText: 0, notificationText: 0, notificationTextMissingPlan: 0 }
    const timings = { notificationFactsMs: 0, mainNotificationFactsMs: 0, mainUnreadFromMs: 0, deliveryPlanMs: 0, notificationTextMs: 0 }
    let insideNotificationText = false
    let ledgerReplyMs: number | null = null
    let fanoutDispatchMs: number | null = null
    const originalReply = ledger.reply.bind(ledger)
    ledger.reply = async (...args: unknown[]) => {
      const begin = now()
      try { return await originalReply(...args) } finally { ledgerReplyMs = elapsed(begin) }
    }
    const team = host.ctx.agentTeam as any
    const originalEmitCommitted = team.emitCommitted.bind(team)
    team.emitCommitted = (...args: unknown[]) => {
      const begin = now()
      try { return originalEmitCommitted(...args) } finally { fanoutDispatchMs = elapsed(begin) }
    }
    const original = {
      notificationFacts: ledger.notificationFacts.bind(ledger),
      mainNotificationFacts: ledger.mainNotificationFacts.bind(ledger),
      mainUnreadFrom: ledger.mainUnreadFrom.bind(ledger),
      deliveryPlan: host.ctx.agentTeam['inboxDeliveryPlan'].bind(host.ctx.agentTeam),
      notificationText: host.ctx.agentTeam['notificationText'].bind(host.ctx.agentTeam),
    }
    ledger.notificationFacts = (...args: unknown[]) => {
      counts.notificationFacts += 1
      const begin = now()
      try { return original.notificationFacts(...args) } finally { timings.notificationFactsMs += elapsed(begin) }
    }
    ledger.mainNotificationFacts = (...args: unknown[]) => {
      counts.mainNotificationFacts += 1
      const begin = now()
      try { return original.mainNotificationFacts(...args) } finally { timings.mainNotificationFactsMs += elapsed(begin) }
    }
    ledger.mainUnreadFrom = (...args: unknown[]) => {
      counts.mainUnreadFrom += 1
      const begin = now()
      try { return original.mainUnreadFrom(...args) } finally { timings.mainUnreadFromMs += elapsed(begin) }
    }
    host.ctx.agentTeam['inboxDeliveryPlan'] = (...args: Parameters<typeof original.deliveryPlan>) => {
      counts.deliveryPlans += 1
      if (insideNotificationText) counts.deliveryPlansDuringText += 1
      else counts.deliveryPlansOutsideText += 1
      const begin = now()
      try { return original.deliveryPlan(...args) } finally { timings.deliveryPlanMs += elapsed(begin) }
    }
    host.ctx.agentTeam['notificationText'] = (...args: Parameters<typeof original.notificationText>) => {
      counts.notificationText += 1
      if (args[4] === undefined) counts.notificationTextMissingPlan += 1
      insideNotificationText = true
      const begin = now()
      try { return original.notificationText(...args) } finally {
        timings.notificationTextMs += elapsed(begin)
        insideNotificationText = false
      }
    }
    const begin = now()
    const eventLoopBegin = now()
    const eventLoopProbe = new Promise<number>(resolveLag => setImmediate(() => resolveLag(elapsed(eventLoopBegin))))
    const reply = await host.ctx.agentTeam.reply({ requestId: requestId(`baseline:reply:${sample}`), workspaceId,
      threadRef: targetThread.threadRef, baseRevision: targetThread.revision, body: 'Performance baseline reply' })
    const total = elapsed(begin)
    const eventLoopLagMs = await eventLoopProbe
    const drainBegin = now()
    const expectedDispatches = followerCount + 1
    const deadline = now() + 20_000
    while (notificationDispatches < expectedDispatches) {
      if (now() > deadline) throw new Error(`Only ${notificationDispatches}/${expectedDispatches} notification dispatches completed`)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const notificationDrainMs = elapsed(drainBegin)
    if (reply.kind !== 'committed') throw new Error(`baseline reply did not commit: ${reply.kind}`)
    if (notificationDispatches !== expectedDispatches) throw new Error('Unexpected notification dispatch count')
    return {
      runId, scenario: 'collaboration-fanout', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt: startedAt, teamCommit: commits.team, harnessCommit: commits.harness,
      node: process.version, workload: { sender: sender.memberId, receiver: receiver.memberId, followerCount, threadCount, factsPerThread: 1, schema: 2 },
      stages: { replyCommitAndFanoutMs: total, notificationDrainMs, triggerToDispatchCompleteMs: elapsed(begin), ledgerReplyMs, ledgerQueueWaitMs: ledgerQueue.timings.queueWaitMs,
        ledgerQueueOperationMs: ledgerQueue.timings.operationMs, fanoutDispatchMs, eventLoopLagMs, ...timings, sessionAgentMs: null, clientMs: null },
      ids: { requestId: reply.receipt.requestId, operationId: reply.receipt.operationId, noticeMessageId: null, turnId: null, agentSessionId: receiver.agent.id },
      counters: { ...counts, unreadThreads, notificationDispatches, expectedDispatches, queuedNotifications: counts.notificationText, ledgerQueueOperations: ledgerQueue.operationCount() },
    }
  } finally {
    releaseAdapter()
    await host.dispose()
  }
}

type BenchSessionEvent = { readonly seq: number; readonly type: string; readonly time: number; readonly data?: { readonly turn?: number; readonly reason?: { readonly kind: 'completed' } } }

function benchSessionEvents(count: number): BenchSessionEvent[] {
  return Array.from({ length: count }, (_unused, index) => index % 2 === 0
    ? { seq: index, type: 'turn/start', time: index, data: { turn: Math.floor(index / 2) + 1 } }
    : { seq: index, type: 'turn/end', time: index, data: { turn: Math.floor(index / 2) + 1, reason: { kind: 'completed' as const } } })
}

async function sessionFoldSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const events = benchSessionEvents(sessionEventCount)
  const countFold: SessionEventFold<number, BenchSessionEvent> = { start: 0, step: count => count + 1 }
  const coldBegin = now()
  const cold = advanceSessionEventCursor(initSessionEventCursor(countFold), events, 0, events.length, countFold)
  const sessionCursorColdMs = elapsed(coldBegin)
  const prefixLength = Math.floor(events.length * 0.8)
  const prefix = advanceSessionEventCursor(initSessionEventCursor(countFold), events.slice(0, prefixLength), 0, prefixLength, countFold)
  const incrementalBegin = now()
  const incremental = advanceSessionEventCursor(prefix, events, 0, events.length, countFold)
  const sessionCursorIncrementalMs = elapsed(incrementalBegin)
  const projectionEvents = events as any
  const projectionBegin = now()
  const projection = foldTeamContextProjection(projectionEvents, { sessionId: `benchmark-session-${sample}` })
  const teamProjectionColdMs = elapsed(projectionBegin)
  if (cold.value !== events.length || incremental.value !== events.length || projection.lastTurn !== Math.ceil(events.length / 2)) {
    throw new Error(`session fold benchmark produced an incomplete result: cursor=${incremental.value}, projectionTurn=${projection.lastTurn}`)
  }
  return {
    runId, scenario: 'session-fold', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
    teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
    workload: { backend: 'in-memory synthetic events', eventCount: events.length, incrementalPrefixRatio: prefixLength / events.length, model: 'none' },
    stages: { sessionCursorColdMs, sessionCursorIncrementalMs, teamProjectionColdMs },
    ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null },
    counters: { eventCount: events.length, sessionJsonBytes: Buffer.byteLength(JSON.stringify(events)), coldFoldedEvents: cold.value, incrementalTailEvents: incremental.value - prefix.value },
  }
}

async function sessionReplayJsonlSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const directory = await mkdtemp(join(root, 'artifacts/team-perf/session-'))
  const events = benchSessionEvents(sessionEventCount)
  const sessionId = SessionId(`benchmark-session-${sample}`)
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: sessionCompression as 'zstd' | 'none' })
    const persistence = ctx.get('sessionPersistence') as {
      create: (header: unknown) => Promise<{ append: (events: readonly unknown[]) => Promise<void>; flush: () => Promise<void>; close: () => Promise<void> }>
      open: (id: SessionId, access: 'read') => Promise<{ read: () => Promise<{ events: readonly unknown[] }>; close: () => Promise<void> }>
    }
    const writeBegin = now()
    const writer = await persistence.create({ id: sessionId, version: sessionFormatCatalog.currentVersion, createdAt: Date.now(), isSeeded: false, delegationDepth: 0, cwd: root })
    await writer.append(events)
    await writer.flush()
    const writeMs = elapsed(writeBegin)
    await writer.close()
    const names = await readdir(directory, { recursive: true }) as string[]
    const sessionBytes = (await Promise.all(names.map(async name => {
      const details = await stat(join(directory, name))
      return details.isFile() ? details.size : 0
    }))).reduce((sum, value) => sum + value, 0)
    const readBegin = now()
    const reader = await persistence.open(sessionId, 'read')
    const loaded = await reader.read()
    const readMs = elapsed(readBegin)
    await reader.close()
    if (loaded.events.length !== events.length) throw new Error(`JSONL Session replay returned ${loaded.events.length} events, expected ${events.length}`)
    return {
      runId, scenario: 'session-replay-jsonl', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { backend: `jsonl-${sessionCompression}`, eventCount: events.length, model: 'none' },
      stages: { sessionWriteMs: writeMs, sessionReadMs: readMs, sessionTotalMs: writeMs + readMs },
      ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null },
      counters: { eventCount: events.length, sessionBytes, replayedEvents: loaded.events.length },
    }
  } finally {
    await ctx.fiber.dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

interface LedgerWorkload {
  readonly ledger: AgentTeamLedger
  readonly actor: AgentTeamMemberActor
  readonly threadRefs: readonly string[]
  readonly projectRef: string
  readonly operationCount: number
}

async function seedLedger(ledger: AgentTeamLedger, sample: number): Promise<LedgerWorkload> {
  const member = await addLedgerMember(ledger, undefined, `member:bench-${sample}`, 'Performance benchmark member', `bench-${sample}`)
  const projectResult = await ledger.createProject({ requestId: requestId(`bench:project:${sample}`), workspaceId: alpha,
    name: 'Performance benchmark', description: 'Deterministic ledger workload', memberIds: [member.member.memberId], actor: agentTeamHumanActor() })
  const project = projectResult.value.project
  await makeOwner(ledger, project.projectRef, member.member.memberId)
  const threadRefs: string[] = []
  for (let index = 0; index < threadCount; index += 1) {
    const started = await ledger.startThread({ kind: 'discussion', requestId: requestId(`bench:thread:${sample}:${index}`), workspaceId: alpha,
      projectRef: project.projectRef, body: `Benchmark Thread ${index}`, actor: agentTeamHumanActor() })
    if (!started.committed) throw new Error('ledger benchmark Thread did not commit')
    const thread = started.value.thread
    threadRefs.push(thread.threadRef)
    await ledger.changeAttention({ requestId: requestId(`bench:follow:${sample}:${index}`), workspaceId: alpha,
      threadRef: thread.threadRef, action: 'follow', actor: member.actor })
    const replied = await ledger.reply({ requestId: requestId(`bench:reply:${sample}:${index}`), workspaceId: alpha,
      threadRef: thread.threadRef, baseRevision: thread.revision, body: `Benchmark reply ${index}`, actor: agentTeamHumanActor() })
    if (!replied.committed) throw new Error('ledger benchmark reply did not commit')
  }
  const operationCount = ledger.status().operationCount
  if (threadRefs.length !== threadCount || operationCount < 5 + threadCount * 3) throw new Error('ledger benchmark seed shape is incomplete')
  return { ledger, actor: member.actor, threadRefs, projectRef: project.projectRef, operationCount }
}

function readLedgerWorkload(workload: LedgerWorkload): { readonly stages: Record<string, number>; readonly counters: Record<string, number> } {
  const { ledger, actor, threadRefs, projectRef } = workload
  const firstThreadRef = threadRefs[0]
  if (firstThreadRef === undefined) throw new Error('ledger benchmark has no Thread')
  const ledgerInternals = ledger as any
  const originalUnreadFor = ledgerInternals.unreadFor.bind(ledger)
  let unreadForCalls = 0
  ledgerInternals.unreadFor = (...args: unknown[]) => { unreadForCalls += 1; return originalUnreadFor(...args) }
  const stages: Record<string, number> = {}
  const measure = <T>(name: string, operation: () => T): T => {
    const begin = now()
    try { return operation() } finally { stages[name] = elapsed(begin) }
  }
  const history = measure('threadHistoryMs', () => ledger.threadHistory(actor, { workspaceId: alpha, threadRef: firstThreadRef as never }))
  const view = measure('viewMs', () => ledger.view({ workspaceId: alpha, threadRef: firstThreadRef as never }, actor.memberId))
  const board = measure('taskBoardMs', () => ledger.taskBoard(actor, { workspaceId: alpha, projectRef: projectRef as never }))
  const notificationFacts = measure('notificationFactsMs', () => ledger.notificationFacts(actor.memberId, { workspaceId: alpha, limit: 100 }))
  const inbox = measure('memberInboxMs', () => ledger.memberInbox(actor, { limit: 100 }))
  const expectedFacts = Math.min(threadRefs.length, 100)
  if (history.facts.length !== 2 || view.items.length !== 2 || board.open.length !== 0
    || notificationFacts.length !== expectedFacts || notificationFacts.some(item => item.facts.length !== 1)
    || inbox.items.length !== expectedFacts) {
    throw new Error(`ledger benchmark read shape is incomplete: history=${history.facts.length}, view=${view.items.length}, board=${board.open.length}, notifications=${notificationFacts.length}, inbox=${inbox.items.length}`)
  }
  ledgerInternals.unreadFor = originalUnreadFor
  return { stages, counters: { historyFacts: history.facts.length, viewItems: view.items.length, taskBoardOpen: board.open.length,
    notificationThreads: notificationFacts.length, inboxItems: inbox.items.length, unreadForCalls, operationCount: workload.operationCount } }
}

async function ledgerReadMemorySample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const test = await harness()
  try {
    const seeded = await seedLedger(ledgerAtBoot(test), sample)
    const begin = now()
    const read = readLedgerWorkload(seeded)
    const readMs = elapsed(begin)
    return { runId, scenario: 'ledger-read-memory', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { backend: 'memory', threadCount, notificationLimit: 100, operationCount: seeded.operationCount },
      stages: { ledgerReadMs: readMs, ...read.stages }, ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null }, counters: read.counters }
  } finally {
    await test.fiber.dispose()
    await test.facility.closeAll()
  }
}

async function ledgerReplaySqliteSample(sample: number, commits: { team: string; harness: string }): Promise<Sample> {
  const startedAt = new Date().toISOString()
  const directory = await mkdtemp(join(root, 'artifacts/team-perf-sqlite-'))
  const path = join(directory, 'agent-team.sqlite')
  let first: Awaited<ReturnType<typeof sqliteHarness>> | undefined
  let second: Awaited<ReturnType<typeof sqliteHarness>> | undefined
  try {
    first = await sqliteHarness(path)
    const seeded = await seedLedger(ledgerAtBoot(first), sample)
    await first.fiber.dispose(); await first.facility.closeAll(); await first.backend.close(); first = undefined
    const begin = now()
    const hostBootBegin = now()
    second = await sqliteHarness(path)
    const sqliteHostBootMs = elapsed(hostBootBegin)
    const replayBegin = now()
    const replayed = ledgerAtBoot(second)
    const ledgerConstructorReplayMs = elapsed(replayBegin)
    const validateBegin = now()
    replayed.validate()
    const ledgerValidateMs = elapsed(validateBegin)
    const replayMs = elapsed(begin)
    const readBegin = now()
    const read = readLedgerWorkload({ ...seeded, ledger: replayed })
    const readMs = elapsed(readBegin)
    return { runId, scenario: 'ledger-replay-sqlite', sample, phase: sample === 0 ? 'warmup' : 'measure', startedAt,
      teamCommit: commits.team, harnessCommit: commits.harness, node: process.version,
      workload: { backend: 'sqlite', threadCount, notificationLimit: 100, operationCount: seeded.operationCount },
      stages: { sqliteReplayMs: replayMs, sqliteHostBootMs, ledgerConstructorReplayMs, ledgerValidateMs, ledgerReadMs: readMs, ...read.stages }, ids: { requestId: null, operationId: null, noticeMessageId: null, turnId: null }, counters: read.counters }
  } finally {
    for (const test of [second, first]) if (test !== undefined) {
      await test.fiber.dispose().catch(() => {})
      await test.facility.closeAll().catch(() => {})
      await test.backend.close().catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

function summarize(samples: readonly Sample[]) {
  const byScenario = new Map<string, Sample[]>()
  for (const sample of samples) {
    const list = byScenario.get(sample.scenario) ?? []
    byScenario.set(sample.scenario, list)
    list.push(sample)
  }
  return [...byScenario].map(([scenario, entries]) => {
    const stages = new Set(entries.flatMap(entry => Object.keys(entry.stages)))
    return { scenario, samples: entries.length, metrics: Object.fromEntries([...stages].map(metric => {
      const values = entries.map(entry => entry.stages[metric]).filter((value): value is number => value !== null && value !== undefined)
      return [metric, { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), min: values.length === 0 ? null : Math.min(...values), max: values.length === 0 ? null : Math.max(...values) }]
    })) }
  })
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true })
  const commits = { team: await commitOf(root), harness: await commitOf(harnessRoot) }
  const status = await execFile('git', ['-C', root, 'status', '--porcelain=v1']).then(result => result.stdout.trim()).catch(() => 'unknown')
  const manifest = {
    runId, command: process.argv.slice(2), startedAt: new Date().toISOString(), node: process.version,
    cwd: process.cwd(), commits, dirty: status !== '', status,
    config: { samplesPerScenario, warmupsPerScenario, followerCount, threadCount, memberCount, sessionEventCount, sessionCompression, scenarios: requestedScenarios },
  }
  await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const samplesPath = join(outputRoot, 'samples.jsonl')
  const samples: Sample[] = []
  const runners: Record<string, (sample: number, commits: { team: string; harness: string }) => Promise<Sample>> = {
    'bundle-size': bundleSizeSample, 'host-boot': bootSample, 'member-activation': memberActivationSample, 'member-activation-batch': memberActivationBatchSample, 'member-resume': memberResumeSample, 'tool-call': toolSample, 'tool-read-sweep': toolReadSweepSample, 'thread-read-reply': threadReadReplySample, 'notification-retry': notificationRetrySample,
    'tool-write': toolWriteSample,
    'collaboration-fanout': collaborationSample, 'collaboration-agent-turn': collaborationAgentTurnSample, 'session-fold': sessionFoldSample, 'session-replay-jsonl': sessionReplayJsonlSample,
    'ledger-read-memory': ledgerReadMemorySample, 'ledger-replay-sqlite': ledgerReplaySqliteSample,
  }
  const run = async (scenario: string, sample: number, phase: 'warmup' | 'measure') => {
    const result = await runners[scenario]!(sample, commits)
    const withPhase = { ...result, phase }
    if (phase === 'measure') {
      samples.push(withPhase)
      await appendFile(samplesPath, `${JSON.stringify(withPhase)}\n`)
    }
  }
  await writeFile(samplesPath, '')
  for (const scenario of requestedScenarios) {
    for (let warmup = 1; warmup <= warmupsPerScenario; warmup += 1) await run(scenario, 0, 'warmup')
    for (let sample = 1; sample <= samplesPerScenario; sample += 1) await run(scenario, sample, 'measure')
  }
  const summary = { runId, commits, node: process.version, sampleCount: samples.length, warmupsPerScenario, scenarios: requestedScenarios, summary: summarize(samples) }
  await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ outputRoot, ...summary }, null, 2))
}

if (process.argv.includes('--boot-child')) await coldBootChild()
else await main()
