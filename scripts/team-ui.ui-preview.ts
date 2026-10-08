import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const TEAM_ROOT = '__TEAM_ROOT__'
const HOME = '__HOME__'
const STAGED_BUNDLE = join(HOME, 'profiles', 'node_modules', '@contexera', 'dsh-agent-team')
let scaffold: WebScaffold

beforeAll(async () => {
  await rm(HOME, { recursive: true, force: true })
  const scope = `${HOME}/profiles/node_modules/@contexera`
  await mkdir(scope, { recursive: true })
  await cp(TEAM_ROOT, `${scope}/dsh-agent-team`, {
    recursive: true,
    filter: source => !source.includes('/node_modules') && !source.includes('/src') && !source.includes('/artifacts') && !source.includes('/.hoplite'),
  })
  // Production installs the bundle's regular dependencies with it; stage the
  // same closure inside the staged dir, whose nearest node_modules is what its
  // own imports resolve through.
  const { dependencies } = JSON.parse(await readFile(join(TEAM_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  for (const name of Object.keys(dependencies)) {
    await cp(join(TEAM_ROOT, 'node_modules', name), join(STAGED_BUNDLE, 'node_modules', ...name.split('/')), { recursive: true, dereference: true })
  }
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  const workspacePath = join(scaffold.workspaceCwd, 'team-ui-preview')
  await mkdir(workspacePath, { recursive: true })
  const workspace = await scaffold.ctx.workspaceRegistry.create(workspacePath, 'Team UI Preview')
  const channel = await scaffold.ctx.agentTeam.createChannel({
    requestId: 'ui-preview-channel' as never,
    workspaceId: workspace.id,
    name: 'delivery',
    description: 'Model-free fixture state',
  })
  await scaffold.ctx.agentTeam.sendMessage({
    requestId: 'ui-preview-task' as never,
    workspaceId: workspace.id,
    channelRef: channel.channel.channelRef,
    body: '检查无模型 UI 预览的频道和 Thread 布局',
  })
  process.stdout.write(`AGENT_TEAM_UI_PREVIEW_URL=${scaffold.baseUrl}\n`)
  process.stdout.write('UI-only preview: fixture state is loaded; model calls are disabled and fail explicitly if triggered.\n')
})

afterAll(async () => { await scaffold.close() })

it('serves the model-free Agent Team UI preview until stopped', async () => {
  await new Promise<void>(() => {})
}, 2_147_000_000)
