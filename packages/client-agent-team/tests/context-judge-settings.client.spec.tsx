// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamContextJudgeResult } from '@wowyuarm/dsh-agent-team/types'
import { TeamContextJudgeCheck, type TeamContextJudgeLoader } from '../src/client/context-judge.ts'
import { TeamContextGateForm, type TeamGateSection } from '../src/client/context-gate-form.ts'
import { ContextJudgeSettingsSection } from '../src/client/ContextJudgeSettingsSection.tsx'
import { zh } from '../src/client/locales.ts'

/**
 * The context gate page holds two facts apart: what the form would write, and
 * what the Host says is in force. These tests pin that separation and the
 * states a browser run cannot reach — a judge that failed to mount, a read-only
 * document, and a refused clear — plus the rule that the Host's own diagnostic
 * stays out of the page's copy.
 */

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof ContextJudgeSettingsSection>[0]['t']

const GATE = { tokens: 24000, idleMs: 300000, judgeTimeoutMs: 5000 }

const READY: AgentTeamContextJudgeResult = { enabled: true, keyEnv: 'TYPESAFE_API_KEY', gate: GATE }
const NO_KEY: AgentTeamContextJudgeResult = { enabled: false, reason: 'no-key', keyEnv: 'TYPESAFE_API_KEY', gate: GATE }
const BROKEN: AgentTeamContextJudgeResult = {
  enabled: false,
  reason: 'unavailable',
  detail: 'jev failed to mount: ERR_MODULE_NOT_FOUND',
  keyEnv: 'TYPESAFE_API_KEY',
  gate: GATE,
}

/**
 * The Host row this page reads. It carries the profile's own fields beside the
 * gate's two groups — the page's type names only what it consumes, so a test
 * that fills in the rest has to say so.
 */
type HostRow = TeamGateSection & { readonly name?: string; readonly avatarRef?: string }

/** The page over one judge answer and one settings scope, as the slot injects them. */
function renderPage(options: {
  readonly report?: AgentTeamContextJudgeResult
  readonly section?: HostRow
  readonly user?: unknown
  readonly writable?: boolean
  readonly served?: boolean
  readonly keyConfigured?: boolean
} = {}) {
  const stub = stubConfigForm<TeamGateSection>()
  const loadContextJudge = vi.fn(async (): Promise<RemoteResult<AgentTeamContextJudgeResult>> =>
    ({ ok: true, value: options.report ?? NO_KEY }))
  const judge = new TeamContextJudgeCheck({ loadContextJudge } as unknown as TeamContextJudgeLoader)
  const form = new TeamContextGateForm(stub.scope, judge)
  stub.publish({
    status: options.served === false ? 'unavailable' : 'ready',
    value: options.section ?? {},
    base: {},
    user: options.user,
    writable: options.writable ?? true,
    revision: 4,
  })
  const props = {
    close: () => {},
    t,
    judge,
    form,
    keyConfigured: () => options.keyConfigured ?? false,
  } as unknown as Parameters<typeof ContextJudgeSettingsSection>[0]
  render(<ContextJudgeSettingsSection {...props} />)
  return { stub, form, loadContextJudge }
}

afterEach(cleanup)

describe('context gate page', () => {
  it('states a missing key as a configuration step and names the variable the deployment reads', async () => {
    renderPage()
    const status = await waitFor(() => screen.getByText(zh.contextGateNoKey))
    const block = status.closest('[data-context-judge]')!
    expect(block.getAttribute('data-context-judge')).toBe('no-key')
    expect(block.textContent).toContain(zh.contextGateNoKeyDetail)
    expect(block.textContent).toContain('TYPESAFE_API_KEY')
  })

  it('prints the thresholds the Host resolved, never a default of its own', async () => {
    renderPage()
    const block = (await waitFor(() => screen.getByText(zh.contextGateNoKey))).closest('[data-context-judge]')!
    // The row overrides nothing — every control below is empty — so these three
    // numbers can only have come from the Host's answer.
    expect(block.textContent).toContain(t('contextGateThresholds', { tokens: '24000', idle: '300000', timeout: '5000' }))
    expect((screen.getByLabelText('用量阈值（tokens）') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('判官超时（毫秒）') as HTMLInputElement).value).toBe('')
  })

  it('states an unreachable judge as something to fix, and keeps the Host diagnostic out of the page', async () => {
    renderPage({ report: BROKEN })
    const block = (await waitFor(() => screen.getByText(zh.contextGateUnavailable))).closest('[data-context-judge]')!
    expect(block.getAttribute('data-context-judge')).toBe('unavailable')
    expect(block.textContent).toContain(zh.contextGateUnavailableDetail)
    expect(screen.queryByText(/ERR_MODULE_NOT_FOUND/)).toBeNull()
  })

  it('states a reachable judge with the thresholds in force', async () => {
    renderPage({ report: READY })
    const block = (await waitFor(() => screen.getByText(zh.contextGateEnabled))).closest('[data-context-judge]')!
    expect(block.getAttribute('data-context-judge')).toBe('enabled')
    expect(block.textContent).toContain(t('contextGateThresholds', { tokens: '24000', idle: '300000', timeout: '5000' }))
  })

  it('renders the form the row resolves to, and the clear only while a literal is stored', async () => {
    renderPage({ section: { jev: { apiBase: 'https://openrouter.ai/api/v1' }, gate: { judgeTimeoutMs: 10000 } } })
    await waitFor(() => { expect(screen.getByText(zh.contextGateNoKey)).not.toBeNull() })
    expect((screen.getByLabelText('apiBase') as HTMLInputElement).value).toBe('https://openrouter.ai/api/v1')
    expect((screen.getByLabelText('判官超时（毫秒）') as HTMLInputElement).value).toBe('10000')
    // The key control never echoes anything, and there is nothing to clear.
    expect((screen.getByLabelText('key') as HTMLInputElement).value).toBe('')
    expect(screen.getByLabelText('key').getAttribute('type')).toBe('password')
    expect(screen.getByText(zh.contextGateKeyUnset)).not.toBeNull()
    expect(screen.queryByRole('button', { name: zh.contextGateClearKey })).toBeNull()
  })

  it('offers the clear once a literal is stored, and reports a refused one in the page\'s own words', async () => {
    const { stub } = renderPage({ keyConfigured: true })
    const clear = await waitFor(() => screen.getByRole('button', { name: zh.contextGateClearKey }))
    expect(screen.getByText(zh.contextGateKeySet)).not.toBeNull()
    stub.mutate.mockResolvedValueOnce(false)
    fireEvent.click(clear)
    await waitFor(() => { expect(screen.getByText(zh.contextGateClearFailed)).not.toBeNull() })
  })

  it('holds the clear back while a draft is staged, because the staged save is fenced to the revision it moves', async () => {
    renderPage({ keyConfigured: true })
    const clear = await waitFor(() => screen.getByRole('button', { name: zh.contextGateClearKey }))
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'typesafe/jev-1.13' } })
    await waitFor(() => { expect((clear as HTMLButtonElement).disabled).toBe(true) })
    expect(screen.getByText(zh.contextGateClearBlocked)).not.toBeNull()
  })

  it('disables every control and says so when the document is read-only', async () => {
    renderPage({ writable: false })
    await waitFor(() => { expect(screen.getByText(zh.contextGateFormReadOnly)).not.toBeNull() })
    expect((screen.getByLabelText('apiBase') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: zh.contextGateSave }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says the namespace is not served instead of drawing fields nothing would accept', async () => {
    renderPage({ served: false })
    await waitFor(() => { expect(screen.getByText(zh.contextGateFormUnavailable)).not.toBeNull() })
    expect(screen.queryByLabelText('apiBase')).toBeNull()
  })

  it('renders only its own group of the shared row, never the profile fields beside them', async () => {
    // The profile page and this one edit the same settings namespace, so a form
    // rendered wholesale would put identity fields on the gate's page.
    renderPage({ section: { name: 'Ada', avatarRef: 'ref-1', jev: { model: 'typesafe/jev-1.13' } } })
    await waitFor(() => { expect((screen.getByLabelText('model') as HTMLInputElement).value).toBe('typesafe/jev-1.13') })
    expect(screen.queryByLabelText(zh.humanSettingsName)).toBeNull()
    expect(screen.queryByText(zh.humanSettingsNameHint)).toBeNull()
    expect(screen.queryByText(zh.humanSettingsAvatarHint)).toBeNull()
    expect(screen.queryByText(/Ada|ref-1/)).toBeNull()
  })
})
