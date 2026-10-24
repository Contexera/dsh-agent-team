import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const TEAM_ROOT = '__TEAM_ROOT__'
const HOME = '__HOME__'
const STAGED_BUNDLE = join(HOME, 'profiles', 'node_modules', '@contexera', 'dsh-agent-team')
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'
let scaffold: WebScaffold
let browser: Browser | undefined

const AGENTS = [
  { handle: 'aster', description: '功能开发、修复与测试' },
  { handle: 'vera', description: '独立验收、测试执行与证据' },
] as const

const LONG_BODY = `长文样本（一条 Agent 回答超过 600 字的折叠阈值）：${'这段话会被反复续写，直到超过阈值，读者因此先看到裁切后的预览与底部渐隐，再决定要不要展开全文。'.repeat(16)}`

/**
 * Fixture seam: appends the canonical durable route record — the same
 * `request/context` event a real first request appends — so the pressure
 * policy finds the Member's route priceable instead of failing closed over a
 * preview that never runs a turn.
 */
const recordPriceableRoute = (agent: {
  session: { append: (type: 'request/context', data: { provider: string; model: string; contextWindow: number }) => unknown }
}, contextWindow = 128_000): void => {
  const selection = scaffold.ctx.agentDefaultModel.currentSelection()
  agent.session.append('request/context', { provider: selection.provider, model: selection.model, contextWindow })
}

const wait = async (predicate: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('preview fixture timed out waiting for a live Agent handle')
    await new Promise(resolve => { setTimeout(resolve, 250) })
  }
}

beforeAll(async () => {
  await rm(HOME, { recursive: true, force: true })
  const scope = `${HOME}/profiles/node_modules/@contexera`
  await mkdir(scope, { recursive: true })
  await cp(TEAM_ROOT, `${scope}/dsh-agent-team`, {
    recursive: true,
    filter: source => !source.includes('/node_modules') && !source.includes('/src') && !source.includes('/artifacts') && !source.includes('/.hoplite') && !/\/\.git(\/|$)/.test(source),
  })
  // Production installs the bundle's regular dependencies with it; stage the
  // same closure inside the staged dir, whose nearest node_modules is what its
  // own imports resolve through.
  const { dependencies } = JSON.parse(await readFile(join(TEAM_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  for (const name of Object.keys(dependencies)) {
    await cp(join(TEAM_ROOT, 'node_modules', name), join(STAGED_BUNDLE, 'node_modules', ...name.split('/')), { recursive: true, dereference: true })
  }
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  const workspacePath = join(scaffold.workspaceCwd, 'team-ui-preview')
  await mkdir(workspacePath, { recursive: true })
  const workspace = await scaffold.ctx.workspaceRegistry.create(workspacePath, 'Team UI Preview')
  const team = scaffold.ctx.agentTeam
  const humanMemberId = team.status().humanMemberId

  // Members are provisioned through the Client's own dialog: a direct `agentTeam.addMember` call
  // resolves this lane's shipped presets only, leaving Members with no live Agent answering for them
  // and the conversation missing their side. The headless page is closed before the preview is served.
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  try {
    await page.goto(scaffold.authenticatedUrl)
    await page.locator('nav[class*="panelList"]').getByRole('button', { name: '团队', exact: true }).click()
    await page.getByText('Team UI Preview', { exact: true }).first().click()
    for (const agent of AGENTS) {
      await page.getByRole('button', { name: '添加 Agent' }).click()
      const dialog = page.getByRole('dialog', { name: '添加 Agent' })
      await dialog.getByLabel('名称').fill(agent.handle)
      await dialog.getByLabel('说明').fill(agent.description)
      await dialog.getByRole('button', { name: '创建 Agent' }).click()
      await page.getByText(agent.handle, { exact: true }).first().waitFor({ timeout: 30_000 })
      process.stdout.write(`UI-only preview: provisioned ${agent.handle} through the Client dialog\n`)
    }
  } finally {
    await page.close()
    await browser.close()
    browser = undefined
  }

  const memberOf = (handle: string) => team.members({ workspaceId: workspace.id }).find(candidate => candidate.member.handle === handle)
  const agentFor = (handle: string) => {
    const entry = memberOf(handle)
    return entry === undefined ? undefined : scaffold.ctx.agents.get(entry.member.sessionId)
  }
  // Activation lands asynchronously (handle-based persistence, then the awaited
  // AgentLoop create), so the handle is polled for rather than assumed.
  for (const agent of AGENTS) await wait(() => agentFor(agent.handle) !== undefined)

  // Fixture seam, not a fixture bug: this lane resolves no model route for a
  // Member, so the pressure policy fails closed and every Member row would
  // carry a runtime-fault banner over a preview that never runs a turn.
  for (const agent of AGENTS) recordPriceableRoute(agentFor(agent.handle)!)

  const project = await team.createProject({
    requestId: 'ui-preview-project' as never,
    workspaceId: workspace.id,
    name: 'delivery',
    description: '预览样本：气泡、分组、有人@我、引用回复、长文折叠、Task 条目',
  })
  const projectRef = project.project.projectRef

  const opener = await team.startThread({
    requestId: 'ui-preview-opener' as never,
    workspaceId: workspace.id,
    projectRef,
    kind: 'discussion',
    body: '预览样本 Thread：气泡两侧、同人分组、有人@我、引用回复、长文折叠都在这一条里。',
  })
  if (opener.kind !== 'committed') throw new Error(`preview opener was rejected: ${opener.kind}`)
  const threadRef = opener.thread.threadRef

  /** Every Thread write drains its own read first: a reply carries the revision it is based on. */
  const asHuman = async (id: string, body: string, replyToMessageRef?: string) => {
    const read = await team.readThread({ requestId: `${id}-read` as never, workspaceId: workspace.id, threadRef })
    const write = (confirmationToken?: string) => team.reply({
      requestId: id as never,
      workspaceId: workspace.id,
      threadRef,
      body,
      baseRevision: read.thread.revision,
      ...(replyToMessageRef === undefined ? {} : { replyToMessageRef: replyToMessageRef as never }),
      ...(confirmationToken === undefined ? {} : { confirmationToken: confirmationToken as never }),
    })
    // Answering a Member delivers to them, and a Human hand-delivering to a
    // Member is the Host's own confirmation case: the same invitation goes out
    // again carrying the token it returned.
    let written = await write()
    if (written.kind === 'confirmation_required') written = await write(written.confirmationToken)
    if (written.kind !== 'committed') throw new Error(`${id} was rejected: ${written.kind}`)
    return written
  }
  const asAgent = async (handle: string, id: string, body: string, options: { recipients?: readonly string[]; replyTo?: string } = {}) => {
    const agent = agentFor(handle)!
    const read = await team.readThreadForAgent(agent, { requestId: `${id}-read` as never, workspaceId: workspace.id, threadRef })
    const written = await team.replyForAgent(agent, {
      requestId: id as never,
      workspaceId: workspace.id,
      threadRef,
      body,
      baseRevision: read.thread.revision,
      ...(options.recipients === undefined ? {} : { recipients: options.recipients as never }),
      ...(options.replyTo === undefined ? {} : { replyToMessageRef: options.replyTo as never }),
    })
    if (written.kind !== 'committed') throw new Error(`${id} was rejected: ${written.kind}`)
    return written
  }
  const claim = async (handle: string, id: string, taskRef: string, direction: string) => {
    const agent = agentFor(handle)!
    const read = await team.readThreadForAgent(agent, { requestId: `${id}-read` as never, workspaceId: workspace.id, taskRef: taskRef as never })
    const claimed = await team.changeClaimForAgent(agent, {
      requestId: id as never, workspaceId: workspace.id, taskRef: taskRef as never,
      action: 'claim', direction, baseRevision: read.thread.revision,
    })
    if (claimed.kind !== 'committed') throw new Error(`${id} was rejected: ${claimed.kind}`)
  }

  // A run of the reader's own messages, then a longer run from one Agent: the
  // two grouping cases the reading language has to tell apart.
  await asHuman('ui-preview-h2', '同一个人的连续两条合成一组：头像与昵称只出现一次，行距收紧；hover 时时间落在头像那一列的空白处。')
  const mentioned = await asAgent('aster', 'ui-preview-a1', '收到。这条我点名 @human：hover 时卡片上会多一行「提到了你」，打开 Thread 时视图会自动跳到这条。', { recipients: [humanMemberId] })
  const grouped = await asAgent('aster', 'ui-preview-a2', '同一发送者的连续第二条：昵称被抑制，它自己的时间只在 hover 时出现在头像那一列。')
  await asAgent('aster', 'ui-preview-a3', LONG_BODY)
  const quoted = await asAgent('vera', 'ui-preview-a4', '我引用上面 aster 那条分组消息：引用显示在这条消息的首行，作者与一行摘要，点它能跳回原文。', { replyTo: grouped.message.messageRef })
  await asHuman('ui-preview-h3', '我也引用同一条，只是列序镜像到右侧。', quoted.message.messageRef)
  await asHuman('ui-preview-h4', '这条是普通消息，用来看分组之外的行距。')

  // A Task thread: its entry row in the Project feed carries the state cluster
  // and the owner stack this preview is meant to show, and the claims land as
  // activity rows inside the Thread.
  const taskStart = await team.startThread({
    requestId: 'ui-preview-task' as never,
    workspaceId: workspace.id,
    projectRef,
    kind: 'task',
    body: '叠放校验：这条 Task 用来验证 feed 条目行的状态列与所有者叠放。',
  })
  if (taskStart.kind !== 'committed') throw new Error(`preview Task was rejected: ${taskStart.kind}`)
  const taskRef = taskStart.task!.taskRef
  await claim('aster', 'ui-preview-claim-1', taskRef, '实现 hover 阅读语言')
  await claim('vera', 'ui-preview-claim-2', taskRef, '独立验收引用与跳转')

  // Answering a Member delivers to them, so every quote wakes the parent's author, and this lane has no
  // model, so that turn faults. The product's own remedy clears it.
  for (const agent of AGENTS) {
    await team.recoverMember({
      requestId: `ui-preview-recover-${agent.handle}` as never,
      workspaceId: workspace.id,
      memberId: memberOf(agent.handle)!.member.memberId,
    })
  }

  // The bare origin refuses a browser that carries no session cookie; the
  // token URL is what a Human actually opens.
  process.stdout.write(`AGENT_TEAM_UI_PREVIEW_URL=${scaffold.authenticatedUrl}\n`)
  process.stdout.write(`AGENT_TEAM_UI_PREVIEW_ORIGIN=${scaffold.baseUrl}\n`)
  process.stdout.write('UI-only preview: fixture state is loaded; model calls are disabled and fail explicitly if triggered.\n')
  process.stdout.write(`UI-only preview: fixture thread ${threadRef} carries ${mentioned === undefined ? 'no' : 'one'} mention row.\n`)
  process.stdout.write(`UI-only preview: fixture Task ${taskRef} carries two claims.\n`)
})

afterAll(async () => {
  await browser?.close()
  await scaffold.close()
})

it('serves the model-free Agent Team UI preview until stopped', async () => {
  await new Promise<void>(() => {})
}, 2_147_000_000)
