import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Locator, Page } from './__external-agent-team-support.ts'
import {
  BROWSER_ARTIFACTS, ONE_PIXEL_PNG, browser, chooseMemberModel, closeScenario, memberAgent, openTeamPage,
  scaffold, settleLayout, waitForMemberAgent,
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
