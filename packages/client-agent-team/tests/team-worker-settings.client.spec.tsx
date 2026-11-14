// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { DEFAULT_WORKER_SANDBOX, WORKER_ENGINES } from '@contexera/dsh-agent-team/worker-settings'
import { zh } from '../src/client/locales.ts'
import { WorkerConfigController, workerConfigScope, type TeamConfigSection } from '../src/client/team-config.ts'
import { renderTeamSettingsSection } from './bench/client-fixtures.tsx'

/** The row's Worker group as the Host resolves it with nothing stored. */
const WORKER_DEFAULTS = {
  enabled: false,
  defaultEngine: 'codex',
  engines: {
    codex: { enabled: false, executable: '', sandbox: DEFAULT_WORKER_SANDBOX },
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
  const workerConfig = new WorkerConfigController(workerConfigScope(row.scope))
  const rendered = renderTeamSettingsSection({ workerConfig })
  return { ...rendered, row, workerConfig }
}

/** The worker group's own region: the identity rows above it carry no switch. */
async function group() {
  const region = await screen.findByRole('region', { name: zh.workerTitle })
  // The group is a disclosure and opens closed, so every case starts by opening it.
  const toggle = within(region).getByRole('button', { name: new RegExp(zh.workerTitle) })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
  return region
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

  it('opens closed on a one-phrase summary, and shows its controls only once opened', async () => {
    renderSection()
    const region = await screen.findByRole('region', { name: zh.workerTitle })
    const toggle = within(region).getByRole('button', { name: new RegExp(zh.workerTitle) })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Closed, the group costs one line: its title and what it is set to.
    expect(toggle.textContent).toContain(zh.workerCollapsedOff)
    expect(within(region).queryByRole('switch', { name: zh.workerEnabled })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await within(region).findByRole('switch', { name: zh.workerEnabled })).toBeTruthy()
  })

  it('names the engines an already-on group runs, so the closed row is not just “on”', async () => {
    const row = hostRow({ worker: { ...WORKER_DEFAULTS, enabled: true,
      engines: { ...WORKER_DEFAULTS.engines, codex: { ...WORKER_DEFAULTS.engines.codex, enabled: true } } } })
    renderSection(row)
    const region = await screen.findByRole('region', { name: zh.workerTitle })
    const summary = within(region).getByRole('button', { name: new RegExp(zh.workerTitle) }).textContent ?? ''
    expect(summary).toContain(zh.workerCollapsedOnEngines.replace('{engines}', zh.workerEngineCodex))
    expect(summary).not.toContain(zh.workerEngineClaude)
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
    renderTeamSettingsSection({})
    expect(screen.queryByRole('region', { name: zh.workerTitle })).toBeNull()
  })
})
