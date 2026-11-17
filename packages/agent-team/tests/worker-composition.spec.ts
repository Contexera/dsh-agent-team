/**
 * The composition probe ticket 01 depends on: a Team Member's own Agent context
 * can reach a Host-mounted Harness subagent service, and an external run with
 * parent delivery reports back into that Member's session.
 *
 * The provider here is a stub on purpose. It exercises the seam, not OAR: the
 * native engines are acceptance targets, not unit-test doubles.
 */

import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { realHarness, requestId, ScriptedAdapter, waitFor } from './helpers/member-harness.ts'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentRuntime as SubagentRuntimeService } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { WorkerConfig } from '../src/worker-service.ts'

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
  onTestFinished(() => { release() })

  const activation = await subagents.startActivation({
    provider: 'probe',
    label: 'probe worker',
    parent: agent!, prompt: [{ type: 'text', text: 'run the probe' }], cwd: harness.checkout,
    signal: new AbortController().signal,
    delivery: 'parent',
  })
  await activation.result

  const seen = await waitFor(() => {
    const text = agent!.session.ownEvents().map(event => JSON.stringify(event)).join('\n')
    return text.includes('the probe answer') ? text : undefined
  }, 20_000)
  expect(seen).toContain('the probe answer')
})

const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--help')) { process.stdout.write('codex app-server\\n'); process.exit(0) }
if (args.includes('--version')) { process.stdout.write('codex-cli 0.0.0-fake\\n'); process.exit(0) }
const write = (value) => { process.stdout.write(JSON.stringify(value) + '\\n') }
let thread = 0
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    if (message.method === 'initialize') write({ id: message.id, result: { userAgent: 'fake-codex' } })
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      thread += 1
      write({ id: message.id, result: { thread: { id: 'fake-thread-' + process.pid + '-' + thread } } })
    } else if (message.method === 'turn/start') {
      write({ id: message.id, result: { turn: { id: 'fake-turn-' + process.pid + '-' + thread } } })
    } else write({ id: message.id, result: {} })
  }
})
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
`

const writeFakeCodex = async (root: string): Promise<string> => {
  if (process.platform === 'win32') {
    const source = join(root, 'fake-codex.js')
    const executable = join(root, 'codex.cmd')
    await writeFile(source, FAKE_CODEX)
    await writeFile(executable, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n')
    return executable
  }

  const executable = join(root, 'codex')
  await writeFile(executable, FAKE_CODEX)
  await chmod(executable, 0o755)
  return executable
}

const textChunks = (text: string): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const workerChunks = (calls: ReadonlyArray<{ readonly callId: string; readonly args: object }>): StreamChunk[] => [
  ...calls.flatMap(({ callId, args }, index): StreamChunk[] => {
    const id = ToolCallId(callId)
    const argumentsJson = JSON.stringify(args)
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: 'team_worker', argumentsDelta: argumentsJson },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: 'team_worker', arguments: argumentsJson } },
    ]
  }),
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

it('wakes an owner from a subscription, lets it delegate through team_worker, and stops one on reply', async () => {
  const adapter = new ScriptedAdapter()
  const harness = await realHarness(adapter)
  const { ctx, workspaceId, root } = harness
  await ctx.plugin(SubagentRuntime)

  const fakeCodex = await writeFakeCodex(root)

  const stdoutText = '{"id":"wake-owner","title":"委派并继续回应"}\n'
  let spillIndex = 0
  ctx.provide('shell', {
    resolve: (request: ShellExecSpec) => request,
    execute: async (spec: ShellExecSpec) => {
      const isProbe = spec.command.includes('BASH_VERSION')
      const spillPath = join(root, `sub-stdout-${spillIndex++}.log`)
      if (!isProbe) await writeFile(spillPath, `__DSH_TEAM_RAW_STDOUT__${stdoutText}`)
      const answer: ShellRunResult = {
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
        stdout: { text: isProbe ? '5.2.15' : stdoutText, truncated: false, ...(isProbe ? {} : { spillPath }) },
        stderr: { text: '', truncated: false },
      }
      return { result: async () => answer }
    },
  } as never)

  const workerConfig: WorkerConfig = {
    enabled: true, defaultEngine: 'codex', timeoutMs: 0,
    engines: {
      codex: { enabled: true, executable: fakeCodex, sandbox: 'workspace-write' },
      claude: { enabled: false, executable: '', sandbox: '' },
    },
  }
  ;(ctx.agentTeam as unknown as { config: { worker: { get(): WorkerConfig } } }).config.worker = { get: () => workerConfig }

  const created = await ctx.agentTeam.createProject({
    requestId: requestId('sub-worker-project'), workspaceId,
    name: 'worker-subscription', description: '订阅、委派与回应的完整组合',
  })
  const projectRef = created.project.projectRef
  const added = await ctx.agentTeam.addMember({
    requestId: requestId('sub-worker-member'), workspaceId, handle: 'subscription-owner',
    description: '订阅触发后继续负责对话', presetId: 'team-member', projectRefs: [projectRef],
    model: { provider: 'mock', model: 'mock' },
  })
  expect(added.status.availability).toBe('active')
  const owner = added.status.member
  const agent = ctx.agents.get(owner.sessionId)!
  const thread = await ctx.agentTeam.startThread({
    requestId: requestId('sub-worker-thread'), workspaceId, projectRef,
    kind: 'discussion', body: '订阅结果必须回到这条讨论；owner 继续回应 Human。',
  })
  const threadRef = thread.thread.threadRef
  await ctx.agentTeam.updateMember({
    requestId: requestId('sub-worker-target'), memberId: owner.memberId, handle: owner.handle,
    description: `订阅触发后继续负责对话；目标 Thread ${threadRef}`,
  })

  adapter.enqueue(textChunks('已了解 Project owner 职责。'))
  await ctx.agentTeam.addProjectOwner({
    requestId: requestId('sub-worker-owner'), workspaceId, projectRef, memberId: owner.memberId,
  })
  await waitFor(() => agent.status === 'idle' && agent.session.ownEvents().some(e => e.type === 'turn/end') ? true : undefined, 10_000)

  adapter.enqueue(workerChunks([
    { callId: 'sub-w-1', args: { threadRef, task: '检查订阅报告的第一部分', requestId: 'sub-w-1' } },
    { callId: 'sub-w-2', args: { threadRef, task: '检查订阅报告的第二部分', requestId: 'sub-w-2' } },
  ]))
  adapter.enqueue(textChunks('订阅事件已处理，两个 Worker 正在执行；我继续负责对话。'))

  const armed = await ctx.agentTeam.createSubscriptionForAgent(agent, {
    requestId: requestId('sub-worker-create'), workspaceId, projectRef, name: '唤醒 owner',
    intervalMinutes: 10, notify: [owner.memberId], baseline: 'ignore-history',
    script: { scriptContent: `printf '%s\\n' '{"id":"wake-owner","title":"委派并继续回应"}'` },
  })
  if (armed.kind !== 'changed') throw new Error('expected subscription to be armed')
  const subscription = armed.subscription
  const service = ctx.agentTeam as unknown as { runTimerSubscription(sub: typeof subscription): Promise<unknown> }
  expect(await service.runTimerSubscription(subscription)).toBe('accepted')

  await waitFor(() => agent.status === 'idle'
    && JSON.stringify(agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')).includes('我继续负责对话。')
    ? true : undefined, 10_000)

  const runs = () => ctx.agentTeam.workerRunsForClient({ workspaceId, memberId: owner.memberId }).runs
  expect(runs()).toHaveLength(2)
  expect(runs().every(run => run.threadRef === threadRef && run.state === 'running')).toBe(true)
  const [target, sibling] = runs()

  adapter.enqueue(workerChunks([{ callId: 'sub-w-stop', args: { stop: target!.workerRef } }]))
  adapter.enqueue(textChunks('指定 Worker 已停止；另一个仍在运行，我继续回应 Human。'))

  const read = await ctx.agentTeam.readThread({ requestId: requestId('sub-worker-read'), workspaceId, threadRef })
  const humanQuestion = await ctx.agentTeam.reply({
    requestId: requestId('sub-worker-human-question'), workspaceId, threadRef,
    body: `@subscription-owner 只停止 ${target!.workerRef}，另一条继续；然后回答我的后续问题。`,
    baseRevision: read.thread.revision,
  })
  expect(humanQuestion.kind).toBe('committed')

  await waitFor(() => agent.status === 'idle'
    && JSON.stringify(agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')).includes('我继续回应 Human。')
    ? true : undefined, 20_000)

  const settled = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('sub-worker-settled'), workspaceId, threadRef })
  const targetRun = runs().find(run => run.workerRef === target!.workerRef)
  const targetSettlement = settled.facts.find(entry => entry.fact.kind === 'activity'
    && entry.fact.activity.kind === 'worker_settled' && entry.fact.activity.workerRef === target!.workerRef)
  const targetRecord = (ctx.agentTeam as unknown as {
    ledger?: { workerExecution(workerRef: string): unknown }
  }).ledger?.workerExecution(target!.workerRef)
  expect(targetRun?.state, JSON.stringify({ targetRun, targetRecord, targetSettlement })).toBe('stopped')
  expect(runs().find(run => run.workerRef === sibling!.workerRef)?.state).toBe('running')
  expect(settled.workerStates?.find(run => run.workerRef === target!.workerRef)).toMatchObject({ state: 'stopped', unconfirmed: false })
  expect(settled.workerStates?.find(run => run.workerRef === sibling!.workerRef)).toMatchObject({ state: 'running' })
  expect(settled.facts.filter(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'worker_settled')).toHaveLength(1)
  const main = await ctx.agentTeam.readMainStreamForAgent(agent, { requestId: requestId('sub-worker-main'), workspaceId, projectRef })
  expect(main.entries.some(entry => entry.kind === 'subscription-event' && entry.event.event.id === 'wake-owner')).toBe(true)

  await ctx.agentTeam.workerStopForAgent(agent, { workerRef: sibling!.workerRef })
})
