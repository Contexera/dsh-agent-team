import { afterEach, it, expect } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { BROWSER_ARTIFACTS, CHROME, HOME, STAGED_BUNDLE, installLocalBundle, launchWebScaffold, scaffold, settleLayout } from './__external-agent-team-support.ts'
import type { Page } from './__external-agent-team-support.ts'

let scaffold: WebScaffold | undefined
let browser: Browser | undefined

afterEach(async () => {
  await browser?.close(); browser = undefined
  await scaffold?.close(); scaffold = undefined
})


it('keeps four same-origin Team pages responsive and independently subscribed', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'multi-web')
  await scaffold.ctx.agentTeam.createProject({ requestId: 'multi-project' as never, workspaceId: workspace.id, name: 'multi-web', description: 'Multi-page regression' })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
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
  const separate = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const other = await separate.newPage()
  await other.goto(scaffold.authenticatedUrl)
  await other.getByRole('button', { name: '团队', exact: true }).click()
  await other.getByRole('button', { name: '# multi-web', exact: true }).click()
  await other.locator('[data-team-project] textarea').fill('来自独立浏览器的消息')
  await other.getByRole('button', { name: '发送', exact: true }).click()
  await pages[1]!.locator('[data-team-project] article').filter({ hasText: '来自独立浏览器的消息' }).waitFor()
  await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-desktop.png'), fullPage: true })
  await pages[1]!.setViewportSize({ width: 390, height: 844 })
  await settleLayout(pages[1]!)
  await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-mobile.png'), fullPage: true })
}, 120_000)
import { join } from 'node:path'
