// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'
import { WORKER_ENGINES, WORKER_SANDBOX_MODES } from '@contexera/dsh-agent-team/worker-settings'
import { TeamHumanIdentity } from '../src/client/human-identity.ts'
import { zh } from '../src/client/locales.ts'
import { WorkerConfigController, workerConfigScope, type TeamConfigSection } from '../src/client/team-config.ts'
import { TeamSettingsSection } from '../src/client/TeamSettingsSection.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamSettingsSection>[0]['t']

const PROFILE = {
  name: 'Ada',
  version: '0.1.13',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
}

// One frozen snapshot: useSyncExternalStore compares by identity, so a literal
// returned per call would loop instead of stating "still loading".
const INERT_ENVIRONMENT = { status: 'loading' as const }
const INERT_ENVIRONMENT_SOURCE = {
  getSnapshot: () => INERT_ENVIRONMENT,
  subscribe: () => () => {},
}

/** The row's Worker group as the Host resolves it with nothing stored. */
const WORKER_DEFAULTS = {
  enabled: false,
  defaultEngine: 'codex',
  engines: {
    codex: { enabled: false, executable: '', sandbox: WORKER_SANDBOX_MODES[0] },
    claude: { enabled: false, executable: '', sandbox: '' },
  },
  timeoutMs: 0,
}

/** One Host row stub: the group the user layer already carries, over the defaults. */
function hostRow(options: {
  worker?: Record<string, unknown>
  userWorker?: Record<string, unknown>
  baseWorker?: Record<string, unknown>
  writable?: boolean
  revision?: number
} = {}) {
  const form = stubConfigForm<TeamConfigSection>()
  form.publish({
    status: 'ready',
    writable: options.writable ?? true,
    revision: options.revision ?? 1,
    value: { worker: options.worker ?? WORKER_DEFAULTS } as TeamConfigSection,
    base: { worker: options.baseWorker },
    user: options.userWorker === undefined ? {} : { worker: options.userWorker },
  })
  return form
}

/** Render the page with the real Worker controller over one stubbed row. */
function renderSection(row = hostRow()) {
  const identity = new TeamHumanIdentity({
    loadProfile: async (): Promise<RemoteResult<AgentTeamHumanProfileResult>> => ({ ok: true, value: PROFILE }),
    loadAvatarUrl: async () => null,
  })
  const workerConfig = new WorkerConfigController(workerConfigScope(row.scope))
  const props = {
    close: () => {},
    t,
    identity,
    environment: INERT_ENVIRONMENT_SOURCE,
    saveName: vi.fn(async () => undefined),
    uploadAvatar: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => undefined),
    workerConfig,
  } as unknown as Parameters<typeof TeamSettingsSection>[0]
  const rendered = render(<TeamSettingsSection {...props} />)
  return { ...rendered, row, workerConfig }
}

/** The worker group's own region: the identity rows above it carry no switch. */
async function group() {
  return await screen.findByRole('region', { name: zh.workerTitle })
}

/** The name one engine's path answers to: the visible label plus the engine. */
function pathName(engine: 'codex' | 'claude'): string {
  return zh.workerExecutableFor.replace('{engine}', engine === 'codex' ? zh.workerEngineCodex : zh.workerEngineClaude)
}

/** One engine's block, which is what tells two identically-labelled paths apart. */
function engineBlock(region: HTMLElement, engine: string): HTMLElement {
  const block = region.querySelector(`[data-worker-engine="${engine}"]`)
  if (block === null) throw new Error(`no ${engine} block`)
  return block as HTMLElement
}

/** The switch that turns the whole group on. */
function masterSwitch(region: HTMLElement): HTMLElement {
  return within(region).getByRole('switch', { name: zh.workerEnabled })
}

afterEach(cleanup)

describe('Team settings page: the Worker delegation group', () => {
  it('opens off, with the engines locked until the group is on', async () => {
    renderSection()
    const region = await group()
    expect(masterSwitch(region).getAttribute('aria-checked')).toBe('false')
    // The one fact the switch turns on is stated before the switch, not after it.
    expect(region.textContent).toContain(zh.workerIntro)
    for (const engine of WORKER_ENGINES) {
      const block = engineBlock(region, engine)
      const toggle = within(block).getByRole('switch', { name: zh.workerEngineSwitch.replace('{engine}', engine === 'codex' ? 'Codex' : 'Claude') })
      expect((toggle as HTMLButtonElement).disabled).toBe(true)
      expect((within(block).getByLabelText(pathName(engine)) as HTMLInputElement).disabled).toBe(true)
    }
    expect((within(region).getByLabelText(zh.workerDefaultEngine) as HTMLSelectElement).disabled).toBe(true)
  })

  it('stages the group switch at its own leaf, never at the group', async () => {
    const { row } = renderSection()
    const region = await group()
    fireEvent.click(masterSwitch(region))
    expect(masterSwitch(region).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(region).getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['worker', 'enabled'], value: true }], 1)
    })
  })

  it('stages an engine and its path as two leaves, trimming what a path cannot carry', async () => {
    const { row } = renderSection()
    const region = await group()
    fireEvent.click(masterSwitch(region))
    const codex = engineBlock(region, 'codex')
    fireEvent.click(within(codex).getByRole('switch', { name: zh.workerEngineSwitch.replace('{engine}', 'Codex') }))
    fireEvent.change(within(codex).getByLabelText(pathName('codex')), { target: { value: '  /data/bin/codex  ' } })
    expect((within(codex).getByLabelText(pathName('codex')) as HTMLInputElement).value).toBe('  /data/bin/codex  ')
    fireEvent.click(within(region).getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['worker', 'enabled'], value: true },
        { op: 'set', path: ['worker', 'engines', 'codex', 'enabled'], value: true },
        { op: 'set', path: ['worker', 'engines', 'codex', 'executable'], value: '/data/bin/codex' },
      ], 1)
    })
  })

  it('clears a stored path back to the engine’s own discovery', async () => {
    const row = hostRow({
      worker: { ...WORKER_DEFAULTS, engines: { ...WORKER_DEFAULTS.engines, codex: { ...WORKER_DEFAULTS.engines.codex, executable: '/opt/codex' } } },
      userWorker: { engines: { codex: { executable: '/opt/codex' } } },
    })
    renderSection(row)
    const region = await group()
    const path = within(engineBlock(region, 'codex')).getByLabelText(pathName('codex')) as HTMLInputElement
    expect(path.value).toBe('/opt/codex')
    fireEvent.change(path, { target: { value: '' } })
    fireEvent.click(within(region).getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['worker', 'engines', 'codex', 'executable'] }], 1)
    })
  })

  it('offers Codex’s own sandbox modes and stages the chosen one', async () => {
    const { row } = renderSection()
    const region = await group()
    fireEvent.click(masterSwitch(region))
    const codex = engineBlock(region, 'codex')
    fireEvent.click(within(codex).getByRole('switch', { name: zh.workerEngineSwitch.replace('{engine}', 'Codex') }))
    const sandbox = within(codex).getByLabelText(zh.workerSandbox)
    expect(within(sandbox).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual([...WORKER_SANDBOX_MODES])
    fireEvent.change(sandbox, { target: { value: 'read-only' } })
    fireEvent.click(within(region).getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['worker', 'enabled'], value: true },
        { op: 'set', path: ['worker', 'engines', 'codex', 'enabled'], value: true },
        { op: 'set', path: ['worker', 'engines', 'codex', 'sandbox'], value: 'read-only' },
      ], 1)
    })
  })

  it('keeps a stored policy the list does not offer visible, and stages nothing for it', async () => {
    const row = hostRow({
      worker: { ...WORKER_DEFAULTS, engines: { ...WORKER_DEFAULTS.engines, codex: { ...WORKER_DEFAULTS.engines.codex, sandbox: 'custom-policy' } } },
      userWorker: { engines: { codex: { sandbox: 'custom-policy' } } },
    })
    renderSection(row)
    const region = await group()
    const sandbox = within(engineBlock(region, 'codex')).getByLabelText(zh.workerSandbox) as HTMLSelectElement
    expect(sandbox.value).toBe('custom-policy')
    expect(within(sandbox).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toContain('custom-policy')
    expect((within(region).getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('names an empty stored policy for what it runs instead of as a mode it would not use', async () => {
    const row = hostRow({
      worker: { ...WORKER_DEFAULTS, engines: { ...WORKER_DEFAULTS.engines, codex: { ...WORKER_DEFAULTS.engines.codex, sandbox: '' } } },
      userWorker: { engines: { codex: { sandbox: '' } } },
    })
    renderSection(row)
    const region = await group()
    const sandbox = within(engineBlock(region, 'codex')).getByLabelText(zh.workerSandbox) as HTMLSelectElement
    // The Host passes no mode then, so the page must not show the mode it would
    // have picked itself as if that were the policy in force.
    expect(sandbox.value).toBe('')
    const selected = sandbox.selectedOptions[0] as HTMLOptionElement
    expect(selected.textContent).toBe(zh.workerSandboxUnset)
    expect(selected.textContent).toContain('danger-full-access')
    expect((within(region).getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(masterSwitch(region))
    fireEvent.change(sandbox, { target: { value: 'read-only' } })
    fireEvent.click(within(region).getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['worker', 'enabled'], value: true },
        { op: 'set', path: ['worker', 'engines', 'codex', 'sandbox'], value: 'read-only' },
      ], 1)
    })
  })

  it('names each engine’s path after its engine, so two of them are told apart', async () => {
    renderSection()
    const region = await group()
    const codexPath = within(engineBlock(region, 'codex')).getByLabelText(pathName('codex'))
    const claudePath = within(engineBlock(region, 'claude')).getByLabelText(pathName('claude'))
    expect(codexPath).not.toBe(claudePath)
    // The visible label stays the short one and stays associated with its input;
    // the name is a superset of it, never a different word for the same field.
    expect(pathName('codex')).toContain(zh.workerExecutable)
    expect(within(engineBlock(region, 'codex')).getByLabelText(zh.workerExecutable)).toBe(codexPath)
  })

  it('keeps the Codex-only sandbox off the Claude block', async () => {
    renderSection()
    const region = await group()
    expect(within(engineBlock(region, 'codex')).getByLabelText(zh.workerSandbox)).not.toBeNull()
    expect(within(engineBlock(region, 'claude')).queryByLabelText(zh.workerSandbox)).toBeNull()
  })

  it('says so when the default engine is the one that is off', async () => {
    const row = hostRow({ worker: { ...WORKER_DEFAULTS, defaultEngine: 'claude' } })
    renderSection(row)
    const region = await group()
    fireEvent.click(masterSwitch(region))
    const select = within(region).getByLabelText(zh.workerDefaultEngine) as HTMLSelectElement
    expect(select.value).toBe('claude')
    expect(region.textContent).toContain(zh.workerDefaultEngineUnavailable)
  })

  it('stages the default engine the delegation falls back to', async () => {
    const { row } = renderSection()
    const region = await group()
    fireEvent.click(masterSwitch(region))
    fireEvent.change(within(region).getByLabelText(zh.workerDefaultEngine), { target: { value: 'claude' } })
    fireEvent.click(within(region).getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['worker', 'enabled'], value: true },
        { op: 'set', path: ['worker', 'defaultEngine'], value: 'claude' },
      ], 1)
    })
  })

  it('renders a read-only document as the shipped form does, with every control locked', async () => {
    renderSection(hostRow({ writable: false }))
    const region = await group()
    expect(within(region).getByText(zh.readOnly)).not.toBeNull()
    expect((masterSwitch(region) as HTMLButtonElement).disabled).toBe(true)
    expect((within(region).getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders nothing when the settings service is absent', () => {
    const identity = new TeamHumanIdentity({
      loadProfile: async (): Promise<RemoteResult<AgentTeamHumanProfileResult>> => ({ ok: true, value: PROFILE }),
      loadAvatarUrl: async () => null,
    })
    render(<TeamSettingsSection
      {...{
        close: () => {},
        t,
        identity,
        environment: INERT_ENVIRONMENT_SOURCE,
        saveName: vi.fn(async () => undefined),
        uploadAvatar: vi.fn(async () => undefined),
        removeAvatar: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof TeamSettingsSection>[0]}
    />)
    expect(screen.queryByRole('region', { name: zh.workerTitle })).toBeNull()
  })
})
