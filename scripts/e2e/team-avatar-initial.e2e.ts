import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import { BROWSER_ARTIFACTS, closeScenario, openSidebar, openTeamPage, settleLayout } from './__external-agent-team-support.ts'

/** The avatar lane's own shots: the initial is a glyph-sized fact, so it gets its own directory. */
const AVATAR_SHOTS = join(BROWSER_ARTIFACTS, 'avatar-initial')

afterEach(async () => { await closeScenario() })

it('keeps an astral initial whole in the sidebar avatar', async () => {
  // Two device pixels per CSS pixel: the initial is about 12 CSS px tall, and the
  // difference between a whole astral character and half of one is one glyph wide.
  const { page, consoleWatch } = await openTeamPage({ deviceScaleFactor: 2 })
  // A handle opening with an astral character is what puts the cut point inside one.
  // This one is a Deseret letter: it survives the Host's NFKC handle normalisation,
  // uppercases to U+10400, and the installed Droid Sans Fallback paints it — this
  // container has no emoji font, so a balloon would be tofu on both sides of the fix
  // and the screenshot would show nothing either way.
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const dialog = page.getByRole('dialog', { name: '添加 Agent' })
  await dialog.getByLabel('名称').fill('𐐨builder')
  await dialog.getByLabel('说明').fill('astral handle')
  await dialog.getByRole('button', { name: '创建 Agent' }).click()
  const row = page.locator('[class*="agentRow"]').filter({ hasText: 'builder' }).first()
  await row.waitFor({ timeout: 20_000 })
  const avatar = row.locator('[class*="agentAvatar"]').first()
  await avatar.waitFor()
  // One code point: the capital the lowercase astral letter uppercases to —
  // U+10400, not the lone surrogate 0xD801 a UTF-16 cut leaves.
  await expect.poll(async () => (await avatar.textContent() ?? '').codePointAt(0)).toBe(0x10400)
  await settleLayout(page)
  const desktopBox = await row.boundingBox()
  expect(desktopBox).not.toBeNull()
  await page.screenshot({ path: join(AVATAR_SHOTS, 'avatar-astral-desktop.png'),
    clip: { x: 0, y: Math.max(0, desktopBox!.y - 16), width: 300, height: desktopBox!.height + 32 } })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await openSidebar(page)
  await settleLayout(page)
  const narrowRow = page.locator('[class*="agentRow"]').filter({ hasText: 'builder' }).first()
  await narrowRow.waitFor()
  const narrowAvatar = narrowRow.locator('[class*="agentAvatar"]').first()
  await expect.poll(async () => (await narrowAvatar.textContent() ?? '').codePointAt(0)).toBe(0x10400)
  const narrowBox = await narrowRow.boundingBox()
  expect(narrowBox).not.toBeNull()
  await page.screenshot({ path: join(AVATAR_SHOTS, 'avatar-astral-narrow.png'),
    clip: { x: 0, y: Math.max(0, narrowBox!.y - 16), width: 300, height: narrowBox!.height + 32 } })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
