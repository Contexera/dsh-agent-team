// Explicit semantic probes for the ordered post-commit notification queue.
// Normal development and test commands do not run this file.
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { mountTeamMemberHost, provideQuietTokenMeter } from '../../packages/agent-team/tests/helpers/team-host-fixture.ts'
import { changeBaseline, nextChange } from '../../packages/agent-team/tests/helpers/change-stream.ts'
import type { AgentTeamMemberActor, AgentTeamRequestId } from '../../packages/agent-team/src/types.ts'

if (process.env.DSH_BENCH_TEAM !== '1') {
  console.error('Set DSH_BENCH_TEAM=1 to run the Team semantic probes.')
  process.exit(0)
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const workspaceId = WorkspaceId('workspace:fixture')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const outputRoot = resolve(root, 'artifacts/team-perf/semantics', runId)

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

async function addMember(ctx: any, handle: string, projectRef: string): Promise<{ actor: AgentTeamMemberActor; agent: any }> {
  const result = await ctx.agentTeam.addMember({ requestId: requestId(`semantic:add:${handle}`), workspaceId, handle,
    description: 'Semantic benchmark member', presetId: 'team-member', projectRefs: [projectRef] })
  const agent = ctx.agents.get(result.status.member.sessionId)
  if (agent === undefined) throw new Error(`Member ${handle} did not produce a live Agent`)
  return { actor: { kind: 'member', memberId: result.status.member.memberId, handle }, agent }
}

function silenceAgent(agent: any, calls: UserMessage[], wake: (message: UserMessage) => void = message => { calls.push(message) }): void {
  agent.steer = wake
  agent.followup = wake
}

async function waitForNotificationEffects(team: any): Promise<void> {
  while (team.notificationEffectTails.size > 0) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

async function project(ctx: any, name: string): Promise<string> {
  const result = await ctx.agentTeam.createProject({ requestId: requestId(`semantic:project:${name}`), workspaceId,
    name, description: 'Semantic benchmark project' })
  return result.project.projectRef
}

async function failureProbe() {
  const host = await mount()
  try {
    const projectRef = await project(host.ctx, 'failure')
    const calls: UserMessage[] = []
    const member = await addMember(host.ctx, 'semantic-failure', projectRef)
    let failed = false
    silenceAgent(member.agent, calls, message => {
      calls.push(message)
      if (!failed) {
        failed = true
        throw new Error('semantic wake failure')
      }
    })
    const started = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('semantic:failure:start'), workspaceId,
      projectRef: projectRef as never, body: `@${member.actor.handle} first semantic wake` })
    await waitForNotificationEffects(host.ctx.agentTeam)
    if (started.kind !== 'committed') throw new Error(`failure probe start did not commit: ${started.kind}`)
    const firstCalls = calls.length
    const retry = await host.ctx.agentTeam.reply({ requestId: requestId('semantic:failure:retry'), workspaceId,
      threadRef: started.thread.threadRef, baseRevision: started.thread.revision, body: `@${member.actor.handle} retry semantic wake` })
    await waitForNotificationEffects(host.ctx.agentTeam)
    return { committed: retry.kind === 'committed', firstCalls, totalCalls: calls.length,
      retriedAfterFailure: failed && calls.length > firstCalls }
  } finally {
    await host.dispose()
  }
}

async function shutdownProbe() {
  const host = await mount()
  const state = { shutdownRequested: false }
  try {
    const projectRef = await project(host.ctx, 'shutdown')
    const members = []
    for (let index = 0; index < 8; index += 1) members.push(await addMember(host.ctx, `semantic-shutdown-${index}`, projectRef))
    let ranAfterShutdownRequest = 0
    const team = host.ctx.agentTeam as any
    const originalNotify = team.notifyMember.bind(team)
    team.notifyMember = (...args: unknown[]) => {
      if (state.shutdownRequested) ranAfterShutdownRequest += 1
      return originalNotify(...args)
    }
    for (const member of members) silenceAgent(member.agent, [])
    const started = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('semantic:shutdown:start'), workspaceId,
      projectRef: projectRef as never, body: `${members.map(member => `@${member.actor.handle}`).join(' ')} shutdown semantic wake` })
    if (started.kind !== 'committed') throw new Error(`shutdown probe start did not commit: ${started.kind}`)
    let disposeError: string | undefined
    const disposal = host.dispose().catch(error => { disposeError = error instanceof Error ? error.message : String(error) })
    state.shutdownRequested = true
    await disposal
    await waitForNotificationEffects(team)
    return { committed: true, ranAfterShutdownRequest, disposeError: disposeError ?? null }
  } catch (error) {
    await host.dispose().catch(() => {})
    throw error
  }
}

async function orderingAndClientProbe() {
  const host = await mount()
  try {
    const projectRef = await project(host.ctx, 'ordering')
    const members = []
    for (let index = 0; index < 8; index += 1) members.push(await addMember(host.ctx, `semantic-ordering-${index}`, projectRef))
    for (const member of members) silenceAgent(member.agent, [])
    const sequences: number[] = []
    const team = host.ctx.agentTeam as any
    const originalNotify = team.notifyMember.bind(team)
    team.notifyMember = (agent: any, cause: any, sequenced?: boolean) => {
      if (cause.kind === 'commit') sequences.push(cause.receipt.sequence)
      return originalNotify(agent, cause, sequenced)
    }
    const baseline = await changeBaseline(host.ctx.agentTeam)
    const changed = nextChange(host.ctx.agentTeam)
    const first = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('semantic:ordering:first'), workspaceId,
      projectRef: projectRef as never, body: `${members.map(member => `@${member.actor.handle}`).join(' ')} first ordered wake` })
    const second = await host.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('semantic:ordering:second'), workspaceId,
      projectRef: projectRef as never, body: `@${members[0]!.actor.handle} second ordered wake` })
    const change = await changed
    const invalidatedBeforeDrain = sequences.length === 0
    await waitForNotificationEffects(team)
    const committed = first.kind === 'committed' && second.kind === 'committed'
    return { committed, baseline: baseline.version, changeVersion: change.version, expectedVersion: first.kind === 'committed' ? first.receipt.sequence : null,
      invalidatedBeforeDrain, sequences, ordered: sequences.length >= 2 && sequences.every((value, index) => index === 0 || value >= sequences[index - 1]!) }
  } finally {
    await host.dispose()
  }
}

async function main(): Promise<void> {
  await mkdir(outputRoot, { recursive: true })
  const startedAt = new Date().toISOString()
  const results = { failure: await failureProbe(), shutdown: await shutdownProbe(), orderingAndClient: await orderingAndClientProbe() }
  const checks = {
    failureRecovery: results.failure.retriedAfterFailure === true && results.failure.committed === true,
    shutdownDoesNotThrow: results.shutdown.disposeError === null,
    shutdownSkipsQueuedNotification: results.shutdown.ranAfterShutdownRequest === 0,
    ordering: results.orderingAndClient.committed === true && results.orderingAndClient.ordered === true,
    clientInvalidation: results.orderingAndClient.invalidatedBeforeDrain === true,
  }
  const risks = {
    queuedNotificationRunsAfterShutdownRequest: results.shutdown.ranAfterShutdownRequest > 0,
  }
  const report = { runId, startedAt, teamCommit: await commitOf(root), checks, risks, results }
  await writeFile(join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await appendFile(join(outputRoot, 'samples.jsonl'), `${JSON.stringify(report)}\n`).catch(async () => {
    await writeFile(join(outputRoot, 'samples.jsonl'), `${JSON.stringify(report)}\n`)
  })
  console.log(JSON.stringify({ outputRoot, ...report }, null, 2))
  if (Object.values(checks).some(value => value !== true)) process.exitCode = 1
}

async function commitOf(directory: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try { return (await promisify(execFile)('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim() } catch { return 'unknown' }
}

await main()
