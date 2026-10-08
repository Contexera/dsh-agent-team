// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamEnvironmentResult } from '@contexera/dsh-agent-team/types'
import { TeamEnvironmentCheck, type TeamEnvironmentLoader } from '../src/client/environment-check.ts'
import { EnvironmentCheck } from '../src/client/EnvironmentCheck.tsx'
import { zh } from '../src/client/locales.ts'

/**
 * The environment block states one of three verdicts in text plus an icon, and
 * it never states a version it was not given. These tests hold the three
 * shapes, the withholding rules (no derived certified version, no line), and
 * the fact that the block is quiet rather than alarming before a read lands.
 */

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof EnvironmentCheck>[0]['t']

const OK: AgentTeamEnvironmentResult = {
  verdict: 'ok',
  bundleVersion: '0.1.15',
  dshVersion: '0.1.7-rc.1',
  certifiedDshVersion: '0.1.7-rc.1',
  supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
}

function checkWith(value: AgentTeamEnvironmentResult = OK, failure?: string) {
  const loadEnvironment = vi.fn(async () => failure === undefined
    ? { ok: true as const, value }
    : ({ ok: false, error: { message: failure } } as RemoteResult<AgentTeamEnvironmentResult>))
  return new TeamEnvironmentCheck({ loadEnvironment } as unknown as TeamEnvironmentLoader)
}

/** The range line as the page would print it for the default fixture. */
const rangeLine = (lower = '0.1.7-rc.1', upper = '0.1.8'): string =>
  t('environmentRange', { lower, upper })

function renderCheck(value?: AgentTeamEnvironmentResult, failure?: string) {
  const environment = checkWith(value, failure)
  render(<EnvironmentCheck t={t} environment={environment} />)
  return environment
}

afterEach(cleanup)

describe('environment check block', () => {
  it('states the running version as inside the range, without a range line or an action', async () => {
    renderCheck()
    await waitFor(() => { expect(screen.getByText(zh.environmentOkTitle)).not.toBeNull() })
    expect(screen.getByText('正在运行的 DSH 0.1.7-rc.1 在我们声明的支持范围内。')).not.toBeNull()
    // The quiet tier states the fact and stops: no range line, no release link.
    expect(screen.queryByText(rangeLine())).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('states the range in words and links the release notes when out of range', async () => {
    renderCheck({ ...OK, verdict: 'out-of-range', dshVersion: '0.1.6' })
    await waitFor(() => { expect(screen.getByText(zh.environmentOutOfRangeTitle)).not.toBeNull() })
    expect(screen.getByText(/正在运行的 DSH 0.1.6 不在我们声明的支持范围内/)).not.toBeNull()
    // The range is stated as words, never as a bare semver range.
    expect(screen.getByText(rangeLine())).not.toBeNull()
    expect(screen.queryByText(/>=0\.1\.7-rc\.1/)).toBeNull()
    expect(screen.getByRole('link', { name: zh.environmentReleaseNotes })).not.toBeNull()
  })

  it('prints the certified combination only from derived versions', async () => {
    renderCheck({ ...OK, verdict: 'out-of-range', dshVersion: '0.1.6' })
    await waitFor(() => { expect(screen.getByText(/我们实测认证的组合/)).not.toBeNull() })
    expect(screen.getByText('我们实测认证的组合：Agent Team 0.1.15 × DSH 0.1.7-rc.1。')).not.toBeNull()
  })

  it('withholds the certified combination when the bundle version is unknown', async () => {
    renderCheck({ ...OK, verdict: 'out-of-range', dshVersion: '0.1.6', bundleVersion: 'unknown' })
    await waitFor(() => { expect(screen.getByText(zh.environmentOutOfRangeTitle)).not.toBeNull() })
    // The data layer's 'unknown' never reaches the page: the whole line goes,
    // rather than the page naming a version it could not derive.
    expect(screen.queryByText(/我们实测认证的组合/)).toBeNull()
    expect(screen.queryByText(/unknown/)).toBeNull()
    // The range itself is still known and still stated.
    expect(screen.getByText(rangeLine())).not.toBeNull()
  })

  it('withholds the range line when no range could be derived', async () => {
    renderCheck({ verdict: 'out-of-range', bundleVersion: '0.1.15', dshVersion: '0.1.6' })
    await waitFor(() => { expect(screen.getByText(zh.environmentOutOfRangeTitle)).not.toBeNull() })
    expect(screen.queryByText(rangeLine())).toBeNull()
    // The running version is a fact of its own and is still stated; what goes
    // is the certified line, which has no lower bound left to name.
    expect(screen.getByText(/正在运行的 DSH 0.1.6 不在我们声明的支持范围内/)).not.toBeNull()
    expect(screen.queryByText(/我们实测认证的组合/)).toBeNull()
  })

  it('states an undetermined verdict neutrally, with no range and no alarm', async () => {
    renderCheck({ verdict: 'undetermined', reason: 'the running dsh version is unavailable' })
    await waitFor(() => { expect(screen.getByText(zh.environmentUndeterminedTitle)).not.toBeNull() })
    expect(screen.getByText(zh.environmentUndeterminedDetail)).not.toBeNull()
    // The Host's diagnostic is for logs, not for the page.
    expect(screen.queryByText(/the running dsh version is unavailable/)).toBeNull()
    expect(screen.queryByText(rangeLine())).toBeNull()
  })

  it('renders nothing at all before a read lands, and nothing when it fails', async () => {
    let settle: ((value: RemoteResult<AgentTeamEnvironmentResult>) => void) | undefined
    const pending = new TeamEnvironmentCheck({
      loadEnvironment: () => new Promise<RemoteResult<AgentTeamEnvironmentResult>>(resolve => { settle = resolve }),
    } as unknown as TeamEnvironmentLoader)
    const { container } = render(<EnvironmentCheck t={t} environment={pending} />)
    expect(container.textContent).toBe('')
    settle?.({ ok: true, value: OK })
    await waitFor(() => { expect(screen.getByText(zh.environmentOkTitle)).not.toBeNull() })

    cleanup()
    const failed = render(<EnvironmentCheck t={t} environment={checkWith(OK, 'unreachable')} />)
    await waitFor(() => { expect(failed.container.textContent).toBe('') })
  })
})
