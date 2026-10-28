import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import { SETTINGS_SHOTS, closeScenario, openSettings, openTeamPage, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('paints the Team mark on the Team settings nav row', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })
  await openSettings(page)
  const panel = page.getByRole('dialog')
  const teamRow = panel.getByRole('button', { name: '团队', exact: true })
  await teamRow.waitFor()

  // The shell falls back to the generic gear for an unknown section id (`navIcon(id)`),
  // and `settings.section` carries no icon. The workaround tags our row so CSS can swap
  // the glyph. Discriminative: without it the flag never appears, so this poll fails and
  // the row keeps the host gear.
  await expect.poll(async () => await teamRow.getAttribute('data-agent-team-settings-icon')).not.toBeNull()

  const probe = await teamRow.evaluate(el => {
    const svg = el.querySelector(':scope > svg')
    const before = getComputedStyle(el, '::before')
    return {
      hostGlyphDisplay: svg === null ? 'missing' : getComputedStyle(svg).display,
      markContent: before.content,
      markWidth: before.width,
      markMask: before.maskImage !== '' ? before.maskImage : before.getPropertyValue('-webkit-mask-image'),
    }
  })
  // The host glyph is still in the row but hidden; the mark is a 16px mask in the row's own ink.
  expect(probe.hostGlyphDisplay).toBe('none')
  expect(probe.markContent).not.toBe('none')
  expect(probe.markWidth).toBe('16px')
  expect(probe.markMask).toContain('data:image/svg')

  await page.screenshot({ path: join(SETTINGS_SHOTS, 'settings-nav-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(SETTINGS_SHOTS, 'settings-nav-narrow.png'), fullPage: true })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
