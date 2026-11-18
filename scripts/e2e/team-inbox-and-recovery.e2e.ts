import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import {
  BROWSER_ARTIFACTS,
  ONE_PIXEL_PNG,
  UI05_SHOTS,
  UI07_SHOTS,
  UI08_SHOTS,
  acknowledgeReloadConnectionLoss,
  chooseMemberModel,
  closeScenario,
  entryUnreadCapsule,
  focusRing,
  openSidebar,
  openTeamPage,
  readCountCapsule,
  scaffold,
  scenarioHome,
  settleAnimations,
  settleLayout,
  taskEntryLineSelector,
  waitForMemberAgent,
} from './__external-agent-team-support.ts'
import type { Locator } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('drives the human inbox, offline recovery, consecutive messages, and keyboard navigation', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const activeScaffold = scaffold!
  const inboxWorkspace = activeScaffold.ctx.workspaceRegistry.list()[0]!
  const teamCurrentPage = page.locator('[data-slot="sidebar.workspaces"] [aria-current="page"]')
  const globalPanelsNav = page.locator('nav[class*="panelList"]')
  const projectComposer = page.getByRole('textbox', { name: '消息内容' })

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const agentDialog = page.getByRole('dialog', { name: '添加 Agent' })
  await agentDialog.getByLabel('名称').fill('reviewer')
  await chooseMemberModel(page, agentDialog)
  await agentDialog.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('reviewer', { exact: true }).waitFor({ timeout: 20_000 })

  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('delivery')
  await projectDialog.getByLabel('说明').fill('交付主线')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# delivery', exact: true }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()

  // Seed Task #1 so its Main-stream card supplies an unread capsule and a keyboard target later.
  await page.getByRole('button', { name: '讨论/任务' }).click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await projectComposer.fill('初始交付任务')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('tab', { name: '看板' }).waitFor()
  await page.getByRole('button', { name: /^打开 Task #1/ }).waitFor()

  const inboxReviewer = activeScaffold.ctx.agentTeam.members({ workspaceId: inboxWorkspace.id })
    .find((entry: { member: { handle: string } }) => entry.member.handle === 'reviewer')!
  const inboxAgent = await waitForMemberAgent(activeScaffold, inboxWorkspace.id, inboxReviewer.member.memberId)

  const inboxProjects = activeScaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).projects
  const deliveryProject = inboxProjects.find((project: { name: string }) => project.name === 'delivery')!
  await activeScaffold.ctx.agentTeam.addProjectOwner({
    requestId: 'm2-09-reviewer-owner' as never, workspaceId: inboxWorkspace.id,
    projectRef: deliveryProject.projectRef, memberId: inboxReviewer.member.memberId,
  })
  const task1Item = activeScaffold.ctx.agentTeam.view({
    workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 20,
  }).items.find((item: { message: { body: string } }) => item.message.body === '初始交付任务')!
  const task1Ref = (task1Item.task as { taskRef: string }).taskRef
  const task1Read = await activeScaffold.ctx.agentTeam.readThreadForAgent(inboxAgent, {
    requestId: 'm2-09-task1-read' as never, workspaceId: inboxWorkspace.id, taskRef: task1Ref as never,
  })
  const task1Reply = await activeScaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-task1-reply' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: task1Read.thread.threadRef,
    body: 'Task #1 已收到，准备检查',
    baseRevision: task1Read.thread.revision,
  })
  expect(task1Reply.kind).toBe('committed')
  await page.locator(taskEntryLineSelector(1)).locator('[data-team-count-badge]').waitFor()
  const unreadCapsule = await entryUnreadCapsule(page, taskEntryLineSelector(1))
  // Acknowledge Task #1 before measuring the Inbox queue so draining the two discussions empties '需要我'.
  // Open it as a reader does: a Host read wakes no change subscriber, so only this Client's own read
  // advances the badge; draining out of band would leave it on whatever total the last wake read.
  await page.getByRole('button', { name: /^打开 Task #1/ }).click()
  await page.getByRole('heading', { name: 'Task #1' }).waitFor()
  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.getByRole('tab', { name: '主对话' }).click()

  // Human Inbox: a mention, or an Agent's ordinary reply on a followed Thread,
  // raises the badge and an Inbox row; opening the Thread clears both.
  const inboxCard = page.locator('button[class*="inboxCard"]')
  const railInboxButton = page.locator('nav[class*="railWorkspace"] button[aria-label*="收件箱"]')
  const sidebarUnread = async (): Promise<string | null> => {
    const scope = await inboxCard.count() > 0 ? inboxCard : railInboxButton
    const match = /(\d+)/.exec((await scope.getAttribute('aria-label')) ?? '')
    return match === null ? null : match[1]
  }
  const sidebarDot = async (): Promise<number> => {
    const scope = await inboxCard.count() > 0 ? inboxCard : railInboxButton
    return await scope.locator('[data-team-inbox-dot]').count()
  }
  const expectSidebarUnread = async (expected: string | null): Promise<void> => {
    await expect.poll(async () => await sidebarUnread(), { timeout: 10_000 }).toBe(expected)
    await expect.poll(async () => await sidebarDot()).toBe(expected === null ? 0 : 1)
  }
  await inboxCard.waitFor()
  const baseUnread = activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).totalUnreadCount
  await expectSidebarUnread(baseUnread === 0 ? null : String(baseUnread))

  await page.getByRole('button', { name: '讨论/任务' }).click()
  await projectComposer.fill('请 Human 决策的讨论')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: /^打开讨论：请 Human 决策的讨论/ }).waitFor()
  const inboxView = activeScaffold.ctx.agentTeam.view({
    workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 50,
  })
  const inboxThreadItem = inboxView.items.find((item: { message: { body: string } }) => item.message.body === '请 Human 决策的讨论')!
  const inboxThreadRef = (inboxThreadItem.thread as { threadRef: string }).threadRef
  const inboxRead = await activeScaffold.ctx.agentTeam.readThreadForAgent(inboxAgent, {
    requestId: 'm2-09-builder-read' as never, workspaceId: inboxWorkspace.id, threadRef: inboxThreadRef as never,
  })
  const inboxMention = await activeScaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-builder-mention' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: inboxThreadRef as never,
    body: '@human 需要你拍板：默认走 A 方案',
    baseRevision: inboxRead.thread.revision,
  })
  expect(inboxMention.kind).toBe('committed')
  const mentionedInbox = activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  expect(mentionedInbox.totalUnreadCount).toBe(baseUnread + 1)
  expect(mentionedInbox.items.find((item: { thread: { threadRef: string } }) => item.thread.threadRef === inboxThreadRef)).toMatchObject({
    projectName: 'delivery', previewText: '请 Human 决策的讨论',
  })
  const inboxRow = page.locator('[data-team-inbox] button').filter({ hasText: '请 Human 决策的讨论' })
  await expectSidebarUnread(String(baseUnread + 1))
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-dot-desktop.png'), fullPage: true })

  const inboxOrdinary = await activeScaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-builder-ordinary' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: inboxThreadRef as never,
    body: '继续推进实现细节，无需 Human 介入',
    baseRevision: inboxMention.thread.revision,
  })
  expect(inboxOrdinary.kind).toBe('committed')
  expect(activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).totalUnreadCount).toBe(baseUnread + 2)
  await expectSidebarUnread(String(baseUnread + 2))

  await page.getByRole('button', { name: '讨论/任务' }).click()
  await projectComposer.fill('工程侧同步，无需决策')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: /^打开讨论：工程侧同步，无需决策/ }).waitFor()
  const plainView = activeScaffold.ctx.agentTeam.view({
    workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 50,
  })
  const plainThreadRef = (plainView.items.find((item: { message: { body: string } }) => item.message.body === '工程侧同步，无需决策')!.thread as { threadRef: string }).threadRef
  const plainRead = await activeScaffold.ctx.agentTeam.readThreadForAgent(inboxAgent, {
    requestId: 'm2-09-plain-read' as never, workspaceId: inboxWorkspace.id, threadRef: plainThreadRef as never,
  })
  const plainReply = await activeScaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-plain-reply' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: plainThreadRef as never,
    body: '收到，先按计划推进',
    baseRevision: plainRead.thread.revision,
  })
  expect(plainReply.kind).toBe('committed')
  expect(activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).totalUnreadCount).toBe(baseUnread + 3)
  await expectSidebarUnread(String(baseUnread + 3))

  await inboxCard.click()
  await page.locator('[data-team-inbox]').waitFor()
  const currentCardFill = await inboxCard.evaluate(card => ({
    label: card.getAttribute('aria-current'),
    background: getComputedStyle(card).backgroundColor,
  }))
  expect(currentCardFill.label).toBe('page')
  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  const inboxRail = page.locator('nav[class*="railWorkspace"]')
  await inboxRail.waitFor()
  const railLabels = await inboxRail.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(railLabels).toEqual(['对话', `收件箱，${baseUnread + 3} 条未读`, '任务看板', '团队管理', '项目', 'Agents'])
  await expectSidebarUnread(String(baseUnread + 3))
  await railInboxButton.hover()
  const railHint = page.locator('[role="tooltip"]')
  await expect.poll(async () => await railHint.count()).toBe(1)
  expect(await railHint.textContent()).toBe(`收件箱，${baseUnread + 3} 条未读`)
  await page.mouse.move(300, 600)
  await expect.poll(async () => await railHint.count()).toBe(0)
  const railCurrent = await railInboxButton.evaluate(button => ({
    label: button.getAttribute('aria-current'),
    background: getComputedStyle(button).backgroundColor,
  }))
  expect(railCurrent.label).toBe('page')
  expect(railCurrent.background).toBe(currentCardFill.background)
  expect(railCurrent.background).not.toBe('rgba(0, 0, 0, 0)')
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-rail.png'), fullPage: true })
  await railInboxButton.click()
  await page.locator('[data-sidebar-collapsed]').waitFor({ state: 'detached' })
  await settleLayout(page)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await openSidebar(page)
  await expectSidebarUnread(String(baseUnread + 3))
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-narrow-drawer.png'), fullPage: true })
  await expect.poll(() => page.locator('button[class*="inboxCard"]').count()).toBe(1)
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.textContent()).toContain('#delivery')
  const plainRow = page.locator('[data-team-inbox] button').filter({ hasText: '工程侧同步，无需决策' })
  await expect.poll(async () => await plainRow.count()).toBe(1)
  const inboxPage = page.locator('[data-team-inbox]')
  await expect.poll(async () => await inboxPage.getByRole('heading', { name: '收件箱' }).count()).toBe(1)
  const queueSection = inboxPage.locator('section').filter({ hasText: '需要我' })
  const recentSection = inboxPage.locator('section').filter({ hasText: '最近活跃' })
  const queue = activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  await expect.poll(async () => await queueSection.locator('button[class*="row"]').count()).toBe(queue.items.length)
  await expect.poll(async () => await recentSection.locator('button[class*="row"]').count()).toBeLessThanOrEqual(5)
  const queueUnread = queue.items.reduce((sum, item) => sum + item.unreadCount, 0)
  const queueMentions = queue.items.reduce((sum, item) => sum + item.directCount, 0)
  await expect.poll(async () => await inboxPage.getByText(`${queue.items.length} 个 Thread`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxPage.getByText(`${queueUnread} 条未读`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxPage.getByText(`${queueMentions} 条直接通知`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxRow.locator('time').count()).toBe(1)
  const inboxRowTime = inboxRow.locator('time').first()
  await expect.poll(async () => await inboxRowTime.textContent()).toMatch(/^\d{2}:\d{2}$/)
  expect(await inboxRowTime.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  const namedCapsule = inboxRow.locator('[data-team-count-badge]')
  const plainCapsule = plainRow.locator('[data-team-count-badge]')
  await expect.poll(async () => await namedCapsule.getAttribute('aria-label')).toBe('2 条未读，其中 1 条直接通知')
  await expect.poll(async () => await plainCapsule.getAttribute('aria-label')).toBe('1 条未读')
  expect(await namedCapsule.getAttribute('title')).toBe('2 条未读，其中 1 条直接通知')
  expect(await namedCapsule.textContent()).toBe('2')
  expect(await plainCapsule.textContent()).toBe('1')
  const narrowFit = await inboxPage.evaluate(root => {
    const rows = [...root.querySelectorAll('button[class*="row"]')] as HTMLElement[]
    const crumbs = rows.map(row => row.querySelector('[class*="rowCrumb"]') as HTMLElement)
    const times = rows.map(row => row.querySelector('time') as HTMLElement)
    const crumbStyle = getComputedStyle(crumbs[0]!)
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rowSpill: Math.max(...rows.map(row => row.scrollWidth - row.clientWidth)),
      crumbNowrap: crumbStyle.whiteSpace,
      crumbEllipsis: crumbStyle.textOverflow,
      clockOnIdentityLine: rows.every((_, index) => {
        if (times[index]!.getBoundingClientRect().width === 0) return true
        return Math.abs(crumbs[index]!.getBoundingClientRect().top - times[index]!.getBoundingClientRect().top) < 4
      }),
      rowHeight: Math.round(rows[0]!.getBoundingClientRect().height),
    }
  })
  expect(narrowFit.documentOverflow).toBeLessThanOrEqual(0)
  expect(narrowFit.rowSpill).toBeLessThanOrEqual(0)
  expect(narrowFit.crumbNowrap).toBe('nowrap')
  expect(narrowFit.crumbEllipsis).toBe('ellipsis')
  expect(narrowFit.clockOnIdentityLine).toBe(true)
  expect(narrowFit.rowHeight).toBeLessThanOrEqual(60)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-narrow.png'), fullPage: true })
  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  const collapsedRow = await inboxPage.locator('button[class*="row"]').first().evaluate(row => {
    const box = (selector: string): DOMRect => (row.querySelector(selector) as HTMLElement).getBoundingClientRect()
    const line = box('[class*="rowCrumb"]')
    return { height: Math.round(row.getBoundingClientRect().height), sameLine: Math.abs(line.top - box('time').top) < 4 }
  })
  expect(collapsedRow.height).toBeLessThanOrEqual(62)
  expect(collapsedRow.sameLine).toBe(true)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-narrow-collapsed.png'), fullPage: true })
  await openSidebar(page)
  await page.locator('[data-sidebar-collapsed]').waitFor({ state: 'detached' })
  await settleLayout(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  const ink = async (locator: Locator) => await locator.evaluate(element => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      background: style.backgroundColor, border: style.borderTopColor, color: style.color,
      width: Math.round(box.width), height: Math.round(box.height), left: Math.round(box.x),
    }
  })
  const namedInk = await ink(namedCapsule)
  const plainInk = await ink(plainCapsule)
  expect(plainInk.background).not.toBe(namedInk.background)
  expect(plainInk.border).not.toBe('rgba(0, 0, 0, 0)')
  expect(await page.locator('button[class*="inboxCard"] [data-team-count-badge]').count()).toBe(0)
  const inboxDot = page.locator('button[class*="inboxCard"] [data-team-inbox-dot]')
  await expect.poll(async () => await inboxDot.count()).toBe(1)
  const dotInk = await ink(inboxDot)
  expect(dotInk.background).toBe(namedInk.background)
  expect(dotInk.width).toBe(8)
  expect(dotInk.height).toBe(8)
  expect(namedInk.height).toBe(plainInk.height)
  expect(namedInk.width).toBe(plainInk.width)
  expect(namedInk.left).toBe(plainInk.left)

  const namedCapsuleRead = await namedCapsule.evaluate(readCountCapsule)
  const plainCapsuleRead = await plainCapsule.evaluate(readCountCapsule)
  const capsuleReads = [namedCapsuleRead, plainCapsuleRead, unreadCapsule]
  for (const read of capsuleReads.slice(1)) {
    if (read === null) continue
    expect(read.shape).toEqual(namedCapsuleRead.shape)
  }
  expect(capsuleReads.map(read => read?.inset))
    .toEqual([namedCapsuleRead.inset, namedCapsuleRead.inset, namedCapsuleRead.inset])
  for (const read of capsuleReads) {
    if (read === null || read.text.length !== 1) continue
    expect(read.box.height).toBe(read.box.width)
  }
  const edgeLeft = async (locator: Locator): Promise<number> => Math.round(await locator.evaluate(element => element.getBoundingClientRect().x))
  const edgeRight = async (locator: Locator): Promise<number> => Math.round(await locator.evaluate(element => element.getBoundingClientRect().right))
  const column = await inboxPage.evaluate(root => [...root.querySelectorAll('section')].map(section => {
    const heading = section.querySelector('h2') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(heading)
    const box = (selector: string, row: Element): DOMRect => (row.querySelector(selector) as HTMLElement).getBoundingClientRect()
    const left = (selector: string, row: Element): number => Math.round(box(selector, row).left)
    return {
      heading: Math.round(range.getBoundingClientRect().left),
      rows: [...section.querySelectorAll('button')].map(row => {
        const badge = row.querySelector('[data-team-count-badge]') as HTMLElement | null
        const actor = row.querySelector('[class*="rowActor"]') as HTMLElement
        return {
          actor: left('[class*="rowActor"]', row),
          actorWidth: Math.round((actor.querySelector('[role="img"]') as HTMLElement).getBoundingClientRect().width),
          actorLabel: (actor.querySelector('[role="img"]') as HTMLElement).getAttribute('aria-label'),
          badgeToTime: badge === null ? null : Math.round(box('time', row).left - badge.getBoundingClientRect().right),
          crumb: left('[class*="rowCrumb"]', row),
          preview: left('[class*="rowPreview"]', row),
          text: (row.querySelector('[class*="rowPreview"]') as HTMLElement).textContent,
          workspace: row.querySelector('[class*="rowWorkspace"]') === null ? null : 1,
        }
      }),
    }
  }))
  expect(column.length).toBeGreaterThan(0)
  const inboxNow = activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  const hostRows = [...inboxNow.items, ...inboxNow.recent]
  const clusterWidth = (owners: number): number => owners === 0 ? 18 : 18 + 14 * (Math.min(owners, 3) - 1) + (owners > 3 ? 14 : 0)
  for (const section of column) {
    for (const row of section.rows) {
      const item = hostRows.find(candidate => (candidate.previewText ?? '') === row.text)
      expect(item).toBeDefined()
      expect(row.actorLabel).toBe(item!.liveClaimOwners.length === 0
        ? `最新来自 @${item!.newestActor.name}`
        : `由 ${item!.liveClaimOwners.map(owner => `@${owner.name}`).join(', ')} 认领`)
      expect(row.actorWidth).toBe(clusterWidth(item!.liveClaimOwners.length))
      expect(row.crumb).toBe(row.actor + row.actorWidth + 8)
      expect(row.preview).toBe(row.crumb)
      expect(section.heading).toBe(row.actor + 26)
      if (row.badgeToTime !== null) expect(row.badgeToTime).toBe(8)
      expect(row.workspace).toBeNull()
    }
  }
  expect(await edgeRight(inboxRow.locator('time'))).toBe(await edgeRight(plainRow.locator('time')))
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-desktop.png'), fullPage: true })
  await page.keyboard.press('Tab')
  await inboxRow.focus()
  await inboxRow.scrollIntoViewIfNeeded()
  const rowRing = await focusRing(page, '[data-team-inbox] button[data-named]')
  expect(rowRing?.focusVisible).toBe(true)
  expect(rowRing?.outlineStyle).toBe('solid')
  expect(rowRing?.outlineWidth).toBe('2px')
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-row-focus.png'), fullPage: true })

  await inboxRow.click()
  await page.locator(`[data-team-panel="${inboxThreadRef}"]`).waitFor()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expectSidebarUnread(baseUnread === 0 ? '1' : String(baseUnread + 1))
  await page.locator('button[class*="inboxCard"]').click()
  await page.locator('[data-team-inbox]').waitFor()
  await page.locator('[data-team-inbox]').getByRole('heading', { name: '最近活跃' }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.locator('[data-team-count-badge]').count()).toBe(0)
  await expect.poll(async () => await plainRow.count()).toBe(1)
  await expect.poll(async () => await plainRow.textContent()).toContain('工程侧同步，无需决策')
  await expect.poll(async () => await plainRow.locator('[data-team-count-badge]').count()).toBe(1)
  expect(await edgeLeft(inboxRow.locator('[class*="rowActor"]'))).toBe(await edgeLeft(plainRow.locator('[class*="rowActor"]')))
  expect(await edgeLeft(inboxRow.locator('[class*="rowCrumb"]'))).toBe(await edgeLeft(plainRow.locator('[class*="rowCrumb"]')))

  await plainRow.click()
  await page.locator('[data-team-panel]').waitFor()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expectSidebarUnread(baseUnread === 0 ? null : String(baseUnread))
  await page.locator('button[class*="inboxCard"]').click()
  await page.locator('[data-team-inbox]').waitFor()
  await page.locator('[data-team-inbox]').getByRole('heading', { name: '最近活跃' }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await page.locator('[data-team-inbox]').getByRole('heading', { name: '需要我' }).count()).toBe(0)
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await plainRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.locator('[data-team-count-badge]').count()).toBe(0)
  await expect.poll(async () => await plainRow.locator('[data-team-count-badge]').count()).toBe(0)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-recent.png'), fullPage: true })
  await expect.poll(async () => await page.locator('button[class*="inboxCard"]').getAttribute('aria-current')).toBe('page')

  const stackOwnerIds = () => activeScaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).owners
    .filter((owner: { projectRef: string }) => owner.projectRef === deliveryProject.projectRef)
    .map((owner: { memberId: string }) => owner.memberId)
  if (!stackOwnerIds().includes(inboxReviewer.member.memberId)) {
    await activeScaffold.ctx.agentTeam.addProjectOwner({
      requestId: 'm2-09-stack-owner' as never, workspaceId: inboxWorkspace.id,
      projectRef: deliveryProject.projectRef, memberId: inboxReviewer.member.memberId,
    })
  }
  const stackStarted = await activeScaffold.ctx.agentTeam.startThreadForAgent(inboxAgent, {
    requestId: 'm2-09-stack-task' as never, workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef,
    kind: 'task', body: '叠放校验：谁在这个 Task 上 @human',
  })
  if (stackStarted.kind !== 'committed') throw new Error(`stack fixture was rejected: ${stackStarted.kind}`)
  const stackTaskRef = stackStarted.task!.taskRef
  const stackThreadRef = stackStarted.thread.threadRef
  const projectMemberIds = new Set(activeScaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).members
    .filter((membership: { projectRef: string }) => membership.projectRef === deliveryProject.projectRef)
    .map((membership: { memberId: string }) => membership.memberId))
  const claimants = activeScaffold.ctx.agentTeam.members()
    .filter((entry: { member: { memberId: string; state: string; sessionId: string } }) => entry.member.state === 'enabled'
      && projectMemberIds.has(entry.member.memberId)
      && activeScaffold.ctx.agents.get(entry.member.sessionId as never) !== undefined)
    .slice(0, 3)
  expect(claimants.length).toBeGreaterThanOrEqual(1)
  for (const [index, entry] of claimants.entries()) {
    const claimant = activeScaffold.ctx.agents.get(entry.member.sessionId as never)!
    const read = await activeScaffold.ctx.agentTeam.readThreadForAgent(claimant, {
      requestId: `m2-09-stack-read-${index}` as never, workspaceId: inboxWorkspace.id, taskRef: stackTaskRef,
    })
    const claimed = await activeScaffold.ctx.agentTeam.changeClaimForAgent(claimant, {
      requestId: `m2-09-stack-claim-${index}` as never, workspaceId: inboxWorkspace.id, taskRef: stackTaskRef,
      action: 'claim', direction: `叠放校验 ${index + 1}`, baseRevision: read.thread.revision,
    })
    if (claimed.kind !== 'committed') throw new Error(`stack Claim was rejected: ${claimed.kind}`)
  }
  const stackRow = page.locator('[data-team-inbox] button').filter({ hasText: '叠放校验：谁在这个 Task 上' })
  await expect.poll(async () => await stackRow.count(), { timeout: 30_000 }).toBe(1)
  const stackBox = await stackRow.evaluate(row => {
    const cluster = row.querySelector('[class*="rowActor"] [role="img"]') as HTMLElement
    const gutter = row.querySelector('[class*="rowActor"]') as HTMLElement
    const crumb = row.querySelector('[class*="rowCrumb"]') as HTMLElement
    return {
      label: cluster.getAttribute('aria-label'),
      width: Math.round(cluster.getBoundingClientRect().width),
      circles: cluster.querySelectorAll('span').length,
      inset: Math.round(crumb.getBoundingClientRect().left - gutter.getBoundingClientRect().left),
    }
  })
  const stackItem = activeScaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).items
    .find(item => item.thread.threadRef === stackThreadRef)!
  expect(stackItem.liveClaimOwners.length).toBe(claimants.length)
  expect(stackItem.liveClaimOwners.map(owner => owner.name).sort()).toEqual(
    claimants.map((entry: { member: { handle: string } }) => entry.member.handle).sort())
  expect(stackBox.circles).toBe(Math.min(stackItem.liveClaimOwners.length, 3) + (stackItem.liveClaimOwners.length > 3 ? 1 : 0))
  expect(stackBox.label).toBe(`由 ${stackItem.liveClaimOwners.map(owner => `@${owner.name}`).join(', ')} 认领`)
  expect(stackBox.width).toBe(clusterWidth(stackItem.liveClaimOwners.length))
  expect(stackBox.inset).toBe(stackBox.width + 8)
  await stackRow.hover()
  const stackMarks = await stackRow.locator('[class*="rowActor"] [role="img"]').evaluate(cluster => ({
    overlaps: Array.from(cluster.children, child => getComputedStyle(child).marginLeft),
    shadows: Array.from(cluster.children, child => getComputedStyle(child).boxShadow),
  }))
  expect(stackMarks.overlaps.slice(1)).toEqual(stackMarks.overlaps.slice(1).map(() => '-4px'))
  expect(stackMarks.shadows).toEqual(stackMarks.shadows.map(() => 'none'))
  await page.mouse.move(0, 0)
  await expect.poll(async () => await stackRow.locator('[data-team-task-state]').getAttribute('data-team-task-state')).toBe(stackItem.task!.status)
  expect(await stackRow.locator('[data-team-task-state]').textContent()).toBe('进行中')
  expect(await inboxRow.locator('[data-team-task-state]').count()).toBe(0)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-row-owners-desktop.png'), fullPage: true })

  // Offline / Online recovery
  await page.getByRole('button', { name: '新建项目' }).click()
  const probeDialog = page.getByRole('dialog', { name: '新建项目' })
  await probeDialog.getByLabel('名称').fill('recovery')
  await probeDialog.getByLabel('说明').fill('disconnect probe')
  await probeDialog.getByRole('button', { name: '创建项目' }).click()
  const recoveryRow = page.getByRole('button', { name: '# recovery' })
  await recoveryRow.waitFor()
  const railLabel = await recoveryRow.locator('strong').evaluate(element => ({ x: element.getBoundingClientRect().x, color: getComputedStyle(element).color }))
  const offlineWarningStart = consoleWatch.warnings.length
  await page.context().setOffline(true)
  await recoveryRow.click()
  const projectSurface = page.locator('[data-team-project]')
  const bodyError = projectSurface.locator('[role="alert"]').first()
  await bodyError.waitFor({ timeout: 30_000 })
  const bodyBox = await bodyError.evaluate(element => {
    const box = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    return { centerX: box.x + box.width / 2, centerY: box.y + box.height / 2, parentCenterX: parent.x + parent.width / 2, parentCenterY: parent.y + parent.height / 2 }
  })
  expect(Math.abs(bodyBox.centerY - bodyBox.parentCenterY)).toBeLessThanOrEqual(2)
  expect(Math.abs(bodyBox.centerX - bodyBox.parentCenterX)).toBeLessThanOrEqual(2)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'project-error-offline.png'), fullPage: true })

  await page.getByRole('button', { name: '对话' }).click()
  await page.getByRole('button', { name: '团队', exact: true }).click()
  const railAlert = page.locator('section[aria-label="工作区"] [role="alert"]')
  await railAlert.first().waitFor({ timeout: 30_000 })
  const railBox = await railAlert.first().evaluate(element => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { x: box.x, inset: box.x + parseFloat(style.paddingLeft), fontSize: style.fontSize, marginTop: style.marginTop, marginBottom: style.marginBottom, color: style.color }
  })
  expect(railBox.x).toBeLessThan(300)
  expect(railBox.fontSize).toBe('11px')
  expect(railBox.marginTop).toBe('0px')
  expect(railBox.marginBottom).toBe('0px')
  expect(Math.abs(railBox.inset - railLabel.x)).toBeLessThanOrEqual(1)
  expect(railBox.color).not.toBe(railLabel.color)
  expect(await page.getByText('还没有项目').count()).toBe(0)
  expect(await page.getByText('还没有 Agent').count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'sidebar-error-offline.png'), fullPage: true })

  await page.context().setOffline(false)
  await page.getByRole('heading', { name: '# recovery' }).waitFor({ timeout: 30_000 })
  await expect.poll(() => projectSurface.locator('[role="alert"]').count()).toBe(0)
  await recoveryRow.waitFor({ timeout: 45_000 })
  await expect.poll(async () => await railAlert.count(), { timeout: 20_000 }).toBe(0)
  await page.getByText(/^重新连接中/).waitFor({ state: 'hidden', timeout: 20_000 })
  acknowledgeReloadConnectionLoss(consoleWatch, offlineWarningStart)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'sidebar-recovered-online.png'), fullPage: true })

  // Consecutive entries in the Main stream
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  for (const body of ['连续消息之一', '连续消息之二', '连续消息之三']) {
    await projectComposer.fill(body)
    await page.getByRole('button', { name: '发送' }).click()
    await page.locator('[data-team-project] article').filter({ hasText: body }).waitFor()
  }
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'consecutive-entries.png'), fullPage: true })
  const consecutive = await page.evaluate(() => [...document.querySelectorAll('[data-team-project] article')]
    .filter(article => /连续消息之[一二三]/.test(article.textContent ?? ''))
    .map(article => {
      const identity = article.querySelector('[data-avatar], [data-gutter-time]')
      const body = article.querySelector('[class*="messageBody"]')
      const left = (element: Element | null | undefined): number => element === null || element === undefined ? -1 : Math.round(element.getBoundingClientRect().left)
      return {
        grouped: article.getAttribute('data-grouped') === 'true',
        series: /连续消息之([一二三])/.exec(article.textContent ?? '')?.[1] ?? '',
        seatLeft: left(identity),
        bodyLeft: left(body),
      }
    }))
  const seriesOrder = ['一', '二', '三']
  consecutive.sort((first, second) => seriesOrder.indexOf(first.series) - seriesOrder.indexOf(second.series))
  expect(consecutive.map(row => row.series)).toEqual(seriesOrder)
  expect(consecutive.some(row => row.grouped)).toBe(true)
  for (const row of consecutive) {
    expect(row.seatLeft).toBeGreaterThanOrEqual(0)
  }
  expect(new Set(consecutive.map(row => row.seatLeft)).size).toBe(1)

  // Inbox under Agent overlay and keyboard navigation
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.locator('button[class*="inboxCard"]').focus()
  await page.keyboard.press('Space')
  await page.locator('[data-team-inbox]').waitFor()
  const inboxEntry = page.locator('button[class*="inboxCard"]')
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBe('page')

  const liveAgentCard = page.locator('button[class*="agentSelect"]:not([disabled])').first()
  const liveAgentName = await liveAgentCard.getAttribute('aria-label')
  await liveAgentCard.click()
  await page.locator('[data-team-inbox]').waitFor({ state: 'detached' })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
  await expect.poll(async () => await teamCurrentPage.count()).toBe(1)
  await expect.poll(async () => await teamCurrentPage.getAttribute('aria-label')).toBe(liveAgentName)
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBeNull()
  await settleLayout(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-under-agent-overlay.png'), fullPage: true })
  await inboxEntry.click()
  await page.locator('[data-team-inbox]').waitFor()
  await expect.poll(async () => await teamCurrentPage.count()).toBe(1)
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBe('page')
  await expect.poll(async () => await globalPanelsNav.locator('[aria-current="page"]').count()).toBe(1)
  await expect.poll(async () => await page.locator('[data-composer-input]').count()).toBe(0)

  const projectKeyboard = page.getByRole('button', { name: '# delivery' })
  await projectKeyboard.focus()
  await projectKeyboard.press('Space')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const taskKeyboard = page.getByRole('button', { name: /^打开 Task #1/ })
  await taskKeyboard.focus()
  await taskKeyboard.press('Space')
  await page.getByRole('heading', { name: 'Task #1' }).waitFor()
  const backKeyboard = page.getByRole('button', { name: '返回项目' })
  await backKeyboard.focus()
  await backKeyboard.press('Space')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const leaveTeamKeyboard = page.getByRole('button', { name: '对话' })
  await leaveTeamKeyboard.focus()
  await leaveTeamKeyboard.press('Space')
  await page.locator('[data-composer-input]').first().waitFor({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(0)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)

it('distinguishes an expired attachment from a broken image and rereads it by keyboard', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const requestId = () => crypto.randomUUID() as AgentTeamRequestId
  const { project } = await team.createProject({ workspaceId, requestId: requestId(), name: 'attachment-recovery', description: '' })
  const put = (name: string, bytesBase64: string) => team.putAttachment({
    workspaceId, requestId: requestId(), name, bytesBase64, mediaType: 'image/png',
  })
  const broken = await put('broken.png', Buffer.from('not a PNG').toString('base64'))
  const expired = await put('expired.png', ONE_PIXEL_PNG)
  const longName = 'screenshot-2026-11-11-at-17.26.45-dashboard-overview.png'
  const longBroken = await put(longName, Buffer.from('not a PNG').toString('base64'))
  const sent = await team.postMainMessage({
    workspaceId, projectRef: project.projectRef, requestId: requestId(), body: '附件恢复验收',
    attachments: [broken.attachmentId, expired.attachmentId, longBroken.attachmentId],
  })
  expect(sent.kind).toBe('committed')
  const cache = join(scenarioHome(), 'agent-team', 'attachments', 'v1')
  await rm(join(cache, expired.attachmentId), { recursive: true })

  await page.getByRole('button', { name: '# attachment-recovery', exact: true }).click()
  await page.getByRole('tab', { name: '主对话' }).click()
  const row = page.locator('[data-team-project] article').filter({ hasText: '附件恢复验收' })
  const chipOf = (name: string) => row.locator('[aria-live="polite"]').filter({ hasText: name })
  await row.getByText('broken.png', { exact: true }).waitFor()
  await chipOf('broken.png').getByText('图片暂不可用', { exact: true }).waitFor()
  await row.getByText('expired.png', { exact: true }).waitFor()
  await chipOf('expired.png').getByText('文件已过期清理', { exact: true }).waitFor()
  await row.getByText(longName, { exact: true }).waitFor()
  await chipOf(longName).getByText('图片暂不可用', { exact: true }).waitFor()
  expect(await row.getByRole('button', { name: '查看大图 broken.png' }).count()).toBe(0)
  const retry = chipOf('broken.png').getByRole('button', { name: '重试读取', exact: true })
  const shots = join(BROWSER_ARTIFACTS, 'attachment-recovery')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'unavailable-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await retry.scrollIntoViewIfNeeded()
  const longRetry = chipOf(longName).getByRole('button', { name: '重试读取', exact: true })
  await longRetry.scrollIntoViewIfNeeded()
  expect(await longRetry.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(30)
  const timeline = page.locator('[data-team-project] section[aria-label="消息时间线"]')
  expect(await timeline.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
  await page.screenshot({ path: join(shots, 'unavailable-narrow.png'), fullPage: true })

  await writeFile(join(cache, broken.attachmentId, 'broken.png'), Buffer.from(ONE_PIXEL_PNG, 'base64'))
  await retry.press('Enter')
  const zoom = row.getByRole('button', { name: '查看大图 broken.png' })
  await expect.poll(() => zoom.isEnabled()).toBe(true)
  await expect.poll(() => zoom.evaluate(element => document.activeElement === element)).toBe(true)
  await zoom.press('Enter')
  await page.getByRole('dialog').getByRole('img').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  expect(consoleWatch.pageErrors).toEqual([])
}, 60_000)
