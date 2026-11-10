import { afterEach, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { chooseMemberModel, closeScenario, openSettings, openTeamPage, scaffold, waitForMemberAgent }
  from './__external-agent-team-support.ts'

let replayDir: string | undefined

afterEach(async () => {
  try { await closeScenario() } finally {
    // Only the directory allocated by this scenario; never the shared profile or evidence.
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
    replayDir = undefined
  }
})

const MASTER = '允许从成员会话派出 Worker'

function textResponse(text: string): object {
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }
}

/** The replay adapter resolves refs from the actual request, not from invented fixture ids. */
function workerResponse(calls: ReadonlyArray<{ readonly callId: string; readonly args: object }>): object {
  return { kind: 'chunks', chunks: [
    ...calls.flatMap(({ callId, args }, index) => {
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
  ] }
}

/** A Codex CLI stand-in: complete its app-server handshake, then hold until stopped. */
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

it('wakes an owner from a subscription, lets it delegate through the real tool, and keeps answering', async () => {
  // Only the model and native CLI are scripted. Settings, notices, tool execution,
  // parallel runs, stop confirmation, and the Thread settlement use the real composition.
  replayDir = await mkdtemp(join(tmpdir(), 'dsh-team-worker-subscription-'))
  const fixture = join(replayDir, 'session.jsonl')
  const override = join(replayDir, 'replay.override.json')
  const fakeCodex = join(replayDir, 'codex')
  await writeFile(fakeCodex, FAKE_CODEX)
  await chmod(fakeCodex, 0o755)
  await writeFile(fixture, '{"type":"session","version":0,"id":"primary","createdAt":0}\n')
  const start = (requestId: string, task: string) => ({ callId: requestId,
    args: { threadRef: '{{fromRequest:(thread:[0-9a-f-]+)}}', task, requestId } })
  await writeFile(override, JSON.stringify([
    textResponse('已了解 Project owner 职责。'),
    workerResponse([
      start('e2e-worker-stop-target', '检查订阅报告的第一部分'),
      start('e2e-worker-stop-sibling', '检查订阅报告的第二部分'),
    ]),
    textResponse('订阅事件已处理，两个 Worker 正在执行；我继续负责对话。'),
    workerResponse([{ callId: 'e2e-stop-one', args: { stop: '{{fromRequest:STOP_TARGET=(worker:[0-9a-f-]+)}}' } }]),
    textResponse('指定 Worker 已停止；另一个仍在运行，我继续回应 Human。'),
  ]))
  const { page, consoleWatch } = await openTeamPage({ replay: { fixture, override } })
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('subscription-owner')
  await createAgent.getByLabel('说明').fill('订阅触发后继续负责对话')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('subscription-owner', { exact: true }).waitFor({ timeout: 20_000 })
  const created = await team.createProject({ requestId: 'e2e-worker-subscription-project' as never, workspaceId,
    name: 'worker-subscription', description: '订阅、委派与回应的完整组合' })
  const projectRef = created.project.projectRef
  const owner = team.members({ workspaceId }).find(status => status.member.handle === 'subscription-owner')!.member
  const thread = await team.startThread({ requestId: 'e2e-worker-subscription-thread' as never, workspaceId, projectRef,
    kind: 'discussion', body: '订阅结果必须回到这条讨论；owner 继续回应 Human。' })
  const threadRef = thread.thread.threadRef
  const agent = await waitForMemberAgent(scaffold!, workspaceId, owner.memberId)
  // Subscription notices name their Main stream, not an unrelated Thread. Give the
  // owner its destination through real Member context before any subscription arrives.
  await team.updateMember({ requestId: 'e2e-worker-subscription-target' as never,
    memberId: owner.memberId, handle: owner.handle,
    description: `订阅触发后继续负责对话；目标 Thread ${threadRef}` })
  await team.addProjectOwner({ requestId: 'e2e-worker-subscription-owner' as never, workspaceId, projectRef, memberId: owner.memberId })
  // Tool exposure changes at turn boundaries. Do not script an undeclared tool
  // into the ownership turn that began while the switch was still off.
  await expect.poll(() => agent.status === 'idle'
    && agent.session.ownEvents().some(event => event.type === 'turn/end')).toBe(true)

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const group = panel.locator('[data-worker-settings]')
  await group.waitFor()
  await group.getByRole('button', { name: /Worker 委派/ }).click()
  await group.getByRole('switch', { name: MASTER }).click()
  const codex = group.locator('[data-worker-engine="codex"]')
  await codex.getByRole('switch').click()
  await codex.getByLabel('Codex 的可执行路径').fill(fakeCodex)
  await group.getByRole('button', { name: '保存' }).click()
  await expect.poll(async () => await group.getByRole('button', { name: '保存' }).isDisabled(), { timeout: 20_000 }).toBe(true)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => team.config.worker.get().enabled).toBe(true)
  await expect.poll(() => scaffold!.ctx.tools.schemas(agent as never).some(tool => tool.name === 'team_worker')).toBe(true)

  const armed = await team.createSubscriptionForAgent(agent, {
    requestId: 'e2e-worker-subscription-create' as never, workspaceId, projectRef, name: '唤醒 owner',
    intervalMinutes: 10, notify: [owner.memberId], baseline: 'ignore-history',
    script: { scriptContent: `printf '%s\\n' '{"id":"wake-owner","title":"委派并继续回应"}'` },
  })
  if (armed.kind !== 'changed') throw new Error('the owner could not arm its subscription')
  // Invoke the scheduler's timer entry without waiting ten real minutes. The
  // trial output is deliberately not baselined away; this run publishes it.
  const service = team as unknown as { runTimerSubscription(subscription: typeof armed.subscription): Promise<unknown> }
  expect(await service.runTimerSubscription(armed.subscription)).toBe('accepted')

  const events = () => agent.session.snapshotEvents()
  const runs = () => team.workerRunsForClient({ workspaceId, memberId: owner.memberId }).runs
  const waitForAnswer = async (text: string): Promise<void> => {
    try {
      await expect.poll(() => {
        const ended = events().filter(event => event.type === 'turn/end')
        expect(ended.every(event => event.data.reason.kind === 'completed')).toBe(true)
        return agent.status === 'idle' && JSON.stringify(events().filter(event => event.type === 'assistant/message')).includes(text)
      }, { timeout: 30_000 }).toBe(true)
    } catch (error) {
      // Read-only diagnostics: an acknowledging read here would change the failing scenario.
      throw new Error(JSON.stringify({ status: agent.status, runs: runs(),
        events: events().filter(event => ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end'].includes(event.type)) }), { cause: error })
    }
  }
  await waitForAnswer('我继续负责对话。')
  expect(runs()).toHaveLength(2)
  expect(runs().every(run => run.threadRef === threadRef && run.state === 'running')).toBe(true)
  expect(team.members({ workspaceId })).toHaveLength(1)
  const [target, sibling] = runs()
  expect(target!.workerRef).not.toBe(sibling!.workerRef)
  const initialCalls = events().filter(event => event.type === 'tool/call')
  expect(initialCalls).toHaveLength(2)
  expect(initialCalls.every(event => event.data.name === 'team_worker'
    && JSON.parse(event.data.arguments).threadRef === threadRef)).toBe(true)
  expect(JSON.stringify(agent.session.requestHeader())).toContain('team_worker')
  expect(JSON.stringify(events().filter(event => event.type === 'user/message'))).toContain('委派并继续回应')

  const read = await team.readThread({ workspaceId, threadRef })
  // Delegating never subscribes the owner to this Thread. This is a real directed
  // Human reply; omitting the mention would correctly leave that owner asleep.
  const humanQuestion = await team.reply({
    requestId: 'e2e-worker-subscription-human-question' as never, workspaceId, threadRef,
    body: `@subscription-owner 只停止 STOP_TARGET=${target!.workerRef}，另一条继续；然后回答我的后续问题。`,
    baseRevision: read.thread.revision,
  })
  expect(humanQuestion.kind).toBe('committed')
  await waitForAnswer('我继续回应 Human。')
  expect(runs().find(run => run.workerRef === target!.workerRef)?.state).toBe('stopped')
  expect(runs().find(run => run.workerRef === sibling!.workerRef)?.state).toBe('running')
  const calls = events().filter(event => event.type === 'tool/call')
  expect(calls).toHaveLength(3)
  expect(JSON.parse(calls[2]!.data.arguments)).toEqual({ stop: target!.workerRef })
  const settled = await team.readThreadForAgent(agent, { requestId: 'e2e-worker-subscription-settled' as never, workspaceId, threadRef })
  expect(settled.workerStates?.find(run => run.workerRef === target!.workerRef)).toMatchObject({ state: 'stopped', unconfirmed: false })
  expect(settled.workerStates?.find(run => run.workerRef === sibling!.workerRef)).toMatchObject({ state: 'running' })
  expect(settled.facts.filter(entry => entry.fact.kind === 'activity'
    && entry.fact.activity.kind === 'worker_settled')).toHaveLength(1)
  const main = await team.readMainStreamForAgent(agent, { requestId: 'e2e-worker-subscription-main' as never, workspaceId, projectRef })
  expect(main.entries.some(entry => entry.kind === 'subscription-event' && entry.event.event.id === 'wake-owner')).toBe(true)

  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe(null)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
