import { afterEach, it, expect } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { CHROME, HOME, MAIN_STREAM_SHOTS, STAGED_BUNDLE, closeScenario, connectFreshWorkspaceZh, focusRing, installLocalBundle, launchWebScaffold, maxHorizontalScroll, openTeamPage, scaffold, settleAnimations, settleLayout, watchConsole } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })


it('posts, starts a discussion and a Task, and opens cards in the Main stream under rules version 2 in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage({ clearArtifacts: false })

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('stream-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# stream-web', exact: true }).click()

  const mainTab = page.getByRole('tab', { name: '主对话' })
  await mainTab.waitFor()
  expect(await mainTab.getAttribute('aria-selected')).toBe('true')
  const composer = page.getByRole('textbox', { name: '消息内容' })
  const send = page.getByRole('button', { name: '发送' })
  await page.getByText('主对话还没有内容').waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'empty-desktop.png'), fullPage: true })

  await composer.fill('配色要不要跟设置页统一？')
  await send.click()
  await page.getByText('配色要不要跟设置页统一？', { exact: true }).waitFor()
  await expect.poll(() => composer.inputValue()).toBe('')

  // Discussion: the toggle turns the send into a new Thread whose card lands in the stream.
  const toggle = page.getByRole('button', { name: '讨论/任务' })
  await toggle.click()
  expect(await toggle.getAttribute('aria-pressed')).toBe('true')
  await composer.fill('登录页改版')
  await send.click()
  const discussionCard = page.getByRole('button', { name: /^打开讨论：登录页改版/ })
  await discussionCard.waitFor()
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  expect(await page.getByRole('checkbox', { name: '作为任务' }).count()).toBe(0)

  // Task: checking 作为任务 sends a Task and moves to the board.
  await toggle.click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await composer.fill('实现 API 网关')
  await send.click()
  await page.getByRole('tab', { name: '看板' }).waitFor()
  await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  await page.getByRole('button', { name: '打开 Task #1', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '加载更早消息' }).count()).toBe(0)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'board-desktop.png'), fullPage: true })

  await mainTab.click()
  const taskCard = page.getByRole('button', { name: /^打开 Task #1：实现 API 网关/ })
  await taskCard.waitFor()
  expect(await discussionCard.getAttribute('data-main-card')).toBe('discussion')
  // The feed's large target answers on its own surface, not on one edge: the border alone used to lighten under the
  // pointer, which left the fill untouched and made the only reacting edge fainter.
  const cardRestFill = await discussionCard.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(cardRestFill).not.toBe('rgba(0, 0, 0, 0)')
  await discussionCard.hover()
  await settleAnimations(page)
  const cardHoverFacts = await discussionCard.evaluate(element => {
    const style = getComputedStyle(element)
    return { fill: style.backgroundColor, border: style.borderColor }
  })
  expect(cardHoverFacts.fill).not.toBe(cardRestFill)
  expect(cardHoverFacts.border).not.toBe('rgba(0, 0, 0, 0)')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-desktop.png'), fullPage: true })

  // Keyboard: a card is a real button that opens the Thread side panel from Enter.
  await page.keyboard.press('Tab')
  await discussionCard.focus()
  const ring = await focusRing(page, '[data-main-card="discussion"]')
  expect(ring?.focusVisible).toBe(true)
  expect(ring?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '关闭讨论' }).waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'panel-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭讨论' }).click()

  // An owner grant is a Main stream activity row.
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('steward')
  await createAgent.getByLabel('说明').fill('负责交付')
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('steward', { exact: true }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '# stream-web', exact: true }).hover()
  await page.getByRole('button', { name: 'stream-web 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目' }).click()
  const editor = page.getByRole('dialog', { name: '编辑项目' })
  await editor.getByRole('button', { name: '添加负责人 @steward' }).click()
  await editor.getByRole('button', { name: '移除负责人 @steward' }).waitFor()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByText('human 指定 @steward 为项目负责人').waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-owner-desktop.png'), fullPage: true })

  // A Main stream read moves the same private watermark a Thread read does, and
  // the Host derives both Inbox slices from it — so the sidebar's unread mark must
  // go when this page acknowledges a Main stream arrival. It used to survive the
  // read that consumed it: the Inbox emptied while the mark stayed, which is the
  // drift the Human reported. The arrival is written by the Project's own Agent so
  // the unread is a real Host marker, not a Client guess. It is written while the
  // reader stands on the Inbox instead, because the Project page acknowledges on
  // its own — a reader parked there would consume the mark before it was drawn.
  const mainWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const streamProject = scaffold.ctx.agentTeam.view({ workspaceId: mainWorkspace.id }).projects
    .find((project: { name: string }) => project.name === 'stream-web')!
  const stewardMember = scaffold.ctx.agentTeam.members({ workspaceId: mainWorkspace.id })
    .find((status: { member: { handle: string } }) => status.member.handle === 'steward')!
  const stewardAgent = scaffold.ctx.agents.get(stewardMember.member.sessionId)!
  // The owner grant arrived while it was idle, so its own Main stream standing holds
  // that marker: a writer reads its backlog before it may write (rules version 2).
  await scaffold.ctx.agentTeam.readMainStreamForAgent(stewardAgent, {
    requestId: 'm2-11-steward-read' as never, workspaceId: mainWorkspace.id, projectRef: streamProject.projectRef,
  })
  await page.getByRole('button', { name: '收件箱' }).click()
  await page.locator('[data-team-inbox]').waitFor()
  const mainUnreadBefore = scaffold.ctx.agentTeam.inbox({ workspaceId: mainWorkspace.id }).totalUnreadCount
  const arrivalPost = await scaffold.ctx.agentTeam.postMainMessageForAgent(stewardAgent, {
    requestId: 'm2-11-main-arrival' as never, workspaceId: mainWorkspace.id,
    projectRef: streamProject.projectRef, body: '网关灰度已经就绪，等你确认',
  })
  expect(arrivalPost.kind).toBe('committed')
  expect(scaffold.ctx.agentTeam.inbox({ workspaceId: mainWorkspace.id }).totalUnreadCount).toBe(mainUnreadBefore + 1)
  const streamInboxCard = page.locator('button[class*="inboxCard"]')
  // The card's name is the only place the quantity is written; the dot is its visible half.
  await expect.poll(async () => await streamInboxCard.getAttribute('aria-label'), { timeout: 20_000 }).toBe(`收件箱，${mainUnreadBefore + 1} 条未读`)
  await expect.poll(async () => await streamInboxCard.locator('[data-team-inbox-dot]').count()).toBe(1)
  // The queue names the Project's Main stream: this is the row a reader follows to
  // the very arrival they are being told about.
  const streamMainRow = page.locator('[data-team-inbox] button').filter({ hasText: '#stream-web · 主对话' })
  await streamMainRow.waitFor()
  await streamMainRow.click()
  await page.getByText('网关灰度已经就绪，等你确认', { exact: true }).waitFor()
  // The page acknowledges the arrival on its own; once the Host watermark has moved,
  // the mark and the count must clear together — one unread fact, one number.
  await expect.poll(async () => await streamInboxCard.getAttribute('aria-label'), { timeout: 20_000 }).toBe('收件箱')
  await expect.poll(async () => await streamInboxCard.locator('[data-team-inbox-dot]').count()).toBe(0)
  expect(scaffold.ctx.agentTeam.inbox({ workspaceId: mainWorkspace.id }).totalUnreadCount).toBe(mainUnreadBefore)

  // A quoted line in the Main stream is the same gesture as in a Thread: it names a Message already in this timeline, so
  // it is a button that centres that row and pulses it. Without the wiring the row degrades to inert text — the defect
  // the Human reported here.
  await composer.fill('引用测试：这条会被引用')
  await send.click()
  const quotedRow = page.locator('article').filter({ hasText: '引用测试：这条会被引用' }).first()
  await quotedRow.waitFor()
  await quotedRow.hover()
  await quotedRow.getByRole('button', { name: '引用这条消息' }).click()
  await composer.fill('主对话里的引用回复')
  await send.click()
  const mainQuotedRow = page.locator('article').filter({ hasText: '主对话里的引用回复' })
  await mainQuotedRow.waitFor()
  const mainQuoteLine = mainQuotedRow.locator('[data-quote-line]')
  await expect.poll(() => mainQuoteLine.count()).toBe(1)
  // A button, not a div: the inert fallback is exactly what the defect looked like.
  expect(await mainQuoteLine.evaluate(element => element.tagName)).toBe('BUTTON')
  // The Main stream keeps its rows inert under the pointer — a feed row is an entry row, not the Thread's reading seat —
  // while the action card still reveals. This is the deliberate split, so the journey states both halves: no row layer,
  // card present.
  await quotedRow.hover()
  await settleAnimations(page)
  const mainHoverFacts = await quotedRow.evaluate(element => {
    const row = getComputedStyle(element)
    return {
      rowFill: row.backgroundColor, rowRadius: row.borderRadius, rowShadow: row.boxShadow,
      cardOpacity: getComputedStyle(element.querySelector('[data-message-card]')!).opacity,
    }
  })
  expect(mainHoverFacts.rowFill).toBe('rgba(0, 0, 0, 0)')
  expect(mainHoverFacts.rowShadow).toBe('none')
  expect(mainHoverFacts.cardOpacity).toBe('1')
  await mainQuoteLine.click()
  await expect.poll(async () => await quotedRow.getAttribute('data-reply-flash')).toBe('true')
  // The attribute is the wiring; the pulse is the feedback. The Main stream takes the pulse without the row layer its
  // Thread seat has, so the fill is read here rather than assumed from the attribute.
  await expect.poll(async () => quotedRow.evaluate(element => {
    const fill = getComputedStyle(element).backgroundColor
    return fill === 'rgba(0, 0, 0, 0)' ? 'none' : fill
  })).not.toBe('none')

  // The composer picks no @all at version 2.
  await composer.fill('@')
  expect(await page.getByRole('option', { name: /通知所有成员/ }).count()).toBe(0)
  await composer.fill('')

  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await taskCard.waitFor()
  await toggle.click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await composer.fill('在手机宽度下写一条比较长的任务描述，检查控制行换行与卡片不溢出')
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-mobile.png'), fullPage: true })
  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('[data-main-card], [data-team-composer]')]
    .filter(element => element.getBoundingClientRect().right > window.innerWidth + 0.5).length)
  expect(overflowing).toBe(0)

  // The global Task board: the cross-Workspace face the sidebar's board row
  // opens. Exactly one sidebar row carries aria-current — the board itself,
  // never the Workspace selector, because no Workspace overview stands under a
  // global face (the collapsed states the Human screenshotted).
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  const boardRow = page.getByRole('button', { name: '任务看板' })
  await boardRow.click()
  const boardPage = page.locator('[data-team-task-board]')
  await boardPage.waitFor()
  // The stacked band is one band on every face: title line, 3px step, description line, and a stated height so the band
  // cannot move with the data. Measured here across two of those faces in one render.
  const bandOf = async (): Promise<{ h: number; titleY: number; subY: number } | null> => page.evaluate(() => {
    const band = document.querySelector('[class*="surfaceHeader"]') as HTMLElement | null
    if (band === null) return null
    const title = band.querySelector('h1')
    const sub = band.querySelector('p')
    if (title === null || sub === null) return null
    const box = band.getBoundingClientRect()
    return { h: Math.round(box.height), titleY: Math.round(title.getBoundingClientRect().y - box.y), subY: Math.round(sub.getBoundingClientRect().y - box.y) }
  })
  const boardBand = await bandOf()
  expect(boardBand).not.toBeNull()
  // The Inbox is the other stacked face, measured in the same render: identical band height and identical baselines, so a
  // reader switching between them sees the feed start in the same place.
  await page.getByRole('button', { name: '收件箱' }).click()
  await page.waitForTimeout(400)
  const inboxBand = await bandOf()
  expect(inboxBand).toEqual(boardBand)
  await boardRow.click()
  await page.waitForTimeout(400)
  await expect.poll(async () => await boardRow.getAttribute('aria-current')).toBe('page')
  expect(await page.locator('[data-team-workspace-trigger]').getAttribute('aria-current')).toBeNull()
  const globalCard = boardPage.getByRole('button', { name: /Task #1/ })
  await globalCard.waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'task-board-page.png'), fullPage: true })
  // The two cross-Workspace cards and the Workspace selector stand as one
  // stack: every gap between them is some control's 2px top step, so the
  // two top-to-top distances must measure equal in this one render.
  const stackSteps = await page.evaluate(() => {
    const tops = ['button[aria-label="收件箱"]', 'button[aria-label="任务看板"]', '[data-team-workspace-trigger]']
      .map(selector => document.querySelector(selector)?.getBoundingClientRect().top)
    return [tops[1]! - tops[0]!, tops[2]! - tops[1]!]
  })
  expect(stackSteps[0]).toBe(stackSteps[1])
  // A card opens the Task's own Thread level, and the sidebar marker follows
  // it off the board row: the board is a face, not a standing selection.
  await globalCard.click()
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await expect.poll(async () => await boardRow.getAttribute('aria-current')).toBe(null)
  // Back to the board face, then the narrow width keeps the page itself free
  // of horizontal overflow: the columns become the Project board's own sideways
  // strip, so the containment that must hold is the document's, not the strip's.
  await boardRow.click()
  await boardPage.waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'task-board-page-narrow.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
import { join } from 'node:path'
