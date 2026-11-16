import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import type { Locator, Page, WebScaffold } from './__external-agent-team-support.ts'
import {
  BROWSER_ARTIFACTS,
  CHROME,
  ONE_PIXEL_PNG,
  UI09_SHOTS,
  browser,
  chooseMemberModel,
  closeScenario,
  installLocalBundle,
  launchWebScaffold,
  memberAgent,
  openTeamPage,
  scaffold,
  settleLayout,
  waitForMemberAgent,
} from './__external-agent-team-support.ts'

const SHOTS = join(BROWSER_ARTIFACTS, 'timeline-anchor')

interface Position {
  readonly offset: number
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly distanceFromBottom: number
}

interface Evidence {
  readonly surface: 'Main' | 'Thread'
  readonly viewport: 'desktop' | '390x844'
  readonly event: string
  readonly before: Position
  readonly after: Position
}

afterEach(async () => { await closeScenario() })

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
}

async function positionOf(root: Locator, messageRef: string): Promise<Position> {
  return root.evaluate((timeline, ref) => {
    const message = [...timeline.querySelectorAll<HTMLElement>('article[data-message-ref]')]
      .find(candidate => candidate.getAttribute('data-message-ref') === ref)
    if (message === undefined) throw new Error(`Message '${ref}' is not in this timeline`)
    const timelineBox = timeline.getBoundingClientRect()
    const messageBox = message.getBoundingClientRect()
    return {
      offset: messageBox.top - timelineBox.top,
      scrollTop: timeline.scrollTop,
      scrollHeight: timeline.scrollHeight,
      clientHeight: timeline.clientHeight,
      distanceFromBottom: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
    }
  }, messageRef)
}

async function scrollToAnchor(page: Page, root: Locator, messageRef: string): Promise<void> {
  const message = root.locator(`article[data-message-ref="${messageRef}"]`)
  await message.waitFor()
  await message.evaluate(element => { element.scrollIntoView({ block: 'center' }) })
  await settleFrames(page)
  await expect.poll(async () => (await positionOf(root, messageRef)).distanceFromBottom).toBeGreaterThan(48)
}

async function waitForText(root: Locator, marker: string): Promise<void> {
  await root.locator('article').filter({ hasText: marker }).first().waitFor({ state: 'attached' })
}

async function loadOlder(root: Locator): Promise<void> {
  const button = root.getByRole('button', { name: '加载更早消息' })
  await button.waitFor()
  await button.evaluate(element => { (element as HTMLButtonElement).click() })
}

async function expectStable(
  page: Page,
  root: Locator,
  messageRef: string,
  evidence: Evidence[],
  entry: Omit<Evidence, 'before' | 'after'>,
  before: Position,
): Promise<Position> {
  await expect.poll(async () => Math.abs((await positionOf(root, messageRef)).offset - before.offset), { timeout: 10_000 })
    .toBeLessThanOrEqual(1)
  await settleFrames(page)
  const after = await positionOf(root, messageRef)
  evidence.push({ ...entry, before, after })
  return after
}

it('keeps Thread and Main reading anchors through history and arrivals in real Web', async () => {
  await mkdir(SHOTS, { recursive: true })
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('anchor-owner')
  await createAgent.getByLabel('说明').fill('时间线验收的 Project owner')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('anchor-owner', { exact: true }).waitFor({ timeout: 20_000 })

  const created = await team.createProject({ requestId: 'e2e-timeline-anchor-project' as never, workspaceId,
    name: 'timeline-anchor', description: 'Thread and Main reading positions' })
  const projectRef = created.project.projectRef
  const owner = team.members({ workspaceId }).find(status => status.member.handle === 'anchor-owner')!.member
  await team.addProjectOwner({ requestId: 'e2e-timeline-anchor-owner' as never, workspaceId, projectRef, memberId: owner.memberId })

  const pngBase64 = ONE_PIXEL_PNG.slice(ONE_PIXEL_PNG.indexOf(',') + 1)
  const mainAttachment = await team.putAttachment({ requestId: 'e2e-timeline-main-attachment' as never, workspaceId,
    name: 'main-anchor.png', mediaType: 'image/png', bytesBase64: pngBase64 })
  const threadAttachment = await team.putAttachment({ requestId: 'e2e-timeline-thread-attachment' as never, workspaceId,
    name: 'thread-anchor.png', mediaType: 'image/png', bytesBase64: pngBase64 })

  const getAttachment = team.getAttachment.bind(team)
  ;(team as unknown as { getAttachment: typeof team.getAttachment }).getAttachment = async request => {
    if (request.attachmentId === mainAttachment.attachmentId || request.attachmentId === threadAttachment.attachmentId) {
      await new Promise(resolve => setTimeout(resolve, 1_200))
    }
    return getAttachment(request)
  }

  const mainRefs: string[] = []
  for (let index = 1; index <= 100; index += 1) {
    const marker = `MAIN-${String(index).padStart(3, '0')}`
    const body = index === 84
      ? `${marker} long reading block\n${Array.from({ length: 24 }, (_, line) => `line ${line + 1}: keep this visible while history and arrivals change`).join('\n')}`
      : `${marker} timeline reading row`
    const result = await team.postMainMessage({ requestId: `e2e-timeline-main-${index}` as never, workspaceId, projectRef, body,
      ...(index === 82 ? { attachments: [mainAttachment.attachmentId] } : {}) })
    if (result.kind !== 'committed') throw new Error(`Main seed ${index} was refused: ${result.kind}`)
    mainRefs.push(result.message.messageRef)
  }

  await waitForMemberAgent(scaffold!, workspaceId, owner.memberId)
  const agent = memberAgent(scaffold!, workspaceId, owner.memberId)
  const readAgentMain = async (id: string): Promise<void> => {
    for (let page = 0; page < 10; page += 1) {
      const read = await team.readMainStreamForAgent(agent, { requestId: `${id}-${page}` as never, workspaceId, projectRef })
      if (read.standing.unreadCount === 0) return
    }
    throw new Error('the owner could not drain the seeded Main stream')
  }
  await readAgentMain('e2e-timeline-owner-main-read')
  const started = await team.startThreadForAgent(agent, { requestId: 'e2e-timeline-thread-start' as never, workspaceId, projectRef,
    kind: 'discussion', body: 'THREAD-ANCHOR timeline reading anchor' })
  if (started.kind !== 'committed') throw new Error(`Thread start was refused: ${started.kind}`)
  const threadRef = started.thread.threadRef
  const humanRead = await team.readThread({ requestId: 'e2e-timeline-human-thread-read' as never, workspaceId, threadRef })
  let threadRevision = humanRead.thread.revision

  const threadRefs: string[] = []
  for (let index = 1; index <= 100; index += 1) {
    const marker = `THREAD-${String(index).padStart(3, '0')}`
    const body = index === 84
      ? `${marker} long reading block\n${Array.from({ length: 24 }, (_, line) => `line ${line + 1}: keep this visible while history and arrivals change`).join('\n')}`
      : `${marker} thread reading row`
    const result = await team.reply({ requestId: `e2e-timeline-thread-${index}` as never, workspaceId, threadRef, body,
      baseRevision: threadRevision, ...(index === 82 ? { attachments: [threadAttachment.attachmentId] } : {}) })
    if (result.kind !== 'committed') throw new Error(`Thread seed ${index} was refused: ${result.kind}`)
    threadRevision = result.thread.revision
    threadRefs.push(result.message.messageRef)
  }

  for (let round = 0; round < 10; round += 1) {
    const read = await team.readThreadForAgent(agent, { requestId: `e2e-timeline-owner-thread-read-${round}` as never, workspaceId, threadRef })
    threadRevision = read.thread.revision
    if (read.remainingUnreadCount === 0) break
    if (round === 9) throw new Error('the owner could not drain the seeded Thread')
  }

  const mainAnchor = mainRefs[86]!
  const threadAnchor = threadRefs[86]!
  const evidence: Evidence[] = []

  await page.getByRole('button', { name: '# timeline-anchor', exact: true }).waitFor()
  await page.getByRole('button', { name: '# timeline-anchor', exact: true }).click()
  const mainRoot = page.locator('[data-team-project] section[aria-label="消息时间线"]')
  await mainRoot.waitFor()
  await mainRoot.getByText('main-anchor.png', { exact: true }).waitFor()
  await scrollToAnchor(page, mainRoot, mainAnchor)
  const imageBefore = await positionOf(mainRoot, mainAnchor)
  await mainRoot.locator('img[alt="main-anchor.png"]').waitFor({ timeout: 10_000 })
  await expectStable(page, mainRoot, mainAnchor, evidence,
    { surface: 'Main', viewport: 'desktop', event: 'image above finishes loading' }, imageBefore)

  const mainArrival = async (marker: string, requestId: string, overlap?: () => Promise<void>): Promise<void> => {
    await readAgentMain(`${requestId}-read`)
    const beforeUnread = team.inbox({ workspaceId }).totalUnreadCount
    const overlapPromise = overlap?.() ?? Promise.resolve()
    const result = await team.postMainMessageForAgent(agent, { requestId: requestId as never, workspaceId, projectRef, body: marker })
    await overlapPromise
    if (result.kind !== 'committed') throw new Error(`Main arrival was refused: ${result.kind}`)
    await waitForText(mainRoot, marker)
    await expect.poll(() => team.mainStreamHistory({ workspaceId, projectRef }).entries.find(entry =>
      entry.kind === 'message' && entry.message.messageRef === result.message.messageRef)?.unread).toBe(false)
    await expect.poll(() => team.inbox({ workspaceId }).totalUnreadCount, { timeout: 10_000 }).toBe(beforeUnread)
  }

  const mainPages = ['MAIN-063', 'MAIN-043', 'MAIN-023', 'MAIN-003'] as const
  for (const viewport of ['desktop', '390x844'] as const) {
    if (viewport === '390x844') {
      await page.setViewportSize({ width: 390, height: 844 })
      await settleLayout(page)
    }
    await scrollToAnchor(page, mainRoot, mainAnchor)

    const headBefore = await positionOf(mainRoot, mainAnchor)
    await loadOlder(mainRoot)
    await waitForText(mainRoot, mainPages[viewport === 'desktop' ? 0 : 2])
    await expectStable(page, mainRoot, mainAnchor, evidence, { surface: 'Main', viewport, event: 'history prepend' }, headBefore)

    const tailBefore = await positionOf(mainRoot, mainAnchor)
    await mainArrival(`MAIN-ARRIVAL-${viewport}-TAIL`, `e2e-timeline-main-tail-${viewport}`)
    await expectStable(page, mainRoot, mainAnchor, evidence, { surface: 'Main', viewport, event: 'tail arrival' }, tailBefore)

    const combinedBefore = await positionOf(mainRoot, mainAnchor)
    await mainArrival(`MAIN-ARRIVAL-${viewport}-COMBINED`, `e2e-timeline-main-combined-${viewport}`, () => loadOlder(mainRoot))
    await waitForText(mainRoot, mainPages[viewport === 'desktop' ? 1 : 3])
    await expectStable(page, mainRoot, mainAnchor, evidence, { surface: 'Main', viewport, event: 'history prepend with tail arrival' }, combinedBefore)

    await page.screenshot({ path: join(SHOTS, `main-${viewport}.png`), fullPage: true })
  }

  await mainRoot.evaluate(element => { element.scrollTop = element.scrollHeight })
  await settleFrames(page)
  const pinnedBefore = await positionOf(mainRoot, mainAnchor)
  expect(pinnedBefore.distanceFromBottom).toBeLessThan(48)
  await mainArrival('MAIN-ARRIVAL-PINNED', 'e2e-timeline-main-pinned')
  const pinnedAfter = await positionOf(mainRoot, mainAnchor)
  expect(pinnedAfter.distanceFromBottom).toBeLessThanOrEqual(2)
  evidence.push({ surface: 'Main', viewport: '390x844', event: 'bottom follow', before: pinnedBefore, after: pinnedAfter })

  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  await page.getByRole('button', { name: /^打开讨论：THREAD-ANCHOR/ }).click()
  const threadRoot = page.locator('[data-team-panel] section[aria-label="消息时间线"]')
  await threadRoot.waitFor()
  await threadRoot.getByText('thread-anchor.png', { exact: true }).waitFor()
  await scrollToAnchor(page, threadRoot, threadAnchor)
  const threadImageBefore = await positionOf(threadRoot, threadAnchor)
  await threadRoot.locator('img[alt="thread-anchor.png"]').waitFor({ timeout: 10_000 })
  await expectStable(page, threadRoot, threadAnchor, evidence,
    { surface: 'Thread', viewport: 'desktop', event: 'image above finishes loading' }, threadImageBefore)

  const threadArrival = async (marker: string, requestId: string, overlap?: () => Promise<void>): Promise<void> => {
    const beforeUnread = team.inbox({ workspaceId }).totalUnreadCount
    const overlapPromise = overlap?.() ?? Promise.resolve()
    const result = await team.replyForAgent(agent, { requestId: requestId as never, workspaceId, threadRef, body: marker,
      baseRevision: threadRevision })
    await overlapPromise
    if (result.kind !== 'committed') throw new Error(`Thread arrival was refused: ${result.kind}`)
    threadRevision = result.thread.revision
    await waitForText(threadRoot, marker)
    await expect.poll(() => team.inbox({ workspaceId }).totalUnreadCount, { timeout: 10_000 }).toBe(beforeUnread)
  }

  const threadPages = ['THREAD-061', 'THREAD-041', 'THREAD-021', 'THREAD-001'] as const
  for (const viewport of ['desktop', '390x844'] as const) {
    if (viewport === '390x844') {
      await page.setViewportSize({ width: 390, height: 844 })
      await settleLayout(page)
    }
    await scrollToAnchor(page, threadRoot, threadAnchor)

    const headBefore = await positionOf(threadRoot, threadAnchor)
    await loadOlder(threadRoot)
    await waitForText(threadRoot, threadPages[viewport === 'desktop' ? 0 : 2])
    await expectStable(page, threadRoot, threadAnchor, evidence, { surface: 'Thread', viewport, event: 'history prepend' }, headBefore)

    const tailBefore = await positionOf(threadRoot, threadAnchor)
    await threadArrival(`THREAD-ARRIVAL-${viewport}-TAIL`, `e2e-timeline-thread-tail-${viewport}`)
    await expectStable(page, threadRoot, threadAnchor, evidence, { surface: 'Thread', viewport, event: 'tail arrival' }, tailBefore)

    const combinedBefore = await positionOf(threadRoot, threadAnchor)
    await threadArrival(`THREAD-ARRIVAL-${viewport}-COMBINED`, `e2e-timeline-thread-combined-${viewport}`, () => loadOlder(threadRoot))
    await waitForText(threadRoot, threadPages[viewport === 'desktop' ? 1 : 3])
    await expectStable(page, threadRoot, threadAnchor, evidence, { surface: 'Thread', viewport, event: 'history prepend with tail arrival' }, combinedBefore)

    await page.screenshot({ path: join(SHOTS, `thread-${viewport}.png`), fullPage: true })
  }

  await threadRoot.evaluate(element => { element.scrollTop = element.scrollHeight })
  await settleFrames(page)
  const threadPinnedBefore = await positionOf(threadRoot, threadAnchor)
  expect(threadPinnedBefore.distanceFromBottom).toBeLessThan(48)
  await threadArrival('THREAD-ARRIVAL-PINNED', 'e2e-timeline-thread-pinned')
  const threadPinnedAfter = await positionOf(threadRoot, threadAnchor)
  expect(threadPinnedAfter.distanceFromBottom).toBeLessThanOrEqual(2)
  evidence.push({ surface: 'Thread', viewport: '390x844', event: 'bottom follow', before: threadPinnedBefore, after: threadPinnedAfter })

  console.log(JSON.stringify({ browser: browser!.version(), evidence }))
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)

it('keeps four same-origin Team pages responsive and independently subscribed', async () => {
  let localScaffold: WebScaffold | undefined
  let localBrowser: Browser | undefined
  try {
    const { home, stagedBundle } = await installLocalBundle()
    localScaffold = await launchWebScaffold({ harnessHome: home, profile: { packages: [{ dir: stagedBundle, enabled: true }] } })
    const workspace = await localScaffold.ctx.workspaceRegistry.create(localScaffold.workspaceCwd, 'multi-web')
    await localScaffold.ctx.agentTeam.createProject({ requestId: 'multi-project' as never, workspaceId: workspace.id, name: 'multi-web', description: 'Multi-page regression' })
    localBrowser = await chromium.launch({ headless: true, executablePath: CHROME })
    const context = await localBrowser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const pages: Page[] = []
    let membersRequest: { url: string; body: string } | undefined
    context.on('request', request => {
      if (request.url().endsWith('/agentTeam/members')) membersRequest = { url: request.url(), body: request.postData()! }
    })
    const probe = async (page: Page) => {
      expect(membersRequest).toBeDefined()
      const result = await page.evaluate(async request => {
        const start = performance.now()
        const response = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body, signal: AbortSignal.timeout(3000) })
        return { status: response.status, body: await response.json(), ms: performance.now() - start }
      }, membersRequest!)
      expect(result.status).toBe(200)
      expect(result.body.result.ok).toBe(true)
      console.log(`Team multi-page query (${pages.length} pages): ${Math.round(result.ms)}ms`)
    }
    for (let index = 0; index < 4; index++) {
      const page = await context.newPage()
      pages.push(page)
      await page.goto(localScaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
      if (index === 0) await page.getByRole('button', { name: '团队', exact: true }).click()
      await page.getByRole('button', { name: '# multi-web', exact: true }).click()
      await page.getByRole('heading', { name: '# multi-web', exact: true }).waitFor()
      await probe(page)
    }
    const composer = pages[0]!.locator('[data-team-project] textarea')
    await composer.fill('来自第一页的消息')
    await pages[0]!.getByRole('button', { name: '发送', exact: true }).click()
    for (const page of pages) await page.locator('[data-team-project] article').filter({ hasText: '来自第一页的消息' }).waitFor()
    await pages.shift()!.close()
    await probe(pages[0]!)
    await pages[0]!.getByRole('button', { name: '对话', exact: true }).click()
    await probe(pages[1]!)
    const separate = await localBrowser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const other = await separate.newPage()
    await other.goto(localScaffold.authenticatedUrl)
    await other.getByRole('button', { name: '团队', exact: true }).click()
    await other.getByRole('button', { name: '# multi-web', exact: true }).click()
    await other.locator('[data-team-project] textarea').fill('来自独立浏览器的消息')
    await other.getByRole('button', { name: '发送', exact: true }).click()
    await pages[1]!.locator('[data-team-project] article').filter({ hasText: '来自独立浏览器的消息' }).waitFor()
    await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-desktop.png'), fullPage: true })
    await pages[1]!.setViewportSize({ width: 390, height: 844 })
    await settleLayout(pages[1]!)
    await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-mobile.png'), fullPage: true })
  } finally {
    try {
      await localBrowser?.close()
    } finally {
      await localScaffold?.close()
    }
  }
}, 120_000)

it('toggles the complete bundle without restarting the session controller', async () => {
  let localScaffold: WebScaffold | undefined
  try {
    const { home, stagedBundle } = await installLocalBundle()
    localScaffold = await launchWebScaffold({ harnessHome: home, profile: { packages: [{ dir: stagedBundle, enabled: false }] } })
    const sessionController = [...localScaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber

    const enabled = await localScaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', true)
    expect(enabled, JSON.stringify(enabled)).toMatchObject({ application: 'applied' })
    expect(localScaffold.ctx.get('agentTeam')).toBeDefined()
    const workspace = await localScaffold.ctx.workspaceRegistry.create(localScaffold.workspaceCwd, 'toggle-persistence')
    const project = await localScaffold.ctx.agentTeam.createProject({
      requestId: 'toggle-persistence' as never,
      workspaceId: workspace.id,
      name: 'toggle-persistence',
      description: '',
    })
    expect(localScaffold.ctx.agentTeam.status().projectCount).toBe(1)
    expect(localScaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
    expect([...localScaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)

    const disabled = await localScaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', false)
    expect(disabled, JSON.stringify(disabled)).toMatchObject({ application: 'applied' })
    expect(localScaffold.ctx.get('agentTeam')).toBeUndefined()
    expect(localScaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(false)
    expect([...localScaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)

    expect(await localScaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', true)).toMatchObject({ application: 'applied' })
    expect(localScaffold.ctx.get('agentTeam')).toBeDefined()
    expect(localScaffold.ctx.agentTeam.status().projectCount).toBe(1)
    expect(localScaffold.ctx.agentTeam.view({ workspaceId: project.project.workspaceId }).projects[0]?.name).toBe('toggle-persistence')
    expect(localScaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
    expect([...localScaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)
  } finally {
    await localScaffold?.close()
  }
}, 30_000)

it('reaches Team mode, its three global faces, and the shortcut reference from the keyboard', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true, platform: 'MacIntel' })
  const mode = (): Promise<string | null> => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)
  expect(await mode()).toBeNull()

  await page.keyboard.press('Meta+Alt+KeyT')
  await expect.poll(mode).toBe('team')

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('shortcut')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# shortcut', exact: true }).click()
  await page.locator('[data-team-composer] textarea').waitFor()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
  await page.keyboard.press('Meta+Alt+KeyM')
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')

  const snapshot = (): Promise<Record<string, unknown>> => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as Record<string, unknown>)
  await page.getByRole('button', { name: '讨论/任务' }).click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await page.getByRole('textbox', { name: '消息内容' }).fill('返回键验收')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  await page.getByRole('button', { name: '打开 Task #1' }).click()
  await page.locator('main[data-team-thread]').waitFor()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('main[data-team-thread]').waitFor({ state: 'detached' })
  await page.locator('[data-team-project]').waitFor()
  await expect.poll(async () => (await snapshot()).threadRef).toBeUndefined()
  expect((await snapshot()).projectRef).toMatch(/^project:/)

  await page.keyboard.press('Meta+Alt+ArrowRight')
  await page.locator('main[data-team-thread]').waitFor()
  await expect.poll(async () => (await snapshot()).threadRef).toMatch(/^thread:/)
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('main[data-team-thread]').waitFor({ state: 'detached' })
  await page.locator('[data-team-project]').waitFor()

  await page.keyboard.press('Meta+Alt+Digit1')
  await page.locator('[data-team-inbox]').waitFor()
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-inbox.png'), fullPage: true })

  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('[data-team-inbox]').waitFor({ state: 'detached' })
  await page.locator('[data-team-conversation]').waitFor()
  await expect.poll(async () => (await snapshot()).inbox).toBeUndefined()

  await page.keyboard.press('Meta+Alt+Digit2')
  await page.locator('[data-team-task-board]').waitFor()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('[data-team-task-board]').waitFor({ state: 'detached' })
  await page.locator('[data-team-conversation]').waitFor()
  await expect.poll(async () => (await snapshot()).board).toBeUndefined()

  await page.keyboard.press('Meta+Alt+Digit3')
  await expect.poll(async () => (await snapshot()).manager).toBe(true)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor()
  await expect.poll(() => page.locator('[data-global-panel]').count()).toBe(0)
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-manager.png'), fullPage: true })
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await expect.poll(async () => (await snapshot()).manager).toBeUndefined()
  await page.locator('[data-team-conversation]').waitFor()

  const welcome = await snapshot()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('[data-team-conversation]').waitFor()
  expect(await snapshot()).toEqual(welcome)

  await page.keyboard.press('Meta+Alt+KeyT')
  await expect.poll(mode).toBeNull()

  await page.keyboard.press('Meta+Slash')
  const reference = page.getByRole('dialog', { name: '快捷键' })
  await reference.waitFor()
  const application = reference.getByRole('region', { name: '应用操作' })
  for (const label of ['进入或退出团队模式', '收件箱', '任务看板', '团队管理', '聚焦输入框', '返回', '前进', '上一个项目', '下一个项目',
    '收件箱第 1 项', '收件箱第 9 项']) {
    expect(await application.getByText(label, { exact: true }).count()).toBe(1)
  }
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-reference.png'), fullPage: true })

  await application.getByText('聚焦输入框', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-reference-team.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-reference-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
