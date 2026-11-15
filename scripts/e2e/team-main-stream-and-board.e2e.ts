import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  MAIN_STREAM_SHOTS,
  UI02_SHOTS,
  UI04_SHOTS,
  chooseMemberModel,
  closeScenario,
  focusRing,
  maxHorizontalScroll,
  openSidebar,
  openTeamPage,
  scaffold,
  settleAnimations,
  settleLayout,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('posts, starts a discussion and a Task, and opens cards in the Main stream under rules version 2 in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage()

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

  const toggle = page.getByRole('button', { name: '讨论/任务' })
  await toggle.click()
  expect(await toggle.getAttribute('aria-pressed')).toBe('true')
  await composer.fill('**登录页改版** 先统一配色')
  await send.click()
  const discussionCard = page.getByRole('button', { name: /^打开讨论：登录页改版 先统一配色/ })
  await discussionCard.waitFor()
  expect(await discussionCard.textContent()).toContain('登录页改版 先统一配色')
  expect(await discussionCard.textContent()).not.toContain('**')
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  expect(await page.getByRole('checkbox', { name: '作为任务' }).count()).toBe(0)

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
  expect(await taskCard.locator('[data-team-owner]').textContent()).toBe('H你负责')
  expect(await taskCard.getAttribute('aria-label')).toContain('你负责')
  expect(await taskCard.locator('[data-team-owner] > *').first().evaluate(node => getComputedStyle(node).boxShadow)).toBe('none')
  expect(await discussionCard.getAttribute('data-main-card')).toBe('discussion')
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

  await page.keyboard.press('Tab')
  await discussionCard.focus()
  const ring = await focusRing(page, '[data-main-card="discussion"]')
  expect(ring?.focusVisible).toBe(true)
  expect(ring?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '关闭讨论' }).waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'panel-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭讨论' }).click()

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('steward')
  await createAgent.getByLabel('说明').fill('负责交付')
  await chooseMemberModel(page, createAgent)
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

  const activeScaffold = scaffold!
  const mainWorkspace = activeScaffold.ctx.workspaceRegistry.list()[0]!
  const streamProject = activeScaffold.ctx.agentTeam.view({ workspaceId: mainWorkspace.id }).projects
    .find((project: { name: string }) => project.name === 'stream-web')!
  const stewardMember = activeScaffold.ctx.agentTeam.members({ workspaceId: mainWorkspace.id })
    .find((status: { member: { handle: string } }) => status.member.handle === 'steward')!
  const stewardAgent = activeScaffold.ctx.agents.get(stewardMember.member.sessionId)!
  await activeScaffold.ctx.agentTeam.readMainStreamForAgent(stewardAgent, {
    requestId: 'm2-11-steward-read' as never, workspaceId: mainWorkspace.id, projectRef: streamProject.projectRef,
  })
  await page.getByRole('button', { name: '收件箱' }).click()
  await page.locator('[data-team-inbox]').waitFor()
  const mainUnreadBefore = activeScaffold.ctx.agentTeam.inbox({ workspaceId: mainWorkspace.id }).totalUnreadCount
  const arrivalPost = await activeScaffold.ctx.agentTeam.postMainMessageForAgent(stewardAgent, {
    requestId: 'm2-11-main-arrival' as never, workspaceId: mainWorkspace.id,
    projectRef: streamProject.projectRef, body: '网关灰度已经就绪，等你确认',
  })
  expect(arrivalPost.kind).toBe('committed')
  expect(activeScaffold.ctx.agentTeam.inbox({ workspaceId: mainWorkspace.id }).totalUnreadCount).toBe(mainUnreadBefore + 1)
  const streamInboxCard = page.locator('button[class*="inboxCard"]')
  await expect.poll(async () => await streamInboxCard.getAttribute('aria-label'), { timeout: 20_000 }).toBe(`收件箱，${mainUnreadBefore + 1} 条未读`)
  await expect.poll(async () => await streamInboxCard.locator('[data-team-inbox-dot]').count()).toBe(1)
  const streamMainRow = page.locator('[data-team-inbox] button').filter({ hasText: '#stream-web · 主对话' })
  await streamMainRow.waitFor()
  await streamMainRow.click()
  await page.getByText('网关灰度已经就绪，等你确认', { exact: true }).waitFor()
  await expect.poll(async () => await streamInboxCard.getAttribute('aria-label'), { timeout: 20_000 }).toBe('收件箱')
  await expect.poll(async () => await streamInboxCard.locator('[data-team-inbox-dot]').count()).toBe(0)
  expect(activeScaffold.ctx.agentTeam.inbox({ workspaceId: mainWorkspace.id }).totalUnreadCount).toBe(mainUnreadBefore)

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
  expect(await mainQuoteLine.evaluate(element => element.tagName)).toBe('BUTTON')
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
  await expect.poll(async () => quotedRow.evaluate(element => {
    const fill = getComputedStyle(element).backgroundColor
    return fill === 'rgba(0, 0, 0, 0)' ? 'none' : fill
  })).not.toBe('none')

  await composer.fill('@')
  expect(await page.getByRole('option', { name: /通知所有成员/ }).count()).toBe(0)
  await composer.fill('')

  const picker = page.getByRole('listbox', { name: '提及成员建议' })
  await composer.pressSequentially('把这个给@')
  await picker.waitFor()
  expect(await picker.getByRole('option').count()).toBeGreaterThan(0)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'mention-picker-desktop.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => picker.count()).toBe(0)
  await composer.fill('')
  await composer.pressSequentially('mail@')
  await expect.poll(() => picker.count()).toBe(0)
  await composer.fill('')

  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await taskCard.waitFor()
  await toggle.click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await composer.pressSequentially('把这个给@')
  await picker.waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'mention-picker-mobile.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => picker.count()).toBe(0)
  await composer.fill('在手机宽度下写一条比较长的任务描述，检查控制行换行与卡片不溢出')
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-mobile.png'), fullPage: true })
  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('[data-main-card], [data-team-composer]')]
    .filter(element => element.getBoundingClientRect().right > window.innerWidth + 0.5).length)
  expect(overflowing).toBe(0)

  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  const boardRow = page.getByRole('button', { name: '任务看板' })
  await boardRow.click()
  const boardPage = page.locator('[data-team-task-board]')
  await boardPage.waitFor()
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
  const stackSteps = await page.evaluate(() => {
    const tops = ['button[aria-label="收件箱"]', 'button[aria-label="任务看板"]', 'button[aria-label="团队管理"]', '[data-team-workspace-trigger]']
      .map(selector => document.querySelector(selector)?.getBoundingClientRect().top)
    return [tops[1]! - tops[0]!, tops[2]! - tops[1]!, tops[3]! - tops[2]!]
  })
  expect(stackSteps[0]).toBeGreaterThan(0)
  expect(stackSteps).toEqual([stackSteps[0], stackSteps[0], stackSteps[0]])
  await globalCard.click()
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await expect.poll(async () => await boardRow.getAttribute('aria-current')).toBe(null)
  await boardRow.click()
  await boardPage.waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'task-board-page-narrow.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

  const pointerRules = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules] } catch { return [] }
    })
    return {
      hoverMedia: rules.filter(rule => rule instanceof CSSMediaRule && /hover:\s*hover/.test(rule.conditionText)).length,
      bareHover: rules.filter(rule => rule instanceof CSSStyleRule && /:hover/.test(rule.selectorText)).length,
    }
  })
  expect(pointerRules.hoverMedia).toBeGreaterThan(0)
  expect(pointerRules.bareHover).toBe(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

it('edits Project owners from the Project dialog under rules version 2 in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const activeScaffold = scaffold!

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('owners-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# owners-web', exact: true }).waitFor()

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('steward')
  await createAgent.getByLabel('说明').fill('负责交付')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('steward', { exact: true }).waitFor({ timeout: 20_000 })

  const openEditor = async () => {
    await page.getByRole('button', { name: '# owners-web', exact: true }).hover()
    await page.getByRole('button', { name: 'owners-web 的操作' }).click()
    await page.getByRole('menuitem', { name: '编辑项目' }).click()
    const editor = page.getByRole('dialog', { name: '编辑项目' })
    await editor.waitFor()
    return editor
  }
  const editor = await openEditor()
  const owners = editor.getByRole('group', { name: '负责人' })
  await owners.waitFor()
  await owners.getByText('始终是负责人').waitFor()
  expect(await owners.getByRole('button', { name: /^移除负责人/ }).count()).toBe(0)

  await owners.getByLabel('新负责人的责任（可留空）').fill('负责交付与验收')
  await owners.getByRole('button', { name: '添加负责人 @steward' }).click()
  const remove = owners.getByRole('button', { name: '移除负责人 @steward' })
  await remove.waitFor()
  await owners.getByText('负责交付与验收').waitFor()
  expect(await owners.getByRole('button', { name: '添加负责人 @steward' }).count()).toBe(0)
  const workspaceId = activeScaffold.ctx.workspaceRegistry.list()[0]!.id
  expect(activeScaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(1)
  expect(activeScaffold.ctx.agentTeam.view({ workspaceId }).owners[0]!.responsibility).toBe('负责交付与验收')

  await owners.getByRole('button', { name: '编辑 @steward 的责任' }).click()
  const field = owners.getByLabel('@steward 的责任')
  await expect.poll(() => field.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
  const nameField = editor.getByLabel('名称')
  await field.evaluate(element => { (element as HTMLElement).blur() })
  const fieldSurface = await field.evaluate(element => {
    const style = getComputedStyle(element)
    return { size: style.fontSize, leading: style.lineHeight, radius: style.borderRadius, stroke: style.borderColor, fill: style.backgroundColor }
  })
  const inputSurface = await nameField.evaluate(element => {
    const style = getComputedStyle(element)
    const frame = getComputedStyle(element.parentElement as HTMLElement)
    return { size: style.fontSize, leading: style.lineHeight, radius: frame.borderRadius, stroke: frame.borderColor, fill: frame.backgroundColor }
  })
  expect(fieldSurface).toEqual(inputSurface)
  await nameField.focus()
  const inputFocusStroke = await nameField.evaluate(element => getComputedStyle(element.parentElement as HTMLElement).borderColor)
  await field.focus()
  const fieldFocus = await field.evaluate(element => {
    const style = getComputedStyle(element)
    return { stroke: style.borderColor, outline: style.outlineStyle }
  })
  expect(fieldFocus.stroke).toBe(inputFocusStroke)
  expect(fieldFocus.outline).toBe('none')
  await field.fill('负责交付、验收与发布')
  const [cancelBox, saveBox, fieldBox] = await Promise.all([
    owners.getByRole('button', { name: '取消' }).boundingBox(),
    owners.getByRole('button', { name: '保存' }).boundingBox(),
    field.boundingBox(),
  ])
  expect(saveBox!.x).toBeCloseTo(cancelBox!.x + cancelBox!.width + 8, 0)
  expect(saveBox!.x + saveBox!.width).toBeCloseTo(fieldBox!.x + fieldBox!.width, 0)
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-responsibility-edit.png'), fullPage: true })
  await owners.getByRole('button', { name: '保存' }).click()
  await owners.getByText('负责交付、验收与发布').waitFor()
  expect(activeScaffold.ctx.agentTeam.view({ workspaceId }).owners[0]!.responsibility).toBe('负责交付、验收与发布')
  await expect.poll(() => owners.getByRole('button', { name: '编辑 @steward 的责任' })
    .evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-desktop.png'), fullPage: true })
  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await openSidebar(page)
  const narrowEditor = await openEditor()
  const narrowOwners = narrowEditor.getByRole('group', { name: '负责人' })
  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).waitFor()
  await narrowOwners.getByText('负责交付、验收与发布').waitFor()
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-mobile.png'), fullPage: true })

  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).click()
  await narrowOwners.getByRole('button', { name: '添加负责人 @steward' }).waitFor()
  expect(activeScaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

it('lands a started Task on its board card, keyboard and mouse', async () => {
  const { page, consoleWatch } = await openTeamPage()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('delivery')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# delivery', exact: true }).click()

  const active = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    return {
      role: element?.getAttribute('role') ?? null,
      label: element?.getAttribute('aria-label') ?? null,
      taskRef: element?.getAttribute('data-team-task-ref') ?? null,
      focusVisible: element?.matches(':focus-visible') ?? false,
    }
  })

  const startTask = async (body: string, send: 'enter' | 'click'): Promise<void> => {
    const composer = page.getByRole('textbox', { name: '消息内容' })
    await composer.waitFor()
    const toggle = page.getByRole('button', { name: '讨论/任务' })
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => toggle.getAttribute('aria-pressed')).toBe('true')
    await page.getByRole('checkbox', { name: '作为任务' }).check()
    await composer.fill(body)
    if (send === 'enter') await composer.press('Enter')
    else await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  }

  await startTask('键盘发送的任务', 'enter')
  await expect.poll(async () => (await active()).label).toBe('打开 Task #1')
  const keyboard = await active()
  expect(keyboard.role).not.toBe('tab')
  expect(keyboard.taskRef).toMatch(/^task:/)
  expect(keyboard.focusVisible).toBe(true)
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'task-focus-card-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'task-focus-card-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  await page.getByRole('tab', { name: '主对话' }).click()
  await startTask('鼠标发送的任务', 'click')
  await expect.poll(async () => (await active()).label).toBe('打开 Task #2')
  const mouse = await active()
  expect(mouse.role).not.toBe('tab')
  expect(mouse.taskRef).toMatch(/^task:/)
  expect(mouse.focusVisible).toBe(false)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

it('opens a taskless thread from its ref chip in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const activeScaffold = scaffold!
  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('ref-repro')
  await projectDialog.getByLabel('说明').fill('thread ref chips')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# ref-repro', exact: true }).click()
  await page.getByRole('heading', { name: '# ref-repro', exact: true }).waitFor()
  const projectComposer = page.getByRole('textbox', { name: '消息内容' })
  const workspaceId = activeScaffold.ctx.workspaceRegistry.list()[0]!.id
  const refProject = activeScaffold.ctx.agentTeam.view({ workspaceId }).projects.find((entry: { name: string }) => entry.name === 'ref-repro')!
  const started = await activeScaffold.ctx.agentTeam.startThread({
    requestId: 'e2e-thread-ref' as never, workspaceId,
    projectRef: refProject.projectRef, kind: 'discussion', body: '**ALPHA-ROOT-MARKER** alpha discussion opens here',
  })
  const alphaRef = (started as { thread: { threadRef: string } }).thread.threadRef
  const alphaShort = `thread:${(alphaRef.slice('thread:'.length) as string).replaceAll('-', '').slice(0, 8).toLowerCase()}`
  await projectComposer.fill(`BETA-ROOT-MARKER citing ${alphaShort} for the chip`)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const betaArticle = page.locator('[data-team-project] article').filter({ hasText: 'BETA-ROOT-MARKER' })
  await betaArticle.waitFor()
  const chip = betaArticle.locator(`button[title="${alphaShort}"]`)
  await chip.waitFor()
  await expect.poll(() => chip.textContent()).toMatch(/ALPHA-ROOT-MARKER alpha discussion open…/)
  expect(await chip.textContent()).not.toContain('**')
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip.png'), fullPage: true })
  await chip.click()
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { discussionRef?: string }).discussionRef), { timeout: 10_000 }).toBe(alphaRef)
  await page.locator(`[data-team-panel="${alphaRef}"]`).waitFor({ timeout: 20_000 })
  await page.locator(`main[data-team-thread="${alphaRef}"]`).waitFor({ state: 'detached', timeout: 5_000 })
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { discussionRef?: string; threadRef?: string }).discussionRef)).toBe(alphaRef)
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { threadRef?: string }).threadRef)).toBeUndefined()
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened-narrow.png'), fullPage: true })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
