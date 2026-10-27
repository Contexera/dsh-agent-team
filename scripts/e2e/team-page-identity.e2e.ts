import { afterEach, it, expect } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { CHROME, HOME, ONE_PIXEL_PNG, STAGED_BUNDLE, UI09_SHOTS, closeScenario, connectFreshWorkspaceZh, focusRing, installLocalBundle, launchWebScaffold, openSettings, openTeamPage, scaffold, settleLayout, watchConsole } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })


it('configures the Team page identity from Settings in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const nameField = panel.getByLabel('名字')
  await nameField.waitFor()
  const nameSave = panel.locator('form button[type="submit"]')
  // With no stored override the page shows the default name plus the bundle
  // version and repo link.
  expect(await nameField.inputValue()).toBe('human')
  // The page names its owner first: among the Harness's settings pages a bare
  // 「团队」 is ambiguous.
  expect(await panel.textContent()).toContain('你在 Team 里的身份')
  expect(await panel.textContent()).toMatch(/版本 \d+\.\d+\.\d+/)
  expect(await panel.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('https://github.com/Contexera/dsh-agent-team')
  expect(await panel.getByRole('button', { name: '移除头像' }).count()).toBe(0)

  // Keyboard-only rename: typing dirties the field, Tab reaches the owning Save
  // button, Enter submits.
  await nameField.fill('Ada')
  await nameField.press('Tab')
  const saveRing = await focusRing(page, '[role="dialog"] form button[type="submit"]')
  expect(saveRing?.focusVisible).toBe(true)
  expect(saveRing?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(() => scaffold!.ctx.agentTeam.humanHandle()).toBe('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  // Avatar bytes go to the persistent store, the reference into settings, and the
  // page draws what the browser can decode.
  const avatarPath = join(HOME, 'ada-avatar.png')
  await writeFile(avatarPath, Buffer.from(ONE_PIXEL_PNG, 'base64'))
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  const preview = panel.locator('img').first()
  await preview.waitFor()
  await expect.poll(async () => await preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
  expect(await preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page.png'), fullPage: true })

  // The Host row's compaction threshold: the page's one settings-document
  // field. A save stages a child path of `memberCompaction`, so the sibling
  // `enabled` switch the page never shows has to survive it — the Host's own
  // descriptor is what proves the write, not the field it just rendered.
  const context = panel.getByRole('region', { name: '上下文' })
  const threshold = context.getByLabel('默认压缩阈值')
  await threshold.waitFor()
  expect(await threshold.inputValue()).toBe('256K')
  // Keyboard, no pointer: the staged edit makes the field dirty, Tab hands
  // focus from the input to the form's own save (the staged edit also puts the
  // reset control earlier in the document, so this proves the tab order skips
  // nothing it should not), and Enter writes it.
  await threshold.fill('512K')
  await threshold.press('Tab')
  const thresholdSave = context.getByRole('button', { name: '保存', exact: true })
  const thresholdRing = await thresholdSave.evaluate((target) => {
    const style = getComputedStyle(target)
    return {
      focusVisible: target.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(thresholdRing.focusVisible).toBe(true)
  expect(thresholdRing.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(() => {
    const value = scaffold!.ctx.settings.describe().find(row => row.ns === 'wowyuarm-agent-team-host')?.value as
      | { memberCompaction?: { enabled?: boolean; tokens?: number } }
      | undefined
    return value?.memberCompaction
  }).toEqual({ enabled: true, tokens: 512_000 })
  await expect.poll(async () => await context.getByText('已覆盖').count()).toBe(1)

  // An unreadable draft never becomes a value: the field keeps the text, the
  // group says what it accepts, and the save stays out of reach.
  await threshold.fill('2GB')
  await context.getByText('请填一个大于 0 的整数，例如 256K 或 1M。').waitFor()
  await expect.poll(async () => await context.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  expect(await threshold.inputValue()).toBe('2GB')
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-compaction-invalid.png'), fullPage: true })
  await threshold.fill('512K')
  await expect.poll(async () => await context.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-compaction.png'), fullPage: true })

  // A refused name is refused before the round trip: the field keeps the typed
  // text and the notice states the rule.
  await nameField.fill('   ')
  await panel.getByText('名字不能为空。').waitFor()
  expect(await nameSave.isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-empty-name.png'), fullPage: true })
  await nameField.fill('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  // The shipped panel keeps its 188px nav rail at every viewport; this checks
  // whether our column survives the squeeze.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390)
  // The configuration group is a shipped field inside the same squeezed
  // column: its own box must fit the column rather than painting past it, and
  // the group adds no width the panel did not already have.
  const narrowContext = await panel.getByRole('region', { name: '上下文' }).evaluate((element) => {
    const label = element.querySelector('label') as HTMLElement
    const input = element.querySelector('input') as HTMLElement
    return {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      // A label with no room collapses to a zero-width box and paints one
      // character per line; that is readable neither by a scrollWidth probe
      // (the text wraps instead of overflowing) nor by the eye at 390px.
      labelWidth: Math.round(label.getBoundingClientRect().width),
      labelHeight: Math.round(label.getBoundingClientRect().height),
      labelLineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
      inputWidth: Math.round(input.getBoundingClientRect().width),
    }
  })
  expect(narrowContext.scrollWidth).toBeLessThanOrEqual(narrowContext.clientWidth)
  expect(narrowContext.labelWidth).toBeGreaterThan(0)
  // Four characters at 13px must sit on one line: a 1.5-line budget catches a
  // wrapped label without pinning the shipped line-height's exact value.
  expect(narrowContext.labelHeight).toBeLessThanOrEqual(narrowContext.labelLineHeight * 1.5)
  expect(narrowContext.inputWidth).toBeGreaterThan(0)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // Undecodable bytes fall back to the initial like a removed avatar. The Host
  // checks only the declared media type, so a HEIC phone photo lands here, and
  // the page copy promises the initial.
  await panel.locator('input[type="file"]').setInputFiles([{ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG') }])
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await expect.poll(async () => await panel.locator('[data-avatar="initial"]').textContent()).toBe('A')
  expect(await panel.locator('img').count()).toBe(0)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-undecodable-avatar.png'), fullPage: true })

  await panel.getByRole('button', { name: '移除头像' }).click()
  await expect.poll(async () => await panel.locator('img').count()).toBe(0)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBeUndefined()
  await expect.poll(async () => await panel.getByRole('button', { name: '上传头像' }).count()).toBe(1)
  // Restore readable bytes: the Inbox leg below draws the compact stack from the
  // same profile and needs a picture.
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  await expect.poll(async () => await panel.locator('img').count()).toBe(1)
  await panel.getByRole('button', { name: '关闭' }).click()

  // The rename is not page-local: the Team timeline names the Human by it.
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('profile-check')
  await projectDialog.getByLabel('说明').fill('renamed human')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# profile-check', exact: true }).click()
  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill('PROFILE-NAME-MARKER hello from the renamed human')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const row = page.locator('[data-team-project] article').filter({ hasText: 'PROFILE-NAME-MARKER' })
  await row.waitFor()
  // A recent Inbox row admits Threads the reader wrote in; the Main stream post
  // above belongs to no Thread, so the Human's own discussion provides the row.
  const profileWorkspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const profileProject = scaffold!.ctx.agentTeam.view({ workspaceId: profileWorkspaceId }).projects.find((entry: { name: string }) => entry.name === 'profile-check')!
  await scaffold!.ctx.agentTeam.startThread({ requestId: 'e2e-profile-thread' as never, workspaceId: profileWorkspaceId,
    projectRef: profileProject.projectRef, kind: 'discussion', body: 'PROFILE-NAME-MARKER hello from the renamed human' })
  await expect.poll(async () => await row.textContent()).toContain('Ada')
  expect(await row.textContent()).not.toContain('Human')
  // The picture lands on the Human's own message row; the Agent row keeping its
  // initial is pinned by the component suite.
  const humanPicture = row.locator('[data-avatar="image"]')
  await expect.poll(async () => await humanPicture.count()).toBe(1)
  expect(await humanPicture.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await page.screenshot({ path: join(UI09_SHOTS, 'renamed-human-in-timeline.png'), fullPage: true })

  // The Inbox row naming the Human leads with the profile picture in the same
  // 18px circle an Agent's initial fills, and reads the display name rather than
  // the `member:human` id.
  await page.locator('button[class*="inboxCard"]').click()
  const identityRow = page.locator('[data-team-inbox] button').filter({ hasText: 'PROFILE-NAME-MARKER' })
  await expect.poll(async () => await identityRow.count(), { timeout: 30_000 }).toBe(1)
  const identityStack = identityRow.locator('[class*="rowActor"] [role="img"]')
  const identityPicture = identityStack.locator('img')
  await expect.poll(async () => await identityPicture.count()).toBe(1)
  expect(await identityPicture.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(await identityStack.getAttribute('aria-label')).toContain('@Ada')
  const identityGeometry = await identityStack.evaluate(cluster => {
    const rect = cluster.getBoundingClientRect()
    return { width: Math.round(rect.width), height: Math.round(rect.height), radius: getComputedStyle(cluster.firstElementChild!).borderTopLeftRadius }
  })
  expect(identityGeometry).toEqual({ width: 18, height: 18, radius: '50%' })
  await page.screenshot({ path: join(UI09_SHOTS, 'human-identity-in-inbox-stack.png'), fullPage: true })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
