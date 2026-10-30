import { afterEach, it, expect } from 'vitest'
import type { Browser } from 'playwright'
import { HOME, STAGED_BUNDLE, installLocalBundle, launchWebScaffold } from './__external-agent-team-support.ts'
import type { WebScaffold } from './__external-agent-team-support.ts'

let scaffold: WebScaffold | undefined
let browser: Browser | undefined

afterEach(async () => {
  await browser?.close(); browser = undefined
  await scaffold?.close(); scaffold = undefined
})


it('toggles the complete bundle without restarting the session controller', async () => {
  await installLocalBundle()
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: false }] } })
  const sessionController = [...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber

  const enabled = await scaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', true)
  expect(enabled, JSON.stringify(enabled)).toMatchObject({ application: 'applied' })
  expect(scaffold.ctx.get('agentTeam')).toBeDefined()
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'toggle-persistence')
  const project = await scaffold.ctx.agentTeam.createProject({
    requestId: 'toggle-persistence' as never,
    workspaceId: workspace.id,
    name: 'toggle-persistence',
    description: '',
  })
  expect(scaffold.ctx.agentTeam.status().projectCount).toBe(1)
  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)

  const disabled = await scaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', false)
  expect(disabled, JSON.stringify(disabled)).toMatchObject({ application: 'applied' })
  expect(scaffold.ctx.get('agentTeam')).toBeUndefined()
  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(false)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)

  expect(await scaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', true)).toMatchObject({ application: 'applied' })
  expect(scaffold.ctx.get('agentTeam')).toBeDefined()
  expect(scaffold.ctx.agentTeam.status().projectCount).toBe(1)
  expect(scaffold.ctx.agentTeam.view({ workspaceId: project.project.workspaceId }).projects[0]?.name).toBe('toggle-persistence')
  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)
}, 30_000)
