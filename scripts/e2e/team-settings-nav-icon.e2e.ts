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

  // Our own registration fills the seat; without it the seat holds the shell's gear.
  const probe = await teamRow.evaluate(el => {
    const seat = el.querySelector('[class*="navIcon"]')
    const svg = seat?.querySelector('svg') ?? null
    const path = svg?.querySelector('path') ?? null
    const dot = svg?.querySelector('circle') ?? null
    const box = svg?.getBoundingClientRect() ?? null
    return {
      glyphCount: seat === null ? -1 : seat.querySelectorAll('svg').length,
      ringPath: path?.getAttribute('d') ?? null,
      dot: dot === null ? null : { cx: dot.getAttribute('cx'), cy: dot.getAttribute('cy'), r: dot.getAttribute('r') },
      ink: path === null ? null : getComputedStyle(path).stroke,
      box: box === null ? null : { width: box.width, height: box.height },
    }
  })
  expect(probe.glyphCount).toBe(1)
  expect(probe.ringPath).toBe('M11.7 10.15A4.9 4.9 0 1 1 11.7 5.85')
  expect(probe.dot).toEqual({ cx: '12.7', cy: '8', r: '1.6' })
  expect(probe.ink).not.toBe('none')
  expect(probe.box).toEqual({ width: 16, height: 16 })

  // Exactly one nav row carries the mark, addressed by the section id: a wrong id would
  // paint it on all of them and leave the assertions above green, and host glyphs are sprite `<use>` marks.
  const rows = await panel.evaluate(root => [...root.querySelectorAll('nav button')].map(button => {
    const svg = button.querySelector('svg')
    return {
      name: (button.textContent ?? '').trim(),
      ring: svg?.querySelector('path')?.getAttribute('d') ?? null,
      dots: svg?.querySelectorAll('circle').length ?? -1,
    }
  }))
  expect(rows.length).toBeGreaterThan(1)
  expect(rows.filter(row => row.ring === 'M11.7 10.15A4.9 4.9 0 1 1 11.7 5.85').map(row => row.name)).toEqual(['团队'])
  expect(rows.filter(row => row.dots > 0).map(row => row.name)).toEqual(['团队'])

  await page.screenshot({ path: join(SETTINGS_SHOTS, 'settings-nav-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(SETTINGS_SHOTS, 'settings-nav-narrow.png'), fullPage: true })

  // Selecting the row re-renders the seat on the same registration: still one mark.
  await teamRow.click()
  await expect.poll(async () => await teamRow.getAttribute('aria-current')).toBe('true')
  const selected = await teamRow.evaluate(el => {
    const seat = el.querySelector('[class*="navIcon"]')
    const svg = seat?.querySelector('svg') ?? null
    return {
      glyphCount: seat === null ? -1 : seat.querySelectorAll('svg').length,
      width: svg === null ? -1 : svg.getBoundingClientRect().width,
    }
  })
  expect(selected.glyphCount).toBe(1)
  expect(selected.width).toBe(16)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
